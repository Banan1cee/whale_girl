'use strict';

/**
 * 内核公共模块回归：称呼 / 会话闸门 / 历史行解析。
 * 这些规则以前散在 trigger、chat、canned、context 里，改一处很容易漏另一处。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const addressing = require('../src/core/addressing');
const sessionState = require('../src/core/sessionState');
const history = require('../src/core/history');
const { buildTurns } = require('../src/core/context');
const personCard = require('../src/memory/personCard');
const { computeTrigger } = require('../src/core/trigger');
const { DEFAULT_CONFIG } = require('../src/infra/config');

test('称呼表合并人设名、别名和桥接账号昵称', () => {
  const bot = { config: { persona: { name: '鲸鲸', aliases: ['糯糯'] } } };
  assert.deepEqual(addressing.herNames(bot, { selfNames: ['许愿'] }), ['鲸鲸', '糯糯', '许愿']);
});

test('提及名单过滤自己、广播词和重复项', () => {
  assert.deepEqual(
    addressing.filterSelfMentions(['许愿', '张三', '所有人', '张三'], ['许愿']),
    ['张三'],
  );
});

test('@ 了别人 / 第三人称算在跟别人说', () => {
  assert.equal(addressing.talkingToOthers({
    msg: { mentionedNames: ['张三'] }, text: '你怎么看', names: ['许愿'],
  }), true);
  assert.equal(addressing.talkingToOthers({
    msg: { mentionedNames: [] }, text: '他今天没来', names: ['许愿'],
  }), true);
  assert.equal(addressing.talkingToOthers({
    msg: { mentionedNames: [] }, text: '你怎么看', names: ['许愿'],
  }), false);
});

test('静默只由显式 @ 解除，问号/开麦不能解除', () => {
  const state = { silentUntil: 1000, engagedUntil: 0, engagedBy: '' };
  assert.equal(sessionState.isSilent(state, 999), true);
  assert.equal(sessionState.isSilent(state, 1001), false);
  sessionState.clearSilent(state);
  assert.equal(state.silentUntil, 0);
});

test('接话窗口只认同一个人，写入/清除都是同一套', () => {
  const state = {};
  sessionState.touchEngagement(state, 'u-a', 1000, 6);
  assert.equal(sessionState.engagedWith(state, 'u-a', 1000), true);
  assert.equal(sessionState.engagedWith(state, 'u-b', 1000), false);
  sessionState.clearEngagement(state);
  assert.equal(state.engagedUntil, 0);
});

test('带间隔和时间戳的历史行能被解析', () => {
  const line = '[间隔约 35 分钟]\n[11-12 01:30] {"发言人":"甲","内容":"旧话题"}';
  assert.deepEqual(history.parseHistoryLine(line), { 发言人: '甲', 内容: '旧话题' });
  assert.equal(history.parseHistoryLine('not json'), null);
});

test('群聊当前消息也受单条字符上限保护', () => {
  const turns = buildTurns({
    chatType: 'group', senderId: 'u-a', senderName: '甲',
    text: '长'.repeat(3000), cleanText: '长'.repeat(3000), ts: 1,
  }, [], '', '', '');
  assert.ok(turns[0].content.length < 3000);
});

test('退场静默不会被问号或「开麦」绕过', () => {
  const bot = {
    config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    rng: () => 1,
  };
  bot.config.group.masterAlwaysReply = true;
  const base = {
    msg: { senderId: 'u-a', selfNames: [] }, isGroup: true, nowMs: 1000,
    isMaster: false, key: 'g', state: { silentUntil: 5000 },
  };
  assert.equal(computeTrigger(bot, { ...base, atMe: false, clean: { text: '？' } }).reason, 'silent');
  assert.equal(computeTrigger(bot, { ...base, atMe: false, clean: { text: '开麦聊两句' } }).reason, 'silent');
  assert.equal(computeTrigger(bot, { ...base, atMe: true, clean: { text: '你说呢' } }).reason, 'addressed');
});

test('空 /forget 不清空整张人物卡', () => {
  const card = {
    chatId: 'c', uid: 'u', nickname: '甲',
    traits: [{ text: '温柔' }], preferences: [{ text: '怕黑' }],
    events: [{ title: '体检' }], threads: [{ text: '周末去哪' }],
    updatedAt: 0,
  };
  assert.equal(personCard.forget(card, '', 1), 0);
  assert.ok(card.traits[0].text && card.preferences[0].text);
});
