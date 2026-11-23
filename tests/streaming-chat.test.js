'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStreamingChat } = require('../src/services/streamingChat');
const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

// 有界等待：上游卡住时让测试失败，而不是把进程挂死。
function within(promise, ms = 5000, label = 'wait') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bounded wait timeout: ' + label)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Bot 的公开结果 seam：流式与非流式共用 finishReply / finishFailure。
function fakeBot(overrides = {}) {
  return {
    decide: async () => ({ action: 'reply', reason: 'fixture', msg: { text: 'hi' }, ...overrides.decision }),
    async *generate() { yield 'hello'; yield ' world'; },
    transformPluginReply: async (_decision, text) => text.trim(),
    finalize: (_decision, text) => [text],
    async finishReply(decision, text) {
      const clean = await this.transformPluginReply(decision, String(text == null ? '' : text).trim());
      const bubbles = this.finalize(decision, clean);
      return { text: bubbles.length ? clean : '', bubbles, reason: decision.reason };
    },
    finishFailure: () => ({ action: 'reply', reply: 'friendly', bubbles: ['friendly'], reason: 'llm_error', error: true }),
    ...overrides,
  };
}

test('流式聊天适配器输出稳定的 meta、规范化增量与完成协议', async () => {
  const events = [];
  for await (const event of createStreamingChat(fakeBot())({ chatType: 'private', senderName: '测试' })) events.push(event);
  assert.equal(events[0].type, 'meta');
  assert.equal(events[0].reason, 'fixture');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'hello world');
  assert.equal(events.at(-1).text, 'hello world');
  assert.deepEqual(events.at(-1).bubbles, ['hello world']);
});

test('meta 在上游仍未结束时先下发，原始增量不提前泄露', async () => {
  let release; let entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const bot = fakeBot({ async *generate() { entered(); await barrier; yield 'hello'; } });
  const events = [];
  const stream = createStreamingChat(bot)({ chatType: 'private', senderName: '测试' });
  const first = await within(stream.next(), 5000, 'meta');
  events.push(first.value);
  const pending = stream.next();
  await within(reached, 5000, 'upstream reached');
  assert.equal(events.filter(event => event.type === 'meta').length, 1);
  assert.equal(events.filter(event => event.type === 'delta').length, 0, 'delta 只发规范化后的最终正文');
  release();
  for (let step = await within(pending, 5000, 'complete'); !step.done; step = await stream.next()) events.push(step.value);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).text, 'hello');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'hello');
});

test('done 保留对用户可见的字段（stickerCategory / separateText）', async () => {
  const bot = fakeBot();
  const original = bot.decide;
  bot.decide = async () => ({ ...(await original()), stickerCategory: '开心', separateText: true });
  const events = [];
  for await (const event of createStreamingChat(bot)({ chatType: 'private', senderName: '测试' })) events.push(event);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.stickerCategory, '开心');
  assert.equal(done.separateText, true);
});

test('流式聊天对忽略和判定异常维持非流式早退语义', async () => {
  const ignored = [];
  for await (const event of createStreamingChat(fakeBot({ decision: { action: 'ignore', reason: 'not_addressed' } }))({ chatType: 'group' })) ignored.push(event);
  assert.deepEqual(ignored, [{ type: 'ignore', reason: 'not_addressed' }]);
  const errors = [];
  for await (const event of createStreamingChat(fakeBot({ decide: async () => { throw Error('private details'); } }), { error: () => {} })({ chatType: 'private' })) errors.push(event);
  assert.deepEqual(errors, [{ type: 'decision_error' }]);
});

test('判定阶段被取消时零事件收尾，不把取消记成 decision_error', async () => {
  const abort = new AbortController();
  const bot = fakeBot({ decide: async () => { abort.abort(); throw Object.assign(new Error('aborted'), { code: 'capability_aborted' }); } });
  const events = [];
  for await (const event of createStreamingChat(bot, { error: () => {} })({ chatType: 'private' }, { signal: abort.signal })) events.push(event);
  assert.deepEqual(events, []);
});

test('全接管返回无效结果时按真实故障收尾', async () => {
  const events = [];
  const errors = [];
  const stream = createStreamingChat({}, { error: message => errors.push(message) }, { takeOver: () => true, handle: async () => undefined });
  for await (const event of stream({ chatType: 'private' })) events.push(event);
  assert.deepEqual(events, [{ type: 'decision_error' }]);
  assert.equal(errors.length, 1);
});

test('流式聊天遵守取消，不再生成或提交迟到结果', async () => {
  let generated = false;
  const bot = fakeBot({ async *generate() { generated = true; yield 'late'; } });
  const abort = new AbortController(); abort.abort();
  const events = [];
  for await (const event of createStreamingChat(bot)({ chatType: 'private' }, { signal: abort.signal })) events.push(event);
  assert.deepEqual(events, []);
  assert.equal(generated, false);
});

test('请求开始前已取消时零事件且不进入判定', async () => {
  let decided = 0;
  const bot = fakeBot({ decide: async () => { decided += 1; return { action: 'reply', reason: 'fixture', msg: { text: 'hi' } }; } });
  const abort = new AbortController(); abort.abort();
  const events = [];
  for await (const event of createStreamingChat(bot)({ chatType: 'private' }, { signal: abort.signal })) events.push(event);
  assert.deepEqual(events, [], 'pre-aborted SSE must not emit meta/ignore');
  assert.equal(decided, 0, 'pre-aborted SSE must not call decide');
});

