'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// 执行真实管线模块，只替换持久化接缝；不构造磁盘 Store、不写真实人设或设置。
const sourceFile = path.join(__dirname, '..', 'src', 'pipeline', 'chat.js');
const sourceRequire = createRequire(sourceFile);
const savedByConfig = new WeakMap();
const personaStore = {
  save(config, patch) {
    const saved = savedByConfig.get(config);
    assert.ok(saved, 'save must belong to this in-memory fixture');
    saved.push(structuredClone(patch));
  },
};
const compiled = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(sourceFile, 'utf8') + '\n})', {
  filename: sourceFile,
})(name => name === '../persona/store' ? personaStore : sourceRequire(name), compiled, compiled.exports, sourceFile, path.dirname(sourceFile));
const { Bot } = compiled.exports;
const { DEFAULT_CONFIG } = sourceRequire('../infra/config');
const NOW = Date.parse('2026-11-14T10:00:00Z');
const KEY = 'wechat:u:fixture-owner';
const OWNER = { platform: 'wechat', chatType: 'private', chatId: 'fixture-owner', senderId: 'wxid_fixture_owner', senderName: 'FixtureOwner' };
const ALIASES = ['改名', '改名为', '改名成', '改名字', '名字改成'];

function fixture({ granted = true } = {}) {
  const bot = Object.create(Bot.prototype);
  bot.config = structuredClone(DEFAULT_CONFIG);
  bot.config.persona.master = { names: ['FixtureOwner'], wxids: [OWNER.senderId] };
  bot.config.admin = { spell: 'fixture-admin-spell', minutes: 30 };
  bot.store = { markDirty() {} };
  bot.logger = null;
  bot._adminSpellGrants = new WeakMap();
  bot._adminGrantsByKey = new Map();
  const state = granted ? { adminUser: OWNER.senderId, adminUntil: NOW + 60000 } : {};
  if (granted) bot._adminSpellGrants.set(state, bot.config.admin.spell);
  const saved = [];
  savedByConfig.set(bot.config, saved);
  return { bot, state, saved, command(text, extra = {}) {
    return bot.handleAdmin({ msg: { ...OWNER, ...extra.msg }, clean: { text }, key: extra.key || KEY,
      state: extra.state || state, isMaster: true, nowMs: NOW });
  } };
}

for (const alias of ALIASES) {
  test('declared rename alias extracts only the name: ' + alias, () => {
    for (const separator of [' ', ':', '：', '']) {
      const f = fixture();
      const result = f.command(alias + separator + '小鱼');
      assert.equal(result.action, 'command');
      assert.deepEqual(f.saved, [{ name: '小鱼' }], alias + JSON.stringify(separator));
    }
  });
  test('empty rename suffix never falls back to a shorter alias: ' + alias, () => {
    for (const suffix of ['', ' ', ':', '：', ' ""']) {
      const f = fixture(); f.command(alias + suffix);
      assert.deepEqual(f.saved, [], alias + JSON.stringify(suffix));
    }
  });
}

test('upstream quote and terminal-punctuation cleanup is equivalent for every alias', () => {
  for (const raw of ['「小鱼」', '小鱼。', '「小鱼」。', '“小鱼”！']) {
    const short = fixture(); short.command('改名 ' + raw);
    assert.equal(short.saved.length, 1);
    for (const alias of ALIASES) {
      const f = fixture(); f.command(alias + ' ' + raw);
      assert.deepEqual(f.saved, short.saved, alias + ':' + raw);
    }
  }
});

test('explicit name-leading alias characters remain valid', () => {
  for (const [text, expected] of [['改名 为小鱼', '为小鱼'], ['改名 成小鱼', '成小鱼'], ['改名 字小鱼', '字小鱼']]) {
    const f = fixture(); f.command(text); assert.deepEqual(f.saved, [{ name: expected }]);
  }
});

test('non-command prefixes and invalid names produce no save', () => {
  for (const text of ['不改名 小鱼', '请改名为 小鱼', '我的名字改成 小鱼', '改姓名 小鱼', '改名吧',
    '改名 ' + '鱼'.repeat(21), '改名 小\n鱼']) {
    const f = fixture(); f.command(text); assert.deepEqual(f.saved, [], text);
  }
});

for (const variant of ['ungranted', 'expired', 'foreign-sender', 'group', 'web', 'missing-spell', 'forged-state', 'changed-spell']) {
  test('rename aliases retain the private verified-owner grant gate: ' + variant, () => {
    for (const alias of ALIASES) {
      const f = fixture({ granted: !['ungranted', 'forged-state'].includes(variant) });
      const msg = {};
      if (variant === 'expired') f.state.adminUntil = NOW;
      if (variant === 'foreign-sender') msg.senderId = 'wxid_fixture_other';
      if (variant === 'group') msg.chatType = 'group';
      if (variant === 'web') msg.platform = 'web';
      if (variant === 'missing-spell') f.bot.config.admin.spell = '';
      if (variant === 'forged-state') Object.assign(f.state, { adminUser: OWNER.senderId, adminUntil: NOW + 60000 });
      if (variant === 'changed-spell') f.bot.config.admin.spell = 'fixture-changed-spell';
      f.command(alias + ' 小鱼', { msg });
      assert.deepEqual(f.saved, [], alias);
    }
  });
}

for (const variant of ['valid', 'expired', 'changed-spell', 'different-sender', 'different-key', 'new-process-no-map', 'forged-persisted-state', 'explicit-exit']) {
  test('upstream restored grant identity and original TTL remain unchanged: ' + variant, () => {
    const f = fixture({ granted: false });
    const spell = f.bot.config.admin.spell;
    const grant = { spell, senderId: OWNER.senderId, until: NOW + 60000 };
    f.bot._adminGrantsByKey.set(KEY, grant);
    let key = KEY; const msg = { ...OWNER }; const nextState = {};
    if (variant === 'expired') grant.until = NOW;
    if (variant === 'changed-spell') f.bot.config.admin.spell = 'fixture-changed-spell';
    if (variant === 'different-sender') msg.senderId = 'wxid_fixture_other';
    if (variant === 'different-key') key = 'wechat:u:fixture-other';
    if (variant === 'new-process-no-map') f.bot._adminGrantsByKey.clear();
    if (variant === 'forged-persisted-state') {
      f.bot._adminGrantsByKey.clear(); Object.assign(nextState, { adminUser: OWNER.senderId, adminUntil: grant.until });
    }
    if (variant === 'explicit-exit') {
      Object.assign(f.state, { adminUser: OWNER.senderId, adminUntil: grant.until });
      f.bot._adminSpellGrants.set(f.state, spell);
      assert.equal(f.command('退出管理').action, 'command');
      assert.equal(f.bot._adminGrantsByKey.has(KEY), false);
    }
    f.bot.restoreAdminGrant(key, nextState, msg, f.bot.config.admin.spell, NOW);
    const active = f.bot.adminSpellActive(msg, nextState, NOW);
    assert.equal(active, variant === 'valid');
    if (active) {
      assert.equal(nextState.adminUntil, grant.until, 'restoration must not extend TTL');
      f.command('改名为 小鱼', { state: nextState });
      assert.deepEqual(f.saved, [{ name: '小鱼' }]);
    } else assert.deepEqual(f.saved, []);
  });
}

test('pending persona policy is not silently restored through this alias repair', () => {
  for (const text of ['情绪 关', '人味 高', '语气 高冷', '语态 只说一句', '重置语态']) {
    const f = fixture(); assert.equal(f.command(text), null); assert.deepEqual(f.saved, []);
  }
});
