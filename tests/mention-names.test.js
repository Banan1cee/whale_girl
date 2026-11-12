'use strict';

/**
 * 「她在群里叫什么」不能只靠人设别名：账号昵称/备注由桥接从微信读出来，
 * 要一路传到内核的触发判断和提示词清洗里。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeInbound } = require('../src/adapters/gateway');
const { computeTrigger, namedHerIn } = require('../src/core/trigger');
const persona = require('../src/persona');
const { extractMentionNames } = require('../src/core/mentions');
const { DEFAULT_CONFIG } = require('../src/infra/config');

const NOW = 1_700_000_000_000;

function bot(config = {}) {
  return {
    config: {
      ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
      group: { ...DEFAULT_CONFIG.group, ...config, groupAddressGuard: true },
    },
    rng: () => 1,
  };
}

test('网关把 self_names 带进统一消息', () => {
  const msg = normalizeInbound({ chat_id: 'g', chat_type: 'group', text: '@许愿 在吗', self_names: ['许愿', ' 鲸鲸 '] }, 'wechat');
  assert.deepEqual(msg.selfNames, ['许愿', '鲸鲸']);
});

test('账号昵称没 @ 也能进入接话窗口', () => {
  const state = { engagedUntil: NOW + 60_000, engagedBy: 'u-b', lastReplyAt: NOW - 5_000 };
  const result = computeTrigger(bot(), {
    msg: { senderId: 'u-a', selfNames: ['许愿'], mentionedNames: [] },
    atMe: false, clean: { text: '许愿你说呢' }, isGroup: true,
    state, nowMs: NOW, isMaster: false, key: 'g',
  });
  assert.equal(result.wake, true);
  assert.equal(result.reason, 'engaged_group');
});

test('账号昵称在 3 分钟追话窗口里也算叫她', () => {
  const state = { engagedUntil: 0, lastReplyAt: NOW - 5_000 };
  const result = computeTrigger(bot(), {
    msg: { senderId: 'u-a', selfNames: ['许愿'], mentionedNames: [] },
    atMe: false, clean: { text: '许愿在吗' }, isGroup: true,
    state, nowMs: NOW, isMaster: false, key: 'g',
  });
  assert.equal(result.wake, true);
  assert.equal(result.reason, 'followup');
});

test('旧的人设别名仍然有效', () => {
  assert.equal(namedHerIn('鲸鲸你说呢'), true);
  assert.equal(namedHerIn('许愿你说呢', ['许愿']), true);
  assert.equal(namedHerIn('许愿你说呢', ['鲸鲸']), false);
});

test('提示词清洗会去掉账号昵称的 @，并排除自己被当成第三人', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.persona.name = '鲸鲸';
  cfg.persona.aliases = ['糯糯'];
  const clean = persona.cleanIncomingForPersona('@许愿\u2005 在吗', cfg, ['许愿']);
  assert.equal(clean.hadAlias, true);
  assert.equal(clean.text, '在吗');
  assert.deepEqual(extractMentionNames('@许愿 @张三 你们说', persona.aliasList(cfg, ['许愿'])), ['张三']);
});
