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

test('host capabilities enforce a bounded concurrent admission limit', async () => {
  const plugins = { isApproved: () => true };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins, maxHostConcurrent: 1, maxHostPending: 1 });
  let finish;
  let started = 0;
  dispatcher.defineHost('status.read@1', () => {
    started++;
    return new Promise(resolve => { finish = () => resolve({ version: '4.3.0', running: true, pluginProtocol: registry.format }); });
  });

  const first = dispatcher.invokeHost('status.read@1', {});
  await new Promise(resolve => setImmediate(resolve));
  const second = dispatcher.invokeHost('status.read@1', {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 1, 'queued call must not enter the handler before a slot is released');
  finish();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 2, 'next call starts when the active handler releases its slot');
  finish();
  await second;
});

test('host capability queue rejects overflow and frees capacity after handler failures', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  let release;
  let calls = 0;
  dispatcher.defineHost('status.read@1', () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { release = () => resolve({ version: '4.3.0', running: true, pluginProtocol: registry.format }); });
    if (calls === 2) throw Object.assign(new Error('fixture'), { code: 'fixture_failure' });
    return { version: '4.3.0', running: true, pluginProtocol: registry.format };
  });

  const first = dispatcher.invokeHost('status.read@1', {});
  await new Promise(resolve => setImmediate(resolve));
  const second = dispatcher.invokeHost('status.read@1', {});
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(dispatcher.invokeHost('status.read@1', {}), { code: 'host_capability_queue_limit' });
  release();
  await first;
  await assert.rejects(second, { code: 'fixture_failure' });
  assert.deepEqual(await dispatcher.invokeHost('status.read@1', {}),
    { version: '4.3.0', running: true, pluginProtocol: registry.format });
});

test('host admission removes queued callers when aborted or expired', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 2 });
  let finish;
  let calls = 0;
  dispatcher.defineHost('status.read@1', () => {
    calls++;
    return new Promise(resolve => { finish = () => resolve({ version: '4.3.0', running: true, pluginProtocol: registry.format }); });
  });

  const first = dispatcher.invokeHost('status.read@1', {});
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  const aborted = dispatcher.invokeHost('status.read@1', {}, { signal: controller.signal });
  const expired = dispatcher.invokeHost('status.read@1', {}, { deadline: Date.now() + 20 });
  controller.abort();
  await assert.rejects(aborted, { code: 'capability_aborted' });
  await assert.rejects(expired, { code: 'capability_timeout' });
  finish();
  await first;
  assert.equal(calls, 1, 'cancelled or expired waiters must never invoke handlers');
  // 只用行为证明容量已归还：下一次调用必须能直接执行；泄漏的话它会排在队列里而不是执行。
  const probe = dispatcher.invokeHost('status.read@1', {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, 'capacity must be returned after cancelled waiters are removed');
  finish();
  await probe;
});

// —— 宿主能力有界准入（maxHostConcurrent / maxHostPending）——

const STATUS_OUTPUT = { version: '4.3.0', running: true, pluginProtocol: registry.format };

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

// handler 启动与名额交接都发生在连续微任务里，单次 tick 会读到中间态。
const flush = () => new Promise(resolve => setImmediate(resolve));

// 只回答「现在还没结束」，不 await 它真正结束：用来证明运行中的调用没有被强行中断。
async function stateOf(promise) {
  return Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    flush().then(() => 'pending'),
  ]);
}

// 拒绝路径先挂上处理，避免断言窗口里的 unhandledRejection。
const capture = promise => promise.then(value => ({ value }), error => ({ error }));

// 目标行为缺失时不能让测试挂死：超时即失败，并说明缺的是哪条语义。
async function within(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  try { return await Promise.race([promise, guard]); } finally { clearTimeout(timer); }
}

// 继承上下文必须通过 abort 监听实现，且无论正常、异常还是准入拒绝都要成对摘掉。
function trackAbortListeners(signal) {
  const added = [];
  const removed = [];
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') added.push(listener);
    return add(type, listener, options);
  };
  signal.removeEventListener = (type, listener) => {
    if (type === 'abort') removed.push(listener);
    return remove(type, listener);
  };
  return { added, removed };
}

function assertAbortListenersBalanced(tracks, message) {
  const added = tracks.flatMap(track => track.added);
  const removed = tracks.flatMap(track => track.removed);
  assert.ok(added.length > 0, message);
  assert.equal(removed.length, added.length, message);
  added.forEach(listener => assert.ok(removed.includes(listener), message));
}

test('unsafe admission limits are refused instead of silently coerced', () => {
  const plugins = { isApproved: () => true };
  const invalid = limits => assert.throws(
    () => new UnifiedCapabilityDispatcher({ plugins, ...limits }), { code: 'invalid_dispatcher_limits' });

  // 0 并发等于让所有宿主调用永久排队，不能被当成「用默认值」悄悄修正。
  invalid({ maxHostConcurrent: 0 });
  invalid({ maxHostConcurrent: -1 });
  invalid({ maxHostConcurrent: 1.5 });
  invalid({ maxHostConcurrent: '8' });
  invalid({ maxHostConcurrent: Number.NaN });
  invalid({ maxHostConcurrent: Number.POSITIVE_INFINITY });
  invalid({ maxHostConcurrent: Number.NEGATIVE_INFINITY });
  invalid({ maxHostConcurrent: 257 });
  invalid({ maxHostPending: -1 });
  invalid({ maxHostPending: 2.5 });
  invalid({ maxHostPending: '16' });
  invalid({ maxHostPending: Number.NaN });
  invalid({ maxHostPending: Number.POSITIVE_INFINITY });
  invalid({ maxHostPending: Number.NEGATIVE_INFINITY });
  invalid({ maxHostPending: 4097 });
  invalid({ maxHostWaitMs: 0 });
  invalid({ maxHostWaitMs: -1 });
  invalid({ maxHostWaitMs: 1.5 });
  invalid({ maxHostWaitMs: '30000' });
  invalid({ maxHostWaitMs: Number.NaN });
  invalid({ maxHostWaitMs: Number.POSITIVE_INFINITY });
  invalid({ maxHostWaitMs: Number.NEGATIVE_INFINITY });
  // 超过 setTimeout 的 32 位毫秒上限，不能指望定时器如实等待。
  invalid({ maxHostWaitMs: 2147483648 });

  // 边界值是可配置语义的一部分：1 并发 / 0 队列 / 1ms 与最长等待也要能用。
  for (const limits of [{ maxHostConcurrent: 1, maxHostPending: 0, maxHostWaitMs: 1 },
    { maxHostConcurrent: 256, maxHostPending: 4096, maxHostWaitMs: 2147483647 }]) {
    const dispatcher = new UnifiedCapabilityDispatcher({ plugins, ...limits });
    assert.equal(dispatcher.maxHostConcurrent, limits.maxHostConcurrent);
    assert.equal(dispatcher.maxHostPending, limits.maxHostPending);
    assert.equal(dispatcher.maxHostWaitMs, limits.maxHostWaitMs);
  }
  const defaults = new UnifiedCapabilityDispatcher({ plugins });
  assert.deepEqual([defaults.maxHostConcurrent, defaults.maxHostPending, defaults.maxHostWaitMs], [32, 128, 30000]);
});

