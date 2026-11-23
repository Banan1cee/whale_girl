'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { UnifiedPluginRuntime } = require('../src/services/unifiedPluginRuntime');

function setup(t, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-v5-'));
  const root = path.join(dataDir, 'plugins');
  fs.mkdirSync(root);
  const runtime = new UnifiedPluginRuntime({ dataDir, ...options });
  t.after(async () => {
    await runtime.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const install = (id, javascript, { epoch = randomUUID(), level = 4, fullAccess = level === 4, grantFields = {}, ...overrides } = {}) => {
    const plugin = path.join(root, id);
    fs.mkdirSync(path.join(plugin, 'data'), { recursive: true });
    const manifest = { format: 'whale-plugin/1', level, id, name: 'Fixture', author: 'Tester', version: '1.0.0', minAppVersion: '1.0.0',
      description: 'Fixture plugin', appEpoch: 2,
      runtime: level === 4 ? 'node-full' : 'wasm-restricted', entry: level === 4 ? 'plugin.js' : 'plugin.wasm', provides: { 'tool.run@1': { mode: 'tool', scope: 'manual' } },
      calls: [], ...overrides };
    const raw = JSON.stringify(manifest);
    const digest = value => createHash('sha256').update(value).digest('hex');
    fs.writeFileSync(path.join(plugin, 'plugin.json'), raw);
    fs.writeFileSync(path.join(plugin, manifest.entry), javascript);
    fs.writeFileSync(path.join(plugin, 'grant.json'), JSON.stringify({ epoch,
      packageHash: createHash('sha256').update(raw).update(javascript).digest('hex'),
      manifestHash: digest(raw), entryHash: digest(javascript), enabled: true, level, fullAccess, nodeFullConfirmed: fullAccess, chatConfirmed: level === 3,
      approvedCalls: manifest.calls, approvedProviders: Object.keys(manifest.provides), approvedDataAccess: manifest.dataAccess || [], settings: { level: 2 }, ...grantFields }));
    return plugin;
  };
  return { runtime, root, install };
}

test('restricted level 1 runs an integer tool without Node authorization', async t => {
  const { runtime, install } = setup(t);
  const module = Buffer.from('0061736d010000000105016000017f030201000707010372756e00000a06010400412a0b', 'hex');
  install('integer', module, { level: 1 });
  const [flow] = runtime.installed();
  assert.ok(flow);
  assert.equal(await runtime.invoke(flow, 'tool.run@1', null), 42);
});

// 只用标准 Wasm 与逐字节输出，不依赖本机 WAT 编译器。
function wasmOutput(text, namespace = 'whale_plugin') {
  const section = (id, bytes) => [id, bytes.length, ...bytes];
  const body = [0, ...Array.from(Buffer.from(text)).flatMap(byte => [65, ...(byte < 64 ? [byte] : [(byte & 127) | 128, byte >> 7]), 16, 0]), 65, 0, 11];
  return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [2, 96, 1, 127, 0, 96, 0, 1, 127]),
    ...section(2, [1, namespace.length, ...Buffer.from(namespace), 11, ...Buffer.from('output_byte'), 0, 0]),
    ...section(3, [1, 1]), ...section(7, [1, 3, 114, 117, 110, 0, 1]), ...section(10, [1, body.length, ...body])]);
}

test('restricted text and chat providers return their level-specific results', async t => {
  const { runtime, install } = setup(t);
  install('text', wasmOutput('你好'), { level: 2 });
  const provides = { 'chat.reply@1': { mode: 'enhance', scope: 'all' } };
  install('chat', wasmOutput('{"text":"ok"}'), { level: 3, provides });
  install('no-chat-consent', wasmOutput('{"text":"ok"}'), { level: 3, provides, grantFields: { chatConfirmed: false } });
  install('low-chat', wasmOutput('no'), { level: 2, provides });
  install('host-call', wasmOutput('no'), { level: 3, calls: ['status.read@1'] });
  install('full-grant', wasmOutput('no'), { level: 2, fullAccess: true });
  const [chat, text] = runtime.installed();
  assert.deepEqual(runtime.installed().map(flow => flow.id), ['chat', 'text']);
  assert.deepEqual(await runtime.invoke(chat, 'chat.reply@1', {}), { text: 'ok' });
  assert.equal(await runtime.invoke(text, 'tool.run@1', ''), '你好');
});

