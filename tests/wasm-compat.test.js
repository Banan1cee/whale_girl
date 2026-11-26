'use strict';

/**
 * 旧 Api 1/2/3 Wasm 兼容回归。测试直接读市场仓库 packages/*.zip 里的真实 plugin.wasm；
 * 市场仓库不在时整组 skip（不影响 CI 绿），但本地必须真实跑过。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  compileRestricted, executeRestricted, buildWasmPayload, compatOutput,
} = require('../src/services/unifiedWasm');
const { validateManifest } = require('../src/services/pluginProtocol');
const { UnifiedPluginRuntime } = require('../src/services/unifiedPluginRuntime');
const registry = require('../src/services/pluginProtocolRegistry.json');

// 旧 Wasm 二进制随仓库放在 tests/fixtures/old-wasm/，不依赖本机的市场仓库，
// 这样 CI 和无市场检出也能真跑兼容回归，不会整组 skip。
const FIXTURES = path.join(__dirname, 'fixtures', 'old-wasm');
const PACKAGE_NAMES = {
  'context-notes': 'context-notes.wasm',
  'followup-window': 'followup-window.wasm',
  'daily-digest': 'daily-digest.wasm',
  'text-counter': 'text-counter.wasm',
};
// 夹具是测试输入的一部分，漏带时必须失败，不能让整组兼容检查静默变绿。
for (const name of Object.values(PACKAGE_NAMES)) {
  assert.ok(fs.existsSync(path.join(FIXTURES, name)), `missing required Wasm fixture: ${name}`);
}
const skip = false;
const wasm = id => fs.readFileSync(path.join(FIXTURES, PACKAGE_NAMES[id]));

const message = {
  platform: 'wechat', chatType: 'group', chatId: 'g1', senderId: 'u1',
  senderName: '甲', text: '在吗', atMe: false, msgId: 'm1', chatTitle: '示例群',
};

/* 手搓最小 Wasm：指定导入模块/函数，导出 run。 */
function uleb(value) {
  const out = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest) byte |= 0x80;
    out.push(byte);
  } while (rest);
  return Buffer.from(out);
}
const wasmString = value => {
  const raw = Buffer.from(value, 'utf8');
  return Buffer.concat([uleb(raw.length), raw]);
};
const section = (id, payload) => Buffer.concat([Buffer.from([id]), uleb(payload.length), payload]);

function importModule(moduleName, fieldName) {
  const type = section(1, Buffer.concat([uleb(1), Buffer.from([0x60, 0x00, 0x01, 0x7f])]));
  const imports = section(2, Buffer.concat([
    uleb(1), wasmString(moduleName), wasmString(fieldName), Buffer.from([0x00, 0x00]),
  ]));
  const functions = section(3, Buffer.concat([uleb(1), uleb(0)]));
  const exports = section(7, Buffer.concat([uleb(1), wasmString('run'), Buffer.from([0x00, 0x00])]));
  const body = Buffer.from([0x00, 0x41, 0x00, 0x0b]);
  const code = section(10, Buffer.concat([uleb(1), uleb(body.length), body]));
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    type, imports, functions, exports, code,
  ]);
}

test('真实旧 Wasm（Api1/2/3）都能在 whale 别名下加载', { skip }, () => {
  assert.ok(compileRestricted(wasm('text-counter'), 1));
  assert.ok(compileRestricted(wasm('daily-digest'), 2));
  assert.ok(compileRestricted(wasm('followup-window'), 3));
  assert.ok(compileRestricted(wasm('context-notes'), 3));
});

test('2 级工具返回纯文本，不再按 JSON 解析；1 级整数工具仍返回整数', { skip }, () => {
  const counter = compileRestricted(wasm('text-counter'), 1);
  assert.equal(executeRestricted(counter, 1, 'tool.run@1', 'hello', {}), 5);

  const digest = compileRestricted(wasm('daily-digest'), 2);
  const text = executeRestricted(digest, 2, 'tool.run@1', '## 标题\n\n- 第一条\n- 第二条', {});
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
  assert.match(text, /标题/);
});

