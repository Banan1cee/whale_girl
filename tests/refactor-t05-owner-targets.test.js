'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const master = require('../src/core/master');
const care = require('../src/services/care');
const { ContactsCache, normalizeItem } = require('../src/services/contacts');

const OWNER = 'wxid_test_bound_owner';
const OTHER = 'wxid_test_same_name';
const NAME = 'Fixture Owner';
const config = (wxids = [OWNER], patch = {}) => ({
  persona: { master: { wxids, names: [NAME] } },
  care: { onlyMaster: true, allowOthers: false, allowGroups: false, ...patch },
});
const contacts = (...rows) => ({
  items: rows.map(normalizeItem),
  get: ContactsCache.prototype.get,
});

test('T05/F13: configured hard ID blocks same-name non-owner in proactive targets', () => {
  const cfg = config([OWNER], { whitelist: [OTHER] });
  const cache = contacts({ wxid: OWNER, name: NAME }, { wxid: OTHER, name: NAME });
  assert.equal(master.matchMaster(cfg, { platform: 'wechat', senderId: OTHER, senderName: NAME }).reason, 'name_blocked');
  assert.equal(care.isMasterTarget(cfg, OTHER, cache), false);
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }), []);
});

test('T05/F13: upper-case configured hard IDs also block nickname impersonation', () => {
  const cfg = config([OWNER.toUpperCase()], { whitelist: [OTHER] });
  const cache = contacts({ wxid: OTHER, name: NAME });
  assert.equal(master.matchMaster(cfg, { platform: 'wechat', senderId: OTHER, senderName: NAME }).isMaster, false);
  assert.equal(care.isMasterTarget(cfg, OTHER, cache), false);
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }), []);
});

test('T05/F13: bound IDs stay verified despite changed names and account-directory suffixes', () => {
  for (const id of [OWNER, `${OWNER}_c248`, OWNER.toUpperCase()]) {
    const cfg = config([id]);
    const cache = contacts({ wxid: OWNER, name: 'Changed fixture name' });
    const facts = master.masterTargetFacts(cfg, OWNER, cache);
    assert.equal(facts.isMaster, true);
    assert.equal(facts.verified, true);
    assert.equal(facts.weakMatch, false);
    assert.equal(facts.reason, 'wxid');
    assert.equal(care.careTargets(cfg, { contacts: cache })[0].wxid, id);
  }
});

test('T05/F13: hard binding never expands default targets by matching contact display names', () => {
  const cfg = config([OWNER], { onlyMaster: false, allowOthers: true });
  const cache = contacts({ wxid: OWNER, name: NAME }, { wxid: OTHER, name: NAME });
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }).map(item => item.wxid), [OWNER, 'filehelper']);
});

test('T05/F13: explicit permission for another person remains distinct from owner identity', () => {
  const cfg = config([OWNER], { whitelist: [OTHER], onlyMaster: false, allowOthers: true });
  const cache = contacts({ wxid: OTHER, name: NAME });
  assert.equal(master.masterTargetFacts(cfg, OTHER, cache).reason, 'name_blocked');
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }), [{ wxid: OTHER, name: NAME, isGroup: false, kind: 'other' }]);
});

test('T05/F13: unique legacy nickname remains a weak target match without management authority', () => {
  const cfg = config([]);
  const cache = contacts({ wxid: OWNER, name: NAME });
  const facts = master.masterTargetFacts(cfg, OWNER, cache);
  assert.equal(facts.isMaster, true);
  assert.equal(facts.weakMatch, true);
  assert.equal(facts.verified, false);
  assert.equal(facts.ambiguous, false);
  assert.equal(master.isVerifiedOwner(cfg, { platform: 'wechat', senderId: OWNER, senderName: NAME }), false);
  assert.equal(care.careTargets(cfg, { contacts: cache })[0].kind, 'master');
});

test('T05/F13: unique legacy remark is resolved separately from the display nickname', () => {
  const cfg = config([]);
  const cache = contacts({ wxid: OWNER, name: 'Different fixture nickname', remark: NAME });
  assert.equal(master.masterTargetFacts(cfg, OWNER, cache).weakMatch, true);
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }), [{ wxid: OWNER, name: NAME, isGroup: false, kind: 'master' }]);
});

test('T05/F13: whitespace and case follow owner name matching without partial-name search', () => {
  const cfg = config([]);
  const cache = contacts({ wxid: OWNER, name: `  ${NAME.toLowerCase()}  ` }, { wxid: OTHER, name: `${NAME} Extra` });
  assert.equal(care.isMasterTarget(cfg, OWNER, cache), true);
  assert.equal(care.isMasterTarget(cfg, OTHER, cache), false);
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }).map(item => item.wxid), [OWNER]);
});

test('T05/F13: two same-name private contacts are ambiguous in default and explicit lists', () => {
  const cache = contacts({ wxid: OWNER, name: NAME }, { wxid: OTHER, name: NAME });
  for (const patch of [{}, { whitelist: [OWNER] }]) {
    const cfg = config([], patch);
    const facts = master.masterTargetFacts(cfg, OWNER, cache);
    assert.equal(facts.isMaster, false);
    assert.equal(facts.ambiguous, true);
    assert.equal(facts.reason, 'ambiguous_name');
    assert.deepEqual(care.careTargets(cfg, { contacts: cache }), []);
  }
});

