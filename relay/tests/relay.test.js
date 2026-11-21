'use strict';
// 编排层测试：假 agents（不联网、不起进程）+ 假订单库，把「什么阶段该快、什么阶段该插话」钉死。

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
    desk: { timeoutMs: 1000, permissionMode: 'read-only', model: 'deepseek-flash' },
    worker: {
      timeoutMs: 1000, permissionMode: 'danger-full-access', evalPermissionMode: 'read-only',
      evalTimeoutMs: 60000, model: 'deepseek-v4-pro', idleWatchMs: 5000,
    },
    orders: { confirmMode: 'frontdesk', maxReplyChars: 1200, bubbleChars: 180 },
    owner: { chatId: '', paused: false },
  }, over || {});
}

function fakeOrders() {
  const orders = new Map();
  const events = [];
  const threads = [];
  const requirements = [];
  const dirs = new Map();
  let seq = 0;
  function make(chatId, nickname) {
    seq += 1;
    const order = {
      orderId: 'ord-20261121-00' + seq,
      chatId, nickname: nickname || '', status: 'intake', title: '',
      deskSessionId: null, workerSessionId: null,
      pendingQuestions: [], pendingReport: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
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
    loadOrder(id) { const o = orders.get(id); if (!o) throw new Error('未知订单 ' + id); return o; },
    updateOrder(id, patch) { Object.assign(api.loadOrder(id), patch, { updatedAt: new Date().toISOString() }); return api.loadOrder(id); },
    appendEvent(id, ev) { events.push({ id, ...ev }); },
    appendWorkerEvent(id, ev) { events.push({ id, worker: true, ...ev }); },
    appendWorkerEvents(id, list) { for (const ev of list || []) events.push({ id, worker: true, ...ev }); },
    appendThread(id, md) { threads.push({ id, md }); },
    appendRequirement(id, lines) { for (const l of lines || []) requirements.push({ id, line: l }); },
    readOrderMd(id) { return '【需求】id=' + id + '\n【验收】能跑\n【口径】报价另议'; },
    writeOrderMd() {},
    paths(id) {
      if (!dirs.has(id)) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-order-'));
        fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
        dirs.set(id, dir);
      }
      const dir = dirs.get(id);
      return { dir, workspace: path.join(dir, 'workspace'), deliverables: path.join(dir, 'deliverables') };
    },
    withOrderLock(id, fn) { return Promise.resolve(fn()); },
  };
  return { api, orders, events, threads, requirements };
}

// 假 agents：把每个角色的调用都记下来，测试只关心「谁在第几步被叫、拿到什么」。
function fakeAgents(script) {
  const s = script || {};
  const calls = [];
  const states = new Map();
  let deskIndex = 0;
  function st(orderId) {
    let v = states.get(orderId);
    if (!v) { v = { running: false, turn: 0, step: 0, lastTool: '', lastAssistant: '', injected: 0 }; states.set(orderId, v); }
    return v;
  }
  const deskScript = s.desk || [];
  const api = {
    calls,
    states,
    async deskTurn(job) {
      calls.push({ kind: 'desk', chatId: job.chatId, sessionId: job.sessionId, prompt: job.prompt });
      const step = deskScript.length ? deskScript[Math.min(deskIndex, deskScript.length - 1)] : { text: '【回复客户】好' };
      deskIndex += 1;
      if (step.ok === false) return { ok: false, sessionId: job.sessionId || 'desk-s0', error: step.error || 'boom' };
      return { ok: true, sessionId: job.sessionId || step.sessionId || 'desk-s0', text: step.text || '【回复客户】好' };
    },
    async workerEval(job) {
      calls.push({ kind: 'eval', orderId: job.orderId, prompt: job.prompt, timeoutMs: job.timeoutMs, sessionId: job.sessionId });
      const step = s.eval || { text: '能做，大概两三天' };
      if (step.ok === false) return { ok: false, sessionId: 'worker-s0', error: step.error || 'eval-fail' };
      return { ok: true, sessionId: 'worker-s0', text: step.text || '能做，大概两三天' };
    },
    async workerStart(job) {
      calls.push({ kind: 'start', orderId: job.orderId, prompt: job.prompt, cwd: job.cwd });
      st(job.orderId).running = true;
      return { ok: true, sessionId: 'worker-s0' };
    },
    async workerInject(orderId, text) {
      calls.push({ kind: 'inject', orderId, text });
      const v = st(orderId);
      v.injected += 1;
      v.running = true;
      return { ok: true };
    },
    workerState(orderId) { return Object.assign({}, st(orderId)); },
    async workerWaitTurn(orderId, turnBefore) {
      calls.push({ kind: 'wait', orderId, turnBefore });
      const v = st(orderId);
      if (s.turnEnd && v.turn === turnBefore) {
        v.running = false;
        v.turn += 1;
        v.lastAssistant = s.turnEnd.text || '【给前台】做好了';
        return { ok: true, turn: v.turn, text: v.lastAssistant, running: false, reason: null };
      }
      return { ok: false };
    },
    close() {},
  };
  return api;
}

