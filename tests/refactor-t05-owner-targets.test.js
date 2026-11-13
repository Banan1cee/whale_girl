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
