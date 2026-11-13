'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const helperFile = path.join(__dirname, 'helpers/test-python.js');

test('all seven old guards select an available CI Python without requiring bundled files', () => {
  const entries = [];
  for (const name of ['bridge-globals.test.js', 'db-dir.test.js']) {
    const stubTest = (title, options) => entries.push({ title, skip: options && typeof options === 'object' && options.skip });
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    vm.runInNewContext(source, { __dirname, process: { platform: 'win32', env: { CI: 'true', PYTHON: 'python' } },
      require(id) {
        if (id === 'node:test') return stubTest;
        if (id === 'node:fs') return { existsSync: () => false, readFileSync: () => '' };
        if (id === './helpers/bridge-source') return '';
        if (id === './helpers/test-python') return { selectTestPython: () => '/verified/python.exe' };
        return require(id);
      } }, { filename: name });
  }
  assert.equal(entries.length, 10, 'all original static and dynamic tests remain registered');
  assert.equal(entries.filter((entry) => entry.skip).length, 0, 'installed CI Python must not leave seven skips');
});

function select(options) { return require(helperFile).selectTestPython(options); }
const good = { status: 0, stdout: '/verified/python.exe\n' };
const missing = { status: null, error: Object.assign(new Error('fixture unavailable'), { code: 'ENOENT' }) };
test('explicit Python path and PATH command are validated rather than checked with existsSync', () => {
  for (const command of ['C:/fixture with spaces/python.exe', 'python']) {
    const seen = [];
    assert.equal(select({ env: { CI: 'true', PYTHON: command }, exists: () => false,
      spawn(file, args) { seen.push(file); assert.ok(args.includes('-I') && args.includes('-B')); return good; } }), '/verified/python.exe');
    assert.deepEqual(seen, [command]);
  }
});
test('WHALE_TEST_PYTHON takes precedence and a broken explicit choice cannot silently fall back', () => {
  const seen = [];
  assert.throws(() => select({ env: { CI: 'true', WHALE_TEST_PYTHON: 'chosen', PYTHON: 'other' },
    exists: () => false, spawn(file) { seen.push(file); return missing; } }), /Python/);
  assert.deepEqual(seen, ['chosen']);
});
test('bundled Python remains compatible and unavailable bundles fall back to existing PATH Python', () => {
  const bundle = path.join(root, 'runtime/python/python.exe');
  const seen = [];
  assert.equal(select({ root, platform: 'win32', env: {}, exists: (file) => file === bundle,
    spawn(file) { seen.push(file); return good; } }), '/verified/python.exe');
  assert.deepEqual(seen, [bundle]);
  const pathCalls = [];
  assert.equal(select({ root, platform: 'win32', env: { CI: 'true' }, exists: () => false,
    spawn(file) { pathCalls.push(file); return file === 'python' ? good : missing; } }), '/verified/python.exe');
  assert.deepEqual(pathCalls, ['python']);
});
test('CI without any working Python fails explicitly; only a non-CI unavailable host returns null', () => {
  assert.throws(() => select({ root, platform: 'win32', env: { CI: 'true' }, exists: () => false,
    spawn: () => missing }), (error) => error.code === 'ERR_TEST_PYTHON_UNAVAILABLE');
  assert.equal(select({ root, platform: 'win32', env: {}, exists: () => false, spawn: () => missing }), null);
});
test('a present but broken bundled interpreter cannot turn the old local failure into a skip', () => {
  assert.throws(() => select({ root, platform: 'win32', env: {}, exists: () => true, spawn: () => missing }),
    (error) => error.code === 'ERR_TEST_PYTHON_UNAVAILABLE');
});
test('a child launch or non-Python response is not accepted as a valid interpreter', () => {
  assert.throws(() => select({ env: { CI: 'true', PYTHON: 'bad' }, spawn: () => ({ status: 0, stdout: '' }) }), /Python/);
  assert.throws(() => select({ env: { CI: 'true', PYTHON: 'bad' }, spawn() { throw new Error('fixture spawn failure'); } }), /Python/);
});

