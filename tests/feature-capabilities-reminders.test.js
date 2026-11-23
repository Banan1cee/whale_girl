'use strict';

/**
 * 提醒 / 表情包 / 日记 / 汇总 四个域接入统一通信层（宿主能力）的验收。
 *
 * 这里验证三件事：
 *   1. 能力名确实登记在 pluginProtocolRegistry.json（defineHost 不拒绝）；
 *   2. handler 只做字段清洗与形状映射，业务判断仍在服务层；
 *   3. 路由把业务调用交给 invokeHost，响应体与改造前逐字段一致。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createFeatureCapabilities } = require('../src/services/features');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const registry = require('../src/services/pluginProtocolRegistry.json');

const registerReminders = require('../src/http/routes/reminders');
const registerStickers = require('../src/http/routes/stickers');
const registerDiary = require('../src/http/routes/diary');
const registerDigest = require('../src/http/routes/digest');
const { startServer } = require('../server');

const CAPABILITIES = [
  'reminders.rules@1', 'reminders.enqueue@1', 'reminders.due@1', 'reminders.ack@1', 'reminders.permission@1',
  'stickers.enqueue@1', 'stickers.gate@1', 'stickers.pending@1', 'stickers.claim@1', 'stickers.ack@1',
  'stickers.cancel@1', 'diary.generate@1', 'diary.read@1', 'digest.status@1',
];

/* ------------------------------ 夹具 ------------------------------ */

function captureRes() {
  return {
    destroyed: false,
    writableEnded: false,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); },
    end(body) { this.body = body === undefined ? undefined : JSON.parse(body); this.writableEnded = true; },
  };
}

function captureRouter() {
  const handler = { fn: null };
  const router = {
    pattern: (_regex, fn) => { handler.fn = fn; },
  };
  return { router, handler };
}

