'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = process.env.WHALE_ROOT || path.resolve(__dirname, '..');
const requireApp = (rel) => require(path.join(ROOT, rel));

const { stripPatMark } = requireApp('src/core/replyMarks');
const { normalizeInbound, Gateway } = requireApp('src/adapters/gateway');
const { Bot, PAT_COMMAND_RE } = requireApp('src/pipeline/chat');
const features = requireApp('src/infra/features');

test('[[pat]] 标记被剥掉，正文保留', () => {
  assert.deepStrictEqual(stripPatMark('好啊 [[pat]]'), { text: '好啊', pat: true });
  assert.deepStrictEqual(stripPatMark('[[pat]] 拍你一下'), { text: '拍你一下', pat: true });
  assert.deepStrictEqual(stripPatMark('[[pat]]'), { text: '', pat: true });
  assert.deepStrictEqual(stripPatMark('[[sticker:傲娇]] 嗯'), { text: '[[sticker:傲娇]] 嗯', pat: false });
  assert.deepStrictEqual(stripPatMark('普通文本'), { text: '普通文本', pat: false });
});

test('[[pat]] 只认一次，未知长标记不误伤', () => {
  assert.deepStrictEqual(stripPatMark('[[pat]] [[pat]]'), { text: '', pat: true });
  assert.deepStrictEqual(stripPatMark('[[patches]] 你好'), { text: '[[patches]] 你好', pat: false });
});

test('入站消息保留 pat 标记', () => {
  const msg = normalizeInbound({
    chat_id: 'wxid_a', sender_id: 'wxid_a', sender_name: '测试好友',
    text: '"测试好友" 拍了拍 "鲸鲸"', pat: true, at_me: true,
  }, 'wechat');
  assert.strictEqual(msg.pat, true);
  assert.strictEqual(msg.atMe, true);
});

test('网关：内核只要拍拍时回 action=pat', async () => {
  const config = { group: {}, wechat: {} };
  const bot = {
    config,
    handle: async () => ({ action: 'pat', pat: true, reason: 'pat_command' }),
  };
  const gw = new Gateway({ platform: 'wechat', options: { inboundToken: 't' }, bot, logger: null });
  const out = await gw.handleInbound({
    chat_id: 'wxid_a', chat_type: 'private', sender_id: 'wxid_a',
    senderName: '测试好友', text: '拍拍我',
  }, { local: true });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.action, 'pat');
  assert.strictEqual(out.pat, true);
});

test('网关：拍一拍 + 正文时两个都带出去', async () => {
  const config = { group: {}, wechat: {} };
  const bot = {
    config,
    handle: async () => ({ action: 'reply', reply: '啪', bubbles: ['啪'], pat: true, reason: 'pat' }),
  };
  const gw = new Gateway({ platform: 'wechat', options: { inboundToken: 't' }, bot, logger: null });
  const out = await gw.handleInbound({
    chat_id: 'wxid_a', chat_type: 'private', sender_id: 'wxid_a',
    senderName: '测试好友', text: '"测试好友" 拍了拍 "鲸鲸"', pat: true,
  }, { local: true });
  assert.strictEqual(out.action, 'reply');
  assert.strictEqual(out.reply, '啪');
  assert.strictEqual(out.pat, true);
});

test('拍一拍开关默认开，显式关掉生效', () => {
  assert.strictEqual(features.isOn({}, 'pat'), true);
  assert.strictEqual(features.isOn({ features: { pat: false } }, 'pat'), false);
});

test('私聊拍一拍命令只认整句', () => {
  for (const text of ['拍拍我', '拍一拍我', '拍我一下', '快拍我', '戳戳我', '拍拍我呀',
    '你拍我一下', '你能拍我一下吗？', '请你拍一拍我吧', '你也可以拍我', '拍一下我', '拍我一下可以吗']) {
    assert.strictEqual(PAT_COMMAND_RE.test(text), true, text);
  }
  for (const text of ['他拍了拍我的头', '拍拍我然后呢', '拍了拍你', '别拍我', '你不可以拍我', '你刚刚拍我了吗', '为什么不拍我']) {
    assert.strictEqual(PAT_COMMAND_RE.test(text), false, text);
  }
});