test('T05/F13: separate configured owner names can each have one unique candidate', () => {
  const cfg = config([]);
  cfg.persona.master.names.push('Second Fixture Owner');
  const cache = contacts({ wxid: OWNER, name: NAME }, { wxid: OTHER, name: 'Second Fixture Owner' });
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }).map(item => item.wxid), [OWNER, OTHER]);
});

test('T05/F13: account-directory aliases do not make a single legacy owner ambiguous or duplicated', () => {
  const cfg = config([]);
  const cache = contacts({ wxid: OWNER, name: NAME }, { wxid: `${OWNER}_c248`, name: NAME });
  assert.equal(master.masterTargetFacts(cfg, OWNER, cache).ambiguous, false);
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }).map(item => item.wxid), [OWNER]);
});

test('T05/F13: legacy get-only contact adapters keep their known single-name behavior', () => {
  const cfg = config([], { whitelist: [OWNER] });
  const cache = { get(id) { return id === OWNER ? { name: NAME } : null; } };
  assert.equal(care.isMasterTarget(cfg, OWNER, cache), true);
  assert.equal(care.careTargets(cfg, { contacts: cache })[0].wxid, OWNER);
});

test('T05/F13: missing contact metadata cannot synthesize a weak owner', () => {
  const cfg = config([], { whitelist: [OTHER] });
  assert.equal(care.isMasterTarget(cfg, OTHER), false);
  assert.deepEqual(care.careTargets(cfg), []);
  assert.equal(care.isMasterTarget(config([OWNER]), OWNER), true);
});

test('T05/F13: filehelper, unknown and groups cannot authenticate as proactive owners', () => {
  for (const id of ['filehelper', 'FILEHELPER', 'unknown', 'test-owner@chatroom']) {
    const cfg = config([id], { whitelist: [id] });
    const cache = contacts({ wxid: id, name: NAME });
    assert.equal(master.masterTargetFacts(cfg, id, cache).verified, false);
    assert.equal(care.isMasterTarget(cfg, id, cache), false);
    assert.deepEqual(care.careTargets(cfg, { contacts: cache }), []);
  }
});

test('T05/F13: invalid and non-person targets are refused before contact lookup', () => {
  const cache = { get() { assert.fail('non-person target must not query contacts'); } };
  for (const id of ['', 'unknown', 'filehelper', 'test-owner@chatroom']) {
    assert.equal(care.isMasterTarget(config([id]), id, cache), false);
  }
});

test('T05/F13: filehelper remains an explicitly permitted other target when onlyMaster is off', () => {
  const cfg = config([OWNER], { whitelist: ['filehelper'], onlyMaster: false });
  assert.deepEqual(care.careTargets(cfg), [{ wxid: 'filehelper', name: '文件传输助手', isGroup: false, kind: 'other' }]);
});

test('T05/F13: normalized group metadata cannot bypass the group permission switch', () => {
  const cfg = config([], { whitelist: [OTHER], onlyMaster: false, allowOthers: true });
  const cache = contacts({ wxid: OTHER, name: NAME, isGroup: true });
  assert.equal(care.isMasterTarget(cfg, OTHER, cache), false);
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }), []);
  cfg.care.allowGroups = true;
  assert.equal(care.careTargets(cfg, { contacts: cache })[0].kind, 'group');
});

test('T05/F13: contact ambiguity and live owner binding changes are not cached as authority', () => {
  const cfg = config([]);
  const cache = contacts({ wxid: OWNER, name: NAME });
  assert.equal(care.careTargets(cfg, { contacts: cache }).length, 1);
  cache.items.push(normalizeItem({ wxid: OTHER, name: NAME }));
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }), []);
  cfg.persona.master.wxids = [OTHER];
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }).map(item => item.wxid), [OTHER]);
  cfg.persona.master.wxids = [OWNER];
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }).map(item => item.wxid), [OWNER]);
});

test('T05/F13: whitelist and mute edits are rechecked without a stale owner bypass', () => {
  const cfg = config([OWNER], { whitelist: [OWNER] });
  const cache = contacts({ wxid: OWNER, name: NAME });
  assert.equal(care.careTargets(cfg, { contacts: cache }).length, 1);
  cfg.group = { mutedGroups: [OWNER] };
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }), []);
  cfg.group.mutedGroups = [];
  assert.equal(care.careTargets(cfg, { contacts: cache }).length, 1);
  cfg.wechat = { whitelistOnly: true };
  cfg.care.whitelist = [];
  assert.deepEqual(care.careTargets(cfg, { contacts: cache }), []);
});

test('T05/F13: existing public owner and care exports remain available', () => {
  for (const name of ['matchMaster', 'masterWarnings', 'masterLists', 'looksLikeWxid', 'isVerifiedOwner', 'sameWxid', 'stripAccountHash']) {
    assert.equal(typeof master[name], 'function', name);
  }
  for (const name of ['careTargets', 'careDecide', 'careWhitelist', 'defaultWhitelist', 'isMasterTarget']) assert.equal(typeof care[name], 'function', name);
});
