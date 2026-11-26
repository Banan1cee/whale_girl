'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const registry = require('./pluginProtocolRegistry.json');
const { validate } = require('./capabilitySchema');
const { reconcileDataAccessOutput } = require('./unifiedPluginRuntime');
const { runIsolated } = require('./isolatedRunner');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = code => Object.assign(new Error(code), { code });
// enhance 失败可以安全退回上一个输出的副作用等级：都没有宿主可见状态改动。
// 其余等级（billable-model-call / host-delivered-reply / manual /
// declared-host-calls-only）失败必须让调用方决定，不能在分发层吞掉。
const DEGRADABLE_SIDE_EFFECTS = new Set(['none', 'network-read']);
// handler 正常返回后仍要做事后取消/超时判定的只有只读能力：它们没有外部副作用。
// 白名单只认已知只读等级（none / network-read / read-*）；未知或新增的 sideEffect 按
// 「可能已经完成」处理，避免拼错或新增写类别时静默变成“已写却报超时”而诱导重试。
const READ_ONLY_SIDE_EFFECTS = new Set(['none', 'network-read']);
const isReadOnlySideEffect = sideEffect => READ_ONLY_SIDE_EFFECTS.has(sideEffect)
  || (typeof sideEffect === 'string' && sideEffect.startsWith('read-'));
// 幂等缓存只保留「已完成结果」的短期复用窗口：5 分钟、最多 256 条，避免无界内存。
const HOST_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const HOST_IDEMPOTENCY_MAX = 256;
// 持久任务重放时，这些错误说明任务本身不可能成功：继续保留只会每次启动重复失败。
const DURABLE_DROP_CODES = new Set([
  'invalid_host_capability_input',
  'invalid_capability_input',
  'host_capability_unknown',
  'host_capability_disabled',
  'host_capability_unavailable',
  'host_capability_reentrant',
  'host_capability_not_declared',
  'grant_revoked',
  'capability_shutdown',
]);

class UnifiedCapabilityDispatcher {
  constructor({ plugins, logger, maxPending = 128, maxPendingPerKey = 16,
    maxHostConcurrent = 32, maxHostPending = 128, maxHostWaitMs = 30000,
    maxHostTotalConcurrent = 512 } = {}) {
    // 只做宿主能力分发时不需要插件运行时；缺 installed/invoke 的能力在用到时再报错。
    if (!plugins) throw failure('invalid_plugin_runtime');
    this.plugins = plugins;
    this.logger = logger;
    this.maxPending = maxPending;
    this.maxPendingPerKey = maxPendingPerKey;
    if (!Number.isSafeInteger(maxHostConcurrent) || maxHostConcurrent < 1 || maxHostConcurrent > 256
      || !Number.isSafeInteger(maxHostPending) || maxHostPending < 0 || maxHostPending > 4096
      || !Number.isSafeInteger(maxHostWaitMs) || maxHostWaitMs < 1 || maxHostWaitMs > 2147483647
      || !Number.isSafeInteger(maxHostTotalConcurrent)
      || maxHostTotalConcurrent < 1 || maxHostTotalConcurrent > 8192) {
      throw failure('invalid_dispatcher_limits');
    }
    this.maxHostConcurrent = maxHostConcurrent;
    this.maxHostPending = maxHostPending;
    this.maxHostWaitMs = maxHostWaitMs;
    this.maxHostTotalConcurrent = maxHostTotalConcurrent;
    // 全局并发是「所有宿主能力正在执行的名额之和」；宿主的关闭闸门与关闭后拒绝也在这里。
    this.hostActiveTotal = 0;
    this.hostGlobalRefused = 0;
    this.hostGlobal = { refused: 0, refusedByReason: {} };
    this.hostStatsData = new Map();
    this.hostIdempotency = new Map();
    this.closed = false;
    this.durableStore = null;
    this.replayingDurable = false;
    this.durableSeq = 0;
    this.hostPools = new Map();
    this.hostContext = new AsyncLocalStorage();
    this.contracts = new Map();
    this.chains = new Map();
    this.pending = new Map();
    this.total = 0;
    this.scheduled = new Map();
    // 宿主能力的单一分发点：插件 host.call 与宿主内部调用都从这里走。
    this.hostContracts = new Map();
  }

