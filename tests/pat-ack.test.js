'use strict';

/**
 * 拍一拍执行回执链（BUGS #128）：
 *   内核占额度 → 桥接拍完 POST /api/pat/ack → 内核按结果落账 / 回滚，
 *   并把这一笔记进动作账本，让模型下一轮知道自己到底拍没拍到。
 *
 * 这里测三件事：
 *   1. 回执接口的鉴权、路由和幂等（认不出的单号不算成功）；
 *   2. 网关把内核给的回执单号带给桥接（只拍、拍 + 正文两种返回形态）；
 *   3. 动作账本能认 `pat` 类型，并渲染成提示词里的一行事实。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = process.env.WHALE_ROOT || path.resolve(__dirname, '..');
const requireApp = (rel) => require(path.join(ROOT, rel));

const { Gateway } = requireApp('src/adapters/gateway');
const { Bot } = requireApp('src/pipeline/chat');
const actionEvents = requireApp('src/core/events');

const registerPatRoutes = requireApp('src/http/routes/pat.js');

const TOKEN = 'bridge-token-for-test';

function capturePatRoute() {
  let pattern = null;
  let handler = null;
  registerPatRoutes({ pattern(re, fn) { pattern = re; handler = fn; } });
  return { pattern, handler };
}

const PAT_ROUTE = capturePatRoute();

function makeRuntime({ bot } = {}) {
  const gateway = { verifyToken: (req, body) => (req.headers['x-bot-token'] === TOKEN) || (body && body.token === TOKEN) };
  return {
    bot: bot || { settlePat: () => false },
    gateways: new Map([['wechat', gateway]]),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

async function callPatRoute(runtime, { ip = '127.0.0.1', method = 'POST', headers = {}, body = {}, pathname = '/api/pat/ack' } = {}) {
  const req = new EventEmitter();
  req.socket = { remoteAddress: ip };
  req.method = method;
  req.headers = headers;
  req.url = pathname;
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead(code) { this.status = code; },
    end(payload) { this.body = payload; this.writableEnded = true; },
  };
  const pending = PAT_ROUTE.handler(runtime, req, res, { pathname, method, params: {} });
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  await pending;
  return { status: res.status, json: JSON.parse(res.body) };
}

test('回执路由：只允许本机', async () => {
  const out = await callPatRoute(makeRuntime(), { ip: '10.0.0.9', headers: { 'x-bot-token': TOKEN }, body: { patId: 'pat-1', ok: true } });
  assert.strictEqual(out.status, 403);
  assert.match(out.json.error, /本机/);
});

test('回执路由：桥接 token 不对直接拒绝', async () => {
  const out = await callPatRoute(makeRuntime(), { headers: { 'x-bot-token': 'wrong' }, body: { patId: 'pat-1', ok: true } });
  assert.strictEqual(out.status, 403);
  assert.match(out.json.error, /token/);
});

test('回执路由：非 POST 不放行', async () => {
  const out = await callPatRoute(makeRuntime(), { method: 'GET', headers: { 'x-bot-token': TOKEN } });
  assert.strictEqual(out.status, 404);
});

test('回执路由：把结果交给内核，认不出的单号不算成功', async () => {
  const calls = [];
  const runtime = makeRuntime({ bot: { settlePat: (patId, ok, reason) => { calls.push({ patId, ok, reason }); return patId === 'pat-1'; } } });
  const hit = await callPatRoute(runtime, {
    headers: { 'x-bot-token': TOKEN },
    body: { patId: 'pat-1', ok: false, reason: 'no_friend_row' },
  });
  assert.deepStrictEqual(hit.json, { ok: true, settled: true });
  assert.deepStrictEqual(calls[0], { patId: 'pat-1', ok: false, reason: 'no_friend_row' });

  const miss = await callPatRoute(runtime, { headers: { 'x-bot-token': TOKEN }, body: { patId: 'pat-unknown', ok: true } });
  assert.deepStrictEqual(miss.json, { ok: true, settled: false }, '过期的单号不能假装落账成功');
});

function fakeStoreBot() {
  const events = [];
  const bot = Object.create(Bot.prototype);
  Object.assign(bot, {
    config: { chat: {}, persona: { name: '鲸鲸' }, features: { pat: true }, pat: { cooldownSec: 0, maxPerHour: 2 } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store: { appendEvent: (key, event) => events.push({ key, event }) },
    _patBudget: new Map(),
    _patPending: new Map(),
  });
  return { bot, events };
}

test('端到端：内核占额度 → 桥接回执失败 → 额度回滚 + 动作账本写 failed', async () => {
  const { bot, events } = fakeStoreBot();
  const early = { platform: 'wechat', chatType: 'private', chatId: 'wxid_a', senderName: '测试好友' };
  const t0 = Date.now();
  const patId = bot.reservePat(early, t0);
  assert.strictEqual(bot._patBudget.get('wxid_a').count, 1);

  const out = await callPatRoute(makeRuntime({ bot }), {
    headers: { 'x-bot-token': TOKEN },
    body: { chatId: 'wxid_a', patId, ok: false, reason: 'chat_not_opened' },
  });
  assert.deepStrictEqual(out.json, { ok: true, settled: true });
  assert.strictEqual(bot._patBudget.get('wxid_a').count, 0, '没拍到就不能扣额度');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].key, 'wechat:u:wxid_a');
  assert.strictEqual(events[0].event.type, 'pat');
  assert.strictEqual(events[0].event.status, 'failed');
  assert.ok(events[0].event.detail.includes('测试好友'));
  assert.ok(events[0].event.detail.includes('chat_not_opened'));
});

test('端到端：回执成功 → 额度保留 + 动作账本记为已尝试', async () => {
  const { bot, events } = fakeStoreBot();
  const early = { platform: 'wechat', chatType: 'private', chatId: 'wxid_b', senderName: '测试好友' };
  const patId = bot.reservePat(early, Date.now());
  const out = await callPatRoute(makeRuntime({ bot }), {
    headers: { 'x-bot-token': TOKEN },
    body: { patId, ok: true, reason: 'sent' },
  });
  assert.strictEqual(out.json.settled, true);
  assert.strictEqual(bot._patBudget.get('wxid_b').count, 1);
  assert.strictEqual(events[0].event.status, 'submitted');
  assert.strictEqual(events[0].event.detail, '测试好友');
});

test('网关把回执单号带给桥接（只拍不回话）', async () => {
  const bot = {
    config: { group: {}, wechat: {} },
    handle: async () => ({ action: 'pat', pat: true, patId: 'pat-abc-1', reason: 'pat_command' }),
  };
  const gw = new Gateway({ platform: 'wechat', options: { inboundToken: TOKEN }, bot, logger: null });
  const out = await gw.handleInbound({
    chat_id: 'wxid_a', chat_type: 'private', sender_id: 'wxid_a',
    senderName: '测试好友', text: '拍拍我',
  }, { local: true });
  assert.strictEqual(out.action, 'pat');
  assert.strictEqual(out.pat, true);
  assert.strictEqual(out.patId, 'pat-abc-1');
});

test('网关把回执单号带给桥接（拍 + 正文）', async () => {
  const bot = {
    config: { group: {}, wechat: {} },
    handle: async () => ({ action: 'reply', reply: '啪', bubbles: ['啪'], pat: true, patId: 'pat-abc-2', reason: 'pat' }),
  };
  const gw = new Gateway({ platform: 'wechat', options: { inboundToken: TOKEN }, bot, logger: null });
  const out = await gw.handleInbound({
    chat_id: 'wxid_a', chat_type: 'private', sender_id: 'wxid_a',
    senderName: '测试好友', text: '测试好友 在微信里拍了拍你', pat: true,
  }, { local: true });
  assert.strictEqual(out.action, 'reply');
  assert.strictEqual(out.pat, true);
  assert.strictEqual(out.patId, 'pat-abc-2');
});

test('没有回执单号时照旧执行拍一拍（兼容旧调用方，只是收不到结果）', async () => {
  const bot = {
    config: { group: {}, wechat: {} },
    handle: async () => ({ action: 'pat', pat: true, reason: 'pat_command' }),
  };
  const gw = new Gateway({ platform: 'wechat', options: { inboundToken: TOKEN }, bot, logger: null });
  const out = await gw.handleInbound({
    chat_id: 'wxid_a', chat_type: 'private', sender_id: 'wxid_a',
    senderName: '测试好友', text: '拍拍我',
  }, { local: true });
  assert.strictEqual(out.pat, true);
  assert.strictEqual(out.patId, undefined);
});

test('动作账本认识 pat 类型，并渲染成一行事实', () => {
  const clamped = actionEvents.clampEvent({ type: 'pat', detail: '测试好友', status: 'confirmed' });
  assert.ok(clamped, 'pat 必须是合法动作类型，否则模型永远看不见这一笔');
  assert.strictEqual(clamped.type, 'pat');

  const block = actionEvents.formatBlock([{ ts: Date.now(), type: 'pat', detail: '测试好友', status: 'confirmed' }]);
  assert.ok(block.includes('拍一拍'));
  assert.ok(block.includes('测试好友'));
  assert.ok(block.includes('微信结果未确认'));
  assert.ok(!block.includes('桥接确认发出'), '旧版点击回执不能被当成真正发出');

  const failed = actionEvents.formatBlock([{ ts: Date.now(), type: 'pat', detail: '测试好友（no_friend_row）', status: 'failed' }]);
  assert.ok(failed.includes('失败'), '没拍到要照实写失败，不能写成拍到了');
});
