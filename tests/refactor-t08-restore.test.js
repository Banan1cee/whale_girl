'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const backup = require('../src/memory/backup');
const { recoverRestore } = require('../src/memory/backupRestore');

function seed(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t08-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 }));
  const data = path.join(root, 'data');
  const memory = path.join(data, 'memory');
  const original = {
    'manifest.json': '{"old":true}',
    'chats/aaaaaaaaaaaaaaaa/messages.jsonl': '{"fixture":true}\n',
    'archive/cold/old.bin': Buffer.from([0, 1, 255]),
    'legacy/old.json': '{"legacy":true}',
  };
  for (const [rel, body] of Object.entries(original)) {
    const file = path.join(memory, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  fs.writeFileSync(path.join(data, 'settings.json'), '{"provider":"fixture","userName":"before"}');
  const bundle = { kind: 'whale-girl-memory', version: 2, files: { memory: {
    'manifest.json': '{"new":true}',
    'chats/bbbbbbbbbbbbbbbb/messages.jsonl': '{"restored":true}\n',
  }, settings: { userName: 'after' } } };
  return { root, data, memory, original, bundle };
}

function assertOriginal(fixture) {
  for (const [rel, body] of Object.entries(fixture.original)) {
    assert.deepEqual(fs.readFileSync(path.join(fixture.memory, rel)), Buffer.from(body), rel);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.data, 'settings.json'))).userName, 'before');
}

test('T08/F17: archive copy failure aborts before replacing active or cold memory', t => {
  const fixture = seed(t);
  const cp = fs.cpSync;
  let injected = false;
  t.mock.method(fs, 'cpSync', (from, to, options) => {
    if (from === path.join(fixture.memory, 'archive')) {
      injected = true;
      throw Object.assign(new Error('T08 fixture archive copy failure'), { code: 'EACCES' });
    }
    return cp(from, to, options);
  });
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), { code: 'EACCES' });
  assert.equal(injected, true);
  assertOriginal(fixture);
});

function assertRestored(fixture) {
  for (const [rel, body] of Object.entries(fixture.bundle.files.memory)) {
    assert.equal(fs.readFileSync(path.join(fixture.memory, rel), 'utf8'), body);
  }
  for (const rel of Object.keys(fixture.original).filter(name => /^(archive|legacy)\//.test(name))) {
    assert.deepEqual(fs.readFileSync(path.join(fixture.memory, rel)), Buffer.from(fixture.original[rel]));
  }
  assert.equal(fs.existsSync(path.join(fixture.memory, 'chats', 'aaaaaaaaaaaaaaaa')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.data, 'settings.json'))).userName, 'after');
}

test('T08: recursive legacy and binary archive survive repeated restoration', t => {
  const fixture = seed(t);
  const rel = 'legacy/nested/migration.bin';
  fixture.original[rel] = Buffer.from([42, 0, 254]);
  fs.mkdirSync(path.dirname(path.join(fixture.memory, rel)), { recursive: true });
  fs.writeFileSync(path.join(fixture.memory, rel), fixture.original[rel]);
  fixture.bundle.files.memory['archive/bundle.txt'] = 'bundle archive addition';
  fixture.bundle.files.memory['legacy/old.json'] = 'overridden by retained legacy';
  for (let i = 0; i < 2; i++) {
    const result = backup.restoreFrom(fixture.root, fixture.bundle);
    assert.deepEqual(result.restored, ['memory/', 'settings.json']);
    assert.deepEqual(fs.readFileSync(path.join(fixture.memory, rel)), fixture.original[rel]);
    assert.equal(fs.readFileSync(path.join(fixture.memory, 'legacy/old.json'), 'utf8'), fixture.original['legacy/old.json']);
    assert.deepEqual(fs.readFileSync(path.join(fixture.memory, 'archive/cold/old.bin')), fixture.original['archive/cold/old.bin']);
  }
});

test('T08: legacy copy failure leaves original tree and settings unchanged', t => {
  const fixture = seed(t);
  const cp = fs.cpSync;
  t.mock.method(fs, 'cpSync', (from, to, options) => {
    if (from === path.join(fixture.memory, 'legacy')) throw new Error('fixture legacy copy failure');
    return cp(from, to, options);
  });
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), /legacy copy failure/);
  assertOriginal(fixture);
});

