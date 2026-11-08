'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MomentsService } = require('../src/services/moments');
const { momentsIntent, Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const register = require('../src/http/routes/moments');

test('朋友圈：读取结果保存为最近一次快照，重启后能回答主人', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-snapshot-'));
  try {
    const s = new MomentsService({ dir });
    assert.match(s.contextBlock(), /还没有读取/);
    const j = s.request({ limit: 2 });
    s.claim('test-account');
    s.complete({ id: j.id, account: 'test-account', items: [
      { nickname: 'Peer', text: '第一行\n第二行', create_time: 1700000000 },
    ] });

    const again = new MomentsService({ dir });
    const block = again.contextBlock();
    assert.match(block, /Peer/);
    assert.match(block, /第一行 第二行/);
    assert.match(block, /不是当前聊天/);
    assert.ok(!block.includes('test-account'));

    // 筛选没命中时不要把上一份快照清空
    const empty = again.request({ limit: 2, keyword: '没有这条' });
    again.claim('test-account');
    again.complete({ id: empty.id, account: 'test-account', items: [] });
    assert.match(again.contextBlock(), /Peer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('朋友圈：只有问到朋友圈时才注入快照上下文', () => {
  assert.equal(momentsIntent('今天朋友圈有什么'), true);
  assert.equal(momentsIntent('帮我看看谁发了动态'), true);
  assert.equal(momentsIntent('最近发了啥'), true);
  assert.equal(momentsIntent('今天吃什么'), false);
});

test('朋友圈：只有主人私聊问到才注入快照上下文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-chat-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: [], wxids: ['owner'] };
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const captured = {};
  const llm = {
    isMock: false, model: 'mock', reload() {}, describe() { return {}; },
    async complete({ system, turns }) { captured.system = system; captured.turns = turns; return '好'; },
  };
  const moments = { contextBlock: () => '【朋友圈快照】\n- Peer（2026-11-08 12:00）：春天来了' };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0, moments });
  const msg = (extra) => ({ platform: 'web', chatId: 'owner', chatType: 'private',
    senderId: 'owner', senderName: '主人', text: '今天朋友圈有什么', ...extra });
  try {
    const privateReply = await bot.decide(msg({}));
    assert.equal(privateReply.action, 'reply');
    assert.match(privateReply.turns.map((t) => t.content).join('\n'), /【朋友圈快照】/);
    assert.match(privateReply.turns.map((t) => t.content).join('\n'), /春天来了/);

    const groupReply = await bot.decide(msg({ chatId: 'g1', chatType: 'group', atMe: true }));
    assert.ok(groupReply.turns);
    assert.doesNotMatch(groupReply.turns.map((t) => t.content).join('\n'), /【朋友圈快照】/);

    const otherReply = await bot.decide(msg({ chatId: 'other', senderId: 'other', senderName: '别人' }));
    assert.ok(otherReply.turns);
    assert.doesNotMatch(otherReply.turns.map((t) => t.content).join('\n'), /【朋友圈快照】/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('朋友圈：自动点赞只处理安全候选，执行后不重复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-like-'));
  try {
    const s = new MomentsService({ dir, config: { moments: { autoLike: true, autoLikeMaxPerDay: 2 } } });
    const calls = [];
    let seen = [];
    s.judgeLikes = async (items) => { seen = items; return [{ id: 'ok', confidence: 0.95 }]; };
    s.action = (body) => { calls.push(body); return { id: 'job-' + calls.length }; };
    s.waitForJob = async () => ({ status: 'unconfirmed' });
    const job = {
      account: 'acct', query: {}, items: [
        { id: 'ok', nickname: 'Peer', text: '今天天气真好呀', own: false, likedByMe: false },
        { id: 'own', nickname: 'Me', text: '我自己的动态', own: true, likedByMe: false },
        { id: 'liked', nickname: 'Peer2', text: '已经点过赞的动态', own: false, likedByMe: true },
        { id: 'sad', nickname: 'Peer3', text: '家里有人去世了', own: false, likedByMe: false },
        { id: 'short', nickname: 'Peer4', text: '早安', own: false, likedByMe: false },
      ],
    };
    await s.autoLike(job);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, 'ok');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { action: 'like', publisher: 'Peer', keyword: '今天天气真好呀', account: 'acct' });
    assert.ok(s.state.liked.has('ok'));
    assert.equal(s.state.count, 1);

    await s.autoLike(job);
    assert.equal(calls.length, 1, '执行过的动态不能再自动点赞');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('朋友圈：自动点赞的关键词不带省略号，能匹配原正文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-like-kw-'));
  try {
    const s = new MomentsService({ dir, config: { moments: { autoLike: true, autoLikeMaxPerDay: 1 } } });
    let keyword = '';
    s.judgeLikes = async () => [{ id: 'long', confidence: 0.95 }];
    s.action = (body) => { keyword = body.keyword; return { id: 'job' }; };
    s.waitForJob = async () => ({ status: 'unconfirmed' });
    const text = '很长很长的动态正文'.repeat(5);
    await s.autoLike({ account: 'acct', query: {}, items: [
      { id: 'long', nickname: 'Peer', text, own: false, likedByMe: false },
    ] });
    assert.equal(keyword.length, 20);
    assert.ok(!keyword.includes('…'));
    assert.ok(text.includes(keyword));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('朋友圈：主人问起且快照过期时会先补读一次', async () => {
  const s = new MomentsService({ now: () => 700000 });
  s.latest = { savedAt: 0, items: [{ id: 'old', nickname: 'Peer', text: '旧动态' }] };
  let requested = 0;
  s.request = (body) => { requested++; assert.equal(body.limit, 20); return { id: 'job-refresh' }; };
  s.result = () => ({ status: 'done', items: [] });
  const out = await s.ensureFresh({ waitMs: 700 });
  assert.equal(out.ok, true);
  assert.equal(out.fresh, true);
  assert.equal(requested, 1);

  const fresh = new MomentsService({ now: () => 20000 });
  fresh.latest = { savedAt: 19000, items: [{ id: 'new', nickname: 'Peer', text: '刚读过' }] };
  fresh.request = () => { throw new Error('不该再读'); };
  const again = await fresh.ensureFresh({ waitMs: 700 });
  assert.equal(again.fresh, false);
});

test('朋友圈互动：完整定位、单次领取、仅报告未确认', () => {
  const s = new MomentsService();
  assert.throws(() => s.action({ action: 'comment', publisher: 'Peer', keyword: 'spring' }));
  const j = s.action({ action: 'like', publisher: 'Peer', keyword: 'spring' });
  assert.equal(s.claim('test-account').action, 'like');
  assert.equal(s.claim('test-account'), null);
  assert.equal(s.complete({ id: j.id, account: 'test-account', performed: true }).status, 'unconfirmed');
  assert.throws(() => s.action({ action: 'publish' }));
});

test('朋友圈：手动请求才产生任务；只领取一次且账号绑定', () => {
  const s = new MomentsService();
  assert.equal(s.claim('test-account'), null);
  const j = s.request({ keyword: '春天', own: true });
  assert.equal(j.status, 'queued');
  assert.equal(s.claim(''), null);
  assert.deepEqual(s.claim('test-account').query, { limit: 20, keyword: '春天', username: '', own: true });
  assert.equal(s.claim('test-account'), null);
  assert.throws(() => s.complete({ id: j.id, account: 'other', items: [] }), { statusCode: 409 });
  assert.equal(s.result(j.id).status, 'reading');
});

test('朋友圈：结果限量/白名单，路径/定位/评论不传回客户端', () => {
  const s = new MomentsService();
  const j = s.request({ limit: 1 });
  s.claim('test-account');
  const r = s.complete({ id: j.id, account: 'test-account', items: [
    { text: '测试', id: '1', location: 'private', path: 'secret', comments: ['secret'], images: ['secret'] },
    { text: '不返回' },
  ] });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].text, '测试');
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.throws(() => s.complete({ id: j.id, account: 'test-account', items: [] }), { statusCode: 409 });
});

test('朋友圈：账号钉住后其他桥接不能领走任务', () => {
  const s = new MomentsService();
  const j = s.request({ keyword: '春天', account: 'wxid-a' });
  assert.equal(s.claim('wxid-b'), null);
  assert.equal(s.claim('wxid-a').query.keyword, '春天');
  assert.equal(s.result(j.id).status, 'reading');
});

test('朋友圈：超时从桥接领取时开始算，不在请求时提前判死', () => {
  let now = 1000;
  const s = new MomentsService({ now: () => now });
  const j = s.request();
  now += 60000;
  assert.equal(s.claim('test-account').id, j.id);
  now += 60000;
  assert.equal(s.result(j.id).status, 'reading');
  now += 31000;
  assert.equal(s.result(j.id).status, 'failed');
});

test('朋友圈：正文保留换行，互动错误不再冒充读取错误', () => {
  const s = new MomentsService();
  const j = s.request({ limit: 1 });
  s.claim('test-account');
  const r = s.complete({ id: j.id, account: 'test-account', items: [{ text: '第一行\n第二行' }] });
  assert.equal(r.items[0].text, '第一行\n第二行');

  const a = s.action({ action: 'unlike', publisher: 'Peer', keyword: 'spring' });
  s.claim('test-account');
  const failed = s.complete({ id: a.id, account: 'test-account', error: 'cancel_not_found' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /取消点赞/);
  assert.doesNotMatch(failed.error, /读取失败/);
});

test('朋友圈：超时/过期结果不能污染新任务', () => {
  let now = 1000;
  const s = new MomentsService({ now: () => now });
  const a = s.request(); s.claim('test-account');
  assert.throws(() => s.request(), { statusCode: 409 });
  now += 91000;
  assert.equal(s.result(a.id).status, 'failed');
  const b = s.request();
  assert.throws(() => s.complete({ id: a.id, account: 'test-account', items: [] }), { statusCode: 404 });
  now += 301000;
  assert.throws(() => s.result(b.id), { statusCode: 404 });
  assert.equal(s.job, null);
});

test('朋友圈：限制扫描范围，错误不泄露内部异常', () => {
  const s = new MomentsService();
  for (const limit of [0, -1, 51, 1.5, 'abc']) assert.throws(() => s.request({ limit }), { statusCode: 400 });
  assert.throws(() => s.request(null), { statusCode: 400 });
  const j = s.request(); s.claim('test-account');
  const r = s.complete({ id: j.id, account: 'test-account', error: 'secret path' });
  assert.equal(r.status, 'failed');
  assert.ok(!r.error.includes('secret'));
});

test('朋友圈：所有接口限制本机，桥接写入必须验证 token', async () => {
  const routes = {};
  register({ get: (p, f) => { routes[p] = f; }, post: (p, f) => { routes[p] = f; } });
  const runtime = { moments: new MomentsService(), gateways: new Map([['wechat', { verifyToken: () => false }]]) };
  const remote = { socket: { remoteAddress: '192.0.2.1' } };
  for (const route of Object.values(routes)) {
    await assert.rejects(async () => route(runtime, remote), { statusCode: 403 });
  }
  for (const p of ['/api/moments/claim', '/api/moments/complete']) {
    await assert.rejects(async () => routes[p](runtime, { socket: { remoteAddress: '127.0.0.1' } }), { statusCode: 403 });
  }
});

test('朋友圈 HTTP 全链路：请求、鉴权领取、回传与读取', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { startServer } = require('../server');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-test-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    watchConfig: false, server: { openBrowser: false },
    gateway: { wechat: { enabled: true, inboundToken: 'test-moments-token' } },
  }));
  const app = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  const post = (route, body, token = '') => fetch(app.url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bot-token': token }, body: JSON.stringify(body),
  });
  try {
    const job = await (await post('/api/moments/read', { limit: 2 })).json();
    assert.equal(job.status, 'queued');
    assert.equal((await post('/api/moments/claim', { account: 'test-account' })).status, 403);
    const claimed = await (await post('/api/moments/claim', { account: 'test-account' }, 'test-moments-token')).json();
    assert.equal(claimed.job.id, job.id);
    const completed = await post('/api/moments/complete', { id: job.id, account: 'test-account', items: [{ text: '测试动态' }] }, 'test-moments-token');
    assert.equal(completed.status, 200);
    const result = await (await fetch(app.url + '/api/moments/result?id=' + job.id)).json();
    assert.equal(result.status, 'done');
    assert.equal(result.items[0].text, '测试动态');

    const settings = await (await fetch(app.url + '/api/moments/settings')).json();
    assert.equal(settings.ok, true);
    assert.equal(settings.autoLike, true);
    const patched = await (await fetch(app.url + '/api/moments/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoLike: false, autoReadEveryHours: 6 }),
    })).json();
    assert.equal(patched.autoLike, false);
    assert.equal(patched.autoReadEveryHours, 6);

    const latest = await (await fetch(app.url + '/api/moments/latest')).json();
    assert.equal(latest.snapshot.items[0].text, '测试动态');

    assert.equal((await fetch(app.url + '/healthz')).status, 200);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});