function localReq(method, url) {
  const req = new EventEmitter();
  Object.assign(req, {
    method,
    url,
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return req;
}

// readBody 监听 data/end；先拿住 handler 的 Promise，再喂请求体。
function withBody(req, body) {
  const emit = () => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  };
  return { emit };
}

function reminderService(overrides = {}) {
  const service = {
    items: [],
    rules: () => ({ enabled: true, dailyCap: 5, quietAfterMinutes: 30, sentToday: 2 }),
    list: () => [{ id: 'r1', wxid: 'wxid_a', text: '开会', dueAt: 1, status: 'pending' }],
    enqueueNow: input => ({ id: 'queued-1', dueAt: 2, status: 'pending', kind: input.kind }),
    due: () => [{ id: 'r1', status: 'sending' }],
    nextDueAt: () => 12345,
    ack: (id, options) => ({ ok: true, item: { id, status: options.ok ? 'done' : 'failed', error: '', text: '' } }),
    pluginAllowed: item => item.id === 'allowed',
    ...overrides,
  };
  return service;
}

function stickerService() {
  const calls = [];
  const service = {
    generation: 'gen-1',
    requireEnabled() { calls.push(['requireEnabled']); },
    gate: id => { calls.push(['gate', id]); return { ok: true, enabled: true, generation: 'gen-1', jobs: [] }; },
    enqueue: (emotion, chat) => { calls.push(['enqueue', emotion, chat]); return { id: 'job-1', status: 'queued' }; },
    pending: () => { calls.push(['pending']); return [{ id: 'job-1' }]; },
    claim: id => { calls.push(['claim', id]); return { id, status: 'sending' }; },
    ack: (id, status, error) => { calls.push(['ack', id, status, error]); return { id, status }; },
    cancelReserved: (id, generation, chatUsername) => { calls.push(['cancelReserved', id, generation, chatUsername]); return { id, status: 'cancelled' }; },
  };
  return { service, calls };
}

function diaryService() {
  const calls = [];
  const service = {
    status: () => ({ status: 'idle', message: '尚未生成日记', file: '' }),
    generate: () => { calls.push(['generate']); return Promise.resolve('saved'); },
    readForChat: token => {
      calls.push(['readForChat', token]);
      if (token === '2026-11-22') return '【2026-11-22】\n今天的正文';
      return null;
    },
  };
  return { service, calls };
}

function digestService() {
  const calls = [];
  const service = {
    status: () => ({ status: 'running', message: '正在整理…', range: 'today', text: '', stats: null }),
    generate: range => { calls.push(['generate', range]); return Promise.resolve('done'); },
  };
  return { service, calls };
}

/* ------------------------------ 能力登记 ------------------------------ */

test('四个域的新增能力都在注册表里，能被 defineHost 接受', () => {
  const runtime = {
    config: {},
    reminders: reminderService(),
    stickerService: stickerService().service,
    diary: diaryService().service,
    digest: digestService().service,
  };
  const handlers = createFeatureCapabilities(runtime);
  const dispatcher = new UnifiedCapabilityDispatcher({
    plugins: { installed: () => [], invoke: async () => { throw new Error('unused'); }, isApproved: () => true },
  });
  for (const name of CAPABILITIES) {
    assert.equal(typeof handlers[name], 'function', name + ' 没实现');
    assert.ok(registry.calls[name], name + ' 没在 registry.calls 里');
    dispatcher.defineHost(name, handlers[name]);
  }
});

/* ------------------------------ 提醒 ------------------------------ */

test('提醒规则：dailyCap 映射成启动器用的 maxPerDay，字段集合保持四个', () => {
  const handlers = createFeatureCapabilities({ reminders: reminderService() });
  assert.deepEqual(handlers['reminders.rules@1']({}), {
    rules: { enabled: true, maxPerDay: 5, quietAfterMinutes: 30, sentToday: 2 },
  });
});

test('提醒入队：清洗字段后交给 enqueueNow，返回队列 id/dueAt/status', () => {
  const seen = [];
  const service = reminderService({
    enqueueNow: input => {
      seen.push(input);
      return { id: 'queued-9', dueAt: 77, status: 'pending' };
    },
  });
  const handlers = createFeatureCapabilities({ reminders: service });
  const out = handlers['reminders.enqueue@1']({
    chatId: 'wxid_' + 'x'.repeat(300),
    name: '昵称',
    chatType: 'group',
    text: '日记正文\n第二行',
    kind: 'diary',
    delivery: 'voice',
  });
  assert.deepEqual(out, { id: 'queued-9', dueAt: 77, status: 'pending' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].wxid.length, 120, '超长 chatId 必须截断，不能整段落盘');
  assert.equal(seen[0].chatType, 'group');
  assert.equal(seen[0].delivery, 'voice');
  assert.equal(seen[0].kind, 'diary');
  assert.equal(seen[0].text, '日记正文\n第二行', '正文允许换行，不能被压成一行');
});

test('提醒领取：一次返回 items/nextDueAt/now', () => {
  const handlers = createFeatureCapabilities({ reminders: reminderService() });
  const before = Date.now();
  const out = handlers['reminders.due@1']({});
  assert.deepEqual(out.items, [{ id: 'r1', status: 'sending' }]);
  assert.equal(out.nextDueAt, 12345);
  assert.ok(out.now >= before);
});

test('提醒回执：失败载荷（ok/error/statusCode）原样带回，路由据此挑状态码', () => {
  const service = reminderService({
    ack: () => ({ ok: false, error: '找不到这条提醒', statusCode: 404 }),
  });
  const handlers = createFeatureCapabilities({ reminders: service });
  assert.deepEqual(handlers['reminders.ack@1']({ id: 'nope', ok: true }), {
    ok: false, error: '找不到这条提醒', statusCode: 404,
  });
});

test('提醒回执：ok 只认布尔真值，uncertain 只认严格 true', () => {
  const seen = [];
  const service = reminderService({
    ack: (id, options) => { seen.push([id, options]); return { ok: true, item: { id } }; },
  });
  const handlers = createFeatureCapabilities({ reminders: service });
  handlers['reminders.ack@1']({ id: 'r1', ok: 'yes', error: '超时', uncertain: 'true' });
  handlers['reminders.ack@1']({ id: 'r2', ok: 0, uncertain: true });
  assert.deepEqual(seen[0], ['r1', { ok: true, error: '超时', uncertain: false }]);
  assert.deepEqual(seen[1], ['r2', { ok: false, error: '', uncertain: true }]);
});

test('提醒权限：只有 kind=plugin 且 sending 且授权仍在才回答 ok', () => {
  const allowed = { id: 'allowed', kind: 'plugin', status: 'sending' };
  const service = reminderService({ items: [allowed, { id: 'ordinary', kind: 'diary', status: 'sending' }, { id: 'pending', kind: 'plugin', status: 'pending' }] });
  const handlers = createFeatureCapabilities({ reminders: service });
  assert.deepEqual(handlers['reminders.permission@1']({ id: 'allowed' }), { ok: true });
  assert.deepEqual(handlers['reminders.permission@1']({ id: 'ordinary' }), { ok: false });
  assert.deepEqual(handlers['reminders.permission@1']({ id: 'pending' }), { ok: false });
  assert.deepEqual(handlers['reminders.permission@1']({ id: 'missing' }), { ok: false });
});

/* ------------------------------ 表情包 ------------------------------ */

test('表情包能力：gate/pending/claim/ack/cancel 各自转给服务层并包成命名键', () => {
  const { service, calls } = stickerService();
  const handlers = createFeatureCapabilities({ config: {}, stickerService: service });
  assert.deepEqual(handlers['stickers.gate@1']({ id: 'job-1' }),
    { gate: { ok: true, enabled: true, generation: 'gen-1', jobs: [] } });
  assert.deepEqual(handlers['stickers.pending@1']({}), { items: [{ id: 'job-1' }] });
  assert.deepEqual(handlers['stickers.claim@1']({ id: 'job-1' }), { item: { id: 'job-1', status: 'sending' } });
  assert.deepEqual(handlers['stickers.ack@1']({ id: 'job-1', status: 'failed', error: '目标未打开' }),
    { item: { id: 'job-1', status: 'failed' } });
  assert.deepEqual(handlers['stickers.cancel@1']({ id: 'job-1', generation: 'gen-1', chatUsername: 'peer' }),
    { item: { id: 'job-1', status: 'cancelled' } });
  assert.deepEqual(calls, [
    ['gate', 'job-1'], ['pending'], ['claim', 'job-1'],
    ['ack', 'job-1', 'failed', '目标未打开'], ['cancelReserved', 'job-1', 'gen-1', 'peer'],
  ]);
});

test('表情包排队：emotion/chat 清洗后交给 enqueue', () => {
  const { service, calls } = stickerService();
  const handlers = createFeatureCapabilities({ config: {}, stickerService: service });
  const out = handlers['stickers.enqueue@1']({ emotion: 'cute', chat: '文件传输助手' });
  assert.deepEqual(out, { queued: { id: 'job-1', status: 'queued' } });
  assert.deepEqual(calls.at(-1), ['enqueue', 'cute', '文件传输助手']);
});

test('表情包错误：服务层带 statusCode 的拒绝不在能力层被吞或改写', () => {
  const { service } = stickerService();
  service.claim = () => { throw Object.assign(new Error('任务已领取、取消或过期，不能重复发送'), { statusCode: 409 }); };
  const handlers = createFeatureCapabilities({ config: {}, stickerService: service });
  assert.throws(() => handlers['stickers.claim@1']({ id: 'job-1' }), { statusCode: 409 });
});

/* ------------------------------ 日记 ------------------------------ */

test('日记状态与生成：生成只触发不等待，状态同步返回（启动器据此立刻 202）', () => {
  const { service, calls } = diaryService();
  service.status = () => ({ status: 'running', message: '正在生成日记…', file: '' });
  const handlers = createFeatureCapabilities({ diary: service });
  const out = handlers['diary.generate@1']({});
  assert.deepEqual(out.status, { status: 'running', message: '正在生成日记…', file: '' });
  assert.equal(calls.filter(call => call[0] === 'generate').length, 1);
  assert.deepEqual(handlers['diary.status@1']({}), { status: { status: 'running', message: '正在生成日记…', file: '' } });
});

test('日记读取：命中时拆出日期与正文，读不到返回 found=false 而不是抛错', () => {
  const { service } = diaryService();
  const handlers = createFeatureCapabilities({ diary: service });
  assert.deepEqual(handlers['diary.read@1']({ day: '2026-11-22' }),
    { day: '2026-11-22', text: '今天的正文', found: true });
  assert.deepEqual(handlers['diary.read@1']({ day: '2020-01-01' }),
    { day: '2020-01-01', text: '', found: false });
  assert.deepEqual(handlers['diary.read@1']({}), { day: 'latest', text: '', found: false });
});

test('日记读取：day 参数超长时截断后再交给读接口', () => {
  const { service, calls } = diaryService();
  service.readForChat = token => { calls.push(['readForChat', token]); return null; };
  const handlers = createFeatureCapabilities({ diary: service });
  handlers['diary.read@1']({ day: 'x'.repeat(200) });
  assert.equal(calls.at(-1)[1].length, 40);
});

/* ------------------------------ 汇总 ------------------------------ */

test('汇总状态：返回完整服务状态快照', () => {
  const { service } = digestService();
  const handlers = createFeatureCapabilities({ digest: service });
  assert.deepEqual(handlers['digest.status@1']({}), {
    status: { status: 'running', message: '正在整理…', range: 'today', text: '', stats: null },
  });
});

/* ------------------------------ 路由：提醒 ------------------------------ */

function reminderRoute(runtime) {
  const { router, handler } = captureRouter();
  registerReminders(router);
  return { handler: handler.fn, runtime };
}

test('路由 /api/reminders：列表体字段不变，规则来自能力', async () => {
  const invoked = [];
  const service = reminderService();
  const runtime = {
    reminders: service,
    capabilities: {
      invokeHost: async (name, input) => { invoked.push({ name, input }); return { rules: { enabled: true, maxPerDay: 5, quietAfterMinutes: 30, sentToday: 2 } }; },
    },
    logger: { info() {} },
  };
  const { handler } = reminderRoute(runtime);
  const res = captureRes();
  await handler(runtime, localReq('GET', '/api/reminders'), res, { pathname: '/api/reminders', method: 'GET', url: new URL('http://x/api/reminders') });
  assert.deepEqual(invoked, [{ name: 'reminders.rules@1', input: {} }]);
  assert.deepEqual(res.body, {
    ok: true,
    items: [{ id: 'r1', wxid: 'wxid_a', text: '开会', dueAt: 1, status: 'pending' }],
    rules: { enabled: true, maxPerDay: 5, quietAfterMinutes: 30, sentToday: 2 },
  });
});

test('路由 /api/reminders/due：响应仍带 items/nextDueAt/now，且先过桥接 token', async () => {
  const invoked = [];
  const runtime = {
    reminders: reminderService(),
    gateways: new Map([['wechat', { verifyToken: () => true }]]),
    capabilities: {
      invokeHost: async (name) => {
        invoked.push(name);
        return { items: [{ id: 'r1' }], nextDueAt: 12345, now: 999 };
      },
    },
    logger: { info() {} },
  };
  const { handler } = reminderRoute(runtime);
  const res = captureRes();
  await handler(runtime, localReq('GET', '/api/reminders/due'), res, { pathname: '/api/reminders/due', method: 'GET', url: new URL('http://x/api/reminders/due') });
  assert.deepEqual(invoked, ['reminders.due@1']);
  assert.deepEqual(res.body, { ok: true, items: [{ id: 'r1' }], nextDueAt: 12345, now: 999 });
});

test('路由 /api/reminders/due：没有桥接 token 时不碰能力', async () => {
  const invoked = [];
  const runtime = {
    reminders: reminderService(),
    gateways: new Map([['wechat', { verifyToken: () => false }]]),
    capabilities: { invokeHost: async name => { invoked.push(name); return {}; } },
    logger: { info() {} },
  };
  const { handler } = reminderRoute(runtime);
  const res = captureRes();
  await handler(runtime, localReq('GET', '/api/reminders/due'), res, { pathname: '/api/reminders/due', method: 'GET', url: new URL('http://x/api/reminders/due') });
  assert.deepEqual(invoked, []);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { ok: false, error: '桥接 token 不正确' });
});