  define(name, { builtin, inputSchema, outputSchema } = {}) {
    const spec = registry.providers[name];
    if (!spec || this.contracts.has(name) || typeof builtin !== 'function') throw failure('invalid_capability_contract');
    this.contracts.set(name, { spec, builtin, inputSchema: inputSchema || spec.inputSchema,
      outputSchema: outputSchema || spec.outputSchema });
    return this;
  }

  providers(name, scope, pluginId) {
    const contract = this.contracts.get(name);
    if (!contract) throw failure('unknown_capability');
    if (typeof this.plugins.installed !== 'function') throw failure('invalid_plugin_runtime');
    return this.plugins.installed().filter(plugin => {
      if (pluginId && plugin.id !== pluginId) return false;
      const declaration = plugin.provides?.[name];
      return declaration && contract.spec.modes.includes(declaration.mode) && declaration.scope === scope;
    }).sort((left, right) => left.id.localeCompare(right.id));
  }

  hasProviders(name, scope = 'all') {
    return this.providers(name, scope).length > 0;
  }

  validateOutput(capability, output) {
    const contract = this.contracts.get(capability);
    validate(contract.outputSchema, output, 'invalid_capability_output');
    if (capability === 'chat.handle@1' && output.action === 'reply'
      && (typeof output.reply !== 'string' || !output.reply.trim())) throw failure('invalid_capability_output');
    return output;
  }

  async invoke(name, input, {
    scope = 'all', pluginId, signal, deadline, builtin, preflight, key = '', chatId = '',
  } = {}) {
    const contract = this.contracts.get(name);
    if (!contract) throw failure('unknown_capability');
    if (!contract.spec.scopes.includes(scope)) throw failure('invalid_capability_scope');
    validate(contract.inputSchema, input, 'invalid_capability_input');
    if (signal?.aborted) throw failure('capability_aborted');
    if (this.total >= this.maxPending || key && (this.pending.get(key) || 0) >= this.maxPendingPerKey) {
      throw failure('capability_queue_limit');
    }

    this.total++;
    if (key) this.pending.set(key, (this.pending.get(key) || 0) + 1);
    const release = () => {
      this.total--;
      if (key) {
        const count = this.pending.get(key) - 1;
        if (count) this.pending.set(key, count); else this.pending.delete(key);
      }
    };
    const previous = key ? this.chains.get(key) || Promise.resolve() : Promise.resolve();
    const task = previous.then(async () => {
      if (signal?.aborted) throw failure('capability_aborted');
      const providers = this.providers(name, scope, pluginId);
      const owners = providers.filter(plugin => plugin.provides[name].mode === 'replace');
      const direct = providers.filter(plugin => ['tool', 'schedule'].includes(plugin.provides[name].mode));
      if (owners.length > 1 || direct.length > 1) throw failure('capability_owner_conflict');
      if (name === 'tool.run@1' && (direct.length !== 1 || !pluginId)) throw failure('plugin_not_enabled');
      if (name === 'task.tick@1' && (direct.length !== 1 || !pluginId)) throw failure('plugin_not_enabled');

      if (providers.length && typeof preflight === 'function') {
        const safe = await preflight(structuredClone(input), { signal, deadline });
        if (!safe || safe.allowed !== true) {
          // 前置回退必须服从本次调用的 builtin override：接管路径的 override 带着
          // alreadyQueued / hostHandled 语义，直接调默认 builtin 会二次排同一个会话队列
          // （自等），也会让宿主的完整结果绕过接管入口的结果阶段。
          if (safe?.fallbackBuiltin) return (builtin || contract.builtin)(structuredClone(input), { signal, deadline });
          // 宿主前置闸明确给出处理结果（禁言、重复消息、白名单等）时不运行任何插件。
          if (safe?.result !== undefined) return this.validateOutput(name, safe.result);
          return { action: 'ignore', reason: safe?.reason || 'host_preflight' };
        }
        input = validate(contract.inputSchema, safe.input, 'invalid_capability_input');
      }

      const run = (plugin, value) => this.plugins.invoke(plugin, name, value, {
        signal, deadline, chatId,
        // 运行时在保存 state 前调用：完整 provider output（含 state）校验通过才落库。
        validateOutput: candidate => this.validateOutput(name, candidate),
      });

      // gate：按插件 id 顺序逐个询问，pass 继续，首个 skip/wake 生效。
      // 门禁插件自身故障按 pass 处理，不能因为插件坏了把主人消息静默吞掉。
      const gates = providers.filter(row => row.provides[name].mode === 'gate');
      for (const plugin of gates) {
        try {
          const candidate = await run(plugin, structuredClone(input));
          this.validateOutput(name, candidate);
          if (candidate.action !== 'pass') return candidate;
        } catch (error) {
          this.logFailure(name, plugin, error);
        }
        if (signal?.aborted) throw failure('capability_aborted');
      }

      for (const plugin of providers.filter(row => row.provides[name].mode === 'observe')) {
        try { await run(plugin, structuredClone(input)); }
        catch (error) { this.logFailure(name, plugin, error); }
        if (signal?.aborted) throw failure('capability_aborted');
      }

      const directProvider = direct[0];
      let output;
      if (directProvider) {
        output = await run(directProvider, structuredClone(input));
      } else if (owners.length) {
        output = await run(owners[0], structuredClone(input));
      } else {
        output = await (builtin || contract.builtin)(structuredClone(input), { signal, deadline });
      }
      this.validateOutput(name, output);
      if (signal?.aborted) throw failure('capability_aborted');

      for (const plugin of providers.filter(row => row.provides[name].mode === 'enhance')) {
        try {
          const base = output;
          const prior = name === 'chat.search@1' ? { previous: structuredClone(base) } : { output: structuredClone(base) };
          const candidate = await run(plugin, { ...structuredClone(input), ...prior });
          this.validateOutput(name, candidate);
          // 未授权插件看不到上一层的 system/history，它返回的同名字段也不能覆盖：
          // 保住前一层已授权的值，未授权增强者对这些字段等同于 no-op（不是清空）。
          output = reconcileDataAccessOutput(name, plugin.dataAccess, base, candidate);
        } catch (error) {
          // enhance 是可选的增量步骤：只有宿主可见副作用的能力才必须把失败向上抛。
          // none（回复改写）与 network-read（联网补充资料）失败时退回上一个输出，
          // 观察者/增强者的故障不能把一轮正常回复或一次搜索判死。
          if (!DEGRADABLE_SIDE_EFFECTS.has(contract.spec.sideEffect)) throw error;
          this.logFailure(name, plugin, error);
        }
        if (signal?.aborted) throw failure('capability_aborted');
      }
      return output;
    }).finally(release);
    const guard = task.catch(() => {});
    if (key) this.chains.set(key, guard);
    try { return await task; }
    finally { if (key && this.chains.get(key) === guard) this.chains.delete(key); }
  }

