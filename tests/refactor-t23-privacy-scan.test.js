'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/privacy-scan.js'), 'utf8');
const root = path.resolve('isolated-t23-virtual-root');
function fixture({ entries = [['safe.md', false]], readError, directoryError, cli = false } = {}) {
  const reads = [], output = [], module = { exports: {} };
  const process = { argv: ['node', 'privacy-scan.js', root], env: {}, exitCode: 0,
    exit(code) { this.exitCode = code; } };
  const mockFs = {
    readdirSync(dir) {
      reads.push(path.relative(root, dir) || '.');
      if (directoryError) throw Object.assign(new Error('fixture directory error'), { code: directoryError });
      assert.equal(dir, root, 'excluded directories must not be traversed');
      return entries.map(([name, directory]) => ({ name, isDirectory: () => directory }));
    },
    readFileSync(file) {
      reads.push(path.relative(root, file));
      if (readError) throw Object.assign(new Error('fixture file error'), { code: readError });
      return path.extname(file) === '.exe' ? Buffer.from('safe fixture') : 'safe fixture';
    },
  };
  const requireMock = (id) => id === 'node:fs' ? mockFs : require(id);
  requireMock.main = cli ? module : null;
  vm.runInNewContext(source, { module, require: requireMock, Buffer, process,
    console: { log: (s) => output.push(String(s)), error: (s) => output.push(String(s)) },
    __dirname: path.join(__dirname, '../scripts') });
  return { api: module.exports, reads, output, process };
}

for (const [name, options, operation] of [
  ['text EACCES', { readError: 'EACCES' }, 'read'],
  ['binary EACCES', { entries: [['safe.exe', false]], readError: 'EACCES' }, 'read'],
  ['directory EACCES', { directoryError: 'EACCES' }, 'readdir'],
  ['disappearing file', { readError: 'ENOENT' }, 'read'],
]) {
  test(`scan reports incomplete instead of clean for ${name}`, () => {
    const { api } = fixture(options);
    const result = api.scan(root);
    assert.equal(result.complete, false);
    assert.equal(result.findings.length, 0);
    assert.equal(result.files + result.binaries, 0, 'unread files are not checked files');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].operation, operation);
    assert.equal(result.errors[0].code, options.readError || options.directoryError);
    assert.throws(() => api.scan(root, { strict: true }), (error) =>
      error.code === 'ERR_PRIVACY_SCAN_INCOMPLETE' && error.result.complete === false);
  });
}

test('intentional exclusions remain explicit and do not make a clean scan incomplete', () => {
  const { api, reads } = fixture({ entries: [['data', true], ['runtime', true], ['artifacts', true],
    ['config.json', false], ['safe.md', false], ['asset.png', false]] });
  const result = api.scan(root, { strict: true });
  assert.equal(result.complete, true);
  assert.equal(result.files, 1);
  assert.equal(result.checked.files, 1);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(Array.from(result.skipped, (item) => item.file).sort(),
    ['artifacts', 'asset.png', 'config.json', 'data', 'runtime']);
  assert.ok(result.skipped.every((item) => item.reason));
  assert.equal(reads.some((item) => /^(data|runtime|artifacts)[\\/]/.test(item)), false);
});

test('CLI exits unsuccessfully on incomplete reads and never prints a clean verdict', () => {
  const { process, output } = fixture({ cli: true, readError: 'EACCES' });
  assert.notEqual(process.exitCode, 0);
  assert.equal(output.some((line) => line.includes('未发现个人信息')), false);
  assert.ok(output.some((line) => line.includes('EACCES')));
});

test('CLI --strict is parsed as an option, not as the scan root', () => {
  const module = { exports: {} }, scanned = [];
  const process = { env: {}, argv: ['node', 'privacy-scan.js', '--strict', root], exitCode: 0,
    exit(code) { this.exitCode = code; } };
  const mock = (id) => id === 'node:fs' ? { readdirSync(dir) { scanned.push(dir); return []; } } : require(id);
  mock.main = module;
  vm.runInNewContext(source, { module, require: mock, process, Buffer, console: { log() {}, error() {} }, __dirname });
  assert.deepEqual(scanned, [root]);
  assert.equal(process.exitCode, 0);
});
