'use strict';
// 编排层是「一条消息进来之后发生什么」的全部逻辑。这里用假 dsh + 假订单库，把顺序、状态、兜底全钉死，
// 不依赖真实模型，也不依赖队友还没写完的 orders.js。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRelay } = require('../lib/relay');

const silent = { info() {}, warn() {}, error() {}, close() {} };

let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeConfig(over) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
  return Object.assign({
    stateRoot: root,
    deskCwd: path.join(root, 'desk'),
    ordersRoot: path.join(root, 'orders'),
    logPath: null,
    bridgeToken: '',
    desk: { timeoutMs: 1000, permissionMode: 'workspace-write', fallbackPermissionMode: 'danger-full-access', approvalPolicy: 'never' },
    worker: { timeoutMs: 1000, permissionMode: 'workspace-write', fallbackPermissionMode: 'danger-full-access', approvalPolicy: 'never' },
    orders: { confirmMode: 'frontdesk', maxReplyChars: 1200, bubbleChars: 180 },
    owner: { chatId: '', paused: false },
  }, over || {});
}

function fakeOrders() {
  const orders = new Map();
  const events = [];
  const threads = [];
  const requirements = [];
  let seq = 0;
  function make(chatId, nickname) {
    seq += 1;
    const order = {
      orderId: 'ord-' + seq,
      chatId,
      nickname: nickname || '',
      status: 'intake',
      title: '',
      deskSessionId: null,
      workerSessionId: null,
      pendingQuestions: [],
      pendingReport: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    orders.set(order.orderId, order);
    return order;
  }
  const api = {
    ensureOrder({ chatId, nickname }) {
      for (const o of orders.values()) if (o.chatId === chatId && o.status !== 'delivered') return { order: o, created: false };
      return { order: make(chatId, nickname), created: true };
    },
    findOpenOrderByChat(chatId) {
      for (const o of orders.values()) if (o.chatId === chatId && o.status !== 'delivered') return o;
      return null;
    },
    loadOrder(id) {
      const o = orders.get(id);
      if (!o) throw new Error('未知订单 ' + id);
      return o;
    },
    updateOrder(id, patch) { Object.assign(api.loadOrder(id), patch, { updatedAt: new Date().toISOString() }); return api.loadOrder(id); },
    appendEvent(id, ev) { events.push({ id, ...ev }); },
    appendWorkerEvent(id, ev) { events.push({ id, worker: true, ...ev }); },
    appendWorkerEvents(id, list) { for (const ev of list || []) events.push({ id, worker: true, ...ev }); },
    appendThread(id, md) { threads.push({ id, md }); },
    appendRequirement(id, lines) { for (const l of lines || []) requirements.push({ id, line: l }); },
    readOrderMd(id) { return '【需求】id=' + id + '\n【验收】能跑\n【口径】报价另议'; },
    writeOrderMd() {},
    paths(id) { return { dir: '/tmp/' + id, workspace: '/tmp/' + id + '/workspace', deliverables: '/tmp/' + id + '/deliverables' }; },
    withOrderLock(id, fn) { return Promise.resolve(fn()); },
  };
  return { api, orders, events, threads, requirements };
}

function fakeDsh(script) {
  const calls = [];
  let index = 0;
  let active = 0;
  let maxActive = 0;
  const runTurn = async (opts) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push({ cwd: opts.cwd, sessionId: opts.sessionId, prompt: opts.prompt, permissionMode: opts.permissionMode });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    try {
      if (typeof step === 'function') return await step(opts);
      if (step && step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      if (step && step.throw) throw new Error(step.throw);
      return {
        ok: step.ok !== false,
        sessionId: step.sessionId || null,
        text: step.text || '',
        reason: { kind: step.ok === false ? 'error' : 'completed' },
        events: [],
        timedOut: false,
        durationMs: 1,
        stderrTail: '',
        error: step.ok === false ? (step.error || 'boom') : null,
      };
    } finally { active -= 1; }
  };
  return { runTurn, calls, stats: () => ({ maxActive }) };
}

function build(config, script) {
  const store = fakeOrders();
  const dsh = fakeDsh(script);
  const relay = createRelay({ config, orders: store.api, dsh, logger: silent });
  return { relay, store, dsh };
}

function msg(text, over) {
  return Object.assign({ chat_id: 'wxid_a', text, msg_id: 'm-' + Math.random(), nickname: '客户甲', chat_type: 'private' }, over || {});
}

test('纯问答只跑一轮前台', async () => {
  const config = makeConfig();
  const { relay, dsh } = build(config, [{ text: '【回复客户】你好，想做什么项目？', sessionId: 'desk-s1' }]);
  const res = await relay.handleIncoming(msg('在吗'));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.action, 'reply');
  assert.strictEqual(res.reply, '你好，想做什么项目？');
  assert.strictEqual(dsh.calls.length, 1);
  assert.strictEqual(dsh.calls[0].sessionId, null, '第一轮应该新开 session');
  assert.strictEqual(dsh.calls[0].cwd, config.deskCwd);
});

