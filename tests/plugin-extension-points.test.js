'use strict';

/**
 * 协议 v2 的扩展点语义（不依赖 bot.js）：
 * - gate 顺序询问、pass 继续、skip/wake 生效、故障 fail-open；
 * - enhance 链退化、observe 结果被忽略；
 * - 3 级 calls 必须为空、聊天类 provider 需要 chatConfirmed；
 * - 4 级清单与新增 provider 能从注册表派生通过。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  validateManifest, declaresChatData, CHAT_DATA_PROVIDERS,
} = require('../src/services/pluginProtocol');
const registry = require('../src/services/pluginProtocolRegistry.json');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { UnifiedPluginRuntime, projectDataAccess } = require('../src/services/unifiedPluginRuntime');
const { matchesSchema } = require('../src/services/capabilitySchema');

const message = {
  platform: 'wechat', chatType: 'group', chatId: 'g1', senderId: 'u1',
  senderName: '甲', text: '在吗', atMe: false, msgId: 'm1', chatTitle: '示例群',
};
const gateInput = { message, localWechat: false };

function fakeRuntime(plugins) {
  return {
    installed: () => plugins,
    invoke: async (plugin, capability, input) => plugin.handlers[capability](input),
  };
}

function dispatcherFor(plugins, logger = { warn: () => {} }) {
  return new UnifiedCapabilityDispatcher({ plugins: fakeRuntime(plugins), logger });
}

function plugin(id, capability, mode, handler) {
  return { id, provides: { [capability]: { mode, scope: 'all' } }, handlers: { [capability]: handler } };
}

test('注册表声明 13 个 provider，gate/received 模式由注册表提供', () => {
  assert.equal(Object.keys(registry.providers).length, 13);
  assert.deepEqual(registry.providers['chat.pre_reply@1'].modes, ['gate']);
  assert.deepEqual(registry.providers['chat.received@1'].modes, ['observe']);
  assert.ok(registry.levels['3'].providers.includes('chat.received@1'));
  assert.ok(registry.levels['4'].providers.includes('chat.received@1'));
  assert.ok(CHAT_DATA_PROVIDERS.includes('chat.pre_reply@1'));
  assert.ok(CHAT_DATA_PROVIDERS.includes('chat.prompt@1'));
  assert.ok(!CHAT_DATA_PROVIDERS.includes('chat.dispatched@1'));
});

test('gate：按 id 顺序询问，pass 继续，首个 skip 生效，builtin 不执行', async () => {
  const calls = [];
  let builtin = 0;
  const dispatcher = dispatcherFor([
    plugin('b-skip', 'chat.pre_reply@1', 'gate', () => { calls.push('b'); return { action: 'skip' }; }),
    plugin('a-pass', 'chat.pre_reply@1', 'gate', () => { calls.push('a'); return { action: 'pass' }; }),
  ]);
  dispatcher.define('chat.pre_reply@1', { builtin: async () => { builtin++; return { action: 'pass' }; } });
  const result = await dispatcher.invoke('chat.pre_reply@1', gateInput);
  assert.deepEqual(result, { action: 'skip' });
  assert.deepEqual(calls, ['a', 'b'], '按插件 id 排序询问');
  assert.equal(builtin, 0);
});

test('gate：首个 wake 立即返回，后面的提供者不再询问', async () => {
  const calls = [];
  const dispatcher = dispatcherFor([
    plugin('a-wake', 'chat.pre_reply@1', 'gate', () => { calls.push('a'); return { action: 'wake' }; }),
    plugin('b-skip', 'chat.pre_reply@1', 'gate', () => { calls.push('b'); return { action: 'skip' }; }),
  ]);
  dispatcher.define('chat.pre_reply@1', { builtin: async () => ({ action: 'pass' }) });
  assert.deepEqual(await dispatcher.invoke('chat.pre_reply@1', gateInput), { action: 'wake' });
  assert.deepEqual(calls, ['a']);
});

test('gate：提供者抛错或输出不合法时按 pass 继续（fail-open），不吞消息', async () => {
  const warnings = [];
  const dispatcher = dispatcherFor([
    plugin('a-broken', 'chat.pre_reply@1', 'gate', () => { throw new Error('boom'); }),
    plugin('b-bad', 'chat.pre_reply@1', 'gate', () => ({ action: 'explode' })),
    plugin('c-pass', 'chat.pre_reply@1', 'gate', () => ({ action: 'pass' })),
  ], { warn: line => warnings.push(line) });
  dispatcher.define('chat.pre_reply@1', { builtin: async () => ({ action: 'pass' }) });
  assert.deepEqual(await dispatcher.invoke('chat.pre_reply@1', gateInput), { action: 'pass' });
  assert.equal(warnings.length, 2, '两个故障门禁都要记录');
});

test('enhance：按顺序拿到上一层的 output，失败时退回上一层结果', async () => {
  const seen = [];
  const dispatcher = dispatcherFor([
    plugin('a-enhance', 'chat.prompt@1', 'enhance', input => {
      seen.push(input.output.system);
      return { system: 'A' };
    }),
    plugin('b-enhance', 'chat.prompt@1', 'enhance', input => {
      seen.push(input.output.system);
      throw new Error('enhance boom');
    }),
    plugin('c-enhance', 'chat.prompt@1', 'enhance', input => {
      seen.push(input.output.system);
      return { system: input.output.system + 'C' };
    }),
  ]);
  dispatcher.define('chat.prompt@1', { builtin: async () => ({ system: 'base' }) });
  const result = await dispatcher.invoke('chat.prompt@1', { message, system: 'base' }, { scope: 'all' });
  assert.deepEqual(result, { system: 'AC' });
  assert.deepEqual(seen, ['base', 'A', 'A']);
});

test('observe：返回值被忽略，观察者抛错不影响结果', async () => {
  const dispatcher = dispatcherFor([
    plugin('a-observe', 'chat.dispatched@1', 'observe', () => ({ ignored: true })),
    plugin('b-observe', 'chat.dispatched@1', 'observe', () => { throw new Error('observe boom'); }),
  ]);
  dispatcher.define('chat.dispatched@1', { builtin: async () => ({}) });
  const result = await dispatcher.invoke('chat.dispatched@1', {
    message, text: '', action: 'ignore', sent: false,
  });
  assert.deepEqual(result, {});
});

function manifest(level, extra = {}) {
  const node = level === 4;
  return Buffer.from(JSON.stringify({
    format: 'whale-plugin/1', level, id: 'points-demo', name: '扩展点测试', author: 'tester',
    version: '1.0.0', minAppVersion: '4.3.0', description: 'extension points',
    entry: node ? 'plugin.js' : 'plugin.wasm',
    runtime: node ? 'node-full' : 'wasm-restricted',
    provides: node
      ? { 'chat.dispatched@1': { mode: 'observe', scope: 'all' }, 'app.start@1': { mode: 'observe', scope: 'all' } }
      : { 'chat.pre_reply@1': { mode: 'gate', scope: 'all' } },
    calls: [],
    ...extra,
  }));
}

test('4 级 dataAccess 运行时：声明 model.prompt 拿到 system，未声明拿不到', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-level4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const install = (name, dataAccess) => {
    const dir = path.join(root, 'plugins', name);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const payload = Buffer.from('exports.providers = {};');
    const manifest = Buffer.from(JSON.stringify({
      format: 'whale-plugin/1', level: 4, id: name, name: '四级', author: 'tester', version: '1.0.0',
      minAppVersion: '4.3.0', description: 'level4 dataAccess', entry: 'plugin.js', runtime: 'node-full',
      provides: { 'chat.prompt@1': { mode: 'enhance', scope: 'all' } }, calls: [], dataAccess,
    }));
    fs.writeFileSync(path.join(dir, 'plugin.json'), manifest);
    fs.writeFileSync(path.join(dir, 'plugin.js'), payload);
    fs.writeFileSync(path.join(dir, 'grant.json'), JSON.stringify({
      enabled: true, epoch: crypto.randomUUID(), packageHash: 'b'.repeat(64), level: 4,
      manifestHash: crypto.createHash('sha256').update(manifest).digest('hex'),
      entryHash: crypto.createHash('sha256').update(payload).digest('hex'),
      approvedProviders: ['chat.prompt@1'], approvedCalls: [], approvedDataAccess: dataAccess,
      settings: {}, fullAccess: true, nodeFullConfirmed: true,
    }));
    return path.join(dir);
  };
  install('l4-granted', ['model.prompt']);
  install('l4-plain', []);
  const runtime = new UnifiedPluginRuntime({ dataDir: root, enabled: () => true });
  const granted = runtime.read('l4-granted');
  const plain = runtime.read('l4-plain');
  assert.deepEqual(granted.dataAccess, ['model.prompt']);
  const input = { message, system: 'SYS', history: [{ role: 'user', text: 'q' }], text: 'T' };
  const grantedInput = projectDataAccess('chat.prompt@1', input, granted.dataAccess);
  assert.equal(grantedInput.system, 'SYS');
  assert.equal('history' in grantedInput, false, '没声明 chat.history 仍拿不到历史');
  const plainInput = projectDataAccess('chat.prompt@1', input, plain.dataAccess);
  assert.equal('system' in plainInput, false);
  assert.equal('history' in plainInput, false);
});

test('清单：3 级 calls 非空、非聊天 provider 拒绝，新 provider 在 4 级通过', () => {
  assert.throws(() => validateManifest(manifest(3, { calls: ['status.read@1'] }), { appVersion: '4.3.0' }),
    /manifest_calls_invalid/);
  assert.throws(() => validateManifest(manifest(2, {
    provides: { 'chat.pre_reply@1': { mode: 'gate', scope: 'all' } },
  }), { appVersion: '4.3.0' }), /manifest_provider_invalid/);
  assert.equal(validateManifest(manifest(4), { appVersion: '4.3.0' }).level, 4);
  assert.equal(declaresChatData({ 'chat.pre_reply@1': {} }), true);
  assert.equal(declaresChatData({ 'chat.dispatched@1': {} }), false);
});

/* 3 级聊天确认：由注册表里带 dataAccess 的 chat.* provider 派生。 */
function install(root, { chatConfirmed, providers = ['chat.pre_reply@1'] }) {
  const dir = path.join(root, 'plugins', 'chat-demo');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const payload = Buffer.from('00', 'hex');
  const raw = Buffer.from(JSON.stringify({
    format: 'whale-plugin/1', level: 3, id: 'chat-demo', name: '聊天确认', author: 'tester',
    version: '1.0.0', minAppVersion: '4.3.0', description: 'chat consent',
    entry: 'plugin.wasm', runtime: 'wasm-restricted',
    provides: Object.fromEntries(providers.map(name => [name, { mode: name === 'chat.pre_reply@1' ? 'gate' : 'enhance', scope: 'all' }])),
    calls: [],
  }));
  fs.writeFileSync(path.join(dir, 'plugin.json'), raw);
  fs.writeFileSync(path.join(dir, 'plugin.wasm'), payload);
  fs.writeFileSync(path.join(dir, 'grant.json'), JSON.stringify({
    enabled: true, epoch: crypto.randomUUID(), packageHash: 'a'.repeat(64), level: 3,
    manifestHash: crypto.createHash('sha256').update(raw).digest('hex'),
    entryHash: crypto.createHash('sha256').update(payload).digest('hex'),
    approvedProviders: providers, approvedCalls: [], approvedDataAccess: [],
    settings: {}, fullAccess: false, nodeFullConfirmed: false, chatConfirmed,
  }));
  return dir;
}