test('私聊「拍拍我」走拍一拍动作，关闭开关后不走', async () => {
  const fake = () => Object.assign(Object.create(Bot.prototype), {
    config: { chat: {}, persona: { name: '鲸鲸' }, features: { pat: true } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const raw = {
    platform: 'wechat', chatType: 'private', chatId: 'wxid_a',
    senderId: 'wxid_a', senderName: '测试好友', text: '你也可以拍我',
  };
  const out = await Bot.prototype._handleOnce.call(fake(), raw, { localWechat: true });
  assert.strictEqual(out.action, 'pat');
  assert.strictEqual(out.pat, true);

  const off = fake();
  off.config.features.pat = false;
  const skipped = await Bot.prototype._handleOnce.call(off, raw, { localWechat: true });
  assert.notStrictEqual(skipped.action, 'pat');
});

function patBot({ chatType = 'private', text = '测试好友 在微信里拍了拍你', pat = true, enabled = true,
  patConfig = null, random = null } = {}) {
  const seen = { pat: null, decided: 0 };
  const bot = Object.create(Bot.prototype);
  Object.assign(bot, {
    config: {
      chat: {}, persona: { name: '鲸鲸' }, features: { pat: enabled },
      ...(patConfig ? { pat: patConfig } : {}),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store: { checkpoint() {}, messages() { return []; }, appendEvent() {} },
    llm: { complete: async () => '哼，拍什么拍' },
    normalize: Bot.prototype.normalize,
    decide: async () => {
      seen.decided += 1;
      return {
        action: 'reply', key: 'k', reason: 'r', system: '', turns: [],
        msg: { platform: 'wechat', chatType, text },
      };
    },
    ...(random ? { random } : {}),
    activateReply: () => true,
    finalizeReply: (decision, body) => {
      seen.pat = decision.pat;
      return { action: 'reply', text: body, bubbles: [body], pat: decision.pat === true, reason: 'r',
        ...(decision.patId ? { patId: decision.patId } : {}) };
    },
    recordUsage() {},
    usageSince: () => ({}),
    recentHeard: () => [],
    recentOwn: () => [],
    checkReplyLength() {},
    transformPluginReply: async (decision, body) => body,
    _replyTurns: new Map(),
    _finalReplies: new Map(),
    _replyQuota: { release() {} },
    _patBudget: new Map(),
  });
  return { bot, seen };
}

test('私聊被拍：模型没写 [[pat]] 也会回拍', async () => {
  const { bot, seen } = patBot();
  const raw = {
    platform: 'wechat', chatType: 'private', chatId: 'wxid_a',
    senderId: 'wxid_a', senderName: '测试好友', text: '测试好友 在微信里拍了拍你', pat: true,
  };
  const out = await Bot.prototype._handleOnce.call(bot, raw, { localWechat: true });
  assert.strictEqual(seen.pat, true, 'decision.pat 应该被强制打开');
  assert.strictEqual(out.action, 'reply');
  assert.strictEqual(out.pat, true);
  assert.strictEqual(out.reply, '哼，拍什么拍');
});

test('群里被拍只回文字，不主动回拍（拍不准人）', async () => {
  const { bot, seen } = patBot({ chatType: 'group' });
  const raw = {
    platform: 'wechat', chatType: 'group', chatId: '123@chatroom',
    senderId: 'wxid_a', senderName: '测试好友', text: '测试好友 在微信里拍了拍你', pat: true,
  };
  const out = await Bot.prototype._handleOnce.call(bot, raw, { localWechat: true });
  assert.ok(!seen.pat);
  assert.strictEqual(out.pat, undefined);
  assert.strictEqual(out.action, 'reply');
});

test('关掉拍一拍开关后，被拍不回拍', async () => {
  const { bot, seen } = patBot({ enabled: false });
  const raw = {
    platform: 'wechat', chatType: 'private', chatId: 'wxid_a',
    senderId: 'wxid_a', senderName: '测试好友', text: '测试好友 在微信里拍了拍你', pat: true,
  };
  const out = await Bot.prototype._handleOnce.call(bot, raw, { localWechat: true });
  assert.ok(!seen.pat);
  assert.notStrictEqual(out.pat, true);
});

const PAT_RAW = {
  platform: 'wechat', chatType: 'private', chatId: 'wxid_a',
  senderId: 'wxid_a', senderName: '测试好友', text: '测试好友 在微信里拍了拍你', pat: true,
};

test('回拍概率 0：只回话，不拍', async () => {
  const { bot, seen } = patBot({ patConfig: { replyChance: 1, backChance: 0 } });
  const out = await Bot.prototype._handleOnce.call(bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(out.action, 'reply');
  assert.ok(!seen.pat);
  assert.notStrictEqual(out.pat, true);
});

test('回话概率 0、回拍概率 1：只拍，不调模型', async () => {
  const { bot, seen } = patBot({ patConfig: { replyChance: 0, backChance: 1 } });
  const out = await Bot.prototype._handleOnce.call(bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(out.action, 'pat');
  assert.strictEqual(out.pat, true);
  assert.strictEqual(seen.decided, 0, '这一轮不该调用模型');
});

test('两个概率都 0：安静跳过', async () => {
  const { bot, seen } = patBot({ patConfig: { replyChance: 0, backChance: 0 } });
  const out = await Bot.prototype._handleOnce.call(bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(out.action, 'ignore');
  assert.strictEqual(seen.decided, 0);
});

test('回拍概率 0.5：随机值决定拍不拍', async () => {
  const high = patBot({ patConfig: { replyChance: 1, backChance: 0.5 }, random: () => 0.9 });
  const outHigh = await Bot.prototype._handleOnce.call(high.bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(outHigh.pat, undefined);

  const low = patBot({ patConfig: { replyChance: 1, backChance: 0.5 }, random: () => 0.1 });
  const outLow = await Bot.prototype._handleOnce.call(low.bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(outLow.pat, true);
});

test('回拍冷却：间隔内不再回拍，过了间隔再拍', async () => {
  const { bot, seen } = patBot({
    patConfig: { replyChance: 1, backChance: 1, cooldownSec: 60 }, random: () => 0.1,
  });
  const first = await Bot.prototype._handleOnce.call(bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(first.pat, true);

  seen.pat = null;
  const second = await Bot.prototype._handleOnce.call(bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(second.action, 'reply');
  assert.ok(!seen.pat, '冷却中的第二次不该回拍');

  // 把上次回拍时间往前推 61 秒，冷却过去后再拍
  const rec = bot._patBudget.get('wxid_a');
  rec.last = Date.now() - 61000;
  seen.pat = null;
  const third = await Bot.prototype._handleOnce.call(bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(third.pat, true);
});

test('每小时上限：超过次数后只回话', async () => {
  const { bot } = patBot({
    patConfig: { replyChance: 1, backChance: 1, cooldownSec: 0, maxPerHour: 1 }, random: () => 0.1,
  });
  const first = await Bot.prototype._handleOnce.call(bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(first.pat, true);
  const second = await Bot.prototype._handleOnce.call(bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(second.action, 'reply');
  assert.notStrictEqual(second.pat, true);
});

// ---- BUGS #128：回拍额度先占位，等桥接回执再落账 ----

test('回拍前占额度，并把回执单号带给桥接', async () => {
  const { bot } = patBot({ patConfig: { replyChance: 1, backChance: 1, cooldownSec: 0 } });
  const out = await Bot.prototype._handleOnce.call(bot, PAT_RAW, { localWechat: true });
  assert.strictEqual(out.pat, true);
  assert.match(String(out.patId || ''), /^pat-/, '桥接要靠这个单号回执');
  assert.strictEqual(bot._patBudget.get('wxid_a').count, 1, '拍之前先占住额度');
  assert.ok(bot._patPending.has(out.patId), '占位记录要留着等回执');
});

test('回执成功保留额度，回执失败把额度还回去', () => {
  const bot = Object.create(Bot.prototype);
  const events = [];
  Object.assign(bot, {
    config: { chat: {}, persona: { name: '鲸鲸' }, features: { pat: true }, pat: { cooldownSec: 0, maxPerHour: 2 } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store: { appendEvent: (key, event) => events.push({ key, event }) },
    _patBudget: new Map(),
    _patPending: new Map(),
    random: () => 0.1,
  });
  const early = { platform: 'wechat', chatType: 'private', chatId: 'wxid_a', senderName: '测试好友' };
  const t0 = Date.now();

  const okId = bot.reservePat(early, t0);
  assert.strictEqual(bot.settlePat(okId, true, 'sent', t0 + 500), true);
  assert.strictEqual(bot._patBudget.get('wxid_a').count, 1, '拍到了就留着这次额度');
  assert.strictEqual(events[0].event.type, 'pat');
  assert.strictEqual(events[0].event.status, 'submitted');
  assert.ok(bot._patPending.size === 0);

  const failId = bot.reservePat(early, t0 + 1000);
  assert.strictEqual(bot.settlePat(failId, false, 'no_friend_row', t0 + 1500), true);
  assert.strictEqual(bot._patBudget.get('wxid_a').count, 1, '没拍到就把这次额度还回去');
  const failed = events[1].event;
  assert.strictEqual(failed.status, 'failed');
  assert.ok(failed.detail.includes('no_friend_row'), '日志/账本要能看出失败原因');
  assert.strictEqual(bot.patBudgetAllows('wxid_a', bot.patSettings(), t0 + 2000), true,
    '失败的这一次不能把每小时上限吃掉（成功的那次仍占 1 次）');
});

test('回执超时：额度回滚，并记成「没收到回执」而不是拍到了', () => {
  const bot = Object.create(Bot.prototype);
  const events = [];
  Object.assign(bot, {
    config: { chat: {}, persona: { name: '鲸鲸' }, features: { pat: true }, pat: { cooldownSec: 0 } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    store: { appendEvent: (key, event) => events.push({ key, event }) },
    _patBudget: new Map(),
    _patPending: new Map(),
  });
  const t0 = Date.now();
  const early = { platform: 'wechat', chatType: 'private', chatId: 'wxid_b', senderName: '测试好友' };
  bot.reservePat(early, t0);
  assert.strictEqual(bot.expirePatPending(t0 + 29000), 0, '还没到等待上限不能提前判死');
  assert.strictEqual(bot.expirePatPending(t0 + 31000), 1);
  assert.strictEqual(bot._patBudget.get('wxid_b').count, 0, '超时没回执同样要还额度');
  assert.strictEqual(events[0].event.status, 'unconfirmed');
  assert.ok(events[0].event.detail.includes('没收到桥接回执'));
});
