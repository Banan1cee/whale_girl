'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const virtual = path.resolve('t22-virtual-release');
const source = fs.readFileSync(path.join(root, 'scripts/release-check.js'), 'utf8');
const scanner = fs.readFileSync(path.join(root, 'scripts/privacy-scan.js'), 'utf8');

function run({ fileError, directoryError, binary = false, body = 'safe fixture' } = {}) {
  const scanModule = { exports: {} };
  vm.runInNewContext(scanner, { module: scanModule, Buffer, process: { env: {} },
    require: (id) => id === 'node:fs' ? {
      readdirSync() {
        if (directoryError) throw Object.assign(new Error('fixture'), { code: directoryError });
        return [['data', true], [binary ? 'fixture.exe' : 'fixture.js', false]].map(([name, dir]) => ({ name, isDirectory: () => dir }));
      },
      readFileSync() {
        if (fileError) throw Object.assign(new Error('fixture'), { code: fileError });
        return binary ? Buffer.from(body) : body;
      },
    } : require(id) });
  const output = [], calls = [];
  let exitCode = 0;
  const fakeFs = { ...fs, existsSync(file) {
    const rel = path.relative(virtual, file);
    if (['data', 'runtime', 'config.json', 'wechatauto_db'].includes(rel)) return false;
    return fs.existsSync(path.join(root, rel));
  }, readFileSync(file, ...args) { return fs.readFileSync(path.join(root, path.relative(virtual, file)), ...args); } };
  const privacy = { scan(dir, options) { calls.push({ dir, options }); return scanModule.exports.scan(dir, options); } };
  try {
    vm.runInNewContext(source, { Buffer, __dirname: path.join(root, 'scripts'),
      require: (id) => id === 'node:fs' ? fakeFs : id === './privacy-scan' ? privacy : require(id),
      process: { argv: ['node', 'release-check.js', virtual], exit(code) { exitCode = code; throw Object.assign(new Error('fixture exit'), { fixtureExit: true }); } },
      console: { log: (line) => output.push(String(line)), error: (line) => output.push(String(line)) } });
  } catch (error) { if (!error.fixtureExit) throw error; }
  return { exitCode, output: output.join('\n'), calls };
}

for (const [name, options] of [
  ['text EACCES', { fileError: 'EACCES' }],
  ['binary EACCES', { fileError: 'EACCES', binary: true }],
  ['directory EACCES', { directoryError: 'EACCES' }],
  ['file disappeared', { fileError: 'ENOENT' }],
]) {
  test(`actual release-check fails incomplete scanner result: ${name}`, () => {
    const result = run(options);
    assert.equal(result.exitCode, 1);
    assert.equal(result.calls[0].options.strict, true);
    assert.doesNotMatch(result.output, /全部通过|二进制干净/);
    assert.match(result.output, /未完成/);
    assert.match(result.output, new RegExp(options.fileError || options.directoryError));
  });
}
test('actual caller accepts inspected clean results with intentional exclusions', () => {
  const result = run();
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.calls[0].options.strict, true);
  assert.match(result.output, /全部通过/);
});
test('actual caller retains the existing nonempty finding failure', () => {
  const result = run({ body: 'sk-' + 'AbC123DeF456GhI789' });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /密钥/);
});
