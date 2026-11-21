'use strict';
// HTTP 入口联调：真 orders.js + 真 compat.js，只有 dsh 是假的。这里验证的是「桥接的发包形状能不能被接住」。

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');

const silent = { info() {}, warn() {}, error() {}, close() {} };

let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeConfig(over) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-srv-'));
  return Object.assign({
    stateRoot: root,
    deskCwd: path.join(root, 'desk'),
    ordersRoot: path.join(root, 'orders'),
    logPath: null,
    bridgeToken: '',
    desk: { timeoutMs: 1000, permissionMode: 'workspace-write', approvalPolicy: 'never' },
    worker: { timeoutMs: 1000, permissionMode: 'workspace-write', approvalPolicy: 'never' },
    orders: { confirmMode: 'frontdesk', maxReplyChars: 1200 },
    owner: { chatId: '', paused: false },
  }, over || {});
}

function fakeDsh(text) {
  return {
    runTurn: async () => ({
      ok: true, sessionId: 'desk-fake', text: text || '【回复客户】在的，想做什么项目？',
      reason: { kind: 'completed' }, events: [], timedOut: false, durationMs: 1, stderrTail: '', error: null,
    }),
  };
}

function start(config, dsh) {
  const built = createServer(config, { dsh: dsh || fakeDsh(), logger: silent });
  return new Promise((resolve) => {
    built.server.listen(0, '127.0.0.1', () => resolve({ port: built.server.address().port, built }));
  });
}

function call(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}, payload ? { 'content-length': payload.length } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (err) { json = null; }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('healthz 是桥接认的形状', async () => {
  const { port, built } = await start(makeConfig());
  const r = await call(port, 'GET', '/healthz');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true, up: true, service: 'whale-girl' });
  built.server.close();
});

test('webhook 回来就能发给客户的回复', async () => {
  const config = makeConfig();
  const { port, built } = await start(config);
  const r = await call(port, 'POST', '/webhook/wechat', {
    chat_id: 'wxid_c', text: '在吗', msg_id: 'm1', nickname: '客户', chat_type: 'private', at_me: true,
  }, { 'x-whale-bridge': '1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.action, 'reply');
  assert.strictEqual(r.json.reply, '在的，想做什么项目？');
  built.server.close();
});

test('webhook 之后订单目录与档案真的落盘', async () => {
  const config = makeConfig();
  const { port, built } = await start(config);
  await call(port, 'POST', '/webhook/wechat', { chat_id: 'wxid_d', text: '做个小程序', msg_id: 'm2' });
  const ordersDir = config.ordersRoot;
  const ids = fs.readdirSync(ordersDir).filter((x) => x !== 'index.json');
  assert.strictEqual(ids.length, 1, '应该只建一单：' + ids.join(','));
  const dir = path.join(ordersDir, ids[0]);
  assert.ok(fs.existsSync(path.join(dir, 'order.md')));
  assert.ok(fs.readFileSync(path.join(dir, 'order.md'), 'utf8').includes('【需求】'));
  assert.ok(fs.existsSync(path.join(dir, 'thread.md')));
  assert.ok(fs.existsSync(path.join(dir, 'events.jsonl')));
  built.server.close();
});

test('send-permission 默认放行，暂停时拒绝', async () => {
  const config = makeConfig();
  const { port, built } = await start(config);
  let r = await call(port, 'POST', '/api/wechat/send-permission', { chat_id: 'wxid_c' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.allowed, true);
  config.owner.paused = true;
  r = await call(port, 'POST', '/api/wechat/send-permission', { chat_id: 'wxid_c' });
  assert.strictEqual(r.json.allowed, false);
  built.server.close();
});

test('bridgeToken 配了就校验（桥接用 x-bot-token 头）', async () => {
  const config = makeConfig({ bridgeToken: 'secret-token' });
  const { port, built } = await start(config);
  const bad = await call(port, 'POST', '/webhook/wechat', { chat_id: 'wxid_c', text: '在吗', msg_id: 'm3' });
  assert.strictEqual(bad.status, 403);
  const good = await call(port, 'POST', '/webhook/wechat', { chat_id: 'wxid_c', text: '在吗', msg_id: 'm4' }, { 'x-bot-token': 'secret-token' });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.json.action, 'reply');
  built.server.close();
});

test('畸形 JSON 与非 JSON 请求体不炸 500', async () => {
  const { port, built } = await start(makeConfig());
  const bad = await call(port, 'POST', '/webhook/wechat', '{not json');
  assert.strictEqual(bad.status, 400);
  const ok = await call(port, 'POST', '/api/bridge/heartbeat', '{not json');
  assert.ok(ok.status < 500, '心跳不能 500：' + ok.status);
  built.server.close();
});

test('未知路径 404，且带 ok:false', async () => {
  const { port, built } = await start(makeConfig());
  const r = await call(port, 'GET', '/api/nope');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.ok, false);
  built.server.close();
});

test('沙箱自检：用户目录下支持，盘外不支持', () => {
  const { sandboxSupported } = require('../server');
  const os = require('os');
  const home = os.homedir();
  assert.strictEqual(sandboxSupported(home), true);
  assert.strictEqual(sandboxSupported(path.join(home, 'AppData', 'Local', 'wc-auto-accept-orders')), true);
  assert.strictEqual(sandboxSupported('D:/wc-auto-accept-orders/relay/state'), false);
  assert.strictEqual(sandboxSupported('C:/'), false);
});

test('缺少 chat_id 不报错，只忽略', async () => {
  const { port, built } = await start(makeConfig());
  const r = await call(port, 'POST', '/webhook/wechat', { text: '在吗' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, false);
  built.server.close();
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); console.log('PASS ' + t.name); }
    catch (err) { failed += 1; console.log('FAIL ' + t.name + ' :: ' + err.message); }
  }
  process.exitCode = failed ? 1 : 0;
  console.log(failed ? ('FAILED ' + failed) : 'ALL PASS');
})();