test('an aborted waiter returns its queue place to the next caller', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  const gates = [];
  const started = [];
  dispatcher.defineHost('status.read@1', async (_input, flow) => {
    const gate = deferred();
    gates.push(gate);
    started.push(flow?.id || 'host');
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });

  const first = dispatcher.invokeHost('status.read@1', {});
  await flush();
  const controller = new AbortController();
  const aborted = capture(dispatcher.invokeHost('status.read@1', {}, { signal: controller.signal }));
  await flush();
  // 队列只有 1 个位置，此时已满 —— 也证明撤权/取消之前容量确实被占着。
  await assert.rejects(dispatcher.invokeHost('status.read@1', {}), { code: 'host_capability_queue_limit' });

  controller.abort();
  assert.equal((await aborted).error?.code, 'capability_aborted');
  assert.equal(started.length, 1, '被取消的等待者不得进入 handler');

  // 取消必须把队列位置还回来：新调用应能排队，而不是继续 queue_limit。
  const queued = dispatcher.invokeHost('status.read@1', {});
  await flush();
  assert.equal(await stateOf(queued), 'pending');
  gates[0].resolve();
  await first;
  await flush();
  assert.equal(started.length, 2, '运行中的调用结束后由新的等待者接手');
  gates[1].resolve();
  await queued;
});

test('an expired waiter returns its queue place to the next caller', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  const gates = [];
  const started = [];
  dispatcher.defineHost('status.read@1', async (_input, flow) => {
    const gate = deferred();
    gates.push(gate);
    started.push(flow?.id || 'host');
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });

  const first = dispatcher.invokeHost('status.read@1', {});
  await flush();
  const expired = capture(dispatcher.invokeHost('status.read@1', {}, { deadline: Date.now() + 20 }));
  await flush();
  await assert.rejects(dispatcher.invokeHost('status.read@1', {}), { code: 'host_capability_queue_limit' });

  assert.equal((await expired).error?.code, 'capability_timeout');
  assert.equal(started.length, 1, '超时的等待者不得进入 handler');

  const queued = dispatcher.invokeHost('status.read@1', {});
  await flush();
  assert.equal(await stateOf(queued), 'pending');
  gates[0].resolve();
  await first;
  await flush();
  assert.equal(started.length, 2, '超时者离开后新等待者仍能在名额释放时执行');
  gates[1].resolve();
  await queued;
});

test('a queued caller with a far-future deadline is not timed out by timer overflow', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  const gates = [];
  dispatcher.defineHost('status.read@1', async () => {
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });

  const first = dispatcher.invokeHost('status.read@1', {});
  await flush();
  // 超过 setTimeout 的 32 位毫秒上限（2147483647）：不能被截断成「马上超时」。
  const far = capture(dispatcher.invokeHost('status.read@1', {},
    { deadline: Date.now() + 3_000_000_000 }));
  await flush();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(await stateOf(far), 'pending', '远期 deadline 不能在排队几十毫秒后就提前超时');

  gates[0].resolve();
  await first;
  await flush();
  assert.equal(gates.length, 2, '远期 deadline 的等待者应被正常放行');
  gates[1].resolve();
  assert.deepEqual((await far).value, STATUS_OUTPUT);
});

test('a queued request without a caller deadline still times out after the configured host wait', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1, maxHostWaitMs: 20 });
  const gates = [];
  const started = [];
  dispatcher.defineHost('status.read@1', async () => {
    const gate = deferred();
    gates.push(gate);
    started.push('run');
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });

  const first = dispatcher.invokeHost('status.read@1', {});
  await flush();
  // 内部调用没给 deadline：排队预算取 maxHostWaitMs，不能无限等。
  const waiting = capture(dispatcher.invokeHost('status.read@1', {}));
  await flush();
  const outcome = await within(waiting, 500,
    '无 deadline 的排队请求必须有 maxHostWaitMs 预算，不能无限排队');
  assert.equal(outcome.error?.code, 'capability_timeout');
  assert.equal(started.length, 1, '等待预算到期不得执行 handler');

  // 超时只清掉等待者，运行中的名额不受影响：它结束后新排队者能接手。
  const next = dispatcher.invokeHost('status.read@1', {});
  await flush();
  assert.equal(started.length, 1, '运行中的 handler 仍占着名额');
  gates[0].resolve();
  await first;
  await flush();
  assert.equal(started.length, 2, '运行中的调用结束后由新的排队者接手');
  gates[1].resolve();
  await next;
});

test('the host wait budget ends at admission and does not cap granted handler runtime', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1, maxHostWaitMs: 20 });
  const gate = deferred();
  let calls = 0;
  dispatcher.defineHost('status.read@1', async () => {
    calls++;
    if (calls === 1) await gate.promise;
    // 第二个调用被授予后要跑 50ms，远超排队预算，但不该因此算超时。
    else await new Promise(resolve => setTimeout(resolve, 50));
    return { ...STATUS_OUTPUT };
  });

  const first = dispatcher.invokeHost('status.read@1', {});
  await flush();
  const queued = capture(dispatcher.invokeHost('status.read@1', {}));
  await flush();
  gate.resolve();
  await first;
  await flush();
  assert.equal(calls, 2, '等待者应在预算内被授予并开始执行');
  assert.deepEqual((await queued).value, STATUS_OUTPUT, '授予后执行时长不受排队预算限制');
});

test('aborting a running caller keeps its slot until the handler settles, then reports aborted', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  const gate = deferred();
  const started = [];
  dispatcher.defineHost('status.read@1', async () => {
    started.push('run');
    // 不检查 signal：取消是合作式的，不允许测试假定运行中 handler 可被强杀。
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });

  const controller = new AbortController();
  const running = capture(dispatcher.invokeHost('status.read@1', {}, { signal: controller.signal }));
  await flush();
  controller.abort();
  await flush();
  assert.equal(await stateOf(running), 'pending', '运行中 handler 不提前结束，资源也不提前归还');

  const queued = dispatcher.invokeHost('status.read@1', {});
  await flush();
  assert.equal(started.length, 1, '不合作的运行中 handler 必须继续占着名额');

  gate.resolve();
  // 兼容原契约：handler 已返回但调用方已取消，仍按取消返回；槽位在 settle 后释放。
  assert.equal((await running).error?.code, 'capability_aborted');
  await flush();
  assert.equal(started.length, 2, 'handler 真正结束后名额才交接给等待者');
  await queued;
});

