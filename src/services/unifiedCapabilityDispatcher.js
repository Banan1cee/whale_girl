'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const registry = require('./pluginProtocolRegistry.json');
const { validate } = require('./capabilitySchema');
const { reconcileDataAccessOutput } = require('./unifiedPluginRuntime');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = code => Object.assign(new Error(code), { code });
// enhance 失败可以安全退回上一个输出的副作用等级：都没有宿主可见状态改动。
// 其余等级（billable-model-call / host-delivered-reply / manual /
// declared-host-calls-only）失败必须让调用方决定，不能在分发层吞掉。
const DEGRADABLE_SIDE_EFFECTS = new Set(['none', 'network-read']);

class UnifiedCapabilityDispatcher {
  constructor({ plugins, logger, maxPending = 128, maxPendingPerKey = 16,
    maxHostConcurrent = 32, maxHostPending = 128, maxHostWaitMs = 30000 } = {}) {
    // 只做宿主能力分发时不需要插件运行时；缺 installed/invoke 的能力在用到时再报错。
    if (!plugins) throw failure('invalid_plugin_runtime');
    this.plugins = plugins;
    this.logger = logger;
    this.maxPending = maxPending;
    this.maxPendingPerKey = maxPendingPerKey;
    if (!Number.isSafeInteger(maxHostConcurrent) || maxHostConcurrent < 1 || maxHostConcurrent > 256
      || !Number.isSafeInteger(maxHostPending) || maxHostPending < 0 || maxHostPending > 4096
      || !Number.isSafeInteger(maxHostWaitMs) || maxHostWaitMs < 1 || maxHostWaitMs > 2147483647) {
      throw failure('invalid_dispatcher_limits');
    }
    this.maxHostConcurrent = maxHostConcurrent;
    this.maxHostPending = maxHostPending;
    this.maxHostWaitMs = maxHostWaitMs;
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
  defineHost(name, handler) {
    const contract = registry.calls[name];
    if (!contract || typeof handler !== 'function' || this.hostContracts.has(name)) {
      throw failure('invalid_capability_contract');
    }
    this.hostContracts.set(name, { contract, handler });
    this.hostPools.set(name, { active: 0, waiters: [] });
    return this;
  }

  hasHost(name) {
    return this.hostContracts.has(name);
  }

  acquireHostSlot(pool, { signal, deadline } = {}) {
    if (signal?.aborted) return Promise.reject(failure('capability_aborted'));
    if (Number.isFinite(deadline) && Date.now() >= deadline) return Promise.reject(failure('capability_timeout'));
    if (pool.active < this.maxHostConcurrent) {
      pool.active++;
      return Promise.resolve(this.releaseHostSlot(pool));
    }
    if (pool.waiters.length >= this.maxHostPending) {
      return Promise.reject(failure('host_capability_queue_limit'));
    }

    // 内部调用可能不带 deadline，也必须有有限的排队等待；不替 handler 承诺硬截止。
    deadline = Math.min(Number.isFinite(deadline) ? deadline : Infinity, Date.now() + this.maxHostWaitMs);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, deadline, timer: null, onAbort: null, settled: false };
      const remove = error => {
        if (waiter.settled) return;
        waiter.settled = true;
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
      pool.waiters.push(waiter);
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
            waiter.reject(failure(waiter.signal?.aborted ? 'capability_aborted' : 'capability_timeout'));
          }
          continue;
        }
        waiter.grant();
        return;
      }
      pool.active--;
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
   * 调用宿主能力。plugin 为空 = 宿主内部调用（路由、Bot、定时任务）；
   * 有 plugin = 插件 host.call，按清单声明与授权代次校验。
   * 与「提供者」能力不同：宿主能力可以被任意多个插件同时声明和调用，
   * 没有唯一所有者概念，也不占用提供者的替换名额。
   */
  async invokeHost(name, input, { plugin = null, signal, deadline } = {}) {
    // 顺序与旧 hostCapabilities 一致：未知 → 全局关闭 → 未声明 → 未实现 → 校验 → 执行。
    const contract = registry.calls[name];
    if (!contract) throw failure('host_capability_unknown');
    if (contract.enabled === false) throw failure('host_capability_disabled');
    // 只取仍活着的祖先：settle 的 frame 即使还留在 AsyncLocalStorage 里也不算上下文。
    const ancestors = (this.hostContext.getStore() || []).filter(frame => frame.active);
    const inherited = this.inheritHostContext(ancestors[ancestors.length - 1], signal, deadline);
    try {
      if (inherited.signal?.aborted) throw failure('capability_aborted');
      if (plugin) {
        if (!this.plugins.isApproved(plugin)) throw failure('grant_revoked');
        if (!Array.isArray(plugin.calls) || !plugin.calls.includes(name)) {
          throw failure('host_capability_not_declared');
        }
      }
      validate(contract.inputSchema, input, 'invalid_host_capability_input');
      const handler = this.hostContracts.get(name)?.handler;
      if (!handler) throw failure('host_capability_unavailable');
      if (Number.isFinite(inherited.deadline) && Date.now() >= inherited.deadline) {
        throw failure('capability_timeout');
      }
      // 嵌套调用不能等待自己或已占满的下游池，否则容量阀会制造跨能力自等。
      if (ancestors.some(frame => frame.name === name)) throw failure('host_capability_reentrant');
      const pool = this.hostPools.get(name);
      if (ancestors.length && pool.active >= this.maxHostConcurrent) {
        throw failure('host_capability_queue_limit');
      }
      const release = await this.acquireHostSlot(pool, inherited);
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
        // 保留现有调用结果语义；超时/取消不证明副作用未发生，且不在此重试。
        if (inherited.signal?.aborted) throw failure('capability_aborted');
        if (Number.isFinite(inherited.deadline) && Date.now() >= inherited.deadline) {
          throw failure('capability_timeout');
        }
        return validate(contract.outputSchema, output, 'invalid_host_capability_output');
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