  /**
   * 登记一项宿主能力（必须在 pluginProtocolRegistry.json 的 calls 里声明）。
   * 同名只允许登记一次，避免两个模块各写一份实现后行为分叉。
   */
  defineHost(name, handler, { isolate = null } = {}) {
    const contract = registry.calls[name];
    if (!contract || this.hostContracts.has(name)) throw failure('invalid_capability_contract');
    let run = handler;
    if (isolate) {
      // 隔离执行只把 input 交给 worker：插件对象、宿主闭包和主进程状态都不跨线程。
      // signal/deadline 用来在取消或剩余预算耗尽时终止 worker，错误分类沿用 isolated_*。
      if (typeof isolate.module !== 'string' || !isolate.module
        || typeof isolate.exportName !== 'string' || !isolate.exportName) {
        throw failure('invalid_capability_contract');
      }
      run = (input, _plugin, flow = {}) => runIsolated({
        module: isolate.module,
        exportName: isolate.exportName,
        input,
        signal: flow.signal,
        timeoutMs: Number.isFinite(flow.deadline) ? Math.max(1, flow.deadline - Date.now()) : undefined,
      });
    } else if (typeof handler !== 'function') {
      throw failure('invalid_capability_contract');
    }
    this.hostContracts.set(name, { contract, handler: run });
    const stats = this.newHostStats();
    this.hostPools.set(name, { name, active: 0, waiters: [], stats });
    this.hostStatsData.set(name, stats);
    return this;
  }

  hasHost(name) {
    return this.hostContracts.has(name);
  }

  newHostStats() {
    return {
      granted: 0,
      refused: 0,
      refusedByReason: {},
      idempotentHit: 0,
      queueFull: 0,
      nestedRefused: 0,
      queueTimeout: 0,
      queueAborted: 0,
      completed: 0,
      failed: 0,
    };
  }