function build(config, script) {
  const store = fakeOrders();
  const agents = fakeAgents(script);
  const relay = createRelay({ config, orders: store.api, agents, logger: silent });
  return { relay, store, agents };
}

function msg(text, over) {
  return Object.assign({ chat_id: 'wxid_a', text, msg_id: 'm-' + Math.random(), nickname: '客户甲', chat_type: 'private' }, over || {});
}

test('下单前普通问答：只跑一轮前台，几秒钟就回', async () => {
  const config = makeConfig();
  const { relay, agents } = build(config, { desk: [{ text: '【回复客户】你好，想做什么项目？', sessionId: 'desk-s1' }] });
  const res = await relay.handleIncoming(msg('在吗'));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.reply, '你好，想做什么项目？');
  assert.strictEqual(agents.calls.length, 1);
  assert.strictEqual(agents.calls[0].sessionId, null);
  assert.ok(!agents.calls.some((c) => c.kind === 'start'), '没下单就不许开工');
});

test('前台 session 按会话续接', async () => {
  const config = makeConfig();
  const { relay, agents } = build(config, { desk: [{ text: '【回复客户】一' }, { text: '【回复客户】二' }] });
  await relay.handleIncoming(msg('第一条'));
  await relay.handleIncoming(msg('第二条'));
  assert.strictEqual(agents.calls[1].sessionId, 'desk-s0', '第二条要续接同一个 session');
  assert.strictEqual(relay.deskSessionOf('wxid_a'), 'desk-s0');
});

test('下单前问工程：走快速评估（短超时），再让前台转述', async () => {
  const config = makeConfig();
  const { relay, agents } = build(config, {
    desk: [
      { text: '【回复客户】我确认一下\n【问工程】三页静态站加编辑入口，多久能做' },
      { text: '【回复客户】能做，两天搞定，先按这个来？' },
    ],
    eval: { text: '能做，两天；风险在编辑入口的保存链路。' },
  });
  const res = await relay.handleIncoming(msg('这个能做吗，大概多久'));
  const evalCall = agents.calls.find((c) => c.kind === 'eval');
  assert.ok(evalCall, '应该问工程');
  assert.strictEqual(evalCall.timeoutMs, 60000, '评估必须用短超时');
  assert.ok(!agents.calls.some((c) => c.kind === 'start'), '评估不等于开工');
  assert.strictEqual(res.reply, '能做，两天搞定，先按这个来？');
});

test('评估超时也不能卡住：先用前台的话顶上', async () => {
  const config = makeConfig();
  const { relay } = build(config, {
    desk: [{ text: '【回复客户】我看一下再回你\n【问工程】能不能做' }],
    eval: { ok: false, error: '评估超时' },
  });
  const res = await relay.handleIncoming(msg('能做吗'));
  assert.strictEqual(res.reply, '我看一下再回你');
});

