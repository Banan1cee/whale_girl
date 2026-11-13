'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const backup = require('../src/memory/backup');
const { recoverRestore } = require('../src/memory/backupRestore');
const { Store } = require('../src/memory/store');

const KEY = 'wechat:u:test-t08-startup';
const appFile = path.resolve(__dirname, '../src/app.js');

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t08-startup-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 }));
  const root = path.join(parent, 'target');
  const incoming = path.join(parent, 'incoming');
  for (const [dir, text] of [[root, 'original fixture message'], [incoming, 'restored fixture message']]) {
    const data = path.join(dir, 'data');
    const store = new Store({ file: path.join(data, 'store.json'), logger: null });
    store.appendMessage(KEY, { role: 'user', uid: 'test-startup', name: 'fixture', text });
    store.close();
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ userName: text }));
  }
  const data = path.join(root, 'data');
  const cold = path.join(data, 'memory/archive/cold.bin');
  const legacy = path.join(data, 'memory/legacy/nested/old.json');
  fs.mkdirSync(path.dirname(cold), { recursive: true });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(cold, Buffer.from([0, 42, 255]));
  fs.writeFileSync(legacy, '{"fixture":true}');
  return { parent, root, data, cold, legacy, bundle: backup.collect(incoming) };
}

function interrupt(f, phase) {
  const source = `
    const fs = require('node:fs');
    const path = require('node:path');
    const backup = require(${JSON.stringify(require.resolve('../src/memory/backup'))});
    const [root, raw, phase] = process.argv.slice(1);
    const rename = fs.renameSync;
    const write = fs.writeFileSync;
    fs.writeFileSync = function(file, ...args) {
      const result = write.call(fs, file, ...args);
      if (phase === 'prepared' && String(file).includes('.memory-restore-') && path.basename(file) === 'ready') process.exit(79);
      return result;
    };
    fs.renameSync = function(from, to) {
      const result = rename.call(fs, from, to);
      if ((phase === 'original-moved' && from === path.join(root,'data','memory'))
        || (phase === 'memory-published' && from.endsWith(path.join('prepared','memory')))
        || (phase === 'all-published' && from.endsWith(path.join('prepared','settings.json')))
        || (phase === 'committed' && path.basename(to) === 'committed')) process.exit(79);
      return result;
    };
    backup.restoreFrom(root, JSON.parse(raw));
  `;
  const child = spawnSync(process.execPath, ['-e', source, f.root, JSON.stringify(f.bundle), phase], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 79, child.stderr || child.error?.message);
}

/** Execute the actual assembly function, with every unrelated service stubbed and stop at Store. */
function startup(f, onStore, recovery = recoverRestore) {
  const events = [];
  const warnings = [];
  const stop = new Error('fixture stopped at Store boundary');
  const logger = { warn: message => warnings.push(message), info() {}, child() { return this; } };
  const config = { paths: { storeFile: path.join(f.data, 'store.json') }, log: { level: 'error' }, memory: {} };
  const stubs = {
    'node:path': path,
    './infra/config': {
      ensureConfigFile(root) { assert.equal(root, f.root); events.push('config'); },
      loadConfig() { return config; },
    },
    './infra/logger': { createLogger() { return logger; } },
    './infra/ownerName': { migrateOwnerName() {} },
    './infra/probe': { now() { return 0; }, startEventLoopProbe() { return null; } },
    './infra/configSchema': { validate() { return []; } },
    './infra/features': { isOn() { return false; } },
    './persona/store': { load() { return {}; }, apply() {} },
    './memory/backupRestore': { recoverRestore(dir) { events.push('recover'); assert.equal(dir, f.data); recovery(dir); } },
    './memory/store': { Store: class {
      constructor(options) { events.push('Store'); onStore(options); throw stop; }
    } },
    '../package.json': { version: 'fixture' },
  };
  const box = { exports: {} };
  vm.runInNewContext(fs.readFileSync(appFile, 'utf8'), {
    module: box, require(name) {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      // No real services, timers, watchers, logger streams, plugins or network are constructed.
      return {};
    },
  }, { filename: appFile });
  return { run: () => box.exports.createRuntime({ root: f.root, env: { WHALE_LOG_FILE: '' } }), events, warnings, stop };
}

for (const phase of ['prepared', 'original-moved', 'memory-published', 'all-published', 'committed']) {
  test(`T08 startup: ${phase} interruption is recovered before Store opens`, t => {
    const f = fixture(t);
    interrupt(f, phase);
    const expected = phase === 'committed' ? 'restored fixture message' : 'original fixture message';
    const app = startup(f, options => {
      assert.deepEqual(fs.readFileSync(f.cold), Buffer.from([0, 42, 255]));
      assert.equal(fs.readFileSync(f.legacy, 'utf8'), '{"fixture":true}');
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'settings.json'))).userName, expected);
      assert.equal(fs.readdirSync(f.data).some(name => name.startsWith('.memory-restore-')), false);
      const store = new Store({ ...options, logger: null });
      try { assert.equal(store.messages(KEY, 10)[0].text, expected); } finally { store.close(); }
    });
    assert.throws(app.run, error => error === app.stop);
    assert.deepEqual(app.events, ['recover', 'config', 'Store']);
    assert.deepEqual(app.warnings, []);
  });
}

test('T08 startup: recovery rename failure propagates before Store can create a replacement tree', t => {
  const f = fixture(t);
  interrupt(f, 'original-moved');
  const failure = Object.assign(new Error('fixture startup rollback EACCES'), { code: 'EACCES' });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith(path.join('previous', 'memory'))) throw failure;
    return rename(from, to);
  });
  const app = startup(f, () => assert.fail('Store must not open after recovery failure'));
  assert.throws(app.run, error => error === failure);
  assert.deepEqual(app.events, ['recover']);
  assert.deepEqual(app.warnings, []);
  assert.equal(fs.existsSync(path.join(f.data, 'memory')), false);
  const transaction = fs.readdirSync(f.data).find(name => name.startsWith('.memory-restore-'));
  assert.deepEqual(fs.readFileSync(path.join(f.data, transaction, 'previous/memory/archive/cold.bin')), Buffer.from([0, 42, 255]));
});

test('T08 startup: ordinary Store constructor failures retain their original identity', t => {
  const f = fixture(t);
  const failure = new Error('fixture Store constructor failure');
  const app = startup(f, () => { throw failure; });
  assert.throws(app.run, error => error === failure);
  assert.deepEqual(app.events, ['recover', 'config', 'Store']);
  assert.deepEqual(app.warnings, []);
});

test('T08 startup: empty isolated data root is only created by Store after recovery', t => {
  const f = fixture(t);
  f.root = path.join(f.parent, 'fresh');
  f.data = path.join(f.root, 'data');
  const app = startup(f, options => {
    assert.equal(fs.existsSync(f.data), false);
    const store = new Store({ ...options, logger: null });
    store.close();
    assert.equal(fs.existsSync(path.join(f.data, 'memory')), true);
  });
  assert.throws(app.run, error => error === app.stop);
  assert.deepEqual(app.events, ['recover', 'config', 'Store']);
});
