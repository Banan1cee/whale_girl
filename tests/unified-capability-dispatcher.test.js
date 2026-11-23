'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');

const plugin = (id, provides, extra = {}) => ({
  id, packageHash: id.padEnd(64, '0').slice(0, 64), epoch: 'epoch-' + id, settings: {},
  provides, calls: [], executionTimeoutMs: 30000, ...extra,
});

function fixture(installed, handlers = {}) {
  const calls = [];
  const plugins = {
    installed: () => installed,
    invoke: async (flow, capability, input) => {
      calls.push({ id: flow.id, capability, input });
      const handler = handlers[flow.id];
      if (!handler) throw Object.assign(new Error('plugin_error'), { code: 'plugin_error' });
      return handler(input, capability);
    },
  };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins });
  dispatcher
    .define('chat.reply@1', { builtin: async input => ({ text: input.text }) })
    .define('chat.handle@1', { builtin: async () => ({ action: 'reply', reply: 'builtin' }) })
    .define('chat.search@1', { builtin: async () => ({ text: '', items: [], status: 'empty' }) })
    .define('chat.generate@1', { builtin: async () => ({ text: 'builtin-model' }) })
    .define('tool.run@1', { builtin: async () => null })
    .define('task.tick@1', { builtin: async () => null });
  return { dispatcher, calls };
}

test('no provider keeps the builtin result unchanged', async () => {
  const { dispatcher } = fixture([]);
  assert.deepEqual(await dispatcher.invoke('chat.reply@1', { message: { platform: 'web', chatType: 'private', chatId: 'c', text: 'hi' }, text: 'draft' }),
    { text: 'draft' });
});

test('enhance runs after builtin and receives the previous output; observe cannot change it', async () => {
  const { dispatcher } = fixture([
    plugin('b-observe', { 'chat.reply@1': { mode: 'observe', scope: 'all' } }),
    plugin('a-enhance', { 'chat.reply@1': { mode: 'enhance', scope: 'all' } }),
  ], {
    'b-observe': () => ({ text: 'ignored' }),
    'a-enhance': input => ({ text: input.output.text + ' +enhanced' }),
  });
  const out = await dispatcher.invoke('chat.reply@1', {
    message: { platform: 'web', chatType: 'private', chatId: 'c', text: 'hi' }, text: 'draft',
  });
  assert.deepEqual(out, { text: 'draft +enhanced' });
});

test('a failing observe provider is isolated from the normal result', async () => {
  const { dispatcher } = fixture([
    plugin('broken-observe', { 'chat.reply@1': { mode: 'observe', scope: 'all' } }),
  ]);   // 没有 handler → 插件调用会抛 plugin_error
  const out = await dispatcher.invoke('chat.reply@1', {
    message: { platform: 'web', chatType: 'private', chatId: 'c', text: 'hi' }, text: 'draft',
  });
  assert.deepEqual(out, { text: 'draft' }, '观察者失败只能记日志，不能改写或打断宿主结果');
});

test('preflight fallbackBuiltin honors the per-call builtin override', async () => {
  const { dispatcher, calls } = fixture([
    plugin('takeover', { 'chat.handle@1': { mode: 'replace', scope: 'all' } }),
  ], { takeover: () => ({ action: 'reply', reply: 'plugin' }) });
  const input = { message: { platform: 'web', chatType: 'private', chatId: 'c', senderId: 's', text: 'x' }, localWechat: false };
  let overridden = 0;
  const out = await dispatcher.invoke('chat.handle@1', input, {
    preflight: async () => ({ allowed: false, fallbackBuiltin: true }),
    builtin: async (_value, options) => {
      overridden += 1;
      assert.ok(options && 'signal' in options, 'override 仍应收到 signal/deadline');
      return { action: 'reply', reply: 'override' };
    },
  });
  assert.equal(overridden, 1, '前置回退要落在本次调用的 builtin override 上');
  assert.deepEqual(out, { action: 'reply', reply: 'override' });
  assert.deepEqual(calls, [], '前置回退仍然不能运行插件');
});

test('two replace owners are refused before any provider runs', async () => {
  const calls = [];
  const { dispatcher } = fixture([
    plugin('one', { 'chat.handle@1': { mode: 'replace', scope: 'all' } }),
    plugin('two', { 'chat.handle@1': { mode: 'replace', scope: 'all' } }),
  ], { one: () => ({ action: 'reply', reply: 'one' }), two: () => ({ action: 'reply', reply: 'two' }) });
  await assert.rejects(dispatcher.invoke('chat.handle@1', {
    message: { platform: 'web', chatType: 'private', chatId: 'c', senderId: 's', text: 'x' }, localWechat: false,
  }), { code: 'capability_owner_conflict' });
  assert.deepEqual(calls, []);
});

