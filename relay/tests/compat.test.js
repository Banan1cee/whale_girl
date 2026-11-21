'use strict';

// 逐文件跑：node relay/tests/compat.test.js
// 覆盖 relay/lib/compat.js 对桥接真实调用点的响应形状。全部是纯函数调用，不起端口、
// 不读文件、不依赖真实模型。

const assert = require('node:assert');

const { createCompat } = require('../lib/compat');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function handleFor(config) {
  return createCompat({ config }).handle;
}

function request(handle, patch) {
  return handle({
    method: 'POST',
    path: '/',
    query: {},
    body: {},
    headers: {},
    ...(patch || {}),
  });
}

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = before;
    else delete process.env[name];
  }
}

// ---------------------------------------------------------------------------
// healthz：bridge/config.py wait_for_server 只认 GET /healthz + 三字段全齐
// ---------------------------------------------------------------------------

test('healthz：GET 返回 200 且 ok/up/service 三字段齐全', () => {
  const res = request(handleFor({}), { method: 'GET', path: '/healthz' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, up: true, service: 'whale-girl' });
  // 字段类型也要严格：桥接用的是 === true / === 'whale-girl'
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.up, true);
  assert.strictEqual(res.json.service, 'whale-girl');
});

test('healthz：末尾斜杠也认', () => {
  const res = request(handleFor({}), { method: 'GET', path: '/healthz/' });
  assert.equal(res.status, 200);
  assert.equal(res.json.service, 'whale-girl');
});

test('healthz：POST 不认领（交给 server.js 404/405）', () => {
  assert.strictEqual(request(handleFor({}), { method: 'POST', path: '/healthz' }), null);
});

// ---------------------------------------------------------------------------
// 不认领的路径
// ---------------------------------------------------------------------------

test('未知路径一律返回 null（不越权认领）', () => {
  const handle = handleFor({});
  for (const path of ['/', '/api/status', '/api/chat', '/api/wechat/contacts', '/webhook/wechat', '/webhook', '/api/careless']) {
    assert.strictEqual(request(handle, { method: 'GET', path }), null, path + ' 不该被 compat 认领');
    assert.strictEqual(request(handle, { method: 'POST', path }), null, path + ' 不该被 compat 认领');
  }
});

test('POST /webhook/wechat 不认领：回复必须由 relay.js 产生', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/webhook/wechat',
    body: { chat_id: 'u1', text: '在吗' },
  });
  assert.strictEqual(res, null);
});

// ---------------------------------------------------------------------------
// 唯一的发送闸门：/api/wechat/send-permission
// ---------------------------------------------------------------------------

test('send-permission：默认 allowed=true', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/api/wechat/send-permission',
    body: { chatId: 'wxid_a', name: '阿螈' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, allowed: true });
});