function executeFixture(py, fixture, code) {
  return execFileSync(py, ['-I', '-B', '-c', fixture.prelude + '\n' + code], {
    cwd: fixture.root, encoding: 'utf8', env: fixture.env,
    timeout: 20000,
  });
}
test('copied bridge import cannot read original config or inspect host processes/drives', (t) => {
  const { selectTestPython, createBridgeFixture } = require(helperFile);
  const py = selectTestPython({ env: { ...process.env, CI: 'true' } });
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't23-source-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(sourceRoot, 'bridge'));
  fs.copyFileSync(path.join(root, 'bridge/wechat_db.py'), path.join(sourceRoot, 'bridge/wechat_db.py'));
  fs.writeFileSync(path.join(sourceRoot, 'bridge/engine.py'), 'import os, wechat_db\nROOT=os.path.dirname(os.path.dirname(__file__))\nresolve_db_dir=wechat_db.resolve_db_dir\n');
  fs.writeFileSync(path.join(sourceRoot, 'config.json'), 'original-fixture-config');
  const fixture = createBridgeFixture(t, { sourceRoot });
  const result = JSON.parse(executeFixture(py, fixture, [
    'import engine, psutil, json, os',
    'assert engine.ROOT == _TEST_ROOT',
    'assert engine.resolve_db_dir(config_path=os.path.join(_TEST_ROOT,"missing.json")) == ""',
    'assert psutil is _TEST_PSUTIL',
    'assert _TEST_PROBES["process"] >= 1 and _TEST_PROBES["drives"] >= 1',
    'try:',
    `    open(${JSON.stringify(path.join(sourceRoot, 'config.json'))}).read()`,
    'except RuntimeError: pass',
    'else: raise AssertionError("original config was readable")',
    'print(json.dumps({"root":engine.ROOT,"stubbed":True}))',
  ].join('\n')).trim());
  assert.equal(result.root, fixture.root);
  assert.equal(result.stubbed, true);
  assert.equal(fs.readFileSync(path.join(sourceRoot, 'config.json'), 'utf8'), 'original-fixture-config');
});
test('fixture guard rejects process/network/UI audit events before any real operation', (t) => {
  const { selectTestPython, createBridgeFixture } = require(helperFile);
  const py = selectTestPython({ env: { ...process.env, CI: 'true' } });
  const fixture = createBridgeFixture(t);
  const result = JSON.parse(executeFixture(py, fixture, [
    'import json, sys',
    'blocked=[]',
    'for event,args in [("subprocess.Popen",()),("socket.connect",()),("import",("win32gui",))]:',
    '    try: sys.audit(event,*args)',
    '    except RuntimeError: blocked.append(event)',
    'print(json.dumps(blocked))',
  ].join('\n')).trim());
  assert.deepEqual(result, ['subprocess.Popen', 'socket.connect', 'import']);
});

function nestedInventory({ filtered = false } = {}) {
  const file = path.join(root, 'scripts/test-inventory.js'), project = 'tests/launcher/JsonChecks/JsonChecks.csproj';
  const entry = 'tests/refactor-t17-configuration.test.js';
  const fromSource = createRequire(file), module = { exports: {} };
  const fakeFs = { ...fs, existsSync(p) {
    return [project, entry].some((name) => path.resolve(p) === path.join(root, name)) || fs.existsSync(p);
  }, readFileSync(p, ...args) {
    assert.notEqual(path.resolve(p), path.join(root, entry), 'source text cannot prove execution');
    if (filtered && path.resolve(p) === path.join(root, 'scripts/test-tasks.json')) {
      const plan = JSON.parse(fs.readFileSync(p, ...args));
      plan.tasks.find((task) => task.id === 'node-tests').commands[0].splice(2, 0, '--test-name-pattern=unrelated');
      return JSON.stringify(plan);
    }
    return fs.readFileSync(p, ...args);
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module,
    require: (id) => id === 'node:fs' ? fakeFs : fromSource(id), process, __dirname: path.dirname(file) });
  return module.exports.collect(root);
}
test('inventory recognizes the explicitly selected nested project as a declaration, not a receipt', () => {
  const project = 'tests/launcher/JsonChecks/JsonChecks.csproj', entry = 'tests/refactor-t17-configuration.test.js';
  const inventory = nestedInventory();
  assert.equal(inventory.projects.has(project), true);
  assert.equal(inventory.executionVerified, false);
  assert.ok(inventory.projectEntries.some((item) => item.project === project && item.entry === entry && item.executionVerified === false));
});
test('inventory and task validation both reject a case-filtered nested entry', () => {
  const inventory = nestedInventory({ filtered: true });
  assert.equal(inventory.projects.has('tests/launcher/JsonChecks/JsonChecks.csproj'), false);
  assert.equal(inventory.projectEntries.length, 0);
});