test('运行时：3 级聊天 provider 缺少 chatConfirmed 拒绝，确认后放行', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-points-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const runtime = new UnifiedPluginRuntime({ dataDir: root, enabled: () => true });
  install(root, { chatConfirmed: false });
  assert.equal(runtime.read('chat-demo'), null);
  install(root, { chatConfirmed: true });
  const flow = runtime.read('chat-demo');
  assert.ok(flow, '确认后应能读取');
  assert.equal(flow.level, 3);
});

test('dispatcher 把 chatId 传给运行时，供 state 定位', async () => {
  const seen = [];
  const plugins = {
    installed: () => [plugin('a', 'chat.reply@1', 'enhance', () => ({ text: 'x' }))],
    invoke: async (target, capability, input, options) => {
      seen.push(options.chatId);
      return target.handlers[capability](input);
    },
  };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins, logger: { warn() {} } });
  dispatcher.define('chat.reply@1', { builtin: async () => ({ text: 'base' }) });
  await dispatcher.invoke('chat.reply@1', {
    message: { platform: 'wechat', chatType: 'group', chatId: 'g1', senderId: 'u1',
      senderName: '甲', text: '在吗', atMe: false, replyToBot: false, msgId: 'm1' },
    text: 'base',
  }, { chatId: 'c-1' });
  assert.deepEqual(seen, ['c-1']);
});