test('路由 /api/reminders/ack：能力返回的失败载荷照原样写出（含 statusCode）', async () => {
  const runtime = {
    reminders: reminderService(),
    gateways: new Map([['wechat', { verifyToken: () => true }]]),
    capabilities: { invokeHost: async () => ({ ok: false, error: '找不到这条提醒', statusCode: 404 }) },
    logger: { info() {} },
  };
  const { handler } = reminderRoute(runtime);
  const req = localReq('POST', '/api/reminders/ack');
  const res = captureRes();
  const pending = handler(runtime, req, res, { pathname: '/api/reminders/ack', method: 'POST', url: new URL('http://x/api/reminders/ack') });
  withBody(req, { id: 'nope', ok: true }).emit();
  await pending;
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { ok: false, error: '找不到这条提醒', statusCode: 404 });
});

test('路由 /api/reminders/permission：仍返回 {ok:boolean}', async () => {
  const invoked = [];
  const runtime = {
    reminders: reminderService(),
    gateways: new Map([['wechat', { verifyToken: () => true }]]),
    capabilities: { invokeHost: async (name, input) => { invoked.push({ name, input }); return { ok: true }; } },
    logger: { info() {} },
  };
  const { handler } = reminderRoute(runtime);
  const req = localReq('POST', '/api/reminders/permission');
  const res = captureRes();
  const pending = handler(runtime, req, res, { pathname: '/api/reminders/permission', method: 'POST', url: new URL('http://x/api/reminders/permission') });
  withBody(req, { id: 'p1' }).emit();
  await pending;
  assert.deepEqual(invoked, [{ name: 'reminders.permission@1', input: { id: 'p1' } }]);
  assert.deepEqual(res.body, { ok: true });
});