  /**
   * 取（必要时创建）某项已登记能力对应的统计桶。只有注册表里存在的能力名才会建桶，
   * 未知名字不是能力，按全局 refusedByReason.unknown 计数，避免被任意名字撑爆内存。
   */
  hostStatsFor(name) {
    const existing = this.hostStatsData.get(name);
    if (existing) return existing;
    if (!registry.calls[name]) return null;
    const stats = this.newHostStats();
    this.hostStatsData.set(name, stats);
    return stats;
  }

  /** 准入前拒绝：同时记到该能力的 refused/refusedByReason 与分发器全局聚合。 */
  refuseHost(name, reason) {
    const stats = name ? this.hostStatsFor(name) : null;
    if (stats) {
      stats.refused++;
      stats.refusedByReason[reason] = (stats.refusedByReason[reason] || 0) + 1;
    }
    this.hostGlobal.refused++;
    this.hostGlobal.refusedByReason[reason] = (this.hostGlobal.refusedByReason[reason] || 0) + 1;
  }

  /**
   * 宿主准入的只读快照：active/waiting 是实时 gauge，其余是按能力累计的终态计数。
   * 每次调用都返回全新对象（含内层），调用方改快照不能影响分发器内部计数。
   */
  hostStats() {
    const snapshot = {};
    for (const [name, stats] of this.hostStatsData) {
      const pool = this.hostPools.get(name);
      snapshot[name] = {
        active: pool ? pool.active : 0,
        waiting: pool ? pool.waiters.length : 0,
        granted: stats.granted,
        refused: stats.refused,
        refusedByReason: { ...stats.refusedByReason },
        idempotentHit: stats.idempotentHit,
        queueFull: stats.queueFull,
        nestedRefused: stats.nestedRefused,
        queueTimeout: stats.queueTimeout,
        queueAborted: stats.queueAborted,
        completed: stats.completed,
        failed: stats.failed,
      };
    }
    return snapshot;
  }

  /** 跨能力的全局准入快照：当前执行总数、全局额度拒绝与准入前拒绝聚合。 */
  hostGlobalStats() {
    return {
      active: this.hostActiveTotal,
      globalRefused: this.hostGlobalRefused,
      refused: this.hostGlobal.refused,
      refusedByReason: { ...this.hostGlobal.refusedByReason },
    };
  }

  /**
   * 关闭宿主准入：新调用立即报 capability_shutdown；已排队等待者立即离队并收到同一错误；
   * 正在运行的 handler 不被打断，允许自行结束并正常释放名额。
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pool of this.hostPools.values()) {
      while (pool.waiters.length) {
        const waiter = pool.waiters.shift();
        if (waiter.settled) continue;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.reject(failure('capability_shutdown'));
      }
    }
  }

  // 队列满的 debug 日志只带能力名与计数：不记录输入、插件或会话信息。
  // 嵌套目标池满与全局额度拒绝分别带 phase=nested / phase=global，便于区分。
  logHostQueueFull(pool, phase = null) {
    this.logger?.debug?.(`[host-admission] queue_full capability=${pool.name} active=${pool.active} waiting=${pool.waiters.length}${phase ? ` phase=${phase}` : ''}`);
  }

  /** 挂载持久任务存储（durableStore 的 load/append/remove 契约）。 */
  attachDurableStore(store) {
    if (!store || typeof store.load !== 'function' || typeof store.append !== 'function'
      || typeof store.remove !== 'function') {
      throw failure('invalid_dispatcher_limits');
    }
    this.durableStore = store;
    return this;
  }

  /**
   * 先落盘再执行：任务只有在写进 store 之后才开始调用，进程在两步之间崩溃时重启能重放。
   * 成功（或确定不可重试的失败）才 remove；准入失败/超时/取消保留，等下次启动重试。
   */
  async submitDurable(name, input, { key } = {}) {
    if (!this.durableStore) throw failure('durable_no_file');
    const durableKey = typeof key === 'string' && key.trim()
      ? key.trim()
      : `host-${Date.now()}-${this.durableSeq = (this.durableSeq || 0) + 1}`;
    const written = this.durableStore.append({ name, input, key: durableKey, at: Date.now() });
    if (!written?.ok) throw failure(written?.code || 'durable_write_failed');
    try {
      const result = await this.invokeHost(name, input, { idempotencyKey: durableKey });
      try { this.durableStore.remove(durableKey); } catch { /* 已执行成功，清理失败交给幂等/下次重放 */ }
      return result;
    } catch (error) {
      if (DURABLE_DROP_CODES.has(error?.code)) {
        try { this.durableStore.remove(durableKey); } catch { /* 丢弃失败不影响原错误 */ }
      }
      throw error;
    }
  }