test('a running handler that overruns its deadline still reports timed out after it settles', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  const gate = deferred();
  const started = [];
  dispatcher.defineHost('status.read@1', async () => {
    started.push('run');
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });

  const running = capture(dispatcher.invokeHost('status.read@1', {}, { deadline: Date.now() + 20 }));
  await flush();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(await stateOf(running), 'pending',
    'deadline 不会提前结束运行中的调用：要等 handler settle 后才判定超时');

  const queued = dispatcher.invokeHost('status.read@1', {});
  await flush();
  assert.equal(started.length, 1, '超时的运行中 handler 仍占用名额');

  gate.resolve();
  // 原契约：handler 返回后仍按 deadline 判定超时；槽位在 settle 后释放。
  assert.equal((await running).error?.code, 'capability_timeout');
  await flush();
  assert.equal(started.length, 2);
  await queued;
});

test('an output schema violation still returns the host slot', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 0 });
  let calls = 0;
  dispatcher.defineHost('status.read@1', async () => {
    calls++;
    // 第一次故意多带字段触发输出校验失败；第二次是合法形状。
    return calls === 1 ? { ...STATUS_OUTPUT, extra: true } : { ...STATUS_OUTPUT };
  });

  await assert.rejects(dispatcher.invokeHost('status.read@1', {}), { code: 'invalid_host_capability_output' });
  // maxHostPending=0：校验失败若漏还名额，这次调用会直接 queue_limit 而不是执行。
  assert.deepEqual(await dispatcher.invokeHost('status.read@1', {}), STATUS_OUTPUT);
  assert.equal(calls, 2);
});

test('a queued plugin call is refused when its grant is revoked before admission', async () => {
  let approved = true;
  const dispatcher = new UnifiedCapabilityDispatcher({
    plugins: { isApproved: () => approved, installed: () => [], invoke: async () => null },
    maxHostConcurrent: 1, maxHostPending: 1,
  });
  const gate = deferred();
  let runs = 0;
  dispatcher.defineHost('status.read@1', async () => {
    runs++;
    if (runs === 1) await gate.promise;
    return { ...STATUS_OUTPUT };
  });

  const first = dispatcher.invokeHost('status.read@1', {});
  await flush();
  const queued = capture(dispatcher.invokeHost('status.read@1', {},
    { plugin: plugin('p1', ['status.read@1']) }));
  await flush();

  // 排队期间撤权：授权是执行时判定，不能停留在入队那一刻的快照上。
  approved = false;
  gate.resolve();
  await first;
  const outcome = await queued;
  assert.equal(outcome.error?.code, 'grant_revoked');
  assert.equal(runs, 1, '被撤权的等待者不得执行 handler');
  // 拒绝路径同样不能漏名额：下一次内部调用要能直接执行。
  assert.deepEqual(await within(dispatcher.invokeHost('status.read@1', {}), 500,
    '被撤权的等待者不得占着名额'), STATUS_OUTPUT);
});

test('a slow capability does not consume another capability host slots', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  const slow = deferred();
  const started = [];
  dispatcher.defineHost('contacts.search@1', async () => {
    started.push('contacts');
    await slow.promise;
    return { friends: [], groups: [] };
  });
  dispatcher.defineHost('status.read@1', async () => {
    started.push('status');
    return { ...STATUS_OUTPUT };
  });

  const blocked = dispatcher.invokeHost('contacts.search@1', {});
  await flush();
  // 名额按能力分池：慢读取占的是它自己的名额，不能把状态读取一起卡住。
  assert.deepEqual(await within(dispatcher.invokeHost('status.read@1', {}), 500,
    '慢能力不能占用其他能力的并发名额'), STATUS_OUTPUT);
  assert.deepEqual(started, ['contacts', 'status']);
  slow.resolve();
  await blocked;
});

test('a handler calling its own capability is rejected instead of waiting on itself', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 4 });
  let nested = null;
  dispatcher.defineHost('reminders.list@1', async input => {
    if (input?.nested) return { reminders: [] };
    nested = await dispatcher.invokeHost('reminders.list@1', { nested: true })
      .then(() => null, error => error);
    return { reminders: [] };
  });

  // 同能力嵌套若也去排队，外层会等自己让出的名额 —— 必须快速拒绝。
  assert.deepEqual(await within(dispatcher.invokeHost('reminders.list@1', {}), 500,
    '同能力嵌套调用必须快速拒绝，不能自等'), { reminders: [] });
  assert.equal(nested?.code, 'host_capability_reentrant');
});

test('a handler may nest a different capability whose pool has room', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  let inner = null;
  dispatcher.defineHost('contacts.search@1', async () => {
    inner = await dispatcher.invokeHost('status.read@1', {});
    return { friends: [], groups: [] };
  });
  dispatcher.defineHost('status.read@1', async () => ({ ...STATUS_OUTPUT }));

  // 分池意味着外层占用的是 contacts 的名额，嵌套读取状态不该被外层卡住。
  assert.deepEqual(await within(dispatcher.invokeHost('contacts.search@1', {}), 500,
    '不同能力嵌套应可在自己的池内执行'), { friends: [], groups: [] });
  assert.deepEqual(inner, STATUS_OUTPUT);
});

test('a nested call into a full host pool is rejected instead of queueing behind an ancestor', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 4 });
  const slow = deferred();
  let nested = null;
  dispatcher.defineHost('contacts.search@1', async () => {
    await slow.promise;
    return { friends: [], groups: [] };
  });
  dispatcher.defineHost('status.read@1', async () => {
    // 目标池已被外层调用占满：嵌套若也去排队，会一直等到外层让出名额 —— 自等。
    nested = await dispatcher.invokeHost('contacts.search@1', {}).then(() => null, error => error);
    return { ...STATUS_OUTPUT };
  });

  const blocking = dispatcher.invokeHost('contacts.search@1', {});
  await flush();
  assert.deepEqual(await within(dispatcher.invokeHost('status.read@1', {}), 500,
    '嵌套跨能力在目标池已满时必须快速拒绝'), STATUS_OUTPUT);
  assert.equal(nested?.code, 'host_capability_queue_limit');
  slow.resolve();
  await blocking;
});