test('全接管流式只下发宿主治理后的正文、气泡与可见标记', async () => {
  const calls = [];
  const handle = async (message, options) => {
    calls.push({ message, options });
    return {
      action: 'reply', reply: '治理后正文', bubbles: ['治理后的', '两个气泡'], reason: 'plugin',
      mention: '阿螈', separateText: true, stickerCategory: '开心',
    };
  };
  const message = { chatType: 'group', chatId: 'grp', senderName: '群友' };
  const events = [];
  for await (const event of createStreamingChat({}, null, { takeOver: () => true, handle })(message)) events.push(event);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, message);
  assert.equal(events[0].type, 'meta');
  assert.equal(events[0].reason, 'plugin');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), '治理后正文');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, '治理后正文');
  assert.deepEqual(done.bubbles, ['治理后的', '两个气泡'], '气泡以宿主治理结果为准，不按原始正文重切');
  assert.equal(done.mention, '阿螈');
  assert.equal(done.separateText, true);
  assert.equal(done.stickerCategory, '开心');
});

test('全接管遇到宿主已处理结果时保留 command/reason/mock', async () => {
  const hostResult = {
    action: 'reply', reply: '宿主结果', bubbles: ['宿主结果'], reason: 'command',
    commandType: 'admin_spell', mock: true,
  };
  const events = [];
  for await (const event of createStreamingChat({}, null, { takeOver: () => true, handle: async () => hostResult })({ chatType: 'private' })) {
    events.push(event);
  }
  assert.equal(events[0].type, 'meta');
  assert.equal(events[0].reason, 'command');
  assert.equal(events[0].commandType, 'admin_spell');
  assert.equal(events[0].mock, true);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.reason, 'command');
  assert.equal(done.commandType, 'admin_spell');
  assert.deepEqual(done.bubbles, ['宿主结果']);
});

test('全接管的取消零事件、拒绝只发 ignore', async () => {
  const cancelled = [];
  const handleCancelled = async () => ({ cancelled: true, action: 'ignore', reason: 'cancelled' });
  for await (const event of createStreamingChat({}, null, { takeOver: () => true, handle: handleCancelled })({ chatType: 'private' })) {
    cancelled.push(event);
  }
  assert.deepEqual(cancelled, [], '排队/断线取消不能产出 meta 或 ignore 事件');

  const rejected = [];
  const handleRejected = async () => ({ action: 'ignore', reason: 'burst_limit' });
  for await (const event of createStreamingChat({}, null, { takeOver: () => true, handle: handleRejected })({ chatType: 'private' })) {
    rejected.push(event);
  }
  assert.deepEqual(rejected, [{ type: 'ignore', reason: 'burst_limit' }]);
});

test('全接管请求开始前已取消时不调用接管入口', async () => {
  let called = 0;
  const abort = new AbortController();
  abort.abort();
  const events = [];
  const stream = createStreamingChat({}, null, {
    takeOver: () => true,
    handle: async () => { called += 1; return { action: 'reply', reply: 'late' }; },
  });
  for await (const event of stream({ chatType: 'private' }, { signal: abort.signal })) events.push(event);
  assert.deepEqual(events, []);
  assert.equal(called, 0);
});

function makeTakeoverBot() {
  const config = structuredClone(DEFAULT_CONFIG);
  // 关闭随机补表情：否则纯标点可能被宿主补一个 emoji 气泡，就不再是「无正文」的用例。
  config.chat.emojiChance = 1e-9;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-takeover-quota-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
    logger: null, mockChunkDelayMs: 0,
  });
  return {
    bot,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    },
  };
}

test('全接管结果阶段：取消与空回复不占配额，正常回复走一次普通提交', () => {
  const { bot, cleanup } = makeTakeoverBot();
  try {
    const msg = {
      platform: 'wechat', chatId: 'takeover-quota', chatType: 'private',
      senderId: 'wxid_someone', senderName: '路人甲', text: '在吗', msgId: 'tq-1',
    };
    const key = bot.sessionKey(msg);
    const abort = new AbortController();
    abort.abort();

    assert.deepEqual(
      bot.finishTakeoverReply(msg, { action: 'reply', reply: '迟到回复' }, { signal: abort.signal }),
      { cancelled: true, action: 'ignore', reason: 'cancelled' },
    );
    assert.deepEqual(
      bot.finishTakeoverReply(msg, { action: 'reply', reply: '   ' }),
      { action: 'ignore', reason: 'empty_reply' },
    );
    // 纯标点会被气泡清理整条丢掉：清理后没有可发正文，也不能留下助手记录。
    assert.deepEqual(
      bot.finishTakeoverReply(msg, { action: 'reply', reply: '。' }),
      { action: 'ignore', reason: 'empty_reply' },
    );
    assert.equal(bot.store.messages(key, 10).filter(row => row.role === 'assistant').length, 0,
      '清理后没有气泡的接管回复不能落库');
    assert.equal(bot._replyQuota.pending.size, 0, '取消/空回复不能留下租约');
    assert.equal(bot._replyQuota.committed.size, 0, '取消/空回复不能提交配额');

    const replied = bot.finishTakeoverReply(msg, { action: 'reply', reply: '好的' });
    assert.equal(replied.action, 'reply');
    assert.equal(replied.reason, 'plugin');
    assert.equal(replied.reply, '好的');
    assert.equal(replied.bubbles[0], '好的');
    assert.equal(bot._replyQuota.pending.size, 0, '提交后租约必须归还');
    assert.equal(bot._replyQuota.committed.get(key).length, 1);
    assert.equal(bot.store.messages(key, 10).filter(row => row.role === 'assistant').length, 1);
  } finally {
    cleanup();
  }
});