test('T08: archive metadata access failure cannot be treated as missing cold data', t => {
  const fixture = seed(t);
  const stat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === path.join(fixture.memory, 'archive')) throw Object.assign(new Error('fixture archive access failure'), {code:'EACCES'});
    return stat(file, ...args);
  });
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), {code:'EACCES'});
  assertOriginal(fixture);
});

test('T08: retained archive read failure aborts verification without publication', t => {
  const fixture = seed(t);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === path.join(fixture.memory, 'archive/cold/old.bin')) throw new Error('fixture archive read failure');
    return read(file, ...args);
  });
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), /archive read failure/);
  // The injector also guards the assertion path, so remove it before reading originals.
  fs.readFileSync.mock.restore();
  assertOriginal(fixture);
});

test('T08: silent archive copy corruption is detected before publication', t => {
  const fixture = seed(t);
  const cp = fs.cpSync;
  t.mock.method(fs, 'cpSync', (from, to, options) => {
    cp(from, to, options);
    if (from === path.join(fixture.memory, 'archive')) fs.writeFileSync(path.join(to, 'cold/old.bin'), 'truncated');
  });
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), /校验失败/);
  assertOriginal(fixture);
});

for (const target of ['messages.jsonl', 'settings.json', 'ready']) {
  test(`T08: preparation write failure at ${target} preserves every original`, t => {
    const fixture = seed(t);
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (String(file).includes('.memory-restore-') && path.basename(file) === target) throw new Error('fixture preparation write failure');
      return write(file, ...args);
    });
    assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), /preparation write failure/);
    assertOriginal(fixture);
  });
}

test('T08: truncated prepared active file is rejected before exchange', t => {
  const fixture = seed(t);
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, body, ...args) => {
    if (String(file).includes('.memory-restore-') && path.basename(file) === 'messages.jsonl') body = 'truncated';
    return write(file, body, ...args);
  });
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), /校验失败/);
  assertOriginal(fixture);
});

for (const phase of ['original-memory', 'prepared-memory', 'prepared-settings', 'commit']) {
  test(`T08: ${phase} rename failure rolls back all published targets`, t => {
    const fixture = seed(t);
    const rename = fs.renameSync;
    const fault = t.mock.method(fs, 'renameSync', (from, to) => {
      const selected = phase === 'original-memory' ? from === fixture.memory
        : phase === 'prepared-memory' ? from.endsWith(path.join('prepared', 'memory'))
          : phase === 'prepared-settings' ? from.endsWith(path.join('prepared', 'settings.json'))
            : path.basename(to) === 'committed';
      if (selected) throw new Error('fixture exchange failure');
      return rename(from, to);
    });
    assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), /exchange failure/);
    assertOriginal(fixture);
    fault.mock.restore();
    backup.restoreFrom(fixture.root, fixture.bundle);
    assertRestored(fixture);
  });
}

test('T08: rollback failure keeps previous tree for next restore entry', t => {
  const fixture = seed(t);
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith(path.join('prepared', 'memory')) || from.endsWith(path.join('previous', 'memory'))) throw new Error('fixture publish/rollback failure');
    return rename(from, to);
  });
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), AggregateError);
  assert.equal(fs.existsSync(fixture.memory), false);
  const transaction = fs.readdirSync(fixture.data).find(name => name.startsWith('.memory-restore-'));
  assert.deepEqual(fs.readFileSync(path.join(fixture.data, transaction, 'previous/memory/archive/cold/old.bin')), fixture.original['archive/cold/old.bin']);
  fault.mock.restore();
  const write = fs.writeFileSync;
  const stop = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).includes('.memory-restore-') && path.basename(file) === 'manifest.json') throw new Error('fixture stop next preparation');
    return write(file, ...args);
  });
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), /stop next preparation/);
  assertOriginal(fixture);
  stop.mock.restore();
  backup.restoreFrom(fixture.root, fixture.bundle);
  assertRestored(fixture);
});