  /**
   * 逐条重放持久任务：成功或确定不可重试时移除，其余保留到下次启动。
   * 串行执行，避免重启瞬间把所有任务一起打进宿主准入；重入调用直接返回空统计。
   */
  async replayDurable() {
    if (!this.durableStore) return { replayed: 0, dropped: 0, kept: 0 };
    if (this.replayingDurable) return { replayed: 0, dropped: 0, kept: 0 };
    this.replayingDurable = true;
    const summary = { replayed: 0, dropped: 0, kept: 0 };
    try {
      for (const entry of this.durableStore.load()) {
        if (this.closed) break;
        try {
          await this.invokeHost(entry.name, entry.input, { idempotencyKey: entry.key || undefined });
          try { this.durableStore.remove(entry.key); } catch { /* 见 submitDurable 注释 */ }
          summary.replayed++;
        } catch (error) {
          if (DURABLE_DROP_CODES.has(error?.code)) {
            try { this.durableStore.remove(entry.key); } catch { /* 丢弃失败不影响统计 */ }
            summary.dropped++;
          } else {
            summary.kept++;
          }
        }
      }
      return summary;
    } finally {
      this.replayingDurable = false;
    }
  }

  acquireHostSlot(pool, { signal, deadline, priority = 0 } = {}) {
    if (signal?.aborted) return Promise.reject(failure('capability_aborted'));
    if (Number.isFinite(deadline) && Date.now() >= deadline) return Promise.reject(failure('capability_timeout'));
    if (pool.active < this.maxHostConcurrent) {
      pool.active++;
      this.hostActiveTotal++;
      return Promise.resolve(this.releaseHostSlot(pool));
    }
    if (pool.waiters.length >= this.maxHostPending) {
      pool.stats.queueFull++;
      this.logHostQueueFull(pool);
      return Promise.reject(failure('host_capability_queue_limit'));
    }

    // 内部调用可能不带 deadline，也必须有有限的排队等待；不替 handler 承诺硬截止。
    deadline = Math.min(Number.isFinite(deadline) ? deadline : Infinity, Date.now() + this.maxHostWaitMs);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, deadline, priority, timer: null, onAbort: null, settled: false };
      const remove = error => {
        if (waiter.settled) return;
        waiter.settled = true;
        // 只有真正从等待队列里离队的这一次才算准入终态；重复 remove 不重复计数。
        if (error?.code === 'capability_timeout') pool.stats.queueTimeout++;
        else if (error?.code === 'capability_aborted') pool.stats.queueAborted++;
        const index = pool.waiters.indexOf(waiter);
        if (index >= 0) pool.waiters.splice(index, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', waiter.onAbort);
        reject(error);
      };
      waiter.onAbort = () => remove(failure('capability_aborted'));
      // 先入队再启动到期检查：deadline 可能在两次检查之间已经越过，expire() 会在同一次
      // 同步调用里通过 remove() 摘掉自己。顺序反过来时 indexOf 找不到尚未入队的 waiter，
      // 已 reject 的等待者会留在队列里占住 maxHostPending，直到下一次释放才被清掉。
      // 等待顺序按 priority 从高到低，同优先级插在已有同级之后，保持 FIFO。
      const at = pool.waiters.findIndex(row => row.priority < priority);
      if (at < 0) pool.waiters.push(waiter); else pool.waiters.splice(at, 0, waiter);
      if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (Number.isFinite(deadline)) {
        const expire = () => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) remove(failure('capability_timeout'));
          else waiter.timer = setTimeout(expire, Math.min(2147483647, remaining));
        };
        expire();
      }
      waiter.grant = () => {
        if (waiter.settled) return false;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', waiter.onAbort);
        resolve(this.releaseHostSlot(pool));
        return true;
      };
    });
  }

  releaseHostSlot(pool) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (pool.waiters.length) {
        const waiter = pool.waiters.shift();
        if (waiter.settled || waiter.signal?.aborted
          || Number.isFinite(waiter.deadline) && Date.now() >= waiter.deadline) {
          if (!waiter.settled) {
            waiter.settled = true;
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.signal?.removeEventListener('abort', waiter.onAbort);
            // 交接前才发现等待者已撤消/过期：与定时器到期一样，各记一次准入终态。
            const aborted = Boolean(waiter.signal?.aborted);
            if (aborted) pool.stats.queueAborted++; else pool.stats.queueTimeout++;
            waiter.reject(failure(aborted ? 'capability_aborted' : 'capability_timeout'));
          }
          continue;
        }
        waiter.grant();
        return;
      }
      pool.active--;
      this.hostActiveTotal--;
    };
  }

  /**
   * 嵌套调用的上下文继承：deadline 取父/子较小值；signal 则合并「祖先源 signal ∪ 本次
   * signal」。frame 记录的是源 signal（sources），不是父层的派生 signal：父调用 settle 时
   * 会摘掉自己那对监听，若孙调用只借用父的派生 signal 就会随父断链，所以每个调用都为
   * 自己订阅全部源 signal，由自己的 finally 释放。Node 18 没有 AbortSignal.any，这里手动
   * 挂监听；不占用用户 signal 的 onabort 槽位。父调用已 settle 时不会出现在活动 frame 里，
   * 延后的回调就是新的根调用，不再继承已结束调用的 signal/deadline。
   */
  inheritHostContext(parent, signal, deadline) {
    const inheritedDeadline = Number.isFinite(parent?.deadline)
      ? (Number.isFinite(deadline) ? Math.min(deadline, parent.deadline) : parent.deadline)
      : deadline;
    const sources = [];
    for (const source of parent?.sources || []) {
      if (source && !sources.includes(source)) sources.push(source);
    }
    if (signal && !sources.includes(signal)) sources.push(signal);
    if (!sources.length) return { signal, deadline: inheritedDeadline, sources, release: null };
    // 只有一个源时直接共用，免去派生和一对监听。
    if (sources.length === 1) return { signal: sources[0], deadline: inheritedDeadline, sources, release: null };
    const derived = new AbortController();
    const cancel = () => derived.abort();
    if (sources.some(source => source.aborted)) cancel();
    else for (const source of sources) source.addEventListener('abort', cancel, { once: true });
    return {
      signal: derived.signal,
      deadline: inheritedDeadline,
      sources,
      release: () => {
        for (const source of sources) source.removeEventListener('abort', cancel);
      },
    };
  }

  /**
   * 调用宿主能力（公共入口）。负责关闭闸门、单次调度选项与写能力幂等复用；
   * 准入与执行细节在 invokeHostAdmitted 里，保持既有顺序和错误语义。
   * plugin 为空 = 宿主内部调用（路由、Bot、定时任务）；
   * 有 plugin = 插件 host.call，按清单声明与授权代次校验。
   */
  async invokeHost(name, input, options = {}) {
    if (this.closed) throw failure('capability_shutdown');
    const { plugin = null, signal, deadline, priority = 0, idempotencyKey } = options || {};
    this.validateHostOptions(priority, idempotencyKey);
    const call = { plugin, signal, deadline, priority };
    const contract = registry.calls[name];
    // 幂等只对写能力开放：只读能力的重复读取没有副作用，仍按普通调用执行。
    // 授权、禁用与未实现仍走原准入顺序，不能借已缓存结果绕过这些闸门。
    const replayable = Boolean(contract) && contract.enabled !== false
      && !isReadOnlySideEffect(contract.sideEffect)
      && idempotencyKey !== undefined && idempotencyKey !== null
      && this.hostContracts.has(name)
      && (!plugin || (this.plugins.isApproved(plugin)
        && Array.isArray(plugin.calls) && plugin.calls.includes(name)));
    if (!replayable) return this.invokeHostAdmitted(name, input, call);
    // 作用域包含能力、调用者与业务键：不同插件用同一个键不能互相复用结果。
    const cacheKey = `${name}\u0000${plugin?.id || 'host'}\u0000${idempotencyKey}`;
    const existing = this.idempotencyLookup(cacheKey);
    if (existing) {
      this.countIdempotentHit(name);
      const value = await existing.promise;
      // 结果正常都是 JSON 形状；极少数不可克隆值时退回原引用，不能因缓存复制失败而报错。
      try { return structuredClone(value); } catch { return value; }
    }
    let resolveEntry;
    let rejectEntry;
    const entryPromise = new Promise((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });
    // 在途条目可能暂时没有重复请求在等它：先吃掉自身的拒绝，避免未处理拒绝。
    entryPromise.catch(() => {});
    this.idempotencyRemember(cacheKey, { at: Date.now(), promise: entryPromise });
    try {
      const result = await this.invokeHostAdmitted(name, input, call);
      // 缓存一份副本：首个调用方之后修改自己的返回值不能污染后续幂等命中。
      // 极少数无法克隆的结果直接放弃缓存，不能把已经成功的调用改报为失败。
      let cached;
      try { cached = structuredClone(result); }
      catch {
        this.hostIdempotency.delete(cacheKey);
        resolveEntry(result);
        return result;
      }
      resolveEntry(cached);
      return result;
    } catch (error) {
      this.hostIdempotency.delete(cacheKey);
      rejectEntry(error);
      throw error;
    }
  }

  // 单次调度选项非法时复用既有错误码，不新增插件可见错误。
  validateHostOptions(priority, idempotencyKey) {
    if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) {
      throw failure('invalid_dispatcher_limits');
    }
    if (idempotencyKey !== undefined && idempotencyKey !== null
      && (typeof idempotencyKey !== 'string' || !idempotencyKey.length || idempotencyKey.length > 128)) {
      throw failure('invalid_dispatcher_limits');
    }
  }

  idempotencyLookup(cacheKey) {
    const entry = this.hostIdempotency.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.at > HOST_IDEMPOTENCY_TTL_MS) {
      this.hostIdempotency.delete(cacheKey);
      return null;
    }
    return entry;
  }

  idempotencyRemember(cacheKey, entry) {
    // 上限内按插入顺序淘汰最老条目；不刷新命中时间，保持固定保留窗口。
    while (this.hostIdempotency.size >= HOST_IDEMPOTENCY_MAX && !this.hostIdempotency.has(cacheKey)) {
      this.hostIdempotency.delete(this.hostIdempotency.keys().next().value);
    }
    this.hostIdempotency.set(cacheKey, entry);
  }

  countIdempotentHit(name) {
    const pool = this.hostPools.get(name);
    if (pool) pool.stats.idempotentHit++;
  }

  async invokeHostAdmitted(name, input, { plugin = null, signal, deadline, priority = 0 } = {}) {
    // 顺序与旧 hostCapabilities 一致：未知 → 全局关闭 → 未声明 → 未实现 → 校验 → 执行。
    const contract = registry.calls[name];
    if (!contract) {
      this.refuseHost(null, 'unknown');
      throw failure('host_capability_unknown');
    }
    if (contract.enabled === false) {
      this.refuseHost(name, 'disabled');
      throw failure('host_capability_disabled');
    }
    // 只取仍活着的祖先：settle 的 frame 即使还留在 AsyncLocalStorage 里也不算上下文。
    const ancestors = (this.hostContext.getStore() || []).filter(frame => frame.active);
    const inherited = this.inheritHostContext(ancestors[ancestors.length - 1], signal, deadline);
    try {
      if (inherited.signal?.aborted) throw failure('capability_aborted');
      if (plugin) {
        if (!this.plugins.isApproved(plugin)) {
          this.refuseHost(name, 'revoked');
          throw failure('grant_revoked');
        }
        if (!Array.isArray(plugin.calls) || !plugin.calls.includes(name)) {
          this.refuseHost(name, 'not_declared');
          throw failure('host_capability_not_declared');
        }
      }
      try {
        validate(contract.inputSchema, input, 'invalid_host_capability_input');
      } catch (error) {
        this.refuseHost(name, 'invalid_input');
        throw error;
      }
      const handler = this.hostContracts.get(name)?.handler;
      if (!handler) {
        this.refuseHost(name, 'unavailable');
        throw failure('host_capability_unavailable');
      }
      if (Number.isFinite(inherited.deadline) && Date.now() >= inherited.deadline) {
        this.refuseHost(name, 'expired');
        throw failure('capability_timeout');
      }
      // 嵌套调用不能等待自己或已占满的下游池，否则容量阀会制造跨能力自等。
      if (ancestors.some(frame => frame.name === name)) {
        this.refuseHost(name, 'reentrant');
        throw failure('host_capability_reentrant');
      }
      const pool = this.hostPools.get(name);
      if (ancestors.length && pool.active >= this.maxHostConcurrent) {
        // 这是嵌套目标池满的快速拒绝，不是等待队列满：单独计数并打 phase=nested。
        pool.stats.nestedRefused++;
        this.logHostQueueFull(pool, 'nested');
        throw failure('host_capability_queue_limit');
      }
      // 全局额度是硬拒绝而非排队：任一能力占满全局名额时快速失败，不再跨能力排队。
      if (this.hostActiveTotal >= this.maxHostTotalConcurrent) {
        this.hostGlobalRefused++;
        this.logHostQueueFull(pool, 'global');
        throw failure('host_capability_queue_limit');
      }
      const release = await this.acquireHostSlot(pool, { signal: inherited.signal,
        deadline: inherited.deadline, priority });
      pool.stats.granted++;
      const frame = { name, active: true, signal: inherited.signal, sources: inherited.sources,
        deadline: inherited.deadline };
      try {
        if (inherited.signal?.aborted) throw failure('capability_aborted');
        if (Number.isFinite(inherited.deadline) && Date.now() >= inherited.deadline) {
          throw failure('capability_timeout');
        }
        if (plugin) {
          if (!this.plugins.isApproved(plugin)) throw failure('grant_revoked');
          if (!Array.isArray(plugin.calls) || !plugin.calls.includes(name)) throw failure('host_capability_not_declared');
        }
        const output = await this.hostContext.run([...ancestors, frame],
          () => handler(input || {}, plugin, { signal: inherited.signal, deadline: inherited.deadline }));
        // 只有只读能力的「失败」没有副作用代价，才保留事后取消/超时判定；
        // 写能力与未知/新增 sideEffect 一旦 handler 正常返回就按完成校验返回。
        // 准入与排队阶段的判定不受影响。
        if (isReadOnlySideEffect(contract.sideEffect)) {
          if (inherited.signal?.aborted) throw failure('capability_aborted');
          if (Number.isFinite(inherited.deadline) && Date.now() >= inherited.deadline) {
            throw failure('capability_timeout');
          }
        }
        const result = validate(contract.outputSchema, output, 'invalid_host_capability_output');
        pool.stats.completed++;
        return result;
      } catch (error) {
        // failed 只统计已经拿到名额之后的终态；准入阶段的拒绝走 refused/queue* 计数。
        pool.stats.failed++;
        throw error;
      } finally {
        frame.active = false;
        release();
      }
    } finally {
      inherited.release?.();
    }
  }

  runTool(id, input, options = {}) {
    return this.invoke('tool.run@1', input, { ...options, pluginId: id, scope: 'manual' });
  }

  reconcileTasks(scheduler) {
    if (!scheduler || typeof scheduler.every !== 'function' || typeof scheduler.cancel !== 'function') return;
    const expected = new Map();
    for (const plugin of this.plugins.installed()) {
      const declaration = plugin.provides?.['task.tick@1'];
      if (declaration?.mode !== 'schedule' || declaration.scope !== 'all') continue;
      const name = `plugin-v1:${plugin.id}:task.tick@1`;
      const signature = `${plugin.authRevision ?? plugin.epoch}:${declaration.intervalSeconds}`;
      expected.set(name, { plugin, declaration, signature });
    }
    for (const [name, signature] of this.scheduled) {
      if (expected.get(name)?.signature !== signature) {
        scheduler.cancel(name);
        this.scheduled.delete(name);
      }
    }
    for (const [name, item] of expected) {
      if (this.scheduled.get(name) === item.signature) continue;
      scheduler.every(name, item.declaration.intervalSeconds * 1000, () => {
        if (!this.plugins.isApproved(item.plugin)) return;
        const now = scheduler.now();
        const input = { scheduledAt: now, now, settings: item.plugin.settings || {} };
        return this.invoke('task.tick@1', input, { pluginId: item.plugin.id, scope: 'all',
          deadline: now + item.plugin.executionTimeoutMs,
          preflight: () => ({ allowed: this.plugins.isApproved(item.plugin), input }),
        });      });
      this.scheduled.set(name, item.signature);
    }
  }

  stopTasks(scheduler) {
    if (!scheduler) return;
    for (const name of this.scheduled.keys()) scheduler.cancel(name);
    this.scheduled.clear();
  }

  logFailure(capability, plugin, error) {
    this.logger?.warn?.(`[plugin-dispatch] capability=${capability} plugin=${plugin.id} result=ignored code=${String(error?.code || 'plugin_error').slice(0, 64)}`);
  }
}

module.exports = { UnifiedCapabilityDispatcher };
