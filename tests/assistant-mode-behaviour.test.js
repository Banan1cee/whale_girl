'use strict';

/**
 * 小助手模式的回归测试（移植自大肥鱼的 follow-up 逻辑）。
 *
 * 现场：旧规则只有「被 @ 一次 → 6 分钟内谁说话都回」这一条时间窗，
 * 于是别人刚聊起来她也会插一句 —— 她分不清大家在跟她说话还是在互相说话。
 *
 * 新规则给窗口加两个硬约束：
 *   1. 一次窗口最多顺接 assistantTurns 句（额度用完就收）；
 *   2. 窗口只对「她最后回的那个人」有效，别人插话立刻收口。
 * 另外叫别人名字、纯捧场（哈哈 / 好的）都不算在跟她说话。
 *
 * 这些用例只调 computeTrigger（纯函数），不碰网络和落盘。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeTrigger } = require('../src/core/trigger');

const NOW = new Date('2026-10-31T10:00:00+08:00').getTime();
const SEC = 1000;

function bot(over = {}) {
  return {
    config: {
      group: {
        requireAt: true,
        freeChat: false,
        freeChatChance: 0,
        cooldownSec: 0,
        maxRepliesPerMinute: 15,
        masterAlwaysReply: true,
        engagedMinutes: 6,
        assistantTurns: 3,
        assistantSeconds: 180,
        ...(over.group || {}),
      },
      features: over.features || {},
      persona: { name: '鲸鲸', aliases: ['小鲸'] },
    },
    store: { messages: () => [] },
    rng: () => 0.99,
  };
}

/** 她刚回完 u1 一句问话，窗口还开着 */
function state(over = {}) {
  return {
    followLeft: 3,
    followInterrupted: false,
    lastBotAt: NOW - 10 * SEC,
    lastBotText: '你觉得哪个好？',
    lastBotSenderId: 'u1',
    ...over,
  };
}

function args(text, { st = state(), senderId = 'u1', otherMemberNames = [] } = {}) {
  return {
    msg: { senderId, isGroup: true, otherMemberNames },
    atMe: false,
    clean: { text },
    isGroup: true,
    state: st,
    nowMs: NOW,
    isMaster: false,
    key: 'g1',
  };
}

test('她提问后对方短句回答 → 接，并扣掉一格额度', () => {
  const st = state();
  const r = computeTrigger(bot(), args('第一个吧', { st }));
  assert.equal(r.wake, true);
  assert.equal(r.reason, 'followup');
  assert.equal(st.followLeft, 2);
});

test('额度用完 → 不再接（窗口还开着也不接）', () => {
  const st = state({ followLeft: 0 });
  const r = computeTrigger(bot(), args('那第二个呢', { st }));
  assert.equal(r.wake, false);
});

test('别的人插话 → 立刻收口，整段窗口作废', () => {
  const st = state();
  const r = computeTrigger(bot(), args('刚才那个事咋样了', { st, senderId: 'u2' }));
  assert.equal(r.wake, false);
  assert.equal(st.followInterrupted, true);
  assert.equal(st.followLeft, 0);
});

test('叫的是别人的名字 → 判成在跟别人说话，收口', () => {
  const st = state();
  const r = computeTrigger(
    bot(),
    args('老王你先说', { st, otherMemberNames: ['老王'] }),
  );
  assert.equal(r.wake, false);
  assert.equal(st.followInterrupted, true);
});

test('纯捧场（好的 / 哈哈）→ 不值得再开一轮', () => {
  const st = state();
  const r = computeTrigger(bot(), args('好的', { st }));
  assert.equal(r.wake, false);
  assert.equal(st.followLeft, 3);
});

test('窗口过期 → 不接', () => {
  const st = state({ lastBotAt: NOW - 600 * SEC });
  const r = computeTrigger(bot(), args('第一个吧', { st }));
  assert.equal(r.wake, false);
});

test('关掉开关 → 回到旧的「3 分钟内 + 你」时间窗', () => {
  const st = state({ lastReplyAt: NOW - 60 * SEC, followLeft: 0, followInterrupted: false });
  const b = bot({ features: { assistantMode: false } });
  const r = computeTrigger(b, args('你说的是哪个', { st }));
  assert.equal(r.wake, true);
  assert.equal(r.reason, 'followup');
});

test('被 @ 到 → 重新开一轮额度', () => {
  const st = state({ followLeft: 0, followInterrupted: true });
  const a = args('你说呢', { st });
  a.atMe = true;
  const r = computeTrigger(bot(), a);
  assert.equal(r.wake, true);
  assert.equal(r.reason, 'addressed');
  assert.equal(st.followLeft, 3);
  assert.equal(st.followInterrupted, false);
});
