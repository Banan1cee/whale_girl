'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const care = require('../src/services/care');
const { parseBoolean } = require('../src/infra/configValues');
const features = require('../src/infra/features');

const OWNER = 'wxid_test_boolean_owner';
const OTHER = 'wxid_test_boolean_other';
const GROUP = 'test-boolean-group@chatroom';
const FILE = 'filehelper';
const config = (patch = {}) => ({
  persona: { master: { wxids: [OWNER], names: ['Fixture Owner'] } },
  care: { whitelist: [OWNER, OTHER, GROUP, FILE], ...patch },
});
const ids = (cfg, options) => care.careTargets(cfg, options).map(item => item.wxid).sort();
const expected = (onlyMaster, others, groups) => [OWNER, ...(!onlyMaster ? [FILE, ...(others ? [OTHER] : []), ...(groups ? [GROUP] : [])] : [])].sort();

test('T05/F07: string onlyMaster true overrides allowOthers true', () => {
  assert.deepEqual(ids(config({ onlyMaster: 'true', allowOthers: true, allowGroups: true })), [OWNER]);
});

test('T05/F07: string false option overrides never grant permissions', () => {
  const cfg = config({ onlyMaster: false, allowOthers: true, allowGroups: true });
  assert.deepEqual(ids(cfg, { allowOthers: 'false', allowGroups: 'false' }), [FILE, OWNER].sort());
});

test('T05/F07: supplied undefined onlyMaster is restrictive while an omitted field keeps its domain fallback', () => {
  const omitted = config({ allowOthers: true });
  const supplied = config({ onlyMaster: undefined, allowOthers: true });
  assert.deepEqual(ids(omitted), [OWNER, OTHER, FILE].sort());
  assert.deepEqual(ids(supplied), [OWNER]);
});