for (const phase of ['prepared', 'original-moved', 'memory-published', 'all-published', 'committed']) {
  test(`T08: isolated process interruption at ${phase} is recoverable`, t => {
    const fixture = seed(t);
    const source = `
      const fs = require('node:fs');
      const path = require('node:path');
      const backup = require(${JSON.stringify(require.resolve('../src/memory/backup'))});
      const [root, raw, phase] = process.argv.slice(1);
      const memory = path.join(root, 'data', 'memory');
      const rename = fs.renameSync;
      const write = fs.writeFileSync;
      fs.writeFileSync = function(file, ...args) {
        const result = write.call(fs, file, ...args);
        if (phase === 'prepared' && String(file).includes('.memory-restore-') && path.basename(file) === 'ready') process.exit(79);
        return result;
      };
      fs.renameSync = function(from, to) {
        const result = rename.call(fs, from, to);
        if ((phase === 'original-moved' && from === memory)
          || (phase === 'memory-published' && from.endsWith(path.join('prepared','memory')))
          || (phase === 'all-published' && from.endsWith(path.join('prepared','settings.json')))
          || (phase === 'committed' && path.basename(to) === 'committed')) process.exit(79);
        return result;
      };
      backup.restoreFrom(root, JSON.parse(raw));
    `;
    const child = spawnSync(process.execPath, ['-e', source, fixture.root, JSON.stringify(fixture.bundle), phase], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 79, child.stderr || child.error?.message);
    recoverRestore(fixture.data);
    if (phase === 'committed') assertRestored(fixture); else assertOriginal(fixture);
    backup.restoreFrom(fixture.root, fixture.bundle);
    assertRestored(fixture);
  });
}

test('T08: cleanup failure retains committed copies and retries without replay', t => {
  const fixture = seed(t);
  const rm = fs.rmSync;
  const fault = t.mock.method(fs, 'rmSync', (file, options) => {
    if (path.basename(file).startsWith('.memory-restore-')) throw new Error('fixture cleanup failure');
    return rm(file, options);
  });
  backup.restoreFrom(fixture.root, fixture.bundle);
  assertRestored(fixture);
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), /cleanup failure/);
  assertRestored(fixture);
  fault.mock.restore();
  backup.restoreFrom(fixture.root, fixture.bundle);
  assertRestored(fixture);
  assert.equal(fs.readdirSync(fixture.data).some(name => name.startsWith('.memory-restore-')), false);
});

test('T08: unknown transaction directory is preserved without blocking retries', t => {
  const fixture = seed(t);
  const unknown = fs.mkdtempSync(path.join(fixture.data, '.memory-restore-'));
  fs.writeFileSync(path.join(unknown, 'unowned.txt'), 'keep');
  backup.restoreFrom(fixture.root, fixture.bundle);
  assert.equal(fs.readFileSync(path.join(unknown, 'unowned.txt'), 'utf8'), 'keep');
  assertRestored(fixture);
});

test('T08: malformed ready transaction fails closed without changing originals', t => {
  const fixture = seed(t);
  const transaction = fs.mkdtempSync(path.join(fixture.data, '.memory-restore-'));
  fs.writeFileSync(path.join(transaction, 'plan.json'), JSON.stringify({ kind:'whale-memory-restore',version:1,entries:[{name:'../outside',existed:true}] }));
  fs.writeFileSync(path.join(transaction, 'ready'), 'prepared\n');
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), /描述损坏/);
  assertOriginal(fixture);
});

test('T08: v1 store and settings participate in the same rollback', t => {
  const fixture = seed(t);
  const store = path.join(fixture.data, 'store.json');
  fs.writeFileSync(store, '{"sessions":{},"old":true}');
  const bundle = {kind:'whale-girl-memory',version:1,files:{store:{sessions:{}},settings:{userName:'after'}}};
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith(path.join('prepared', 'settings.json'))) throw new Error('fixture ancillary exchange failure');
    return rename(from, to);
  });
  assert.throws(() => backup.restoreFrom(fixture.root, bundle), /ancillary exchange failure/);
  assert.equal(JSON.parse(fs.readFileSync(store)).old, true);
  assertOriginal(fixture);
});

test('T08: rollback removes newly published targets when the original root was empty', t => {
  const fixture = seed(t);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t08-empty-'));
  t.after(() => fs.rmSync(fresh, { recursive:true,force:true,maxRetries:8,retryDelay:40 }));
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith(path.join('prepared', 'settings.json'))) throw new Error('fixture fresh exchange failure');
    return rename(from, to);
  });
  assert.throws(() => backup.restoreFrom(fresh, fixture.bundle), /fresh exchange failure/);
  assert.equal(fs.existsSync(path.join(fresh, 'data/memory')), false);
  assert.equal(fs.existsSync(path.join(fresh, 'data/settings.json')), false);
  fault.mock.restore();
  backup.restoreFrom(fresh, fixture.bundle);
  assert.equal(fs.readFileSync(path.join(fresh, 'data/memory/manifest.json'), 'utf8'), fixture.bundle.files.memory['manifest.json']);
});
