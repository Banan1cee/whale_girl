'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTrigger } = require('../src/core/trigger');
const { sendDenial } = require('../src/core/wechatSendPolicy');
const { DEFAULT_CONFIG } = require('../src/infra/config');

test('群聊开关与黑白名单组合：默认无名单可发、黑名单始终优先', () => {
  for (const requireAt of [false, true]) for (const freeChat of [false, true])
    for (const masterAlwaysReply of [false, true]) for (const whitelistOnly of [false, true])
      for (const black of [false, true]) for (const white of [false, true]) {
        const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        Object.assign(config.group, { requireAt, freeChat, masterAlwaysReply, freeChatChance: 1, cooldownSec: 0, mutedGroups: black ? ['matrix@chatroom'] : [] });
        config.wechat.whitelistOnly = whitelistOnly;
        config.care.whitelist = white ? ['matrix@chatroom'] : [];
        const denial = sendDenial(config, { id: 'matrix@chatroom', isGroup: true });
        assert.equal(denial, black ? 'muted_group' : whitelistOnly && !white ? 'not_whitelisted' : null);
        const out = computeTrigger({ config, rng: () => 0, store: { messages: () => [] } }, {
          msg: { chatId: 'matrix@chatroom', senderId: 'peer' }, clean: { text: '今天下雨了' },
          isGroup: true, isMaster: false, atMe: false, key: 'matrix', state: {}, nowMs: Date.now(),
        });
        assert.equal(out.wake, !requireAt || freeChat);
      }
});