test('send-permission：config.owner.paused=true 时 allowed=false', () => {
  const res = request(handleFor({ owner: { paused: true } }), {
    method: 'POST',
    path: '/api/wechat/send-permission',
    body: { chatId: 'wxid_a', name: '阿螈' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.strictEqual(res.json.allowed, false);
  assert.equal(res.json.reason, 'paused');
});

test('send-permission：owner.paused 兼容手写的 "true"/1，"false" 不算暂停', () => {
  const allowedOf = (paused) => request(handleFor({ owner: { paused } }), {
    method: 'POST',
    path: '/api/wechat/send-permission',
    body: { chatId: 'c', name: 'n' },
  }).json.allowed;
  assert.strictEqual(allowedOf('true'), false);
  assert.strictEqual(allowedOf('1'), false);
  assert.strictEqual(allowedOf(1), false);
  assert.strictEqual(allowedOf('false'), true, '"false" 不能被当成真值');
  assert.strictEqual(allowedOf(0), true);
  assert.strictEqual(allowedOf(undefined), true);
});

test('send-permission：RELAY_PAUSED 每次调用现读，不缓存', () => {
  const handle = handleFor({ owner: { paused: false } });
  const call = () => request(handle, { method: 'POST', path: '/api/wechat/send-permission', body: { chatId: 'c', name: 'n' } });

  assert.strictEqual(call().json.allowed, true);
  withEnv('RELAY_PAUSED', '1', () => {
    assert.strictEqual(call().json.allowed, false, 'RELAY_PAUSED=1 必须立刻生效');
  });
  withEnv('RELAY_PAUSED', 'true', () => {
    assert.strictEqual(call().json.allowed, false, 'RELAY_PAUSED=true 也必须生效');
  });
  assert.strictEqual(call().json.allowed, true, '环境变量撤掉后必须立刻恢复');
  withEnv('RELAY_PAUSED', '0', () => {
    assert.strictEqual(call().json.allowed, true, 'RELAY_PAUSED=0 不算暂停');
  });
  withEnv('RELAY_PAUSED', 'false', () => {
    assert.strictEqual(call().json.allowed, true, 'RELAY_PAUSED=false 不算暂停');
  });
});

test('send-permission：暂停不挡心跳等其它接口', () => {
  const handle = handleFor({ owner: { paused: true } });
  const hb = request(handle, { method: 'POST', path: '/api/bridge/heartbeat', body: { platform: 'wechat' } });
  assert.equal(hb.status, 200);
  assert.strictEqual(hb.json.ok, true);
  const due = request(handle, { method: 'GET', path: '/api/reminders/due' });
  assert.equal(due.status, 200);
  assert.deepEqual(due.json.items, []);
});

// ---------------------------------------------------------------------------
// bridgeToken：桥接专用接口的鉴权
// ---------------------------------------------------------------------------

test('bridgeToken：配置后缺 token / token 错一律 403', () => {
  const handle = handleFor({ bridgeToken: 'bridge-secret' });
  for (const headers of [{}, { 'x-bot-token': 'wrong' }, { 'x-bot-signature': 'wrong' }]) {
    const res = request(handle, {
      method: 'POST',
      path: '/api/wechat/send-permission',
      body: { chatId: 'c', name: 'n' },
      headers,
    });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.strictEqual(res.json.ok, false);
  }
});

test('bridgeToken：header / 查询参数 / 请求体三处任一命中即可', () => {
  const handle = handleFor({ bridgeToken: 'bridge-secret' });
  const byHeader = request(handle, {
    method: 'POST',
    path: '/api/wechat/send-permission',
    body: { chatId: 'c', name: 'n' },
    headers: { 'X-Bot-Token': 'bridge-secret' },
  });
  assert.equal(byHeader.status, 200);
  const byQuery = request(handle, {
    method: 'POST',
    path: '/api/bridge/heartbeat',
    query: { token: 'bridge-secret' },
    body: {},
  });
  assert.equal(byQuery.status, 200);
  const byBody = request(handle, {
    method: 'POST',
    path: '/api/wechat/contacts/sync',
    body: { token: 'bridge-secret', account: 'wxid_me', items: [] },
  });
  assert.equal(byBody.status, 200);
});

test('bridgeToken：vision / care/due 不要求 token（桥接本来就不带）', () => {
  const handle = handleFor({ bridgeToken: 'bridge-secret' });
  const vision = request(handle, { method: 'POST', path: '/api/vision', body: { image: 'x' } });
  assert.equal(vision.status, 200);
  assert.strictEqual(vision.json.ok, false);
  const due = request(handle, { method: 'GET', path: '/api/care/due' });
  assert.equal(due.status, 200);
  assert.strictEqual(due.json.due, false);
  const care = request(handle, { method: 'GET', path: '/api/care' });
  assert.equal(care.status, 200);
  assert.equal(care.json.text, '');
});

// ---------------------------------------------------------------------------
// 心跳 / 联系人 / 视觉
// ---------------------------------------------------------------------------

test('heartbeat：200 + ok，且带内核形状的 online/serverTime', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/api/bridge/heartbeat',
    body: { platform: 'wechat', uia: true, listener: true },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.online, true);
  assert.equal(typeof res.json.serverTime, 'number');
});

test('contacts/sync：count 按 items 计算，account 原样回传', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/api/wechat/contacts/sync',
    body: { account: 'wxid_me', at: 1700000000000, items: [{ wxid: 'a' }, { wxid: 'b' }, { wxid: 'c' }] },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.equal(res.json.count, 3);
  assert.equal(res.json.account, 'wxid_me');
  assert.equal(res.json.updatedAt, 1700000000000);
});

