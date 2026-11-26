'use strict';

/**
 * compat 清单字段的三端一致性：宿主 Node 运行时、启动器 C# 安装校验（tests/plugin-market）
 * 与市场 validate.py（market/test_validate.py）必须接受/拒绝同一批清单。
 *
 * 这里做两件事：
 * 1. 用同一份非法用例集合驱动真实的 validateManifest，确认 Node 的判定就是注册表
 *    manifest.compat 的 values/levels/runtime —— 不是另抄一份规则；
 * 2. 市场仓库在场时，核对它 protocol.json 里随仓库拷贝的注册表和宿主注册表的 compat
 *    策略逐字段相同，避免市场侧按旧策略放行。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { validateManifest } = require('../src/services/pluginProtocol');
const { UnifiedPluginRuntime } = require('../src/services/unifiedPluginRuntime');
const registry = require('../src/services/pluginProtocolRegistry.json');

const policy = registry.manifest.compat;
const APP = { appVersion: '4.3.0' };
// 与 tests/plugin-market/Program.cs、test_validate.py 的用例名一一对应。
const VALUE_CASES = ['api4', 'API3', '', ' api3', 'api3.0'];
const LEVEL_CASES = [0, 1, 2, 4];
const RUNTIME_CASES = ['node-full', 'wasm-sandbox'];

function manifest(level, extra = {}) {
  const levelPolicy = registry.levels[String(level)];
  assert.ok(levelPolicy, `注册表没有 ${level} 级`);
  const provides = level === 0 ? {}
    : level === 3 ? { 'chat.reply@1': { mode: 'enhance', scope: 'all' } }
      : { 'tool.run@1': { mode: 'tool', scope: 'manual' } };
  return Buffer.from(JSON.stringify({
    format: 'whale-plugin/1', level, id: 'compat-parity', name: '一致测试', author: 'tester',
    version: '1.0.0', minAppVersion: '4.3.0', description: 'compat',
    entry: levelPolicy.entry, runtime: levelPolicy.runtime, provides, calls: [], ...extra,
  }));
}

test('注册表是唯一策略来源：compat 只登记 3 级 wasm-restricted 的 api3', () => {
  assert.deepEqual(registry.manifest.allowed.filter(key => key === 'compat'), ['compat']);
  assert.equal(policy.runtime, 'wasm-restricted');
  assert.deepEqual(policy.levels, [3]);
  assert.ok(policy.values.length > 0);
  // hooks 是 api3 信封下 provider → 旧 hook 名的对照表，不是清单字段，运行时才用。
  assert.ok(Object.keys(policy.hooks).length > 0);
  for (const [provider, hook] of Object.entries(policy.hooks)) {
    assert.ok(registry.providers[provider], `hooks 登记了未知 provider ${provider}`);
    assert.match(hook, /^[a-z]+(?:\.[a-z_]+)?$/, `hook 名非法 ${hook}`);
  }
});

test('合法 compat 被接受，而且值/等级/运行时都按注册表判定', () => {
  for (const value of policy.values) {
    for (const level of policy.levels) {
      assert.equal(validateManifest(manifest(level, { compat: value }), APP).compat, value);
    }
  }
  // 注册表没登记的值、等级、运行时组合一律拒绝，不因为字符串长得像就放行。
  for (const value of VALUE_CASES.filter(item => !policy.values.includes(item))) {
    assert.throws(() => validateManifest(manifest(3, { compat: value }), APP), /manifest_compat_invalid/);
  }
  for (const value of [1, 0, true, null, ['api3'], { api3: true }]) {
    assert.throws(() => validateManifest(manifest(3, { compat: value }), APP), /manifest_compat_invalid/);
  }
  for (const level of LEVEL_CASES.filter(item => !policy.levels.includes(item))) {
    assert.throws(() => validateManifest(manifest(level, { compat: policy.values[0] }), APP),
      /manifest_compat_invalid/);
  }
  for (const runtime of RUNTIME_CASES.filter(item => item !== policy.runtime)) {
    assert.throws(() => validateManifest(manifest(3, { compat: policy.values[0], runtime }), APP),
      /manifest_(format_unsupported|compat_invalid)/);
  }
  // 旧包不声明 compat 时判定不变：3 级 wasm-restricted 照常通过。
  assert.equal(validateManifest(manifest(3), APP).compat, undefined);
});

test('compat 只覆盖注册表 hooks 里的 provider：tool.run@1 声明 compat 必须拒绝', () => {
  const mapped = new Set(Object.keys(policy.hooks));
  const descriptor = name => ({
    mode: registry.providers[name].modes[0], scope: registry.providers[name].scopes[0],
  });
  // 3 级允许的每个 provider 都按 hooks 表二分：登记过的可带 compat，没登记的不行。
  for (const name of registry.levels['3'].providers) {
    const provides = { [name]: descriptor(name) };
    assert.equal(validateManifest(manifest(3, { provides }), APP).provides[name].mode,
      descriptor(name).mode, `${name} 不声明 compat 时在 3 级合法`);
    if (mapped.has(name)) {
      assert.equal(validateManifest(manifest(3, { compat: policy.values[0], provides }), APP).compat,
        policy.values[0], `${name} 有 api3 hook，可以声明 compat`);
    } else {
      // 这条就是「装得上、第一次派发才 invalid_wasm_compat」的组合，必须在清单校验就拒绝。
      assert.throws(() => validateManifest(manifest(3, { compat: policy.values[0], provides }), APP),
        /manifest_compat_invalid/, `${name} 没有 api3 hook，不能声明 compat`);
    }
  }
  assert.ok(!mapped.has('tool.run@1'), '注册表应保持 tool.run@1 没有旧 hook');
});

test('安装期 Runtime 读取同一份清单时也拒绝 api3 映射不到的 provider', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-compat-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const install = (id, provides, compat) => {
    const dir = path.join(root, 'plugins', id);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const payload = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    const raw = Buffer.from(JSON.stringify({
      format: 'whale-plugin/1', level: 3, id, name: '一致测试', author: 'tester', version: '1.0.0',
      minAppVersion: '4.3.0', description: 'compat', entry: 'plugin.wasm', runtime: 'wasm-restricted',
      provides, calls: [], ...(compat === undefined ? {} : { compat }),
    }));
    fs.writeFileSync(path.join(dir, 'plugin.json'), raw);
    fs.writeFileSync(path.join(dir, 'plugin.wasm'), payload);
    fs.writeFileSync(path.join(dir, 'grant.json'), JSON.stringify({
      enabled: true, epoch: crypto.randomUUID(), packageHash: 'a'.repeat(64), level: 3,
      manifestHash: crypto.createHash('sha256').update(raw).digest('hex'),
      entryHash: crypto.createHash('sha256').update(payload).digest('hex'),
      approvedProviders: Object.keys(provides), approvedCalls: [], approvedDataAccess: [],
      settings: {}, fullAccess: false, nodeFullConfirmed: false, chatConfirmed: true,
    }));
  };
  const chat = { 'chat.reply@1': { mode: 'enhance', scope: 'all' } };
  const tool = { 'tool.run@1': { mode: 'tool', scope: 'manual' } };
  install('compat-chat', chat, 'api3');
  install('compat-tool', tool, 'api3');
  install('plain-tool', tool);
  const runtime = new UnifiedPluginRuntime({ dataDir: root });
  t.after(async () => runtime.stop());
  assert.equal(runtime.read('compat-chat').compat, 'api3', 'chat+api3 安装后可读');
  assert.equal(runtime.read('compat-tool'), null, 'tool+api3 必须在读取时就被拒绝');
  assert.equal(runtime.read('plain-tool').compat, undefined, '不声明 compat 的 tool 合法');
});

test('市场仓库的协议拷贝与宿主注册表 compat 策略一致', t => {
  const root = process.env.WHALE_MARKET_DIR
    || path.join(__dirname, '..', '..', 'whale-girl-plugins');
  const file = path.join(root, 'protocol.json');
  if (!fs.existsSync(file)) {
    t.diagnostic(`市场仓库不在 ${root}，跳过协议拷贝核对（设置 WHALE_MARKET_DIR 可启用）`);
    return;
  }
  const copy = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(copy.registry && copy.registry.manifest, 'protocol.json 缺少 registry.manifest');
  assert.deepEqual(copy.registry.manifest.compat, policy,
    '市场拷贝的 compat 策略与宿主注册表不同，市场会按旧策略放行或误拒');
  assert.deepEqual(copy.registry.levels, registry.levels, '市场拷贝的等级策略与宿主不同');
  assert.deepEqual(copy.registry.manifest.allowed, registry.manifest.allowed,
    '市场拷贝的清单字段白名单与宿主不同');
});