test('派单：立刻回客户，工人后台跑，结果排到下一条补发', async () => {
  const config = makeConfig();
  const { relay, agents, store } = build(config, {
    desk: [
      { text: '【回复客户】我这就开工\n【派单】做三页静态站' },
      { text: '【回复客户】第一版做好了，你看看' },
      { text: '【回复客户】我看下' },
    ],
    turnEnd: { text: '【给前台】三页做完了\n【产出】index.html' },
  });
  const res = await relay.handleIncoming(msg('就按这个做'));
  assert.strictEqual(res.reply, '我这就开工', '派单那一句立刻回');
  assert.ok(agents.calls.some((c) => c.kind === 'start'), '应该开工');
  const order = store.api.loadOrder('ord-20261121-001');
  assert.strictEqual(order.status, 'working');
  await relay.drain();
  const next = await relay.handleIncoming(msg('好了吗', { msg_id: 'm-next' }));
  assert.ok(/第一版做好了/.test(next.bubbles[0]), '工人结果要在下一条消息补发：' + JSON.stringify(next.bubbles));
});

test('派单后客户补充需求：直接插进工人正在跑的那一轮', async () => {
  const config = makeConfig();
  const { relay, agents } = build(config, {
    desk: [
      { text: '【回复客户】好，我开工\n【派单】做首页' },
      { text: '【回复客户】收到，我把它加进去\n【需求更新】- 首页标题改成「你好」' },
    ],
  });
  await relay.handleIncoming(msg('开始吧'));
  const res = await relay.handleIncoming(msg('首页标题改成「你好」', { msg_id: 'm2' }));
  const injectCall = agents.calls.find((c) => c.kind === 'inject');
  assert.ok(injectCall, '必须插话而不是排队等下一轮');
  assert.ok(injectCall.text.includes('首页标题改成'), '插话内容要带上客户原话');
  assert.strictEqual(res.reply, '收到，我把它加进去');
});

test('派单后只是问进度：前台直接回答，不去打扰工人', async () => {
  const config = makeConfig();
  const { relay, agents } = build(config, {
    desk: [
      { text: '【回复客户】好，我开工\n【派单】做首页' },
      { text: '【回复客户】做到一半了，刚写完样式' },
    ],
  });
  await relay.handleIncoming(msg('开始吧'));
  const before = agents.calls.filter((c) => c.kind === 'inject').length;
  const res = await relay.handleIncoming(msg('做到哪了', { msg_id: 'm9' }));
  const after = agents.calls.filter((c) => c.kind === 'inject').length;
  assert.strictEqual(after, before, '问进度不该给工人插话');
  assert.strictEqual(res.reply, '做到一半了，刚写完样式');
});

test('派单后问进度：前台按真实工程状态回答，不去打扰工人', async () => {
  const config = makeConfig();
  const { relay, agents } = build(config, {
    desk: [
      { text: '【回复客户】开工了\n【派单】做首页' },
      { text: '【回复客户】现在第 3 步，刚在写页面' },
    ],
  });
  await relay.handleIncoming(msg('开始吧'));
  const st = agents.states.get('ord-20261121-001');
  st.running = true; st.step = 3; st.lastTool = 'pwsh';
  const res = await relay.handleIncoming(msg('做到哪了', { msg_id: 'm3' }));
  const deskCall = agents.calls.filter((c) => c.kind === 'desk').pop();
  assert.ok(deskCall.prompt.includes('工程当前状态'), '前台任务单要带工程状态');
  assert.ok(/正在做（第 3 步/.test(deskCall.prompt), '状态里要有真实步骤：' + deskCall.prompt.slice(0, 200));
  assert.strictEqual(res.reply, '现在第 3 步，刚在写页面');
});

test('重复 msg_id 只处理一次', async () => {
  const config = makeConfig();
  const { relay, agents } = build(config, { desk: [{ text: '【回复客户】好' }] });
  const body = msg('在吗', { msg_id: 'dup-1' });
  await relay.handleIncoming(body);
  const second = await relay.handleIncoming(body);
  assert.strictEqual(second.action, 'ignore');
  assert.strictEqual(agents.calls.length, 1);
});