test('restricted Wasm rejects non-whitelisted imports and stops running after revocation', async t => {
  const { runtime, install } = setup(t);
  install('foreign-import', wasmOutput('x', 'wasi_snapshot_preview1'), { level: 2 });
  const [flow] = runtime.installed();
  await assert.rejects(runtime.invoke(flow, 'tool.run@1', ''), { code: 'plugin_error' });
  fs.unlinkSync(path.join(flow.pluginData, '..', 'grant.json'));
  await assert.rejects(runtime.invoke(flow, 'tool.run@1', ''), { code: 'grant_revoked' });
});

test('level 3 data access must be granted before history or system prompt reach the plugin', async t => {
  const { runtime, install } = setup(t);
  const provides = { 'chat.reply@1': { mode: 'enhance', scope: 'all' } };
  install('granted', wasmOutput('{"text":"ok"}'), { level: 3, provides, dataAccess: ['chat.history'] });
  install('revoked', wasmOutput('{"text":"ok"}'), { level: 3, provides, dataAccess: ['chat.history'],
    grantFields: { approvedDataAccess: [] } });
  install('not-allowed', wasmOutput('{"text":"ok"}'), { level: 2, provides, dataAccess: ['chat.history'] });
  const [granted] = runtime.installed();
  assert.equal(granted.id, 'granted');
  assert.deepEqual(granted.dataAccess, ['chat.history']);
  assert.deepEqual(await runtime.invoke(granted, 'chat.reply@1', { message: {}, text: '' }), { text: 'ok' });
});

test('reply provider input is projected to the target grant before transport', async t => {
  const { runtime, install } = setup(t);
  const provides = { 'chat.reply@1': { mode: 'enhance', scope: 'all' } };
  const grants = { plain: [], history: ['chat.history'], prompt: ['model.prompt'], both: ['chat.history', 'model.prompt'] };
  for (const [id, dataAccess] of Object.entries(grants)) {
    install(id, wasmOutput('{"text":"ok"}'), { level: 3, provides, dataAccess });
  }
  // 记录投影并结束任务，不把测试数据传给插件进程。
  const inputs = new Map();
  t.mock.method(runtime, 'spawn', job => {
    inputs.set(job.flow.id, job.payload);
    runtime.finish(job, null, { text: 'ok' });
  });
  const base = { message: { text: 'example' }, text: 'draft', output: { text: 'previous draft' } };
  const history = [{ role: 'user', text: 'synthetic history' }];
  const system = 'synthetic system prompt';
  for (const flow of runtime.installed()) {
    await runtime.invoke(flow, 'chat.reply@1', { ...base, history, system });
  }
  assert.deepEqual(inputs.get('plain'), base);
  assert.deepEqual(inputs.get('history'), { ...base, history });
  assert.deepEqual(inputs.get('prompt'), { ...base, system });
  assert.deepEqual(inputs.get('both'), { ...base, history, system });
});

test('scheduled manifests require a bounded interval and validate optional entry bytes', t => {
  const { runtime, install } = setup(t);
  const { validateManifest } = require('../src/services/pluginProtocol');
  const source = `exports.providers = { 'task.tick@1': () => null };`;
  const manifest = intervalSeconds => ({ provides: { 'task.tick@1': { mode: 'schedule', scope: 'all', intervalSeconds } } });
  const invalid = install('missing-interval', source, manifest(undefined));
  const valid = install('valid-interval', source, manifest(30));
  const raw = directory => fs.readFileSync(path.join(directory, 'plugin.json'));
  const entryBytes = Buffer.from(source);
  const options = { appVersion: '1.0.0', appEpoch: 2 };
  assert.throws(() => validateManifest(raw(invalid), options), /manifest_provider_interval_invalid/);
  assert.deepEqual(runtime.installed().map(flow => flow.id), ['valid-interval']);
  assert.equal(validateManifest(raw(valid), { ...options, entryBytes }).id, 'valid-interval');
  assert.throws(() => validateManifest(raw(valid), { ...options, entryBytes: Buffer.alloc(0) }), /entry_size_invalid/);
});

const echo = `exports.providers = { 'tool.run@1': input => input };`;