test('a declared but unimplemented capability reports unavailable instead of silently passing', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  await assert.rejects(dispatcher.invokeHost('digest.status@1', {}), { code: 'host_capability_unavailable' });
});

// —— 嵌套调用的预算与取消继承（AsyncLocalStorage 活动 frame）——
// 宿主内部的嵌套调用不是新请求：它必须继续消耗父调用剩下的预算，
// 并同时响应父、子两边的取消；父调用结束后不能再把已结束的上下文留给延后回调。

test('a nested call inherits the shorter ancestor deadline instead of extending it', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  let nested = null;
  dispatcher.defineHost('status.read@1', async () => {
    // 子调用自己要求 5s，但父调用只剩 30ms：不能借嵌套扩张预算。
    await new Promise(resolve => setTimeout(resolve, 60));
    return { ...STATUS_OUTPUT };
  });
  dispatcher.defineHost('contacts.search@1', async () => {
    nested = await dispatcher.invokeHost('status.read@1', {}, { deadline: Date.now() + 5000 })
      .then(value => ({ value }), error => ({ error }));
    return { friends: [], groups: [] };
  });

  const outer = capture(dispatcher.invokeHost('contacts.search@1', {}, { deadline: Date.now() + 30 }));
  assert.equal((await outer).error?.code, 'capability_timeout');
  assert.equal(nested?.error?.code, 'capability_timeout',
    '嵌套调用必须在父调用剩下的预算内结束，不能被更晚的子 deadline 延长');
});

test('a nested call without its own deadline runs on the ancestor budget', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  let nested = null;
  dispatcher.defineHost('status.read@1', async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
    return { ...STATUS_OUTPUT };
  });
  dispatcher.defineHost('contacts.search@1', async () => {
    nested = await dispatcher.invokeHost('status.read@1', {})
      .then(value => ({ value }), error => ({ error }));
    return { friends: [], groups: [] };
  });

  const outer = capture(dispatcher.invokeHost('contacts.search@1', {}, { deadline: Date.now() + 30 }));
  assert.equal((await outer).error?.code, 'capability_timeout');
  assert.equal(nested?.error?.code, 'capability_timeout',
    '子调用没给 deadline 时必须继承父调用剩下的预算，而不是无限等待');
});

test('a nested call keeps its own earlier deadline', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  let nested = null;
  dispatcher.defineHost('status.read@1', async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
    return { ...STATUS_OUTPUT };
  });
  dispatcher.defineHost('contacts.search@1', async () => {
    nested = await dispatcher.invokeHost('status.read@1', {}, { deadline: Date.now() + 30 })
      .then(value => ({ value }), error => ({ error }));
    return { friends: [], groups: [] };
  });

  // 父预算很宽，子调用自己的 30ms 更早：取较小值，子调用先超时，父调用正常收尾。
  assert.deepEqual(await dispatcher.invokeHost('contacts.search@1', {}, { deadline: Date.now() + 5000 }),
    { friends: [], groups: [] });
  assert.equal(nested?.error?.code, 'capability_timeout');
});

test('an ancestor cancellation aborts a nested call that has its own live signal', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const parent = new AbortController();
  const own = new AbortController();
  const gate = deferred();
  let entered = false;
  let nested = null;
  dispatcher.defineHost('status.read@1', async () => {
    entered = true;
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });
  dispatcher.defineHost('contacts.search@1', async () => {
    nested = await dispatcher.invokeHost('status.read@1', {}, { signal: own.signal })
      .then(value => ({ value }), error => ({ error }));
    return { friends: [], groups: [] };
  });

  const outer = capture(dispatcher.invokeHost('contacts.search@1', {}, { signal: parent.signal }));
  await flush();
  assert.equal(entered, true);
  parent.abort();
  gate.resolve();
  assert.equal((await outer).error?.code, 'capability_aborted');
  assert.equal(nested?.error?.code, 'capability_aborted',
    '父调用取消时必须同时取消已经带上自己 signal 的嵌套调用');
  assert.equal(own.signal.aborted, false, '继承取消不能改写子调用自带 signal 的状态');
});

test('cancelling a nested call signal only aborts that nested call', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const parent = new AbortController();
  const own = new AbortController();
  const gate = deferred();
  let nested = null;
  dispatcher.defineHost('status.read@1', async () => {
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });
  dispatcher.defineHost('contacts.search@1', async () => {
    nested = await dispatcher.invokeHost('status.read@1', {}, { signal: own.signal })
      .then(value => ({ value }), error => ({ error }));
    return { friends: [], groups: [] };
  });

  const outer = capture(dispatcher.invokeHost('contacts.search@1', {}, { signal: parent.signal }));
  await flush();
  own.abort();
  gate.resolve();
  const outcome = await outer;
  assert.deepEqual(outcome.value, { friends: [], groups: [] }, '子调用的取消不能反向取消父调用');
  assert.equal(nested?.error?.code, 'capability_aborted');
  assert.equal(parent.signal.aborted, false);
});

test('a callback scheduled after an ancestor settled does not inherit its signal or deadline', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const parent = new AbortController();
  const scheduled = deferred();
  let delayed = null;
  dispatcher.defineHost('status.read@1', async () => ({ ...STATUS_OUTPUT }));
  dispatcher.defineHost('contacts.search@1', async () => {
    // 父调用早已返回，却在它结束 60ms 后才从它的异步上下文里发起新调用。
    setTimeout(() => {
      delayed = dispatcher.invokeHost('status.read@1', {})
        .then(value => ({ value }), error => ({ error }));
      scheduled.resolve();
    }, 60);
    return { friends: [], groups: [] };
  });

  // 父预算只有 20ms，并且调用结束后再取消父 signal：延后的调用两者都不该继承。
  assert.deepEqual(await dispatcher.invokeHost('contacts.search@1', {},
    { signal: parent.signal, deadline: Date.now() + 20 }), { friends: [], groups: [] });
  parent.abort();
  await scheduled.promise;
  const outcome = await delayed;
  assert.deepEqual(outcome.value, STATUS_OUTPUT, '祖先 settle 后的回调是新的根调用，不应被判超时或取消');
  assert.equal(outcome.error, undefined);
});