test('路由 /api/reminders：没有能力分发器时直接跑同一份 handler（夹具/裁剪装配）', async () => {
  const runtime = { reminders: reminderService(), logger: { info() {} } };
  const { handler } = reminderRoute(runtime);
  const res = captureRes();
  await handler(runtime, localReq('GET', '/api/reminders'), res, { pathname: '/api/reminders', method: 'GET', url: new URL('http://x/api/reminders') });
  assert.deepEqual(res.body.rules, { enabled: true, maxPerDay: 5, quietAfterMinutes: 30, sentToday: 2 });
  assert.equal(res.body.ok, true);
});

/* ------------------------------ 路由：表情包 ------------------------------ */

function stickerRoute(runtime) {
  const { router, handler } = captureRouter();
  registerStickers(router);
  return { handler: handler.fn, runtime };
}

function stickerRuntime(capabilities) {
  const { service, calls } = stickerService();
  const runtime = {
    config: {},
    stickerService: service,
    gateways: new Map([['wechat', { verifyToken: () => true }]]),
    logger: { info() {}, warn() {} },
    capabilities,
  };
  return { runtime, calls, service };
}

test('路由 /api/stickers/gate：业务调用走能力，响应体仍是服务层的 gate 载荷', async () => {
  const invoked = [];
  const { runtime } = stickerRuntime({
    invokeHost: async (name, input) => {
      invoked.push({ name, input });
      return { gate: { ok: true, enabled: true, generation: 'gen-1', jobs: [] } };
    },
  });
  const { handler } = stickerRoute(runtime);
  const res = captureRes();
  await handler(runtime, localReq('GET', '/api/stickers/gate?id=job-1'), res,
    { pathname: '/api/stickers/gate', method: 'GET', url: new URL('http://x/api/stickers/gate?id=job-1') });
  assert.deepEqual(invoked, [{ name: 'stickers.gate@1', input: { id: 'job-1' } }]);
  assert.deepEqual(res.body, { ok: true, enabled: true, generation: 'gen-1', jobs: [] });
});

