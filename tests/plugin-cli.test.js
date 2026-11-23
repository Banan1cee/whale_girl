'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'scripts', 'plugin-cli.js');

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-cli-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function run(cwd, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  return result;
}

function ok(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('author initializes a manual tool and validates the generated project without overwriting it', t => {
  const cwd = workspace(t);
  ok(run(cwd, 'init', 'word-count'));
  const filename = path.join(cwd, 'word-count', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.deepEqual(manifest.provides, { 'tool.run@1': { mode: 'tool', scope: 'manual' } });
  assert.equal(manifest.format, 'whale-plugin/1');
  assert.equal(manifest.id, 'word-count');
  ok(run(cwd, 'validate', 'word-count'));
  assert.notEqual(run(cwd, 'init', 'word-count').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), manifest);
});

test('test, pack and trial never execute source and the ZIP has exactly two root files', t => {
  const cwd = workspace(t);
  ok(run(cwd, 'init', 'demo', '--template', 'reply-enhancer'));
  const filename = path.join(cwd, 'demo', 'plugin.js');
  fs.appendFileSync(filename, '\nrequire("node:fs").writeFileSync("ran", "should never execute");\n');
  fs.writeFileSync(path.join(cwd, 'demo', 'private-not-for-package.txt'), 'not packed');
  ok(run(cwd, 'test', 'demo'));
  ok(run(cwd, 'pack', 'demo', '--out', 'out.zip'));
  ok(run(cwd, 'validate', 'out.zip'));
  const report = JSON.parse(ok(run(cwd, 'trial', 'out.zip')));
  assert.equal(report.executed, false);
  assert.equal(report.installed, false);
  assert.equal(report.nodeAccessConfirmationRequired, true);
  assert.deepEqual(report.routes, [{ capability: 'chat.reply@1', mode: 'enhance', scope: 'all' }]);
  assert.ok(!fs.existsSync(path.join(cwd, 'ran')));
  assert.ok(!fs.existsSync(path.join(cwd, 'demo', 'ran')));
  assert.notEqual(run(cwd, 'pack', 'demo', '--out', 'out.zip').status, 0);

  const archive = fs.readFileSync(path.join(cwd, 'out.zip'));
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  assert.equal(archive.readUInt16LE(end + 10), 2);
  let cursor = archive.readUInt32LE(end + 16);
  const names = [];
  for (let entry = 0; entry < 2; entry++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const length = archive.readUInt16LE(cursor + 28);
    names.push(archive.toString('utf8', cursor + 46, cursor + 46 + length));
    cursor += 46 + length + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  assert.deepEqual(names, ['plugin.json', 'plugin.js']);
});

test('manifest version bounds and simulated call availability follow the shared registry', t => {
  const cwd = workspace(t);
  ok(run(cwd, 'init', 'registry-demo', '--template', 'scheduled-task'));
  const filename = path.join(cwd, 'registry-demo', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const update = value => fs.writeFileSync(filename, JSON.stringify(value));
  update({ ...manifest, maxAppVersion: '999.0.0', calls: ['status.read@1', 'message.submit@1'] });
  const report = JSON.parse(ok(run(cwd, 'trial', 'registry-demo')));
  assert.deepEqual(report.calls, [
    { capability: 'status.read@1', status: 'declared', requiresConsent: false },
    { capability: 'message.submit@1', status: 'unavailable', requiresConsent: true },
  ]);
  update({ ...manifest, maxAppVersion: '0.1.0' });
  assert.match(run(cwd, 'validate', 'registry-demo').stderr, /maxAppVersion/);
  update({ ...manifest, description: 'a'.repeat(601) });
  assert.match(run(cwd, 'validate', 'registry-demo').stderr, /description/);
});

test('settingsSchema 的 title/description 注解有界且只影响展示', t => {
  const cwd = workspace(t);
  ok(run(cwd, 'init', 'annotated', '--template', 'reply-enhancer'));
  const filename = path.join(cwd, 'annotated', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const save = value => fs.writeFileSync(filename, JSON.stringify(value));
  const withSchema = schema => ({ ...manifest, settingsSchema: schema });
  const reject = (schema, reason) => {
    save(withSchema(schema));
    const result = run(cwd, 'validate', 'annotated');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, reason);
  };

  // 旧包（没有注解）在新校验下照常通过。
  save(manifest);
  ok(run(cwd, 'validate', 'annotated'));
  // 对象区块与字段都可以带注解。
  save(withSchema({
    type: 'object', title: '回复设置', description: '只影响展示',
    properties: { tone: { type: 'string', title: '语气', description: '简短说明' } },
  }));
  ok(run(cwd, 'validate', 'annotated'));

  reject({ type: 'object', title: '', properties: {} }, /不能为空/);
  reject({ type: 'object', title: 't'.repeat(41), properties: {} }, /不能超过 40/);
  reject({ type: 'object', description: 'd'.repeat(201), properties: {} }, /不能超过 200/);
  reject({ type: 'object', title: 'a\u0001b', properties: {} }, /控制字符/);
  reject({ type: 'object', description: 42, properties: {} }, /必须是字符串/);
});

test('strict validation rejects unknown fields, unsupported modes and duplicate declarations', t => {
  const cwd = workspace(t);
  ok(run(cwd, 'init', 'strict-demo', '--template', 'reply-enhancer'));
  const filename = path.join(cwd, 'strict-demo', 'plugin.json');
  const original = fs.readFileSync(filename, 'utf8');
  const manifest = JSON.parse(original);
  const checkReject = (changed, reason) => {
    fs.writeFileSync(filename, typeof changed === 'string' ? changed : JSON.stringify(changed));
    const result = run(cwd, 'validate', 'strict-demo');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, reason);
  };
  checkReject({ ...manifest, Hooks: [] }, /未知字段.*Hooks/);
  checkReject({ ...manifest, provides: { 'chat.reply@1': { mode: 'tool', scope: 'all' } } }, /模式/);
  checkReject({ ...manifest, provides: { 'chat.reply@1': { mode: 'enhance', scope: 'manual' } } }, /作用域/);
  checkReject({ ...manifest, calls: ['status.read@1', 'status.read@1'] }, /重复项/);
  checkReject(original.replace('"id":', '"i\\u0064": "other", "id":'), /重复键.*id/);
  checkReject(original.replace('"chat.reply@1":', '"chat.reply@1": {}, "chat.reply@1":'), /重复键.*chat\.reply/);
  checkReject({ ...manifest, settingsSchema: { type: 'object', properties: { x: { type: 'string', pattern: '.*' } } } }, /settingsSchema/);
  checkReject({ ...manifest, executionTimeoutMs: 1 }, /executionTimeoutMs/);
  fs.writeFileSync(filename, original);
  fs.writeFileSync(path.join(cwd, 'strict-demo', 'plugin.js'), 'const malformed = ;');
  assert.match(run(cwd, 'test', 'strict-demo').stderr, /语法错误/);
});

test('ZIP validation refuses non-root filenames, inconsistent local names and modified payloads', t => {
  const cwd = workspace(t);
  ok(run(cwd, 'init', 'archive-demo'));
  ok(run(cwd, 'pack', 'archive-demo'));
  const zip = fs.readFileSync(path.join(cwd, 'archive-demo.zip'));
  const central = zip.readUInt32LE(zip.length - 22 + 16);
  for (const [label, mutate, reason] of [
    ['non-root', value => { value.write('/lugin.json', central + 46); value.write('/lugin.json', 30); }, /非法或重复文件名/],
    ['different-local', value => { value.write('/lugin.json', 30); }, /ZIP 结构/],
    ['bad-crc', value => { value[41] ^= 1; }, /校验和/],
  ]) {
    const changed = Buffer.from(zip);
    mutate(changed);
    fs.writeFileSync(path.join(cwd, `${label}.zip`), changed);
    const result = run(cwd, 'trial', `${label}.zip`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, reason);
  }
});

test('restricted Wasm can be packed and cannot declare full-access calls', t => {
  const cwd = workspace(t);
  ok(run(cwd, 'init', 'wasm-tool'));
  const dir = path.join(cwd, 'wasm-tool');
  const filename = path.join(dir, 'plugin.json');
  const manifest = { ...JSON.parse(fs.readFileSync(filename, 'utf8')), level: 1,
    runtime: 'wasm-restricted', entry: 'plugin.wasm', calls: [] };
  const save = value => fs.writeFileSync(filename, JSON.stringify(value));
  save(manifest);
  fs.writeFileSync(path.join(dir, 'plugin.wasm'), Buffer.from('0061736d010000000105016000017f030201000707010372756e00000a06010400412a0b', 'hex'));
  ok(run(cwd, 'test', 'wasm-tool'));
  ok(run(cwd, 'pack', 'wasm-tool'));
  const report = JSON.parse(ok(run(cwd, 'trial', 'wasm-tool.zip')));
  assert.equal(report.level, 1);
  assert.equal(report.nodeAccessConfirmationRequired, false);
  save({ ...manifest, calls: ['status.read@1'] });
  assert.notEqual(run(cwd, 'validate', 'wasm-tool').status, 0);
  save({ ...manifest, calls: [], dataAccess: ['chat.history'] });
  assert.notEqual(run(cwd, 'validate', 'wasm-tool').status, 0);
  save({ ...manifest, runtime: 'node-full', entry: 'plugin.js' });
  assert.notEqual(run(cwd, 'validate', 'wasm-tool').status, 0);
});

test('each app template produces a syntactically valid project and declares the expected route', t => {
  const cwd = workspace(t);
  for (const [template, capability, mode] of [
    ['reply-enhancer', 'chat.reply@1', 'enhance'],
    ['chat-takeover', 'chat.handle@1', 'replace'],
    ['scheduled-task', 'task.tick@1', 'schedule'],
  ]) {
    ok(run(cwd, 'init', template, '--template', template));
    ok(run(cwd, 'test', template));
    const report = JSON.parse(ok(run(cwd, 'trial', template)));
    assert.deepEqual(report.routes, [{ capability, mode, scope: 'all', ...(mode === 'schedule' ? { intervalSeconds: 60 } : {}) }]);
  }
});
