'use strict';

/**
 * 小助手模式（src/core/assistantMode.js）的模块级测试。
 *
 * 这一块单独成模块 + 单独开关，所以除了走 computeTrigger 的行为测试
 * （tests/followup-window.test.js），再直接测一遍模块边界：
 *   - 开关关掉时整块不接管（judge 返回 null，即使窗口数据还在）；
 *   - 开关是「缺省为开」；
 *   - 参数有兜底和上下限（坏配置不能把额度搞成 NaN / 负数）；
 *   - noteReply / noteExplicitTrigger 写的是同一份 state。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const assistantMode = require('../src/core/assistantMode');

const NOW = new Date('2026-10-31T10:00:00+08:00').getTime();
const SEC = 1000;

function config(over = {}) {
  return {
    group: { engagedMinutes: 6, assistantTurns: 3, assistantSeconds: 180, ...(over.group || {}) },
    features: over.features || {},
    persona: { name: '鲸鲸', aliases: ['小鲸'] },
  };
}

function state(over = {}) {
  return {
    followLeft: 0,
    followInterrupted: false,
    lastBotAt: 0,
    lastBotText: '',
    lastBotSenderId: '',
    ...over,
  };
}

function judge(text, { senderId = 'u1', st, cfg = config() } = {}) {
  return assistantMode.judge({
    config: cfg,
    msg: { senderId, isGroup: true, otherMemberNames: [] },
    clean: { text },
    state: st,
    nowMs: NOW,
  });
}

test('开关缺省为开；显式关掉后 judge 完全不接管', () => {
  assert.equal(assistantMode.isOn(config()), true);
  assert.equal(assistantMode.isOn(config({ features: { assistantMode: false } })), false);
  assert.equal(assistantMode.isOn(config({ features: { assistantMode: 'false' } })), false);

  const st = state({ followLeft: 3, lastBotSenderId: 'u1', lastBotAt: NOW - 5 * SEC, lastBotText: '你觉得呢？' });
  assert.equal(judge('我觉得第一个好', { st, cfg: config({ features: { assistantMode: false } }) }), null);
  // 窗口数据没被改，重新打开还能用
  assert.equal(st.followLeft, 3);
});

test('noteReply 开窗口后，同一个人短句能顺着接，并扣额度', () => {
  const cfg = config();
  const st = state();
  assistantMode.noteReply({ config: cfg, state: st, senderId: 'u1', text: '你觉得哪个好？', nowMs: NOW });
  assert.equal(st.lastBotSenderId, 'u1');
  assert.equal(st.followLeft, 3);

  const r = judge('第一个吧', { st, cfg });
  assert.deepEqual(r, { wake: true, reason: 'followup' });
  assert.equal(st.followLeft, 2);

  // 额度扣到 0 以后不接
  st.followLeft = 0;
  assert.equal(judge('那第二个呢', { st, cfg }), null);
});

test('别人插话 → 收口，且不接管后面的判定', () => {
  const cfg = config();
  const st = state();
  assistantMode.noteReply({ config: cfg, state: st, senderId: 'u1', text: '在吗', nowMs: NOW });

  const r = judge('我先说个事', { st, cfg, senderId: 'u2' });
  assert.equal(r, null);
  assert.equal(st.followInterrupted, true);
});

test('窗口过期 / 没有回给谁 → 不接管', () => {
  const cfg = config({ group: { assistantSeconds: 60 } });
  const st = state();
  assistantMode.noteReply({ config: cfg, state: st, senderId: 'u1', text: '嗯', nowMs: NOW - 120 * SEC });
  assert.equal(judge('接着说', { st, cfg }), null);

  const empty = state();
  assert.equal(judge('接着说', { st: empty, cfg }), null);
});

test('参数坏值有兜底和上下限', () => {
  assert.equal(assistantMode.turns(config({ group: { assistantTurns: 'abc' } })), 3);
  assert.equal(assistantMode.turns(config({ group: { assistantTurns: -5 } })), 0);
  assert.equal(assistantMode.turns(config({ group: { assistantTurns: 99 } })), 20);
  assert.equal(assistantMode.seconds(config({ group: { assistantSeconds: 'x' } })), 180);
  assert.equal(assistantMode.seconds(config({ group: { assistantSeconds: 1 } })), 10);
  assert.equal(assistantMode.seconds(config({ group: { assistantSeconds: 99999 } })), 3600);
});

test('noteExplicitTrigger 重新给满额度', () => {
  const cfg = config({ group: { assistantTurns: 5 } });
  const st = state({ followLeft: 0, followInterrupted: true });
  assistantMode.noteExplicitTrigger(cfg, st);
  assert.equal(st.followLeft, 5);
  assert.equal(st.followInterrupted, false);
});