test('contacts/sync：items 缺失/非法时按 0 条处理，不抛', () => {
  const handle = handleFor({});
  for (const body of [{}, { items: 'oops' }, { items: null }, { account: 42 }]) {
    const res = request(handle, { method: 'POST', path: '/api/wechat/contacts/sync', body });
    assert.equal(res.status, 200);
    assert.equal(res.json.count, 0);
  }
});

test('vision：关闭态返回 200 + ok:false（不得 500），桥接走占位/跳过', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/api/vision',
    body: { image: 'base64...', mime: 'image/jpeg', prompt: '' },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, false);
  assert.equal(res.json.error, 'vision disabled');
});

// ---------------------------------------------------------------------------
// care（关闭态）
// ---------------------------------------------------------------------------

test('care/due：due:false + reason:disabled，桥接只读这两个字段', () => {
  const res = request(handleFor({}), {
    method: 'GET',
    path: '/api/care/due',
    query: { last: '0', sentToday: '0', active: 'wxid_a,wxid_b' },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.due, false);
  assert.equal(res.json.reason, 'disabled');
  assert.strictEqual(res.json.target, null);
});

test('GET /api/care：text 为空串（桥接据此不发）', () => {
  const res = request(handleFor({}), { method: 'GET', path: '/api/care', query: { chat: 'wxid_a' } });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.text, '');
});

test('care/sent：回传恒 ok（不落库）', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/api/care/sent',
    body: { id: 'abc', chat: 'wxid_a', text: '在干啥', group: false },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, true);
});

// ---------------------------------------------------------------------------
// reminders（关闭态）
// ---------------------------------------------------------------------------

test('reminders/due：items 空数组 + nextDueAt 数字（桥接据此睡 30 秒）', () => {
  const res = request(handleFor({}), { method: 'GET', path: '/api/reminders/due' });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.ok(Array.isArray(res.json.items));
  assert.equal(res.json.items.length, 0);
  assert.strictEqual(res.json.nextDueAt, 0);
  assert.equal(typeof res.json.now, 'number');
});

test('reminders/ack：返回 ok:true', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/api/reminders/ack',
    body: { id: 'r1', ok: true, error: '' },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, true);
});

test('reminders/permission：未启用插件提醒 → ok:false', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/api/reminders/permission',
    body: { id: 'r1' },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, false);
});

// ---------------------------------------------------------------------------
// moments（关闭态）
// ---------------------------------------------------------------------------

test('moments/claim：job:null（桥接每 5 秒问一次，必须稳定 200）', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/api/moments/claim',
    body: { account: 'wxid_me' },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.job, null);
});

test('moments/publish-gate：allowed:false', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/api/moments/publish-gate',
    body: { id: 'j1', account: 'wxid_me' },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.allowed, false);
});

test('moments/complete：ok:true', () => {
  const res = request(handleFor({}), {
    method: 'POST',
    path: '/api/moments/complete',
    body: { id: 'j1', account: 'wxid_me', error: '' },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, true);
});

// ---------------------------------------------------------------------------
// stickers（关闭态）
// ---------------------------------------------------------------------------

test('stickers/gate：ok + enabled:false + jobs 空数组（桥接要求这几个字段都在）', () => {
  const res = request(handleFor({}), {
    method: 'GET',
    path: '/api/stickers/gate',
    query: { id: '' },
  });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.enabled, false);
  assert.equal(typeof res.json.generation, 'string');
  assert.deepEqual(res.json.jobs, []);
});