test('前台轮失败给兜底话术', async () => {
  const config = makeConfig();
  const { relay } = build(config, { desk: [{ ok: false, error: 'MISSING_CREDENTIAL' }] });
  const res = await relay.handleIncoming(msg('在吗'));
  assert.strictEqual(res.ok, true);
  assert.ok(res.reply.length > 0);
});

test('confirmMode=owner 时派单被拦下', async () => {
  const config = makeConfig({ orders: { confirmMode: 'owner', maxReplyChars: 1200, bubbleChars: 180 } });
  const { relay, agents, store } = build(config, { desk: [{ text: '【回复客户】我确认下\n【派单】做首页' }] });
  const res = await relay.handleIncoming(msg('开始吧'));
  assert.ok(!agents.calls.some((c) => c.kind === 'start'), '老板没确认就不许开工');
  assert.strictEqual(store.api.loadOrder('ord-20261121-001').status, 'intake');
  assert.strictEqual(res.reply, '我确认下');
});

test('老板 #确认 把订单推进到 working', async () => {
  const config = makeConfig({ owner: { chatId: 'wxid_boss', paused: false } });
  const { relay, store } = build(config, { desk: [{ text: '【回复客户】好' }] });
  await relay.handleIncoming(msg('在吗', { chat_id: 'wxid_a' }));
  const res = await relay.handleIncoming(msg('#确认 ord-20261121-001', { chat_id: 'wxid_boss', msg_id: 'x1' }));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(store.api.loadOrder('ord-20261121-001').status, 'working');
});

test('暂停时一律忽略', async () => {
  const config = makeConfig({ owner: { chatId: '', paused: true } });
  const { relay, agents } = build(config, {});
  const res = await relay.handleIncoming(msg('在吗'));
  assert.strictEqual(res.action, 'ignore');
  assert.strictEqual(agents.calls.length, 0);
});

test('群聊里没 @ 我就不插嘴；私聊 at_me=false 也要回', async () => {
  const config = makeConfig();
  const { relay } = build(config, { desk: [{ text: '【回复客户】在的' }] });
  const quiet = await relay.handleIncoming(msg('随便说说', { chat_type: 'group', at_me: false }));
  assert.strictEqual(quiet.action, 'ignore');
  const loud = await relay.handleIncoming(msg('@机器人 在吗', { chat_type: 'group', at_me: true, msg_id: 'g2' }));
  assert.strictEqual(loud.action, 'reply');
  const priv = await relay.handleIncoming(msg('私聊', { chat_type: 'private', at_me: false, msg_id: 'p1' }));
  assert.strictEqual(priv.action, 'reply');
});

test('回复拆成多条气泡', async () => {
  const longReply = '【回复客户】' + '这一句用来占位置。'.repeat(30);
  const config = makeConfig();
  const { relay } = build(config, { desk: [{ text: longReply }] });
  const res = await relay.handleIncoming(msg('讲讲方案'));
  assert.ok(Array.isArray(res.bubbles));
  assert.ok(res.bubbles.length > 1);
  assert.ok(res.bubbles.every((b) => b.length <= 180));
});

test('没派单却宣称完成 -> 拦下换话术', async () => {
  const config = makeConfig();
  const { relay } = build(config, { desk: [{ text: '【回复客户】好了，已经建好了' }] });
  const res = await relay.handleIncoming(msg('建个文件'));
  assert.ok(!/已经建好/.test(res.reply), '不许把虚报发给客户');
});

test('同一会话串行处理', async () => {
  const config = makeConfig();
  const { relay, agents } = build(config, { desk: [{ text: '【回复客户】一' }, { text: '【回复客户】二' }] });
  await Promise.all([relay.handleIncoming(msg('一')), relay.handleIncoming(msg('二'))]);
  assert.strictEqual(agents.calls.filter((c) => c.kind === 'desk').length, 2);
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); console.log('PASS ' + t.name); }
    catch (err) { failed += 1; console.log('FAIL ' + t.name + ' :: ' + err.message); }
  }
  process.exitCode = failed ? 1 : 0;
  console.log(failed ? ('FAILED ' + failed) : 'ALL PASS');
})();
