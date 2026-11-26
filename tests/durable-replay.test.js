'use strict';

/**
 * 隔离执行与持久任务接线的公共边界验收。
 *
 * 只通过 dispatcher 的公共方法（defineHost/attachDurableStore/submitDurable/
 * replayDurable/invokeHost/close）验证：
 *   - isolate={module,exportName} 真的在 worker 里执行，错误分类沿用 isolated_*；
 *   - submitDurable 先落盘，成功才清；准入失败保留给下次启动；
 *   - replayDurable 串行重放，对不可重试错误丢弃、对可重试错误保留；
 *   - close() 让排队者立即收到 capability_shutdown。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { createDurableStore } = require('../src/services/durableStore');
const registry = require('../src/services/pluginProtocolRegistry.json');

const STATUS_OUTPUT = { version: '4.3.0', running: true, pluginProtocol: registry.format };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whale-durable-replay-'));
}

function durableStore() {
  return createDurableStore({ file: path.join(tempDir(), 'host-tasks.jsonl') });
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const capture = promise => promise.then(value => ({ value }), error => ({ error }));

test('defineHost with isolate executes the module in a worker', async () => {
  const dir = tempDir();
  const moduleFile = path.join(dir, 'isolated-fixture.js');
  fs.writeFileSync(moduleFile, [
    "'use strict';",
    'module.exports.echo = async input => ({ echoed: input?.text ?? null });',
    "module.exports.boom = async () => { throw new Error('worker boom'); };",
  ].join('\n'));

  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  dispatcher.defineHost('reminders.create@1', null, {
    isolate: { module: moduleFile, exportName: 'echo' },
  });
  dispatcher.defineHost('digest.generate@1', null, {
    isolate: { module: moduleFile, exportName: 'boom' },
  });

  assert.deepEqual(await dispatcher.invokeHost('reminders.create@1', { text: '隔离' }),
    { echoed: '隔离' });
  await assert.rejects(dispatcher.invokeHost('digest.generate@1', {}), { code: 'isolated_failed' });
  assert.equal(dispatcher.hostStats()['digest.generate@1'].failed, 1,
    '隔离执行的失败仍计入该能力的 failed');
});

test('submitDurable removes the task after the capability completes', async () => {
  const store = durableStore();
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  dispatcher.attachDurableStore(store);
  let runs = 0;
  dispatcher.defineHost('reminders.create@1', async () => {
    runs++;
    return { ok: true };
  });

  assert.deepEqual(await dispatcher.submitDurable('reminders.create@1', { text: 'x' }, { key: 'k1' }),
    { ok: true });
  assert.equal(runs, 1);
  assert.deepEqual(store.load(), [], '成功执行后持久任务必须清除');
});

test('submitDurable drops a task whose failure can never succeed', async () => {
  const store = durableStore();
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  dispatcher.attachDurableStore(store);

  await assert.rejects(dispatcher.submitDurable('api.read@1', {}, { key: 'bad' }),
    { code: 'host_capability_unknown' });
  assert.deepEqual(store.load(), [], '未登记能力等不可重试错误不应保留任务');
});

test('a durable task kept after admission failure is replayed later', async () => {
  const store = durableStore();
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 0 });
  dispatcher.attachDurableStore(store);
  const gate = deferred();
  let runs = 0;
  dispatcher.defineHost('reminders.create@1', async () => {
    runs++;
    if (runs === 1) await gate.promise;
    return { ok: true };
  });

  const first = capture(dispatcher.invokeHost('reminders.create@1', {}));
  await flush();
  await assert.rejects(dispatcher.submitDurable('reminders.create@1', { text: 'later' }, { key: 'kept' }),
    { code: 'host_capability_queue_limit' });
  assert.deepEqual(store.load().map(entry => entry.key), ['kept'], '准入失败必须保留任务');
  assert.equal(runs, 1, '准入失败的提交不能执行 handler');

  gate.resolve();
  await first;
  assert.deepEqual(await dispatcher.replayDurable(), { replayed: 1, dropped: 0, kept: 0 });
  assert.deepEqual(store.load(), [], '重放成功后清除任务');
  assert.equal(runs, 2);
});

test('replayDurable removes tasks that can never succeed and keeps retryable ones', async () => {
  const store = durableStore();
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  dispatcher.attachDurableStore(store);
  dispatcher.defineHost('reminders.create@1', async () => ({ ok: true }));

  store.append({ name: 'api.read@1', input: {}, key: 'unknown' });
  store.append({ name: 'reminders.create@1', input: { text: 'ok' }, key: 'good' });

  assert.deepEqual(await dispatcher.replayDurable(), { replayed: 1, dropped: 1, kept: 0 });
  assert.deepEqual(store.load(), []);
});

test('close rejects queued callers with capability_shutdown', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  const gate = deferred();
  dispatcher.defineHost('status.read@1', async () => {
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });

  const running = capture(dispatcher.invokeHost('status.read@1', {}));
  await flush();
  const queued = capture(dispatcher.invokeHost('status.read@1', {}));
  await flush();

  dispatcher.close();
  assert.equal((await queued).error?.code, 'capability_shutdown');
  assert.equal(dispatcher.hostStats()['status.read@1'].waiting, 0);

  gate.resolve();
  assert.deepEqual((await running).value, STATUS_OUTPUT, '关闭时运行中的 handler 允许结束');
});