test('compat:"api3" 的真实旧插件端到端：pre_reply/reply/prompt/before_send', { skip }, () => {
  const followup = compileRestricted(wasm('followup-window'), 3);
  assert.deepEqual(
    executeRestricted(followup, 3, 'chat.pre_reply@1', { message, localWechat: false }, {}, 'api3'),
    { action: 'pass' },
  );
  const reply = executeRestricted(followup, 3, 'chat.reply@1', { message, text: '原始回复' }, {}, 'api3');
  assert.equal(reply.text, '原始回复');
  assert.ok(reply.state && typeof reply.state === 'object', '旧输出里的 state 要保留');

  const notes = compileRestricted(wasm('context-notes'), 3);
  const prompt = executeRestricted(notes, 3, 'chat.prompt@1',
    { message, system: 'BASE SYSTEM', history: [{ role: 'user', text: '上一条' }] }, {}, 'api3');
  assert.equal(typeof prompt.system, 'string');
  assert.match(prompt.system, /^BASE SYSTEM/);
  assert.match(prompt.system, /【本轮上下文】/);

  const cleaned = executeRestricted(notes, 3, 'chat.before_send@1',
    { message, text: '**hello**   world' }, {}, 'api3');
  assert.equal(cleaned.text, 'hello world');
});

test('api3 信封字段齐全，按 hook 带 text/system/history', { skip }, () => {
  const pre = JSON.parse(buildWasmPayload(3, 'chat.pre_reply@1',
    { message, localWechat: false }, { tone: 'x' }, 'api3').toString('utf8'));
  assert.equal(pre.api, 3);
  assert.equal(pre.hook, 'chat.pre_reply');
  assert.deepEqual(pre.message, message);
  assert.ok(Number.isInteger(pre.now) && pre.now > 0);
  // 宿主没提供 lastBot 时保持 null（旧插件「没有上一条回复就 pass」的分支）；
  // 真实 lastBot 的投影与跨轮接话在 tests/plugin-followup-compat.test.js 里验。
  assert.equal(pre.lastBot, null);
  assert.deepEqual(pre.state, {});
  assert.deepEqual(pre.settings, { tone: 'x' });
  assert.equal(pre.decision, 'pass');

  const prompt = JSON.parse(buildWasmPayload(3, 'chat.prompt@1',
    { message, system: 'SYS', history: [{ role: 'user', text: 'q' }] }, {}, 'api3').toString('utf8'));
  assert.equal(prompt.hook, 'chat.prompt');
  assert.equal(prompt.system, 'SYS');
  assert.deepEqual(prompt.history, [{ role: 'user', text: 'q' }]);

  const reply = JSON.parse(buildWasmPayload(3, 'chat.reply@1',
    { message, text: '草稿' }, {}, 'api3').toString('utf8'));
  assert.equal(reply.text, '草稿');
});

test('未声明 compat 时使用 v2 信封 {capability,input,settings,state}', { skip }, () => {
  const input = { message, system: 'SYS' };
  const payload = JSON.parse(buildWasmPayload(3, 'chat.prompt@1', input, { a: 1 }).toString('utf8'));
  assert.deepEqual(payload, { capability: 'chat.prompt@1', input, settings: { a: 1 }, state: {} });
  assert.equal('api' in payload, false);
  assert.equal('hook' in payload, false);
});

test('state：api3 旧信封用真实 state，旧输出里的 state 保留', { skip }, () => {
  const envelope = JSON.parse(buildWasmPayload(3, 'chat.reply@1',
    { message, text: '草稿' }, {}, 'api3', { streak: 2 }).toString('utf8'));
  assert.deepEqual(envelope.state, { streak: 2 });
  assert.equal(envelope.api, 3);

  assert.deepEqual(compatOutput('chat.reply@1', { text: 'x', state: { streak: 3 } }, { text: 'x' }),
    { text: 'x', state: { streak: 3 } });
  assert.deepEqual(compatOutput('chat.pre_reply@1', { action: 'pass', state: { n: 1 } }, {}),
    { action: 'pass', state: { n: 1 } });
  assert.throws(() => compatOutput('chat.reply@1', { text: 'x', state: 'bad' }, {}), /invalid_wasm_output/);
  assert.throws(() => compatOutput('chat.reply@1', { text: 'x', state: { big: 'x'.repeat(9000) } }, {}),
    /invalid_wasm_output/);
});