test('第二条消息续接同一个前台 session', async () => {
  const config = makeConfig();
  const { relay, dsh } = build(config, [
    { text: '【回复客户】做个官网？', sessionId: 'desk-s1' },
    { text: '【回复客户】收到', sessionId: 'desk-s1' },
  ]);
  await relay.handleIncoming(msg('在吗'));
  await relay.handleIncoming(msg('做官网'));
  assert.strictEqual(dsh.calls.length, 2);
  assert.strictEqual(dsh.calls[1].sessionId, 'desk-s1');
  assert.strictEqual(relay.deskSessionOf('wxid_a'), 'desk-s1');
});

test('前台派单 → 工人一轮 → 前台再翻一遍给客户', async () => {
  const config = makeConfig();
  const { relay, dsh, store } = build(config, [
    { text: '【回复客户】我先安排做一版\n【派单】做一个静态首页\n【需求更新】- 要手机端', sessionId: 'desk-s1' },
    { text: '【给前台】首页写完了\n【产出】index.html', sessionId: 'worker-s1' },
    { text: '【回复客户】第一版做好了，发你看看', sessionId: 'desk-s1' },
  ]);
  const res = await relay.handleIncoming(msg('做个官网，要手机端'));
  assert.strictEqual(dsh.calls.length, 3);
  assert.ok(dsh.calls[1].cwd.includes('workspace'), '工人必须在订单工作区里跑');
  assert.ok(dsh.calls[1].prompt.includes('做一个静态首页'), '工人任务单要带上派单内容');
  assert.strictEqual(res.reply, '第一版做好了，发你看看');
  const order = store.api.loadOrder('ord-1');
  assert.strictEqual(order.status, 'working');
  assert.strictEqual(order.workerSessionId, 'worker-s1');
  assert.deepStrictEqual(store.requirements.map((r) => r.line), ['要手机端']);
});

test('重复 msg_id 只处理一次', async () => {
  const config = makeConfig();
  const { relay, dsh } = build(config, [{ text: '【回复客户】好', sessionId: 'desk-s1' }]);
  const body = msg('在吗', { msg_id: 'dup-1' });
  await relay.handleIncoming(body);
  const second = await relay.handleIncoming(body);
  assert.strictEqual(second.action, 'ignore');
  assert.strictEqual(dsh.calls.length, 1);
});

test('前台轮失败给兜底话术，不让客户看到空回复', async () => {
  const config = makeConfig();
  const { relay } = build(config, [{ ok: false, error: 'MISSING_CREDENTIAL' }]);
  const res = await relay.handleIncoming(msg('在吗'));
  assert.strictEqual(res.ok, true);
  assert.ok(res.reply.length > 0);
});

test('工人轮失败也不静默：前台给一句可交付的话', async () => {
  const config = makeConfig();
  const { relay } = build(config, [
    { text: '【回复客户】我安排了\n【派单】做首页', sessionId: 'desk-s1' },
    { ok: false, error: 'timeout' },
  ]);
  const res = await relay.handleIncoming(msg('做官网'));
  assert.strictEqual(res.ok, true);
  assert.ok(res.reply.length > 0);
});

test('confirmMode=owner 时派单被拦下，状态不动', async () => {
  const config = makeConfig({ orders: { confirmMode: 'owner', maxReplyChars: 1200 } });
  const { relay, dsh, store } = build(config, [
    { text: '【回复客户】我确认下安排\n【派单】做首页', sessionId: 'desk-s1' },
  ]);
  const res = await relay.handleIncoming(msg('做官网'));
  assert.strictEqual(dsh.calls.length, 1, '不该唤醒工人');
  assert.strictEqual(store.api.loadOrder('ord-1').status, 'intake');
  assert.strictEqual(res.reply, '我确认下安排');
});

test('老板指令 #确认 能把订单推进到 working', async () => {
  const config = makeConfig({ owner: { chatId: 'wxid_boss', paused: false } });
  const { relay, store } = build(config, [{ text: '【回复客户】好', sessionId: 'desk-s1' }]);
  await relay.handleIncoming(msg('在吗', { chat_id: 'wxid_a' }));
  const res = await relay.handleIncoming(msg('#确认 ord-1', { chat_id: 'wxid_boss', msg_id: 'x1' }));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(store.api.loadOrder('ord-1').status, 'working');
});