test('dataAccess 按插件投影：声明了才给 system/history，新旧词等价', () => {
  const input = { message, system: 'SYS', history: [{ role: 'user', text: 'q' }], text: 'T' };
  const none = projectDataAccess('chat.prompt@1', input, []);
  assert.equal('system' in none, false, '没声明 model.prompt 不给 system');
  assert.equal('history' in none, false, '没声明 chat.history 不给历史');

  const systemOnly = projectDataAccess('chat.prompt@1', input, ['model.prompt']);
  assert.equal(systemOnly.system, 'SYS');
  assert.equal('history' in systemOnly, false);

  const historyOnly = projectDataAccess('chat.prompt@1', input, ['chat.history']);
  assert.equal('system' in historyOnly, false);
  assert.deepEqual(historyOnly.history, input.history);

  const both = projectDataAccess('chat.prompt@1', input, ['model.prompt', 'chat.history']);
  assert.equal(both.system, 'SYS');
  assert.deepEqual(both.history, input.history);

  const newNames = projectDataAccess('chat.reply@1', input, ['system-prompt', 'conversation-history']);
  assert.equal(newNames.system, 'SYS');
  assert.deepEqual(newNames.history, input.history);

  assert.equal('system' in projectDataAccess('chat.generate@1', input, []), false);
  assert.equal(projectDataAccess('chat.before_send@1', input, []).text, 'T');
  assert.equal(projectDataAccess('chat.dispatched@1', input, []).system, 'SYS', '非 dataAccess 能力不投影');
});