test('非法 compat 被拒：只允许 3 级 + api3 + 消息 hook', { skip }, () => {
  assert.throws(() => buildWasmPayload(1, 'tool.run@1', 'x', {}, 'api3'), /invalid_wasm_compat/);
  assert.throws(() => buildWasmPayload(2, 'tool.run@1', 'x', {}, 'api3'), /invalid_wasm_compat/);
  assert.throws(() => buildWasmPayload(4, 'tool.run@1', {}, {}, 'api3'), /invalid_wasm_compat/);
  assert.throws(() => buildWasmPayload(3, 'chat.reply@1', { message, text: 'x' }, {}, 'api2'), /invalid_wasm_compat/);
  assert.throws(() => buildWasmPayload(3, 'tool.run@1', {}, {}, 'api3'), /invalid_wasm_compat/);
});

test('导入白名单：whale 别名可用，未知模块/函数仍拒绝', { skip }, () => {
  assert.ok(compileRestricted(importModule('whale', 'input_size'), 3));
  assert.throws(() => compileRestricted(importModule('whale', 'evil'), 3), /unsupported_wasm_import/);
  assert.throws(() => compileRestricted(importModule('other', 'input_size'), 3), /unsupported_wasm_import/);
  assert.throws(() => compileRestricted(importModule('whale', 'output_byte'), 1), /unsupported_wasm_import/);
});

function manifest(level, extra = {}) {
  const node = level === 4;
  return Buffer.from(JSON.stringify({
    format: 'whale-plugin/1', level, id: 'compat-demo', name: '兼容测试', author: 'tester',
    version: '1.0.0', minAppVersion: '4.3.0', description: 'compat',
    entry: node ? 'plugin.js' : 'plugin.wasm', runtime: node ? 'node-full' : 'wasm-restricted',
    provides: node ? { 'tool.run@1': { mode: 'tool', scope: 'manual' } }
      : { 'chat.pre_reply@1': { mode: 'gate', scope: 'all' } },
    calls: [], ...extra,
  }));
}

test('清单 compat 只允许 3 级 wasm-restricted 的 api3', { skip }, () => {
  assert.equal(validateManifest(manifest(3, { compat: 'api3' }), { appVersion: '4.3.0' }).compat, 'api3');
  assert.equal(registry.manifest.allowed.includes('compat'), true);
  assert.throws(() => validateManifest(manifest(4, { compat: 'api3' }), { appVersion: '4.3.0' }),
    /manifest_compat_invalid/);
  assert.throws(() => validateManifest(manifest(2, { compat: 'api3' }), { appVersion: '4.3.0' }),
    /manifest_compat_invalid/);
  assert.throws(() => validateManifest(manifest(3, { compat: 'api2' }), { appVersion: '4.3.0' }),
    /manifest_compat_invalid/);
});

test('运行时 read 把 compat 带进 flow，非法 compat 拒绝', { skip }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const install = (compat, name) => {
    const dir = path.join(root, 'plugins', name);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const payload = wasm('followup-window');
    const raw = Buffer.from(JSON.stringify({
      format: 'whale-plugin/1', level: 3, id: name, name: '兼容', author: 'tester', version: '1.0.0',
      minAppVersion: '4.3.0', description: 'compat', entry: 'plugin.wasm', runtime: 'wasm-restricted',
      provides: { 'chat.pre_reply@1': { mode: 'gate', scope: 'all' } }, calls: [], compat,
    }));
    fs.writeFileSync(path.join(dir, 'plugin.json'), raw);
    fs.writeFileSync(path.join(dir, 'plugin.wasm'), payload);
    fs.writeFileSync(path.join(dir, 'grant.json'), JSON.stringify({
      enabled: true, epoch: crypto.randomUUID(), packageHash: 'a'.repeat(64), level: 3,
      manifestHash: crypto.createHash('sha256').update(raw).digest('hex'),
      entryHash: crypto.createHash('sha256').update(payload).digest('hex'),
      approvedProviders: ['chat.pre_reply@1'], approvedCalls: [], approvedDataAccess: [],
      settings: {}, fullAccess: false, nodeFullConfirmed: false, chatConfirmed: true,
    }));
  };
  install('api3', 'compat-ok');
  install('api2', 'compat-bad');
  const runtime = new UnifiedPluginRuntime({ dataDir: root, enabled: () => true });
  assert.equal(runtime.read('compat-ok').compat, 'api3');
  assert.equal(runtime.read('compat-bad'), null);
});