test('暂停时一律忽略', async () => {
  const config = makeConfig({ owner: { chatId: '', paused: true } });
  const { relay, dsh } = build(config, [{ text: '【回复客户】好', sessionId: 'desk-s1' }]);
  const res = await relay.handleIncoming(msg('在吗'));
  assert.strictEqual(res.action, 'ignore');
  assert.strictEqual(dsh.calls.length, 0);
});

test('同一会话严格串行，不会两条消息同时进前台', async () => {
  const config = makeConfig();
  const { relay, dsh } = build(config, [
    { text: '【回复客户】一', sessionId: 'desk-s1', delayMs: 20 },
    { text: '【回复客户】二', sessionId: 'desk-s1', delayMs: 20 },
  ]);
  await Promise.all([relay.handleIncoming(msg('第一条')), relay.handleIncoming(msg('第二条'))]);
  assert.strictEqual(dsh.stats().maxActive, 1);
  assert.strictEqual(dsh.calls.length, 2);
});

test('群聊里没 @ 我 就不插嘴；私聊 at_me 恒 false 也要回', async () => {
  const config = makeConfig();
  const { relay, dsh } = build(config, [{ text: '【回复客户】在的', sessionId: 'desk-s1' }]);
  const quiet = await relay.handleIncoming(msg('随便说说', { chat_type: 'group', at_me: false }));
  assert.strictEqual(quiet.action, 'ignore');
  assert.strictEqual(dsh.calls.length, 0);
  const loud = await relay.handleIncoming(msg('@机器人 在吗', { chat_type: 'group', at_me: true, msg_id: 'g2' }));
  assert.strictEqual(loud.action, 'reply');
  const priv = await relay.handleIncoming(msg('私聊里 at_me 是 false', { chat_type: 'private', at_me: false, msg_id: 'p1' }));
  assert.strictEqual(priv.action, 'reply');
});

test('回复带 bubbles，长回复拆成多条', async () => {
  const longReply = '【回复客户】' + '这一句用来占位置。'.repeat(30);
  const config = makeConfig();
  const { relay } = build(config, [{ text: longReply, sessionId: 'desk-s1' }]);
  const res = await relay.handleIncoming(msg('讲讲方案'));
  assert.ok(Array.isArray(res.bubbles), '必须有 bubbles');
  assert.ok(res.bubbles.length > 1, '长回复要拆条：' + res.bubbles.length);
  assert.ok(res.bubbles.every((b) => b.length <= 200));
  assert.strictEqual(res.reply, res.bubbles.join('\n'));
});

test('前台没派单却宣称已完成 -> 拦下换话术', async () => {
  const config = makeConfig();
  const { relay } = build(config, [{ text: '【回复客户】好了，hello.txt 已经建好了，我确认过没写错。', sessionId: 'desk-s1' }]);
  const res = await relay.handleIncoming(msg('建个 hello.txt'));
  assert.ok(!/已经建好/.test(res.reply), '不许把虚报发给客户：' + res.reply);
  assert.ok(res.reply.length > 0);
});

test('有工程汇报时「已经做好」是合法的', async () => {
  const config = makeConfig();
  const { relay } = build(config, [
    { text: '【回复客户】我安排了\n【派单】建 hello.txt', sessionId: 'desk-s1' },
    { text: '【给前台】建好了，内容是 hello relay\n【产出】hello.txt', sessionId: 'worker-s1' },
    { text: '【回复客户】好了，hello.txt 已经建好了，内容是 hello relay。', sessionId: 'desk-s1' },
  ]);
  const res = await relay.handleIncoming(msg('建个 hello.txt'));
  assert.ok(/已经建好/.test(res.reply), '有汇报就该如实转述：' + res.reply);
});

test('沙箱落地失败时自动退回 fallback 权限重跑', async () => {
  const config = makeConfig();
  const { relay, dsh } = build(config, [
    { ok: false, error: 'Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\x\\workspace)' },
    { text: '【回复客户】好，我在的', sessionId: 'desk-s1' },
  ]);
  const res = await relay.handleIncoming(msg('在吗'));
  assert.strictEqual(res.action, 'reply');
  assert.strictEqual(dsh.calls.length, 2);
  assert.strictEqual(dsh.calls[0].permissionMode, 'workspace-write');
  assert.strictEqual(dsh.calls[1].permissionMode, 'danger-full-access');
  assert.strictEqual(dsh.calls[1].sessionId, null, '退回重跑要开新 session，避免同一句话进两次');
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); console.log('PASS ' + t.name); }
    catch (err) { failed += 1; console.log('FAIL ' + t.name + ' :: ' + err.message); }
  }
  process.exitCode = failed ? 1 : 0;
  console.log(failed ? ('FAILED ' + failed) : 'ALL PASS');
})();
