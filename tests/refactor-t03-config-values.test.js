'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { loadConfig, DEFAULT_CONFIG } = require('../src/infra/config');
const schema = require('../src/infra/configSchema');
const patcher = require('../src/infra/configPatch');
const features = require('../src/infra/features');
const location = require('../src/services/location');
const { saveLocalConfiguration } = require('../src/services/launcherSnapshot');

function fixture(t, initial = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t03-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('whale-t03-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ features: { envContext: false }, env: { autoDetect: false }, ...initial }));
  const config = loadConfig({ root, env: { T03_ENV_FIXTURE: 'inherited' }, readOnly: true });
  const events = [];
  t.mock.method(location, 'startAutoProbe', () => { events.push('location'); return () => { events.push('stopLocation'); }; });
  const runtime = {
    config, logger: { info() {}, warn() {}, error() {} },
    store: { replan() { events.push('store'); } },
    stopLocationProbe() { events.push('stopLocation'); },
    momentsPublisher: { reconcile() { events.push('publisher'); } },
    moments: { startAutoRead() { events.push('moments'); } },
    stickerService: { reconcile() { events.push('sticker'); } },
    llm: { reload() { events.push('llm'); } },
  };
  return { root, file, config, runtime, events, raw: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

const writers = {
  runtime: (f, patch) => patcher.applyConfigPatch(f.runtime, patch),
  config: (f, patch) => patcher.saveConfigPatch(f.config, patch),
};
const boolPaths = [...new Set([
  ...Object.entries(schema.FIELDS).filter(([, spec]) => spec.type === 'bool').map(([name]) => name),
  ...features.REGISTRY.map(entry => entry.path),
])];
const boolCases = [
  [true, true], [false, false], [1, true], [0, false], ['true', true], ['false', false],
  ['yes', true], ['no', false], ['on', true], ['off', false], ['TRUE', true], [' true ', true], ['开', true], ['关', false],
];

for (const [name, write] of Object.entries(writers)) {
  test(name + ': all schema and registry booleans use the accepted value matrix', t => {
    const f = fixture(t);
    for (const [input, expected] of boolCases) {
      write(f, Object.fromEntries(boolPaths.map(dotted => [dotted, input])));
      const saved = f.raw();
      for (const dotted of boolPaths) {
        assert.equal(patcher.getByPath(saved, dotted), expected, dotted + ' input=' + JSON.stringify(input));
        assert.equal(patcher.getByPath(f.config, dotted), expected, dotted);
      }
    }
  });

  test(name + ': invalid booleans fail the whole batch before disk or memory changes', t => {
    const f = fixture(t, { group: { requireAt: true } });
    for (const value of ['', 'invalid', 2, null, undefined, [], {}]) {
      const before = fs.readFileSync(f.file, 'utf8');
      const memory = JSON.stringify(f.config);
      assert.throws(() => write(f, { 'group.requireAt': false, 'links.enabled': value }), err => err.statusCode === 400);
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
      assert.equal(JSON.stringify(f.config), memory);
      assert.deepEqual(f.events, []);
    }
  });

  test(name + ': blank or absent numeric inputs are not zero; explicit zero remains valid', t => {
    const f = fixture(t, { group: { cooldownSec: 45 } });
    for (const value of ['', ' ', null, undefined, [], {}, false, NaN, Infinity]) {
      const before = fs.readFileSync(f.file, 'utf8');
      assert.throws(() => write(f, { 'group.cooldownSec': value }), err => err.statusCode === 400);
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
      assert.equal(f.config.group.cooldownSec, 45);
    }
    for (const value of [0, '0']) {
      write(f, { 'group.cooldownSec': value, 'deepseek.temperature': value });
      assert.equal(f.raw().group.cooldownSec, 0);
      assert.equal(f.raw().deepseek.temperature, 0);
    }
  });

  test(name + ': blank secrets preserve stored values, but admin.spell can clear explicitly', t => {
    const f = fixture(t, { deepseek: { apiKey: 'test-placeholder-key' }, admin: { spell: 'test-placeholder-spell' } });
    for (const value of ['', null, undefined]) {
      write(f, { 'deepseek.apiKey': value, 'admin.spell': '' });
      assert.equal(f.raw().deepseek.apiKey, 'test-placeholder-key');
      assert.equal(f.config.deepseek.apiKey, 'test-placeholder-key');
      assert.equal(f.raw().admin.spell, '');
    }
  });

  test(name + ': partial nested schema/feature patches preserve siblings and opaque JSON', t => {
    const f = fixture(t, { group: { requireAt: true, cooldownSec: 45 }, features: { envContext: false, stickers: true } });
    write(f, { group: { requireAt: 'no' }, features: { javascriptPlugins: 'yes' },
      'gateway.wechat.outboundHeaders': { 'X-Test': 'fixture' } });
    assert.equal(f.raw().group.requireAt, false);
    assert.equal(f.raw().group.cooldownSec, 45);
    assert.equal(f.raw().features.stickers, true);
    assert.equal(f.raw().features.javascriptPlugins, true);
    assert.deepEqual(f.raw().gateway.wechat.outboundHeaders, { 'X-Test': 'fixture' });
  });

  test(name + ': forbidden paths reject before persistence, including a top-level __proto__', t => {
    const f = fixture(t);
    for (const patch of [JSON.parse('{"__proto__":{"t03":true}}'), { 'constructor.prototype.t03': true }, { 'env.prototype.t03': true }]) {
      const before = fs.readFileSync(f.file, 'utf8');
      assert.throws(() => write(f, patch));
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
      assert.equal({}.t03, undefined);
    }
  });

  test(name + ': malformed JSON and non-object roots cannot be overwritten', t => {
    const f = fixture(t);
    for (const text of ['{"broken":', '[]', 'null', '"text"']) {
      fs.writeFileSync(f.file, text);
      const memory = JSON.stringify(f.config);
      assert.throws(() => write(f, { 'group.cooldownSec': 0 }), err => err.statusCode === 500);
      assert.equal(fs.readFileSync(f.file, 'utf8'), text);
      assert.equal(JSON.stringify(f.config), memory);
    }
  });

  test(name + ': failed persistence leaves runtime configuration unchanged', t => {
    const f = fixture(t);
    const before = JSON.stringify(f.config);
    const original = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (file === f.file) throw Object.assign(new Error('isolated write failure'), { code: 'EACCES' });
      return original(file, ...args);
    });
    assert.throws(() => write(f, { 'group.cooldownSec': 0 }), /isolated write failure/);
    assert.equal(JSON.stringify(f.config), before);
    assert.deepEqual(f.events, []);
  });
}

test('schema numeric matrix agrees with patch parsing, while omission still means default', () => {
  for (const type of ['int', 'float']) {
    for (const value of ['', ' ', null, [], {}, false, undefined, NaN, Infinity]) {
      assert.ok(schema.checkValue(value, { type, min: 0 }), type + ' input=' + JSON.stringify(value));
    }
    for (const value of [0, '0', ' 0 ']) assert.equal(schema.checkValue(value, { type, min: 0 }), null);
  }
  assert.deepEqual(schema.validate({}), []);
  assert.deepEqual(schema.validate(DEFAULT_CONFIG), []);
});

test('public feature reader retains legacy permissive fallbacks', () => {
  for (const [input, expected] of boolCases) assert.equal(features.toBool(input, !expected), expected);
  assert.equal(features.toBool(undefined, true), true);
  assert.equal(features.toBool(null, true), true);
  assert.equal(features.toBool('', true), false);
  assert.equal(features.toBool(2, false), true);
  assert.equal(features.toBool('unknown', true), true);
  assert.equal(features.toBool(['yes'], false), true);
});

test('API save and file watch reconcile the same effects once, preserving references and env prototype', t => {
  const f = fixture(t);
  const configRef = f.config;
  const envRef = f.config.env;
  const envProto = Object.getPrototypeOf(envRef);
  const groupRef = f.config.group;
  const expected = ['store', 'stopLocation', 'location', 'publisher', 'moments', 'sticker', 'llm'];
  patcher.applyConfigPatch(f.runtime, { 'env.timezone': 'Asia/Shanghai', 'group.cooldownSec': 0 });
  assert.deepEqual(f.events, expected);
  let changed;
  let debounce;
  t.mock.method(fs, 'watch', (_file, callback) => {
    changed = callback;
    return { unref() {}, on() {}, close() {} };
  });
  t.mock.method(global, 'setTimeout', callback => { debounce = callback; return {}; });
  t.mock.method(global, 'clearTimeout', () => {});
  patcher.watchConfigFile(f.runtime);
  fs.writeFileSync(f.file, JSON.stringify({ features: { envContext: false }, group: { cooldownSec: 4 }, env: { timezone: 'UTC', autoDetect: false } }));
  f.events.length = 0;
  changed(); debounce();
  assert.deepEqual(f.events, expected);
  assert.equal(f.runtime.config, configRef);
  assert.equal(f.config.env, envRef);
  assert.equal(Object.getPrototypeOf(f.config.env), envProto);
  assert.equal(f.config.env.T03_ENV_FIXTURE, 'inherited');
  assert.equal(f.config.group, groupRef);
  assert.equal(f.config.group.cooldownSec, 4);
  for (const broken of ['{', '[]']) {
    fs.writeFileSync(f.file, broken); f.events.length = 0;
    changed(); debounce();
    assert.deepEqual(f.events, []);
    assert.equal(f.config.group.cooldownSec, 4);
  }
  f.runtime.stopConfigWatch();
});

async function onlineFeature(f, body) {
  let handler;
  require('../src/http/routes/features')({ get() {}, post(_path, fn) { handler = fn; } });
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { 'content-type': 'application/json' };
  let output;
  await handler(f.runtime, req, { writeHead() {}, end(value) { output = JSON.parse(value); } });
  return output;
}

test('online and offline feature commands accept identical legacy values and preserve response fields', async t => {
  const online = fixture(t);
  const offline = fixture(t);
  for (const value of ['yes', 'on', 'TRUE', '开', false, 'off', 0]) {
    const body = { key: 'stickers', value };
    const response = await onlineFeature(online, body);
    const local = await saveLocalConfiguration(offline.root, { path: '/api/features', body }, {});
    assert.equal(response.ok, true);
    assert.equal(response.key, 'stickers');
    assert.equal(response.value, features.toBool(value));
    assert.equal(local.ok, true);
    assert.equal(online.raw().features.stickers, offline.raw().features.stickers);
    assert.equal(local.features.find(entry => entry.key === 'stickers').value, response.value);
  }
});

test('offline partial Moments fields leave other settings and publishing flags intact', async t => {
  const f = fixture(t, { moments: { autoLike: true, autoLikeMaxPerDay: 7, autoReadEveryHours: 6,
    publishFeatureEnabled: true, publishEnabled: true, publishWithImage: true,
    publishAccount: 'test-account', publishIntervalHours: 8, publishMaxPerDay: 3 } });
  await saveLocalConfiguration(f.root, { path: '/api/moments/settings', body: { autoLike: false } }, {});
  assert.equal(f.raw().moments.autoLike, false);
  assert.equal(f.raw().moments.autoLikeMaxPerDay, 7);
  assert.equal(f.raw().moments.autoReadEveryHours, 6);
  await saveLocalConfiguration(f.root, { path: '/api/moments/publish-settings', body: { interval: 12 } }, {});
  assert.deepEqual(f.raw().moments, { autoLike: false, autoLikeMaxPerDay: 7, autoReadEveryHours: 6,
    publishFeatureEnabled: true, publishEnabled: true, publishWithImage: true,
    publishAccount: 'test-account', publishIntervalHours: 12, publishMaxPerDay: 3 });
});

test('Moments command preparation preserves strict publishing confirmation and selects only own fields', () => {
  const commands = require('../src/services/configCommands');
  const current = { featureEnabled: true, enabled: true };
  assert.deepEqual(commands.prepareMomentsPublishPatch({ withImage: false }, current), { 'moments.publishWithImage': false });
  assert.deepEqual(commands.prepareMomentsPublishPatch({ featureEnabled: false }, current), {
    'moments.publishFeatureEnabled': false, 'moments.publishEnabled': false,
  });
  assert.deepEqual(commands.prepareMomentsPublishPatch({ featureEnabled: 'true', enabled: 'true' }, current), {
    'moments.publishFeatureEnabled': false, 'moments.publishEnabled': false,
  });
  assert.deepEqual(commands.prepareMomentsPublishPatch({ enabled: true, account: 'forged-account' }, { featureEnabled: false }), {
    'moments.publishEnabled': false,
  });
  assert.deepEqual(commands.prepareMomentsSettingsPatch(Object.create({ autoLike: true })), {});
  assert.deepEqual(commands.prepareMomentsPublishPatch(Object.create({ enabled: true }), current), {});
});

test('offline publishing can change enabled alone with an existing confirmed account, without clearing other fields', async t => {
  const f = fixture(t, { moments: { publishFeatureEnabled: true, publishEnabled: false,
    publishAccount: 'test-account', publishWithImage: true, publishIntervalHours: 8, publishMaxPerDay: 3 } });
  const response = await saveLocalConfiguration(f.root, { path: '/api/moments/publish-settings', body: { enabled: true } }, {});
  assert.equal(response.ok, true);
  assert.deepEqual(f.raw().moments, { publishFeatureEnabled: true, publishEnabled: true,
    publishAccount: 'test-account', publishWithImage: true, publishIntervalHours: 8, publishMaxPerDay: 3 });
});

test('offline saves never initiate location probing or fabricate account confirmation', async t => {
  const f = fixture(t, { features: { envContext: true }, env: { autoDetect: true },
    moments: { publishFeatureEnabled: true, publishEnabled: false, publishWithImage: true } });
  let probes = 0;
  t.mock.method(location, 'startAutoProbe', () => { probes++; return () => {}; });
  await saveLocalConfiguration(f.root, { path: '/api/config', body: { patch: { 'group.cooldownSec': 0 } } }, {});
  assert.equal(probes, 0);
  const before = fs.readFileSync(f.file, 'utf8');
  const denied = await saveLocalConfiguration(f.root, { path: '/api/moments/publish-settings', body: { enabled: true, account: 'forged-account', confirm: true } }, {});
  assert.equal(denied.ok, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  const needsKernel = await saveLocalConfiguration(f.root, { path: '/api/moments/publish-test', body: { confirm: true } }, {});
  assert.equal(needsKernel.ok, false);
});