test('所有聊天 provider 的 input/output schema 都接受可选 state，未声明的能力不接受', () => {
  const message = {
    platform: 'wechat', chatType: 'private', chatId: 'c1', senderId: 'u1',
    senderName: '甲', text: '在吗', atMe: false, replyToBot: false, msgId: 'm1',
  };
  for (const [capability, input, output] of [
    ['chat.pre_reply.input@1', { message, localWechat: false }, null],
    ['chat.prompt.input@1', { message, system: 'S' }, null],
    ['chat.before_send.input@1', { message, text: 'T' }, null],
    ['chat.reply.input@1', { message, text: 'T' }, null],
    ['chat.pre_reply.output@1', null, { action: 'pass', state: { n: 1 } }],
    ['chat.prompt.output@1', null, { system: 'S', state: { n: 1 } }],
    ['chat.before_send.output@1', null, { text: 'T', state: { n: 1 } }],
    ['chat.reply.output@1', null, { text: 'T', state: { n: 1 } }],
  ]) {
    if (input) assert.equal(matchesSchema({ ...input, state: { a: 1 } }, capability), true, capability);
    if (output) assert.equal(matchesSchema(output, capability), true, capability);
  }
  assert.equal(matchesSchema({
    message: { ...message, senderId: 'u1', atMe: true, replyToBot: true, msgId: 'm1' }, text: 'T',
  }, 'chat.reply.input@1'), true);
  assert.equal(matchesSchema({
    message: { platform: 'wechat', chatType: 'private', chatId: 'c1', senderId: 'u1', text: 'x' },
    system: 's', turns: [], state: {},
  }, 'chat.generate.input@1'), false, 'generate 不开放 state');
});

test('state：首次为空、按插件×会话隔离、写入后读回、超限/非对象拒绝、LRU 200', () => {
  const logs = [];
  const runtime = new UnifiedPluginRuntime({ dataDir: 'unused', enabled: () => true,
    logger: { info: line => logs.push(line) } });
  assert.deepEqual(runtime.getSessionState('p1', 'c1'), {});
  runtime.saveSessionState('p1', 'c1', { n: 1 });
  assert.deepEqual(runtime.getSessionState('p1', 'c1'), { n: 1 });
  assert.deepEqual(runtime.getSessionState('p1', 'c2'), {}, '不同会话隔离');
  assert.deepEqual(runtime.getSessionState('p2', 'c1'), {}, '不同插件隔离');
  assert.throws(() => runtime.saveSessionState('p1', 'c1', [1, 2]), /invalid_capability_output/);
  assert.throws(() => runtime.saveSessionState('p1', 'c1', { big: 'x'.repeat(9 * 1024) }),
    /invalid_capability_output/);
  for (let index = 0; index < 201; index++) runtime.saveSessionState('p1', 's' + index, { index });
  assert.deepEqual(runtime.getSessionState('p1', 's0'), {}, '最旧会话被 LRU 淘汰');
  assert.deepEqual(runtime.getSessionState('p1', 's200'), { index: 200 });
  assert.ok(logs.every(line => !line.includes('index') && !line.includes('s200')), '日志只记字节数');
});

test('state：停用/更新时清除该插件状态，stop 清空全部', async () => {
  const runtime = new UnifiedPluginRuntime({ dataDir: 'unused', enabled: () => true });
  runtime.saveSessionState('p1', 'c1', { a: 1 });
  runtime.saveSessionState('p2', 'c1', { b: 2 });
  runtime.read = () => null;
  assert.equal(runtime.current({ id: 'p1' }), null);
  assert.deepEqual(runtime.getSessionState('p1', 'c1'), {}, '停用/更新清除');
  assert.deepEqual(runtime.getSessionState('p2', 'c1'), { b: 2 }, '不误删其它插件');
  await runtime.stop();
  assert.deepEqual(runtime.getSessionState('p2', 'c1'), {}, 'stop 清空全部');
});