test('路由 /api/stickers/pending：列表体不变，不直接调服务层', async () => {
  const { runtime, service } = stickerRuntime({
    invokeHost: async () => ({ items: [{ id: 'job-1' }] }),
  });
  service.pending = () => { throw new Error('路由不该再直接调 pending'); };
  const { handler } = stickerRoute(runtime);
  const res = captureRes();
  await handler(runtime, localReq('GET', '/api/stickers/pending'), res,
    { pathname: '/api/stickers/pending', method: 'GET', url: new URL('http://x/api/stickers/pending') });
  assert.deepEqual(res.body, { ok: true, items: [{ id: 'job-1' }] });
});

test('路由 /api/stickers/test：chat 默认值仍由路由决定，再交给能力排队', async () => {
  const invoked = [];
  const { runtime } = stickerRuntime({
    invokeHost: async (name, input) => { invoked.push({ name, input }); return { queued: { id: 'job-1' } }; },
  });
  runtime.config.sticker = { testChat: '配置里的测试会话' };
  const { handler } = stickerRoute(runtime);
  const req = localReq('POST', '/api/stickers/test');
  const res = captureRes();
  const pending = handler(runtime, req, res, { pathname: '/api/stickers/test', method: 'POST', url: new URL('http://x/api/stickers/test') });
  withBody(req, { emotion: 'cute' }).emit();
  await pending;
  assert.deepEqual(invoked, [{ name: 'stickers.enqueue@1', input: { emotion: 'cute', chat: '配置里的测试会话' } }]);
  assert.deepEqual(res.body, { ok: true, queued: { id: 'job-1' } });
});