test('only granted whale-plugin/1 directories load; providers run in the plugin data directory', async t => {
  const { runtime, root, install } = setup(t);
  fs.writeFileSync(path.join(root, 'flat.flow.json'), JSON.stringify({ api: 5 }));
  install('old', echo, { format: 'whale-plugin/0' });
  install('old-fields', echo, { api: 5, hooks: ['tool.run@1'] });
  install('no-epoch', echo, { epoch: null });
  install('no-consent', echo, { fullAccess: false });
  const modified = install('tampered', echo);
  fs.appendFileSync(path.join(modified, 'plugin.js'), '\n// Changed after consent');
  install('tool', `exports.providers = { 'tool.run@1': input => ({ ...input, cwd: process.cwd() }) };`);
  assert.deepEqual(runtime.installed().map(flow => flow.id), ['tool']);
  const [flow] = runtime.installed();
  assert.equal(runtime.isApproved(flow), true);
  assert.deepEqual(await runtime.invoke(flow, 'tool.run@1', { number: 42 }), { number: 42, cwd: path.join(root, 'tool', 'data') });
  await assert.rejects(runtime.invoke(flow, 'chat.reply@1', {}), { code: 'capability_not_declared' });
});

test('the Worker only runs versioned providers and permits declared host calls', async t => {
  const seen = [];
  const { runtime, install } = setup(t, { hostCall: async (name, input, flow, { signal, deadline }) => {
    seen.push({ name, input, id: flow.id, aborted: signal.aborted, deadline });
    return { state: 'ready' };
  } });
  const source = `exports.providers = { 'tool.run@1': async (input, { host }) => {
    try { return await host.call('status.read@1', input); } catch (error) { return {code: error.code}; }
  } };`;
  install('allowed', source, { calls: ['status.read@1'] });
  install('blocked', source);
  install('legacy-entry', `exports.run = () => 'must not execute';`);
  const [allowed, blocked, legacy] = runtime.installed();
  const deadline = Date.now() + 5000;
  assert.deepEqual(await runtime.invoke(allowed, 'tool.run@1', { probe: true }, { deadline }), { state: 'ready' });
  assert.deepEqual(await runtime.invoke(blocked, 'tool.run@1', {}), { code: 'host_capability_not_declared' });
  await assert.rejects(runtime.invoke(legacy, 'tool.run@1', {}), { code: 'plugin_error' });
  assert.deepEqual(seen, [{ name: 'status.read@1', input: { probe: true }, id: 'allowed', aborted: false, deadline }]);
});

test('a declared capability still requires its grant, and the handler sees fresh settings and a signal', async t => {
  const { runtime, install } = setup(t, { hostCall: () => assert.fail('unapproved RPC reached the host') });
  install('tool', `exports.providers = { 'tool.run@1': async (_input, { host, signal, settings }) => {
    try { await host.call('status.read@1', {}); }
    catch (error) { return { code: error.code, aborted: signal.aborted, level: settings.level }; }
  } };`, { calls: ['status.read@1'], grantFields: { approvedCalls: [] } });
  const [flow] = runtime.installed();
  assert.deepEqual(await runtime.invoke(flow, 'tool.run@1', {}), {
    code: 'host_capability_not_declared', aborted: false, level: 2,
  });
  install('tool', echo, { grantFields: { approvedProviders: [] } });
  await assert.rejects(runtime.invoke(runtime.installed()[0], 'tool.run@1', {}), { code: 'capability_not_declared' });
});

test('globally disabled calls do not prevent installation or reach the host even if listed in the grant', async t => {
  let called = false;
  const { runtime, install } = setup(t, { hostCall: () => { called = true; } });
  install('tool', `exports.providers = { 'tool.run@1': async (_input, { host }) => {
    try { await host.call('message.submit@1', {}); } catch (error) { return error.code; }
    return 'unexpected success';
  } };`, { calls: ['status.read@1', 'message.submit@1'], grantFields: { approvedCalls: ['status.read@1'] } });
  const [flow] = runtime.installed();
  assert.deepEqual(flow.calls, ['status.read@1']);
  assert.equal(await runtime.invoke(flow, 'tool.run@1', {}), 'host_capability_disabled');
  assert.equal(called, false);
  install('forged', echo, { calls: ['message.submit@1'] });
  assert.deepEqual(runtime.installed().map(item => item.id), ['tool']);
});

