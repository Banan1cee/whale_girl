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

const encodings = [
  ['native', true, false], ['numeric', 1, 0], ['literal strings', 'true', 'false'],
  ['numeric strings', '1', '0'], ['yes/no', 'yes', 'no'], ['on/off', 'on', 'off'],
  ['Chinese', '开', '关'], ['upper/trim', ' TRUE ', ' FALSE '], ['mixed case', ' YeS ', ' oFF '],
];
for (const [label, on, off] of encodings) {
  for (const scope of ['config', 'overrides']) {
    test(`T05/F07: ${label} ${scope} preserves the full three-switch permission matrix`, () => {
      assert.equal(parseBoolean(on), true);
      assert.equal(parseBoolean(off), false);
      for (let mask = 0; mask < 8; mask++) {
        const master = Boolean(mask & 1), others = Boolean(mask & 2), groups = Boolean(mask & 4);
        const patch = { onlyMaster: master ? on : off, allowOthers: others ? on : off, allowGroups: groups ? on : off };
        const cfg = scope === 'config' ? config(patch) : config({ onlyMaster: !master, allowOthers: !others, allowGroups: !groups });
        assert.deepEqual(ids(cfg, scope === 'overrides' ? patch : undefined), expected(master, others, groups), `mask=${mask}`);
      }
    });
  }
}

const invalid = [undefined, null, '', '   ', 2, -1, NaN, Infinity, '2', 'invalid', [], {}, ['true']];
for (const key of ['onlyMaster', 'allowOthers', 'allowGroups']) {
  test(`T05/F07: supplied invalid ${key} is restrictive in config and overrides`, () => {
    const base = key === 'onlyMaster' ? { onlyMaster: false, allowOthers: true, allowGroups: true }
      : { onlyMaster: false, allowOthers: key === 'allowOthers', allowGroups: key === 'allowGroups' };
    const wanted = key === 'onlyMaster' ? [OWNER] : [OWNER, FILE].sort();
    for (const value of invalid) {
      assert.equal(parseBoolean(value), undefined);
      assert.deepEqual(ids(config({ ...base, [key]: value })), wanted);
      assert.deepEqual(ids(config(base), { [key]: value }), wanted);
    }
  });
}

test('T05/F07: omitted onlyMaster keeps the configured allowOthers fallback and override precedence', () => {
  assert.deepEqual(ids(config()), [OWNER]);
  assert.deepEqual(ids(config({ allowOthers: 'yes', allowGroups: 'on' })), expected(false, true, true));
  assert.deepEqual(ids(config({ allowOthers: 'off', allowGroups: 'on' })), [OWNER]);
  // An allowOthers-only test override has never implicitly switched off the configured master restriction.
  assert.deepEqual(ids(config(), { allowOthers: true }), [OWNER]);
  assert.deepEqual(ids(config({ allowOthers: true }), { allowOthers: false }), [OWNER, FILE].sort());
});

test('T05/F07: explicit undefined permission overrides revoke a configured grant', () => {
  const cfg = config({ onlyMaster: false, allowOthers: true, allowGroups: true });
  assert.deepEqual(ids(cfg, { allowOthers: undefined, allowGroups: undefined }), [OWNER, FILE].sort());
  assert.deepEqual(ids(cfg), expected(false, true, true));
});

test('T05/F07: default filehelper follows normalized onlyMaster without authenticating as owner', () => {
  for (const [, , off] of encodings) {
    const cfg = config({ onlyMaster: off, allowOthers: false });
    delete cfg.care.whitelist;
    assert.deepEqual(care.defaultWhitelist(cfg), [OWNER, FILE]);
    assert.equal(care.isMasterTarget(cfg, FILE), false);
  }
  const invalidMaster = config({ onlyMaster: undefined, allowOthers: true });
  delete invalidMaster.care.whitelist;
  assert.deepEqual(care.defaultWhitelist(invalidMaster), [OWNER]);
});

test('T05/F07: filtered decision metadata uses the same normalized permissions as selection', () => {
  for (const [onlyMaster, allowOthers, allowGroups, wanted] of [
    ['YES', 'ON', '开', [true, true, true]], ['OFF', 'NO', 'FALSE', [false, false, false]],
  ]) {
    const cfg = config({ onlyMaster, allowOthers, allowGroups, whitelist: [OTHER], windows: ['00:00-23:59'] });
    cfg.env = { timezone: 'UTC' };
    const result = care.careDecide(cfg, { now: Date.UTC(2026, 0, 1, 12) });
    assert.equal(result.due, false);
    assert.equal(result.reason, 'whitelist_filtered');
    assert.deepEqual([result.onlyMaster, result.allowOthers, result.allowGroups], wanted);
  }
});

test('T05/F07: runtime string switch, whitelist and mute changes are re-evaluated', () => {
  const cfg = config({ onlyMaster: 'false', allowOthers: 'yes', whitelist: [OTHER] });
  assert.deepEqual(ids(cfg), [OTHER]);
  cfg.care.onlyMaster = 'true';
  assert.deepEqual(ids(cfg), []);
  cfg.care.onlyMaster = 'false';
  cfg.group = { mutedGroups: [OTHER] };
  assert.deepEqual(ids(cfg), []);
  cfg.group.mutedGroups = [];
  assert.deepEqual(ids(cfg), [OTHER]);
  cfg.wechat = { whitelistOnly: true };
  cfg.care.whitelist = [];
  assert.deepEqual(ids(cfg), []);
});

test('T05/F07: normalized switches retain the F13 hard-ID identity barrier', () => {
  const cfg = config({ onlyMaster: 'true', allowOthers: 'true', whitelist: [OTHER] });
  const item = { wxid: OTHER, name: 'Fixture Owner', label: 'Fixture Owner' };
  const contacts = { items: [item], get(id) { return id === OTHER ? item : null; } };
  assert.equal(care.isMasterTarget(cfg, OTHER, contacts), false);
  assert.deepEqual(ids(cfg, { contacts }), []);
});

test('T05/F07: strict permissions do not change the legacy feature reader contract', () => {
  assert.equal(parseBoolean(2), undefined);
  assert.equal(features.toBool(2, false), true);
  assert.equal(features.toBool('', true), false);
  assert.equal(features.toBool(['yes'], false), true);
  assert.equal(features.toBool(undefined, true), true);
});