test('路由 /api/stickers/claim：能力拒绝时状态码沿用原来的 409', async () => {
  const { runtime } = stickerRuntime({
    invokeHost: async () => { throw Object.assign(new Error('任务已领取、取消或过期，不能重复发送'), { statusCode: 409 }); },
  });
  const { handler } = stickerRoute(runtime);
  const req = localReq('POST', '/api/stickers/claim');
  const res = captureRes();
  const pending = handler(runtime, req, res, { pathname: '/api/stickers/claim', method: 'POST', url: new URL('http://x/api/stickers/claim') });
  withBody(req, { id: 'job-1' }).emit();
  await assert.rejects(pending, { statusCode: 409 });
});

/* ------------------------------ 路由：日记 ------------------------------ */

function diaryRoute(runtime) {
  const routes = {};
  registerDiary({ get: (path, fn) => { routes[path] = fn; }, post: (path, fn) => { routes[path] = fn; } });
  return { routes, runtime };
}

test('路由 /api/diary：状态走能力，200 体仍以 status 平铺', async () => {
  const invoked = [];
  const { service } = diaryService();
  const runtime = {
    diary: service,
    capabilities: { invokeHost: async (name) => { invoked.push(name); return { status: { status: 'done', message: '已保存', file: '2026/11-22.md' } }; } },
  };
  const { routes } = diaryRoute(runtime);
  const res = captureRes();
  await routes['/api/diary'](runtime, localReq('GET', '/api/diary'), res);
  assert.deepEqual(invoked, ['diary.status@1']);
  assert.deepEqual(res.body, { ok: true, status: 'done', message: '已保存', file: '2026/11-22.md' });
});