test('manifest version ranges, UTF-8 entry, and saved settings must validate before registration', t => {
  const { runtime, install } = setup(t);
  const settingsSchema = { type: 'object', properties: { level: { type: 'integer', minimum: 1 } },
    required: ['level'], additionalProperties: false };
  const appCompatibility = [{ appEpoch: 1, minAppVersion: '4.1.2' }, { appEpoch: 2, minAppVersion: '1.0.0' }];
  install('valid', echo, { appCompatibility, maxAppVersion: '1.0.9', settingsSchema });
  install('missing-field', echo, { description: undefined });
  install('bad-epoch', echo, { appEpoch: 3 });
  install('duplicate-epoch', echo, { appCompatibility: [appCompatibility[0], appCompatibility[0]] });
  install('range-backwards', echo, { appCompatibility: [{ ...appCompatibility[1], maxAppVersion: '0.9.9' }] });
  install('top-backwards', echo, { maxAppVersion: '1.0' });
  install('bad-version', echo, { version: 'v1.0.0' });
  install('bad-settings', echo, { settingsSchema, grantFields: { settings: { level: '2' } } });
  install('bad-utf8', Buffer.from([0xc3, 0x28]));
  assert.deepEqual(runtime.installed().map(flow => flow.id), ['valid']);
});

test('changing settings invalidates the old revision even without rotating the epoch', async t => {
  const { runtime, install } = setup(t);
  const epoch = randomUUID();
  const source = `exports.providers = { 'tool.run@1': (_input, { settings }) => settings.level };`;
  install('tool', source, { epoch });
  const [old] = runtime.installed();
  install('tool', source, { epoch, grantFields: { settings: { level: 3 } } });
  assert.equal(runtime.isApproved(old), false);
  await assert.rejects(runtime.invoke(old, 'tool.run@1', {}), { code: 'grant_revoked' });
  assert.equal(await runtime.invoke(runtime.installed()[0], 'tool.run@1', {}), 3);
});

test('a new epoch revokes queued and active work, aborts the matching host call, and drops its late result', async t => {
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let finish;
  const { runtime, install } = setup(t, { hostCall: async (_name, _input, _flow, { signal }) => {
    enter(signal);
    return new Promise(resolve => { finish = resolve; });
  } });
  const source = `exports.providers = { 'tool.run@1': async (input, { host }) => {
    if (input.hold) return host.call('status.read@1');
    return 'new generation';
  } };`;
  install('tool', source, { calls: ['status.read@1'] });
  const [flow] = runtime.installed();
  const active = assert.rejects(runtime.invoke(flow, 'tool.run@1', { hold: true }), { code: 'grant_revoked' });
  const queued = assert.rejects(runtime.invoke(flow, 'tool.run@1', {}), { code: 'grant_revoked' });
  const rpcSignal = await entered;
  install('tool', source, { calls: ['status.read@1'] });
  runtime.reconcile();
  await Promise.all([active, queued]);
  assert.equal(rpcSignal.aborted, true);
  finish({ ignored: true });
  assert.equal(runtime.isApproved(flow), false);
  assert.equal(await runtime.invoke(runtime.installed()[0], 'tool.run@1', {}), 'new generation');
});

test('deadline includes queue time and an active timeout retires a busy Worker', async t => {
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const { runtime, install } = setup(t, { hostCall: async () => { enter(); return null; } });
  install('tool', `exports.providers = { 'tool.run@1': async (input, { host }) => {
    if (input === 'hold') { await host.call('status.read@1'); for (;;) {} }
    return input;
  } };`, { calls: ['status.read@1'] });
  const [flow] = runtime.installed();
  const controller = new AbortController();
  const deadline = Date.now() + 1600;
  const active = assert.rejects(runtime.invoke(flow, 'tool.run@1', 'hold', { deadline }), { code: 'capability_timeout' });
  await entered;
  const cancelled = assert.rejects(runtime.invoke(flow, 'tool.run@1', 'queued', { signal: controller.signal }),
    { code: 'capability_aborted' });
  controller.abort();
  await cancelled;
  await assert.rejects(runtime.invoke(flow, 'tool.run@1', 'queued', { deadline: Date.now() + 50 }),
    { code: 'capability_timeout' });
  await active;
  assert.equal(await runtime.invoke(flow, 'tool.run@1', 'ok'), 'ok');
});