test('inherited cancellation listeners are removed after the nested call settles', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const parent = new AbortController();
  const own = new AbortController();
  const parentTrack = trackAbortListeners(parent.signal);
  const ownTrack = trackAbortListeners(own.signal);
  const beforeOnAbort = parent.signal.onabort;
  dispatcher.defineHost('status.read@1', async () => ({ ...STATUS_OUTPUT }));
  dispatcher.defineHost('contacts.search@1', async () => {
    await dispatcher.invokeHost('status.read@1', {}, { signal: own.signal });
    return { friends: [], groups: [] };
  });

  await dispatcher.invokeHost('contacts.search@1', {}, { signal: parent.signal });

  assertAbortListenersBalanced([parentTrack, ownTrack], '嵌套调用 settle 后必须摘掉它挂的取消监听');
  assert.equal(parent.signal.onabort, beforeOnAbort, '不能用 onabort 槽位抢占用户自己的回调');
});

test('inherited cancellation listeners are removed when the nested handler throws', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const parent = new AbortController();
  const own = new AbortController();
  const parentTrack = trackAbortListeners(parent.signal);
  const ownTrack = trackAbortListeners(own.signal);
  let nested = null;
  dispatcher.defineHost('status.read@1', async () => {
    throw Object.assign(new Error('boom'), { code: 'boom' });
  });
  dispatcher.defineHost('contacts.search@1', async () => {
    nested = await dispatcher.invokeHost('status.read@1', {}, { signal: own.signal })
      .then(() => null, error => error);
    return { friends: [], groups: [] };
  });

  await dispatcher.invokeHost('contacts.search@1', {}, { signal: parent.signal });

  assert.equal(nested?.code, 'boom');
  assertAbortListenersBalanced([parentTrack, ownTrack], '嵌套 handler 异常返回时也必须摘掉继承监听');
});

test('inherited cancellation listeners are removed when a nested call is refused at admission', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const parent = new AbortController();
  const own = new AbortController();
  const parentTrack = trackAbortListeners(parent.signal);
  const ownTrack = trackAbortListeners(own.signal);
  let nested = null;
  dispatcher.defineHost('status.read@1', async () => {
    // 同能力嵌套在进入 handler/准入前就拒绝：监听已经在继承上下文时挂上，必须撤掉。
    nested = await dispatcher.invokeHost('status.read@1', {}, { signal: own.signal })
      .then(() => null, error => error);
    return { ...STATUS_OUTPUT };
  });

  await dispatcher.invokeHost('status.read@1', {}, { signal: parent.signal });

  assert.equal(nested?.code, 'host_capability_reentrant');
  assertAbortListenersBalanced([parentTrack, ownTrack], '准入拒绝路径也必须摘掉继承监听');
});

test('a grandchild that outlives its parent still follows the root signal', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const root = new AbortController();
  const middle = new AbortController();
  const gate = deferred();
  let child = null;
  let childFlow = null;
  dispatcher.defineHost('status.read@1', async (_input, _plugin, flow) => {
    childFlow = flow;
    // 运行中的 handler 不检查 signal：取消是合作式的，靠 handler settle 后的判定体现。
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });
  dispatcher.defineHost('contacts.search@1', async () => {
    // 不 await：中间层先 settle，孙调用仍在跑，不能因此丢掉根 signal 的订阅。
    child = dispatcher.invokeHost('status.read@1', {})
      .then(value => ({ value }), error => ({ error }));
    return { friends: [], groups: [] };
  });
  dispatcher.defineHost('reminders.list@1', async () => {
    await dispatcher.invokeHost('contacts.search@1', {}, { signal: middle.signal });
    return { reminders: [] };
  });

  assert.deepEqual(await dispatcher.invokeHost('reminders.list@1', {}, { signal: root.signal }),
    { reminders: [] });
  await flush();
  assert.ok(childFlow, '孙调用必须已经进入 handler');
  root.abort();
  assert.equal(childFlow.signal.aborted, true,
    '中间层 settle 后，根 signal 取消仍必须沿源 signal 到达孙调用');
  gate.resolve();
  assert.equal((await child).error?.code, 'capability_aborted');
});

test('a grandchild subscribing to ancestor sources releases them when it settles', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const root = new AbortController();
  const middle = new AbortController();
  const rootTrack = trackAbortListeners(root.signal);
  const middleTrack = trackAbortListeners(middle.signal);
  const gate = deferred();
  let child = null;
  dispatcher.defineHost('status.read@1', async () => {
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });
  dispatcher.defineHost('contacts.search@1', async () => {
    child = capture(dispatcher.invokeHost('status.read@1', {}));
    return { friends: [], groups: [] };
  });
  dispatcher.defineHost('reminders.list@1', async () => {
    await dispatcher.invokeHost('contacts.search@1', {}, { signal: middle.signal });
    return { reminders: [] };
  });

  await dispatcher.invokeHost('reminders.list@1', {}, { signal: root.signal });
  // 中间层已 settle，但孙调用还在跑：它自己那对源监听必须还在，不能靠中间层的派生 signal。
  assert.ok(rootTrack.added.length + middleTrack.added.length > 0);
  gate.resolve();
  assert.deepEqual((await child).value, STATUS_OUTPUT);
  assertAbortListenersBalanced([rootTrack, middleTrack], '孙调用 settle 后必须释放它对祖先源 signal 的订阅');
});

test('an expired waiter is not left behind to consume host queue capacity', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  let release;
  let calls = 0;
  dispatcher.defineHost('status.read@1', async () => {
    calls++;
    if (calls === 1) {
      return new Promise(resolve => { release = () => resolve({ ...STATUS_OUTPUT }); });
    }
    return { ...STATUS_OUTPUT };
  });

  const first = dispatcher.invokeHost('status.read@1', {});
  await flush();

  // 受控 Date.now：invokeHost/acquire 的前置检查还没到期，进队列做 expire() 时已越过 deadline。
  // 这段窗口全在同步执行里（检查 → 入队 → expire），不经过事件循环。
  const realNow = Date.now;
  let reads = 0;
  Date.now = () => (++reads <= 3 ? 999 : 1000);
  let expired;
  try {
    expired = capture(dispatcher.invokeHost('status.read@1', {}, { deadline: 1000 }));
  } finally {
    Date.now = realNow;
  }
  assert.equal((await expired).error?.code, 'capability_timeout');

  // 僵尸若留在 waiters 里，maxHostPending=1 会让这次合法调用被误判 queue_limit。
  const legal = capture(dispatcher.invokeHost('status.read@1', {}));
  await flush();
  assert.equal(await stateOf(legal), 'pending',
    '已超时的等待者必须真正离队，不能继续占住等待容量');
  assert.equal(calls, 1, '合法等待者应先排队，不能越过仍占着名额的运行中调用');

  release();
  await first;
  await flush();
  assert.deepEqual((await legal).value, STATUS_OUTPUT, '名额释放后合法调用应正常接手');
});