test('路由 /api/diary/generate：能力返回后写出 202；夹具路径同样走分发器', async () => {
  const { service, calls } = diaryService();
  service.status = () => ({ status: 'running', message: '正在生成日记…', file: '' });
  const runtime = { diary: service };
  const { routes } = diaryRoute(runtime);
  const res = captureRes();
  // 没有注入 capabilities 时由 features/hostCall 就地组装 dispatcher：
  // 校验路径与生产一致，只是异步一档，因此这里等它写完响应。
  await routes['/api/diary/generate'](runtime, localReq('POST', '/api/diary/generate'), res);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, status: 'running', message: '正在生成日记…', file: '' });
  assert.equal(calls.filter(call => call[0] === 'generate').length, 1);
});

/* ------------------------------ 路由：汇总 ------------------------------ */

function digestRoute(runtime) {
  const routes = {};
  registerDigest({ get: (path, fn) => { routes[path] = fn; }, post: (path, fn) => { routes[path] = fn; } });
  return { routes, runtime };
}

test('路由 /api/digest/generate：范围清洗后触发后台生成，202 带当前状态', async () => {
  const invoked = [];
  const { service, calls } = digestService();
  const runtime = {
    digest: service,
    logger: { warn() {} },
    capabilities: {
      invokeHost: async (name, input) => {
        invoked.push({ name, input });
        if (name === 'digest.generate@1') return { status: 'done' };
        return { status: { status: 'running', message: '正在整理…', range: 'today', text: '', stats: null } };
      },
    },
  };
  const { routes } = digestRoute(runtime);
  const req = localReq('POST', '/api/digest/generate');
  const res = captureRes();
  const pending = routes['/api/digest/generate'](runtime, req, res);
  withBody(req, { range: 'last-year' }).emit();
  await pending;
  assert.deepEqual(invoked, [{ name: 'digest.generate@1', input: { range: 'today' } }, { name: 'digest.status@1', input: {} }]);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, status: 'running', message: '正在整理…', range: 'today', text: '', stats: null });
  assert.equal(calls.length, 0, '生产路径不应直接调 digest.generate');
});

test('路由 /api/digest：没有能力分发器时仍用同一份 handler 读状态', async () => {
  const { service } = digestService();
  const runtime = { digest: service, logger: { warn() {} } };
  const { routes } = digestRoute(runtime);
  const res = captureRes();
  await routes['/api/digest'](runtime, localReq('GET', '/api/digest'), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, status: 'running', message: '正在整理…', range: 'today', text: '', stats: null });
});

/* ------------------------------ 端到端：真装配走 dispatcher ------------------------------ */

test('真装配：四个域的路由都经 runtime.capabilities 返回原有响应体', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-feature-capabilities-'));
  const server = await startServer({ root, port: 0, host: '127.0.0.1',
    env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  assert.equal(typeof server.runtime.capabilities.invokeHost, 'function', '生产装配必须挂上宿主能力分发器');

  const get = async (p) => {
    const res = await fetch(server.url + p);
    return { status: res.status, body: await res.json() };
  };
  const post = async (p, body) => {
    const res = await fetch(server.url + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json() };
  };

  const list = await get('/api/reminders');
  assert.equal(list.status, 200);
  assert.equal(list.body.ok, true);
  assert.deepEqual(list.body.items, []);
  assert.deepEqual(Object.keys(list.body.rules).sort(),
    ['enabled', 'maxPerDay', 'quietAfterMinutes', 'sentToday']);

  const diary = await get('/api/diary');
  assert.equal(diary.status, 200);
  assert.equal(diary.body.ok, true);
  assert.equal(typeof diary.body.status, 'string');
  assert.equal('enabled' in diary.body, true, 'diary.status@1 必须透出完整状态');

  const generated = await post('/api/diary/generate', {});
  assert.equal(generated.status, 202);
  assert.equal(generated.body.ok, true);
  assert.equal(typeof generated.body.status, 'string');

  const digest = await get('/api/digest');
  assert.equal(digest.status, 200);
  assert.equal(digest.body.ok, true);
  assert.equal(typeof digest.body.status, 'string');

  const digestStart = await post('/api/digest/generate', { range: 'yesterday' });
  assert.equal(digestStart.status, 202);
  assert.equal(digestStart.body.ok, true);
});
