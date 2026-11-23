'use strict';

/**
 * 宿主能力分发（统一通信层）的单元验收。
 *
 * 这里只验证 dispatcher 这一层：登记唯一性、授权/声明顺序、
 * 多插件同接口互不影响、宿主内部调用不受插件名额影响。
 * 端到端（真装插件、真跑 host.call）在 tests/plugin-sdk*.test.js。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const registry = require('../src/services/pluginProtocolRegistry.json');

const plugin = (id, calls, extra = {}) => ({ id, calls, ...extra });

function fixture() {
  const plugins = {
    isApproved: flow => flow.approved !== false,
    installed: () => [],
    invoke: async () => { throw Object.assign(new Error('unused'), { code: 'unused' }); },
  };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins });
  const seen = [];
  dispatcher.defineHost('status.read@1', async (input, flow) => {
    seen.push({ name: 'status.read@1', plugin: flow?.id || null });
    return { version: '4.3.0', running: true, pluginProtocol: registry.format };
  });
  dispatcher.defineHost('reminders.list@1', async (_input, flow) => {
    seen.push({ name: 'reminders.list@1', plugin: flow?.id || null });
    return { reminders: [{ id: `r-${flow?.id || 'host'}`, chatId: 'c', text: 't', dueAt: 1, status: 'pending' }] };
  });
  return { dispatcher, seen };
}

test('host capability names must exist in the shared registry', () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  assert.throws(() => dispatcher.defineHost('nope.read@1', async () => ({})), { code: 'invalid_capability_contract' });
  assert.throws(() => dispatcher.defineHost('status.read@1', 'not-a-function'), { code: 'invalid_capability_contract' });
  dispatcher.defineHost('status.read@1', async () => ({ version: '4.3.0', running: true, pluginProtocol: registry.format }));
  assert.throws(() => dispatcher.defineHost('status.read@1', async () => ({})), { code: 'invalid_capability_contract' });
  assert.equal(dispatcher.hasHost('status.read@1'), true);
});

test('internal callers do not need a plugin declaration', async () => {
  const { dispatcher } = fixture();
  assert.deepEqual(await dispatcher.invokeHost('status.read@1', {}),
    { version: '4.3.0', running: true, pluginProtocol: registry.format });
});

test('plugin callers must declare the capability and keep a live grant', async () => {
  const { dispatcher, seen } = fixture();
  await assert.rejects(dispatcher.invokeHost('status.read@1', {}, { plugin: plugin('a', []) }),
    { code: 'host_capability_not_declared' });
  await assert.rejects(dispatcher.invokeHost('status.read@1', {}, { plugin: plugin('a', ['status.read@1'], { approved: false }) }),
    { code: 'grant_revoked' });
  await assert.rejects(dispatcher.invokeHost('message.submit@1', { chatId: 'c', text: 'x' },
    { plugin: plugin('a', ['message.submit@1']) }), { code: 'host_capability_disabled' });
  await assert.rejects(dispatcher.invokeHost('api.read@1', {}, { plugin: null }), { code: 'host_capability_unknown' });
  assert.deepEqual(seen, []);
});

test('input and output are validated at the single seam', async () => {
  const { dispatcher } = fixture();
  await assert.rejects(dispatcher.invokeHost('status.read@1', { extra: true }),
    { code: 'invalid_host_capability_input' });

  // status.read@1 的输出 schema 是严格的：多一个字段就说明实现和注册表已经分叉，
  // 必须在交付给插件前拒绝，而不是把不一致的形状透出去。
  const strict = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  strict.defineHost('status.read@1', async () => ({
    version: '4.3.0', running: true, pluginProtocol: registry.format, extra: true,
  }));
  await assert.rejects(strict.invokeHost('status.read@1', {}), { code: 'invalid_host_capability_output' });
});

test('several plugins may call the same capability without blocking each other', async () => {
  const { dispatcher, seen } = fixture();
  const calls = ['reminders.list@1'];
  const [a, b, c] = await Promise.all([
    dispatcher.invokeHost('reminders.list@1', {}, { plugin: plugin('a', calls) }),
    dispatcher.invokeHost('reminders.list@1', {}, { plugin: plugin('b', calls) }),
    dispatcher.invokeHost('reminders.list@1', {}, { plugin: plugin('c', calls) }),
  ]);
  assert.deepEqual(a.reminders[0].id, 'r-a');
  assert.deepEqual(b.reminders[0].id, 'r-b');
  assert.deepEqual(c.reminders[0].id, 'r-c');
  assert.equal(seen.filter(row => row.name === 'reminders.list@1').length, 3);
});

test('one plugin failing does not break another plugin using the same capability', async () => {
  const plugins = {
    isApproved: flow => flow.approved !== false,
    installed: () => [],
    invoke: async () => null,
  };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins });
  dispatcher.defineHost('contacts.search@1', async (_input, flow) => {
    if (flow?.id === 'broken') throw Object.assign(new Error('boom'), { code: 'boom' });
    return { friends: [], groups: [] };
  });
  await assert.rejects(dispatcher.invokeHost('contacts.search@1', {}, { plugin: plugin('broken', ['contacts.search@1']) }),
    { code: 'boom' });
  assert.deepEqual(await dispatcher.invokeHost('contacts.search@1', {}, { plugin: plugin('good', ['contacts.search@1']) }),
    { friends: [], groups: [] });
});

test('aborted callers are refused before the handler runs', async () => {
  const { dispatcher, seen } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(dispatcher.invokeHost('status.read@1', {}, { signal: controller.signal }),
    { code: 'capability_aborted' });
  assert.deepEqual(seen, []);
});

test('a declared but unimplemented capability reports unavailable instead of silently passing', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  await assert.rejects(dispatcher.invokeHost('digest.status@1', {}), { code: 'host_capability_unavailable' });
});