test('stickers/pending：items 空数组', () => {
  const res = request(handleFor({}), { method: 'GET', path: '/api/stickers/pending' });
  assert.equal(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.deepEqual(res.json.items, []);
});

test('stickers/claim|ack|cancel：item:null（走关闭分支，不会误发）', () => {
  const handle = handleFor({});
  for (const path of ['/api/stickers/claim', '/api/stickers/ack', '/api/stickers/cancel']) {
    const res = request(handle, { method: 'POST', path, body: { id: 's1' } });
    assert.equal(res.status, 200, path);
    assert.strictEqual(res.json.ok, true, path);
    assert.strictEqual(res.json.item, null, path);
  }
});

// ---------------------------------------------------------------------------
// 关闭功能的前缀兜底：任何未列出的子路径也必须 200 JSON，绝不 500/404
// ---------------------------------------------------------------------------

test('关闭功能前缀：未知子路径与方法都给 200 + {ok:true}', () => {
  const handle = handleFor({});
  const samples = [
    ['GET', '/api/care'],
    ['POST', '/api/care/whatever'],
    ['GET', '/api/moments/latest'],
    ['POST', '/api/stickers/upload'],
    ['GET', '/api/stickers/status'],
    ['GET', '/api/reminders'],
    ['POST', '/api/reminders/cancel'],
    ['DELETE', '/api/moments/feed'],
  ];
  for (const [method, path] of samples) {
    const res = request(handle, { method, path, body: {} });
    assert.ok(res, method + ' ' + path + ' 应被前缀兜底认领');
    assert.equal(res.status, 200, method + ' ' + path);
    assert.strictEqual(res.json.ok, true, method + ' ' + path);
  }
});

// ---------------------------------------------------------------------------
// 契约汇总：所有被认领的路径都必须是 200 + 可 JSON 序列化；不出现 500
// ---------------------------------------------------------------------------

test('汇总：全部契约路径都 200、ok:true（除 vision 的 ok:false），且可序列化', () => {
  const handle = handleFor({ bridgeToken: 't' });
  const headers = { 'x-bot-token': 't' };
  const calls = [
    ['GET', '/healthz', undefined, {}],
    ['POST', '/api/wechat/send-permission', { chatId: 'c', name: 'n' }, headers],
    ['POST', '/api/bridge/heartbeat', { platform: 'wechat' }, headers],
    ['POST', '/api/wechat/contacts/sync', { account: 'a', items: [] }, headers],
    ['POST', '/api/vision', { image: 'x' }, {}],
    ['GET', '/api/care/due', undefined, {}],
    ['GET', '/api/care', undefined, {}],
    ['POST', '/api/care/sent', { id: 'x' }, headers],
    ['GET', '/api/reminders/due', undefined, headers],
    ['POST', '/api/reminders/ack', { id: 'x', ok: true }, headers],
    ['POST', '/api/reminders/permission', { id: 'x' }, headers],
    ['POST', '/api/moments/claim', { account: 'a' }, headers],
    ['POST', '/api/moments/publish-gate', { id: 'x', account: 'a' }, headers],
    ['POST', '/api/moments/complete', { id: 'x', account: 'a' }, headers],
    ['GET', '/api/stickers/gate', undefined, headers],
    ['GET', '/api/stickers/pending', undefined, headers],
    ['POST', '/api/stickers/claim', { id: 'x' }, headers],
    ['POST', '/api/stickers/ack', { id: 'x' }, headers],
    ['POST', '/api/stickers/cancel', { id: 'x' }, headers],
  ];
  for (const [method, path, body, hdrs] of calls) {
    const res = request(handle, { method, path, body: body || {}, headers: hdrs || {} });
    assert.ok(res, path + ' 必须被认领');
    assert.equal(res.status, 200, path + ' 状态码');
    assert.equal(typeof res.json, 'object', path + ' 必须是 JSON 对象');
    assert.notEqual(res.status, 500, path + ' 不得 500');
    // vision 与「插件提醒授权」在关闭态下必须显式 ok:false，其余一律 ok:true。
    const expectedOk = path === '/api/vision' || path === '/api/reminders/permission' ? false : true;
    assert.strictEqual(res.json.ok, expectedOk, path + ' ok 字段');
    assert.doesNotThrow(() => JSON.stringify(res.json), path + ' 必须可序列化');
  }
});

// ---------------------------------------------------------------------------
// 输入形态容错：query / body 的两种来源（server.js 与测试）
// ---------------------------------------------------------------------------

test('query 既认 URLSearchParams 也认普通对象', () => {
  const handle = handleFor({});
  const asParams = request(handle, {
    method: 'GET',
    path: '/api/stickers/gate',
    query: new URLSearchParams({ id: 's1' }),
  });
  assert.equal(asParams.status, 200);
  const asObject = request(handle, { method: 'GET', path: '/api/care/due', query: { last: '1' } });
  assert.equal(asObject.status, 200);
});

test('body 既认已解析对象也认 JSON 字符串', () => {
  const handle = handleFor({});
  const parsed = request(handle, {
    method: 'POST',
    path: '/api/wechat/contacts/sync',
    body: JSON.stringify({ account: 'a', items: [{ wxid: 'x' }] }),
  });
  assert.equal(parsed.json.count, 1);
  const bad = request(handle, {
    method: 'POST',
    path: '/api/wechat/contacts/sync',
    body: '{not json',
  });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.count, 0);
});