// —— 宿主准入统计（hostStats）：实时 gauge + 按能力累计的终态计数 ——

test('host stats expose per-capability gauges and outcome counters', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 2 });
  const gates = [];
  dispatcher.defineHost('status.read@1', async () => {
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });
  dispatcher.defineHost('contacts.search@1', async () => ({ friends: [], groups: [] }));

  const zeros = { active: 0, waiting: 0, granted: 0, refused: 0, refusedByReason: {},
    idempotentHit: 0, queueFull: 0, nestedRefused: 0, queueTimeout: 0, queueAborted: 0,
    completed: 0, failed: 0 };
  assert.deepEqual(dispatcher.hostStats(), {
    'status.read@1': { ...zeros },
    'contacts.search@1': { ...zeros },
  });

  assert.deepEqual(await dispatcher.invokeHost('contacts.search@1', {}), { friends: [], groups: [] });
  assert.deepEqual(dispatcher.hostStats()['contacts.search@1'],
    { ...zeros, granted: 1, completed: 1 });
  assert.equal(dispatcher.hostStats()['status.read@1'].granted, 0, '统计必须按能力分开');

  const running = capture(dispatcher.invokeHost('status.read@1', {}));
  await flush();
  let stats = dispatcher.hostStats()['status.read@1'];
  assert.deepEqual([stats.active, stats.waiting, stats.granted, stats.completed],
    [1, 0, 1, 0], '运行中的调用计入 active 与 granted');

  const queued = capture(dispatcher.invokeHost('status.read@1', {}));
  await flush();
  stats = dispatcher.hostStats()['status.read@1'];
  assert.deepEqual([stats.active, stats.waiting, stats.granted], [1, 1, 1],
    '排队中的调用只增加 waiting，真正授予后才增加 granted');

  gates[0].resolve();
  await running;
  await flush();
  gates[1].resolve();
  await queued;
  await flush();
  stats = dispatcher.hostStats()['status.read@1'];
  assert.deepEqual([stats.active, stats.waiting, stats.granted, stats.completed, stats.failed],
    [0, 0, 2, 2, 0]);

  // failed 只统计拿到名额之后的失败；handler 抛错不改变准入计数。
  const failing = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  failing.defineHost('status.read@1', async () => { throw Object.assign(new Error('boom'), { code: 'boom' }); });
  await assert.rejects(failing.invokeHost('status.read@1', {}), { code: 'boom' });
  assert.deepEqual(failing.hostStats()['status.read@1'], { ...zeros, granted: 1, failed: 1 });
});

test('host stats count queue-full, queue-timeout and queue-aborted rejections', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 1 });
  let release;
  dispatcher.defineHost('status.read@1', async () => new Promise(resolve => {
    release = () => resolve({ ...STATUS_OUTPUT });
  }));

  const first = dispatcher.invokeHost('status.read@1', {});
  await flush();
  const controller = new AbortController();
  const abortedWaiter = capture(dispatcher.invokeHost('status.read@1', {}, { signal: controller.signal }));
  await flush();
  const overflow = capture(dispatcher.invokeHost('status.read@1', {}));
  await flush();
  assert.equal((await overflow).error?.code, 'host_capability_queue_limit');

  controller.abort();
  assert.equal((await abortedWaiter).error?.code, 'capability_aborted');
  assert.equal((await dispatcher.invokeHost('status.read@1', {}, { deadline: Date.now() + 20 })
    .then(() => null, error => error)).code, 'capability_timeout');

  release();
  await first;
  await flush();
  const stats = dispatcher.hostStats()['status.read@1'];
  assert.deepEqual({
    active: stats.active, waiting: stats.waiting, granted: stats.granted,
    completed: stats.completed, failed: stats.failed, queueFull: stats.queueFull,
    nestedRefused: stats.nestedRefused,
    queueTimeout: stats.queueTimeout, queueAborted: stats.queueAborted,
  }, { active: 0, waiting: 0, granted: 1, completed: 1, failed: 0,
    queueFull: 1, nestedRefused: 0, queueTimeout: 1, queueAborted: 1 });

  // 快照是副本：改返回值不能回写内部累计。
  const snapshot = dispatcher.hostStats();
  snapshot['status.read@1'].granted = 99;
  snapshot['status.read@1'].queueAborted = 0;
  const fresh = dispatcher.hostStats()['status.read@1'];
  assert.equal(fresh.granted, 1);
  assert.equal(fresh.queueAborted, 1);
});

test('a queue-full rejection logs only the capability and counts at debug level', async () => {
  const debug = [];
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    logger: { debug: message => debug.push(message), warn() {} },
    maxHostConcurrent: 1, maxHostPending: 0 });
  let release;
  dispatcher.defineHost('status.read@1', async () => new Promise(resolve => {
    release = () => resolve({ ...STATUS_OUTPUT });
  }));

  const first = dispatcher.invokeHost('status.read@1', {});
  await flush();
  await assert.rejects(dispatcher.invokeHost('status.read@1', {}), { code: 'host_capability_queue_limit' });
  assert.deepEqual(debug, ['[host-admission] queue_full capability=status.read@1 active=1 waiting=0'],
    'debug 日志只能带能力名与计数，不能带输入或插件信息');
  release();
  await first;
});

test('a nested queue-full rejection logs only the capability and counts', async () => {
  const debug = [];
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    logger: { debug: message => debug.push(message), warn() {} },
    maxHostConcurrent: 1, maxHostPending: 4 });
  let release;
  dispatcher.defineHost('status.read@1', async () => new Promise(resolve => {
    release = () => resolve({ ...STATUS_OUTPUT });
  }));
  let nested = null;
  dispatcher.defineHost('contacts.search@1', async () => {
    nested = await dispatcher.invokeHost('status.read@1', {}).then(() => null, error => error);
    return { friends: [], groups: [] };
  });

  const blocking = dispatcher.invokeHost('status.read@1', {});
  await flush();
  assert.deepEqual(await dispatcher.invokeHost('contacts.search@1', {}), { friends: [], groups: [] });
  assert.equal(nested?.code, 'host_capability_queue_limit');
  assert.deepEqual(debug, ['[host-admission] queue_full capability=status.read@1 active=1 waiting=0 phase=nested'],
    '嵌套快速拒绝必须带 phase=nested，和真队列满区分');
  const stats = dispatcher.hostStats()['status.read@1'];
  assert.equal(stats.nestedRefused, 1);
  assert.equal(stats.queueFull, 0, '嵌套快速拒绝不能算进真队列满');
  release();
  await blocking;
});