test('a preflight denial short-circuits providers, and fallbackBuiltin bypasses takeover', async () => {
  const { dispatcher, calls } = fixture([
    plugin('takeover', { 'chat.handle@1': { mode: 'replace', scope: 'all' } }),
  ], { takeover: () => ({ action: 'reply', reply: 'plugin' }) });
  const input = { message: { platform: 'web', chatType: 'group', chatId: 'g', senderId: 's', text: 'x' }, localWechat: false };
  assert.deepEqual(await dispatcher.invoke('chat.handle@1', input, {
    preflight: async () => ({ allowed: false, result: { action: 'ignore', reason: 'muted_group' } }),
  }), { action: 'ignore', reason: 'muted_group' });
  assert.deepEqual(calls, []);
  assert.deepEqual(await dispatcher.invoke('chat.handle@1', input, {
    preflight: async () => ({ allowed: false, fallbackBuiltin: true }),
  }), { action: 'reply', reply: 'builtin' });
});

test('invalid provider output is rejected instead of being delivered', async () => {
  const { dispatcher } = fixture([
    plugin('bad', { 'chat.handle@1': { mode: 'replace', scope: 'all' } }),
  ], { bad: () => ({ action: 'reply', reply: '   ' }) });
  await assert.rejects(dispatcher.invoke('chat.handle@1', {
    message: { platform: 'web', chatType: 'private', chatId: 'c', senderId: 's', text: 'x' }, localWechat: false,
  }), { code: 'invalid_capability_output' });
});

test('tool.run@1 requires the explicitly selected installed plugin', async () => {
  const { dispatcher } = fixture([
    plugin('tool', { 'tool.run@1': { mode: 'tool', scope: 'manual' } }),
  ], { tool: input => ({ echo: input }) });
  assert.deepEqual(await dispatcher.runTool('tool', { a: 1 }), { echo: { a: 1 } });
  await assert.rejects(dispatcher.runTool('missing', {}), { code: 'plugin_not_enabled' });
  await assert.rejects(dispatcher.invoke('tool.run@1', {}), { code: 'invalid_capability_scope' });
});

test('search enhance gets the previous payload and keeps the contract', async () => {
  const { dispatcher } = fixture([
    plugin('searcher', { 'chat.search@1': { mode: 'enhance', scope: 'all' } }),
  ], { searcher: input => ({ text: 'prev:' + input.previous.text, items: [], status: 'ok' }) });
  const out = await dispatcher.invoke('chat.search@1', {
    message: { platform: 'web', chatType: 'private', chatId: 'c', text: 'q' },
  });
  assert.deepEqual(out, { text: 'prev:', items: [], status: 'ok' });
});

test('a failing search enhance degrades to the builtin payload', async () => {
  // 没有 handler → 插件调用抛错；network-read 的增强失败只能丢掉增量资料，不能判死整轮。
  const { dispatcher } = fixture([
    plugin('broken-augment', { 'chat.search@1': { mode: 'enhance', scope: 'all' } }),
  ]);
  const out = await dispatcher.invoke('chat.search@1', {
    message: { platform: 'web', chatType: 'private', chatId: 'c', text: 'q' },
  });
  assert.deepEqual(out, { text: '', items: [], status: 'empty' });
});

test('scheduled tasks follow installed providers and are cancelled when they disappear', async () => {
  const jobs = new Map();
  const scheduler = {
    now: () => 1000,
    every: (name, ms, fn) => { jobs.set(name, { ms, fn }); },
    cancel: name => jobs.delete(name),
  };
  let installed = [];
  const ticker = (intervalSeconds, authRevision, label) => plugin('ticker', {
    'task.tick@1': { mode: 'schedule', scope: 'all', intervalSeconds },
  }, { epoch: 'e1', authRevision, settings: { label } });
  const calls = [];
  const plugins = {
    installed: () => installed,
    isApproved: flow => installed.includes(flow),
    invoke: async (flow, _name, input) => { calls.push([flow.authRevision, input.settings]); return null; },
  };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins });
  dispatcher.define('task.tick@1', { builtin: async () => null });
  const name = 'plugin-v1:ticker:task.tick@1';
  dispatcher.reconcileTasks(scheduler);
  assert.equal(jobs.size, 0);
  installed = [ticker(30, 'r1', 'first')];
  dispatcher.reconcileTasks(scheduler);
  const first = jobs.get(name);
  assert.equal(first.ms, 30000);
  dispatcher.reconcileTasks(scheduler);
  assert.equal(jobs.get(name), first);
  await first.fn();

  installed = [ticker(30, 'r2', 'second')];
  await first.fn(); // 授权已变，轮询尚未替换定时项。
  dispatcher.reconcileTasks(scheduler);
  const updated = jobs.get(name);
  assert.notEqual(updated, first);
  await updated.fn();
  installed = [ticker(45, 'r3', 'third')];
  dispatcher.reconcileTasks(scheduler);
  assert.equal(jobs.get(name).ms, 45000);
  await jobs.get(name).fn();
  assert.deepEqual(calls, [['r1', { label: 'first' }], ['r2', { label: 'second' }], ['r3', { label: 'third' }]]);
  installed = [];
  dispatcher.reconcileTasks(scheduler);
  assert.equal(jobs.size, 0);
  dispatcher.stopTasks(scheduler);
});