test('畸形输入不得抛异常（path/method/headers/query/body 各种空值）', () => {
  const handle = handleFor({});
  const weird = [
    {},
    { method: undefined, path: undefined },
    { method: 'get', path: 'healthz' },
    { method: 'GET', path: '/healthz', headers: null, query: null, body: null },
    { method: 'POST', path: '/api/vision', body: [] },
    { method: 'POST', path: '/api/vision', body: 42 },
    { method: 'POST', path: '/api/wechat/send-permission', body: 'null' },
    { method: 'GET', path: '/api/care/due', query: 'a=1' },
    { method: 'GET', path: '' },
  ];
  for (const req of weird) {
    assert.doesNotThrow(() => handle(req), JSON.stringify(req));
    const res = handle(req);
    if (res) {
      assert.ok(Number.isInteger(res.status));
      assert.equal(typeof res.json, 'object');
    }
  }
  // 小写 method + 少斜杠的 healthz 也应该能认（桥接永远发 GET /healthz，这里只是容错）
  const lower = handle({ method: 'get', path: 'healthz' });
  assert.equal(lower.status, 200);
});

test('纯函数：同一输入重复调用结果一致，不共享可变对象', () => {
  const handle = handleFor({});
  const a = request(handle, { method: 'GET', path: '/api/care/due' });
  const b = request(handle, { method: 'GET', path: '/api/care/due' });
  assert.deepEqual(a.json, b.json);
  assert.notStrictEqual(a.json, b.json, '不应把同一个对象返回给两处调用方');
  a.json.due = true;
  assert.strictEqual(b.json.due, false);
});

// ---------------------------------------------------------------------------

let failed = 0;
for (const item of tests) {
  try {
    item.fn();
    console.log('PASS ' + item.name);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + item.name);
    console.error('  ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : String(err)));
  }
}
console.log('');
console.log((tests.length - failed) + '/' + tests.length + ' passed' + (failed ? '，' + failed + ' failed' : ''));
if (failed) process.exitCode = 1;