// —— 写能力完成语义：副作用已发生时，事后取消/超时不能把成功改报失败 ——
// 否则调用方按失败重试会重复写入、重复发送或重复计费。只读类保持原有事后判定。

test('a completed local write is not rewritten as aborted', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const gate = deferred();
  dispatcher.defineHost('reminders.create@1', async () => {
    await gate.promise;
    return { created: true, id: 'r-1' };
  });
  const controller = new AbortController();
  const call = capture(dispatcher.invokeHost('reminders.create@1', {}, { signal: controller.signal }));
  await flush();
  controller.abort();
  gate.resolve();
  const outcome = await call;
  assert.deepEqual(outcome.value, { created: true, id: 'r-1' },
    '副作用已经落地的写能力不能因为事后取消改报失败');
  assert.equal(outcome.error, undefined);
  assert.equal(dispatcher.hostStats()['reminders.create@1'].failed, 0);
});

test('a cancelled read-only capability is still reported aborted', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const gate = deferred();
  dispatcher.defineHost('status.read@1', async () => {
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });
  const controller = new AbortController();
  const call = capture(dispatcher.invokeHost('status.read@1', {}, { signal: controller.signal }));
  await flush();
  controller.abort();
  gate.resolve();
  assert.equal((await call).error?.code, 'capability_aborted',
    '只读能力没有副作用，取消后的结果仍按取消处理');
  assert.equal(dispatcher.hostStats()['status.read@1'].failed, 1);
});

test('an unknown side effect defaults to returning the completed result', async () => {
  const contract = registry.calls['status.read@1'];
  const original = contract.sideEffect;
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const gate = deferred();
  dispatcher.defineHost('status.read@1', async () => {
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });

  // 未知/新增的类别不能被误当只读：已拿到输出就按完成返回，避免“已写却报取消/超时”。
  contract.sideEffect = 'future-external-write';
  try {
    const controller = new AbortController();
    const call = capture(dispatcher.invokeHost('status.read@1', {}, { signal: controller.signal }));
    await flush();
    controller.abort();
    gate.resolve();
    const outcome = await call;
    assert.deepEqual(outcome.value, { ...STATUS_OUTPUT });
    assert.equal(outcome.error, undefined);
    assert.equal(dispatcher.hostStats()['status.read@1'].completed, 1);
  } finally {
    contract.sideEffect = original;
  }
});

// —— 全局额度、等待优先级、准入前拒绝统计、幂等与关闭 ——

test('unsafe global host concurrency limits are refused', () => {
  const plugins = { isApproved: () => true };
  const invalid = limits => assert.throws(
    () => new UnifiedCapabilityDispatcher({ plugins, ...limits }), { code: 'invalid_dispatcher_limits' });
  for (const value of [0, -1, 1.5, '512', Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY, 8193]) {
    invalid({ maxHostTotalConcurrent: value });
  }
  assert.equal(new UnifiedCapabilityDispatcher({ plugins }).maxHostTotalConcurrent, 512);
  assert.equal(new UnifiedCapabilityDispatcher({ plugins, maxHostTotalConcurrent: 1 }).maxHostTotalConcurrent, 1);
  assert.equal(new UnifiedCapabilityDispatcher({ plugins, maxHostTotalConcurrent: 8192 }).maxHostTotalConcurrent, 8192);
});

test('global host concurrency rejects fast and reports globalRefused', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 2, maxHostTotalConcurrent: 1 });
  const gate = deferred();
  dispatcher.defineHost('status.read@1', async () => {
    await gate.promise;
    return { ...STATUS_OUTPUT };
  });
  dispatcher.defineHost('contacts.search@1', async () => ({ friends: [], groups: [] }));

  const first = capture(dispatcher.invokeHost('status.read@1', {}));
  await flush();
  assert.equal(await stateOf(first), 'pending');
  await assert.rejects(dispatcher.invokeHost('contacts.search@1', {}),
    { code: 'host_capability_queue_limit' });
  assert.equal(dispatcher.hostGlobalStats().globalRefused, 1);
  assert.equal(dispatcher.hostStats()['contacts.search@1'].failed, 0,
    '全局额度拒绝发生在准入前，不能记成 failed');

  gate.resolve();
  await first;
  assert.deepEqual(await within(dispatcher.invokeHost('contacts.search@1', {}), 500,
    '全局名额释放后其他能力应能执行'), { friends: [], groups: [] });
});

test('queued callers are granted by priority and stay FIFO within a priority', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true },
    maxHostConcurrent: 1, maxHostPending: 6 });
  const order = [];
  const gates = new Map();
  dispatcher.defineHost('reminders.create@1', async input => {
    order.push(input.tag);
    const gate = deferred();
    gates.set(input.tag, gate);
    await gate.promise;
    return { ok: true };
  });

  const calls = [capture(dispatcher.invokeHost('reminders.create@1', { tag: 'running' }))];
  await flush();
  calls.push(
    capture(dispatcher.invokeHost('reminders.create@1', { tag: 'low' }, { priority: -50 })),
    capture(dispatcher.invokeHost('reminders.create@1', { tag: 'mid' }, { priority: 0 })),
    capture(dispatcher.invokeHost('reminders.create@1', { tag: 'high-a' }, { priority: 50 })),
    capture(dispatcher.invokeHost('reminders.create@1', { tag: 'high-b' }, { priority: 50 })),
    capture(dispatcher.invokeHost('reminders.create@1', { tag: 'mid-2' })),
  );
  await flush();
  assert.deepEqual(order, ['running']);

  for (const tag of ['running', 'high-a', 'high-b', 'mid', 'mid-2', 'low']) {
    gates.get(tag).resolve();
    await flush();
  }
  const values = await Promise.all(calls);
  assert.deepEqual(order, ['running', 'high-a', 'high-b', 'mid', 'mid-2', 'low'],
    '等待按优先级从高到低授予，同优先级保持 FIFO');
  values.forEach(value => assert.deepEqual(value.value, { ok: true }));

  await assert.rejects(dispatcher.invokeHost('reminders.create@1', {}, { priority: 101 }),
    { code: 'invalid_dispatcher_limits' });
});

