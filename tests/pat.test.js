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
  for (const text of ['拍拍我', '拍一拍我', '拍我一下', '快拍我', '戳戳我', '拍拍我呀']) {
    assert.strictEqual(PAT_COMMAND_RE.test(text), true, text);
  }
  for (const text of ['他拍了拍我的头', '拍拍我然后呢', '拍了拍你', '别拍我']) {
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
    senderId: 'wxid_a', senderName: '测试好友', text: '拍拍我',
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
      return { action: 'reply', text: body, bubbles: [body], pat: decision.pat === true, reason: 'r' };
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