test('pre-admission refusals are counted by capability and reason', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({
    plugins: { isApproved: flow => flow.approved !== false },
  });
  dispatcher.defineHost('status.read@1', async () => ({ ...STATUS_OUTPUT }));
  dispatcher.defineHost('reminders.create@1', async () => ({ ok: true }));
  dispatcher.defineHost('contacts.search@1', async () => {
    const nested = await dispatcher.invokeHost('contacts.search@1', {})
      .then(() => null, error => error);
    assert.equal(nested?.code, 'host_capability_reentrant');
    return { friends: [], groups: [] };
  });

  await assert.rejects(dispatcher.invokeHost('api.read@1', {}), { code: 'host_capability_unknown' });
  await assert.rejects(dispatcher.invokeHost('message.submit@1', {}), { code: 'host_capability_disabled' });
  await assert.rejects(dispatcher.invokeHost('status.read@1', {},
    { plugin: { id: 'p1', calls: ['status.read@1'], approved: false } }), { code: 'grant_revoked' });
  await assert.rejects(dispatcher.invokeHost('status.read@1', {},
    { plugin: { id: 'p2', calls: [] } }), { code: 'host_capability_not_declared' });
  await assert.rejects(dispatcher.invokeHost('status.read@1', { extra: true }),
    { code: 'invalid_host_capability_input' });
  await assert.rejects(dispatcher.invokeHost('digest.status@1', {}), { code: 'host_capability_unavailable' });
  await assert.rejects(dispatcher.invokeHost('reminders.create@1', {}, { deadline: Date.now() - 1 }),
    { code: 'capability_timeout' });
  await dispatcher.invokeHost('contacts.search@1', {});

  const stats = dispatcher.hostStats();
  assert.equal(stats['status.read@1'].refused, 3);
  assert.deepEqual(stats['status.read@1'].refusedByReason,
    { revoked: 1, not_declared: 1, invalid_input: 1 });
  assert.deepEqual(stats['message.submit@1'].refusedByReason, { disabled: 1 });
  assert.deepEqual(stats['digest.status@1'].refusedByReason, { unavailable: 1 });
  assert.deepEqual(stats['reminders.create@1'].refusedByReason, { expired: 1 });
  assert.deepEqual(stats['contacts.search@1'].refusedByReason, { reentrant: 1 });
  assert.equal(stats['api.read@1'], undefined, '未登记的能力不建桶');

  const global = dispatcher.hostGlobalStats();
  assert.equal(global.refused, 8);
  assert.deepEqual(global.refusedByReason, {
    unknown: 1, disabled: 1, revoked: 1, not_declared: 1,
    invalid_input: 1, unavailable: 1, expired: 1, reentrant: 1,
  });
});

test('an idempotency key reuses a completed write result', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  let runs = 0;
  dispatcher.defineHost('reminders.create@1', async () => {
    runs++;
    return { created: true, id: `r-${runs}` };
  });

  const first = await dispatcher.invokeHost('reminders.create@1', { text: 'x' },
    { idempotencyKey: 'k1' });
  const second = await dispatcher.invokeHost('reminders.create@1', { text: 'x' },
    { idempotencyKey: 'k1' });
  assert.deepEqual(second, first);
  assert.equal(runs, 1, '同键重复请求不得再次执行 handler');

  // 首个调用方改自己的返回值，不能污染已缓存的结果。
  first.id = 'mutated';
  const third = await dispatcher.invokeHost('reminders.create@1', {}, { idempotencyKey: 'k1' });
  assert.deepEqual(third, { created: true, id: 'r-1' });

  const stats = dispatcher.hostStats()['reminders.create@1'];
  assert.equal(stats.idempotentHit, 2);
  assert.equal(stats.completed, 1);
  assert.equal(stats.granted, 1);

  // 不同键仍按新调用执行。
  assert.deepEqual(await dispatcher.invokeHost('reminders.create@1', {}, { idempotencyKey: 'k2' }),
    { created: true, id: 'r-2' });
  assert.equal(runs, 2);
});

test('duplicate in-flight write keys wait, while read-only keys are ignored', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const gate = deferred();
  let runs = 0;
  dispatcher.defineHost('reminders.create@1', async () => {
    runs++;
    await gate.promise;
    return { created: true, id: `r-${runs}` };
  });

  const first = capture(dispatcher.invokeHost('reminders.create@1', {}, { idempotencyKey: 'same' }));
  await flush();
  const duplicate = capture(dispatcher.invokeHost('reminders.create@1', {}, { idempotencyKey: 'same' }));
  await flush();
  assert.equal(runs, 1, '在途重复请求必须等待同一个结果，不能启动第二个 handler');
  gate.resolve();
  const [a, b] = await Promise.all([first, duplicate]);
  assert.deepEqual(b.value, a.value);
  assert.equal(runs, 1);
  assert.equal(dispatcher.hostStats()['reminders.create@1'].idempotentHit, 1);

  let reads = 0;
  dispatcher.defineHost('status.read@1', async () => {
    reads++;
    return { ...STATUS_OUTPUT };
  });
  await dispatcher.invokeHost('status.read@1', {}, { idempotencyKey: 'same' });
  await dispatcher.invokeHost('status.read@1', {}, { idempotencyKey: 'same' });
  assert.equal(reads, 2, '只读能力不启用幂等复用');
  assert.equal(dispatcher.hostStats()['status.read@1'].idempotentHit, 0);
});

test('close rejects new and queued callers while running handlers finish', async () => {
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
  await assert.rejects(dispatcher.invokeHost('status.read@1', {}), { code: 'capability_shutdown' });
  assert.equal(dispatcher.hostStats()['status.read@1'].waiting, 0);

  gate.resolve();
  assert.deepEqual((await running).value, STATUS_OUTPUT, '关闭时运行中的 handler 允许正常结束');
  dispatcher.close();
});

test('a completed external message is not rewritten as timed out', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  dispatcher.defineHost('moments.publish@1', async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
    return { published: true, id: 'm-1' };
  });
  const outcome = await capture(dispatcher.invokeHost('moments.publish@1', {}, { deadline: Date.now() + 20 }));
  assert.deepEqual(outcome.value, { published: true, id: 'm-1' },
    '已发送的 external-message 不能因事后超时改报失败');
  assert.equal(outcome.error, undefined);
});

test('late cancellation still counts the write capability as completed', async () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  const gate = deferred();
  dispatcher.defineHost('digest.generate@1', async input => {
    if (input?.wait) await gate.promise;
    return { digest: 'ok' };
  });
  assert.deepEqual(await dispatcher.invokeHost('digest.generate@1', {}), { digest: 'ok' });

  const controller = new AbortController();
  const late = capture(dispatcher.invokeHost('digest.generate@1', { wait: true }, { signal: controller.signal }));
  await flush();
  controller.abort();
  gate.resolve();
  assert.deepEqual((await late).value, { digest: 'ok' });
  const stats = dispatcher.hostStats()['digest.generate@1'];
  assert.equal(stats.completed, 2, '正常返回的写能力都计入 completed');
  assert.equal(stats.failed, 0, '事后取消不能把已完成的写能力计入 failed');
});
