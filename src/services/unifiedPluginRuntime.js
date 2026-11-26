'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const registry = require('./pluginProtocolRegistry.json');
const { validateSettings, validate } = require('./capabilitySchema');
const { validateProviderInterval, declaresChatData, CHAT_DATA_PROVIDERS } = require('./pluginProtocol');

const PROVIDER_CAPABILITIES = Object.freeze(Object.keys(registry.providers));
const HOST_CAPABILITIES = Object.freeze(Object.keys(registry.calls));
const { limits, files, manifest: manifestPolicy } = registry;
const ID = new RegExp(manifestPolicy.idPattern);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const EPOCH = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_IO = limits.maxInvocationBytes;
const MAX_SETTINGS = limits.maxSettingsBytes;
const MAX_INSTALLED = limits.maxInstalledPlugins;
const MAX_WAITING = limits.maxQueuedInvocations;

// state 通道：只对四个聊天类扩展点开放；插件版本 × 会话各一份，输出完整替换。
const STATE_CAPABILITIES = new Set(['chat.pre_reply@1', 'chat.prompt@1', 'chat.before_send@1', 'chat.reply@1']);
const MAX_STATE_BYTES = 8 * 1024;
const MAX_STATE_SESSIONS = 200;
// 内层 Map 的会话键、外层 owner 键都用它拼接，避免插件 id/chatId 里出现分隔符时串键。
const SESSION_SEPARATOR = '\u0000';

// 会话数据投影：同一轮多个 provider 共享输入，但 system/history 只能按每个插件
// 自己的 dataAccess 发放；旧词（chat.history/model.prompt）与新词（conversation-history/
// system-prompt）等价，避免老插件迁移后拿不到。
const DATA_ACCESS_CAPABILITIES = new Set(['chat.prompt@1', 'chat.reply@1', 'chat.before_send@1', 'chat.generate@1']);
const SYSTEM_GRANTS = ['model.prompt', 'system-prompt'];
const HISTORY_GRANTS = ['chat.history', 'conversation-history'];
const hasHistoryGrant = grants => HISTORY_GRANTS.some(name => grants.includes(name));
// enhance 链把上一层结果放进 output（chat.search@1 是 previous）再交给下一个插件。
// 只投影顶层会让未授权插件从嵌套字段读到前位插件已经拿到的提示词/历史。
const PROJECTION_ENVELOPES = ['output', 'previous'];
const PROJECTION_DEPTH = 3;

function projectDataAccess(capability, input, dataAccess) {
  if (!DATA_ACCESS_CAPABILITIES.has(capability) || !object(input)) return input;
  const grants = Array.isArray(dataAccess) ? dataAccess : [];
  const draft = projectSensitive(input, grants, 0);
  // chat.generate@1 把会话内容放在 turns（不是 history）：没有 conversation-history 授权时
  // 只清空内容、保留字段本身（input schema 必填），当前 message 不受影响；不能整段删除，
  // 否则未授权的 replace 生成能力会因缺字段无法运行。now/lastBot 属于默认接话上下文，
  // 不在这里裁剪（见 registry 的 lastBot 说明）。
  if (capability === 'chat.generate@1' && !hasHistoryGrant(grants) && Array.isArray(draft.turns)) {
    draft.turns = [];
  }
  return draft;
}

function projectSensitive(value, grants, depth) {
  const draft = { ...value };
  if (!SYSTEM_GRANTS.some(name => grants.includes(name))) delete draft.system;
  if (!hasHistoryGrant(grants)) delete draft.history;
  if (depth >= PROJECTION_DEPTH) return draft;
  for (const key of PROJECTION_ENVELOPES) {
    if (object(draft[key])) draft[key] = projectSensitive(draft[key], grants, depth + 1);
  }
  return draft;
}

/**
 * enhance 是“完整替换”语义：未授权插件看不到 system/history，它返回的同名字段
 * 不能覆盖前一层已授权的值。缺字段时恢复前一层值，避免空 system 把提示词清空；
 * dataAccess 不是数组时视为调用方没有启用投影（假运行器/旧调用），保持替换语义。
 */
function reconcileDataAccessOutput(capability, dataAccess, prior, candidate) {
  if (!DATA_ACCESS_CAPABILITIES.has(capability) || !Array.isArray(dataAccess)
    || !object(prior) || !object(candidate)) return candidate;
  const draft = { ...candidate };
  if (!SYSTEM_GRANTS.some(name => dataAccess.includes(name))) {
    if (prior.system === undefined) delete draft.system; else draft.system = prior.system;
  }
  if (!hasHistoryGrant(dataAccess)) {
    if (prior.history === undefined) delete draft.history; else draft.history = prior.history;
  }
  return draft;
}

/**
 * state 作用域：同一 chatId 在不同 platform/chatType 下不是一个会话，不能互相继承；
 * 插件版本由外层 owner 键（packageHash）绑定，同 id 更新后不会读到旧版本的 state。
 */
function sessionScope(input, chatId) {
  const message = object(input) && object(input.message) ? input.message : {};
  const platform = typeof message.platform === 'string' ? message.platform.slice(0, 24) : '';
  const chatType = typeof message.chatType === 'string' ? message.chatType.slice(0, 16) : '';
  const id = String(chatId || message.chatId || '').slice(0, 120);
  if (!id) return '';
  return `${platform}${SESSION_SEPARATOR}${chatType}${SESSION_SEPARATOR}${id}`;
}

const error = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idAllowed = id => typeof id === 'string' && ID.test(id) && !RESERVED.test(id);
const listAllowed = (list, allowed) => Array.isArray(list) && list.length <= allowed.length
  && new Set(list).size === list.length && list.every(item => allowed.includes(item));
function versionParts(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(value.trim())) return null;
  const parts = value.trim().split('.').map(Number);
  return parts.every(part => part <= 2147483647) ? parts : null;
}

function versionAtLeast(left, right) {
  for (let index = 0; index < 4; index++) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference) return difference > 0;
  }
  return true;
}

function validRange(range, floor) {
  const minimum = versionParts(range.minAppVersion);
  const maximum = versionParts(range.maxAppVersion);
  return minimum && (!floor || versionAtLeast(minimum, floor))
    && (range.maxAppVersion === undefined || range.maxAppVersion === '' || maximum && versionAtLeast(maximum, minimum));
}

function validAppCompatibility(manifest) {
  if (manifest.appEpoch !== undefined && ![1, 2].includes(manifest.appEpoch)) return false;
  if (!versionParts(manifest.version) || !validRange(manifest)) return false;
  const ranges = manifest.appCompatibility === undefined
    ? [{ appEpoch: manifest.appEpoch ?? 1, minAppVersion: manifest.minAppVersion, maxAppVersion: manifest.maxAppVersion }]
    : manifest.appCompatibility;
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 2) return false;
  return ranges.every(range => object(range)
    && Object.keys(range).every(key => ['appEpoch', 'minAppVersion', 'maxAppVersion'].includes(key))
    && [1, 2].includes(range.appEpoch)
    && validRange(range, range.appEpoch === 2 ? [1, 0, 0] : [4, 1, 2]))
    && new Set(ranges.map(range => range.appEpoch)).size === ranges.length;
}

function validTitle(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

/**
 * compat 只改变 3 级 Wasm 的输入信封，不参与授权；其它等级/未知值拒绝。
 * 旧信封只认识注册表 manifest.compat.hooks 登记过的那几个 provider：映射不到的
 * provider（如 tool.run@1）会安装成功、第一次派发才撞 invalid_wasm_compat。
 */
function validCompat(manifest) {
  if (manifest.compat === undefined) return true;
  const policy = registry.manifest?.compat;
  const hooks = policy?.hooks;
  return policy?.values?.includes(manifest.compat) && policy.levels?.includes(manifest.level)
    && manifest.runtime === policy.runtime && object(hooks) && object(manifest.provides)
    && Object.keys(manifest.provides).every(name => Object.hasOwn(hooks, name));
}

const hasChatDataGrant = grant => Array.isArray(grant.approvedProviders)
  && grant.approvedProviders.some(name => CHAT_DATA_PROVIDERS.includes(name));

function acceptedProviders(manifest) {
  if (!object(manifest) || Object.keys(manifest).some(key => !manifestPolicy.allowed.includes(key))
    || manifestPolicy.required.some(key => !Object.hasOwn(manifest, key))
    || manifest.format !== registry.format || !Number.isInteger(manifest.level) || !registry.levels[manifest.level]
    || manifest.runtime !== registry.levels[manifest.level]?.runtime || manifest.entry !== registry.levels[manifest.level]?.entry
    || !validTitle(manifest.name, manifestPolicy.maxNameLength) || !validTitle(manifest.author, manifestPolicy.maxAuthorLength)
    || typeof manifest.description !== 'string' || manifest.description.length > manifestPolicy.maxDescriptionLength
    || !validAppCompatibility(manifest) || !validCompat(manifest) || !object(manifest.provides)
    || manifest.settingsSchema !== undefined && (!object(manifest.settingsSchema) || manifest.settingsSchema.type !== 'object')) return null;
  const capabilities = Object.keys(manifest.provides);
  if (!capabilities.length || !listAllowed(capabilities, PROVIDER_CAPABILITIES)) return null;
  for (const name of capabilities) {
    const row = manifest.provides[name];
    const rule = registry.providers[name];
    if (!registry.levels[manifest.level].providers.includes(name)
      || !object(row) || Object.keys(row).some(key => !['mode', 'scope', 'intervalSeconds'].includes(key))
      || !rule.modes.includes(row.mode) || !rule.scopes.includes(row.scope)) return null;
    if (!validateProviderInterval(rule, row)) return null;
  }
  return manifest.provides;
}

function bytes(filename, limit) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > limit) throw error('invalid_plugin_file');
  const value = fs.readFileSync(filename);
  if (value.length > limit) throw error('invalid_plugin_file');
  return value;
}

function directory(filename) {
  if (!fs.lstatSync(filename).isDirectory()) throw error('invalid_plugin_directory');
}

function wire(value, code) {
  try {
    const json = JSON.stringify(value === undefined ? null : value);
    if (typeof json === 'string' && Buffer.byteLength(json) <= MAX_IO) return JSON.parse(json);
  } catch { /* 不暴露插件传入值或序列化异常中的数据。 */ }
  throw error(code);
}

class UnifiedPluginRuntime {
  constructor({ dataDir, logger, enabled = () => true, hostCall, maxConcurrent = 2 }) {
    this.root = path.join(dataDir, 'plugins');
    this.logger = logger;
    this.enabled = enabled;
    this.hostCall = hostCall;
    this.maxConcurrent = Math.max(1, Math.min(8, Number.isInteger(maxConcurrent) ? maxConcurrent : limits.maxConcurrentInvocations));
    this.waiting = new Set();
    this.workers = new Map();
    // owner（插件 id + 安装包摘要） -> Map(会话作用域 -> { json, bytes })，
    // 内层 Map 的插入顺序就是 LRU 顺序。包摘要进外层键，更新同 id 不继承旧 state。
    this.states = new Map();
    this.closed = false;
  }

  get active() { return this.workers.size; }

  read(id) {
    if (this.closed || !this.enabled() || !idAllowed(id)) return null;
    try {
      directory(path.dirname(this.root));
      directory(this.root);
      const installPath = path.resolve(this.root, id);
      directory(installPath);
      const pluginData = path.join(installPath, files.dataDirectory);
      directory(pluginData);
      const rawGrant = bytes(path.join(installPath, files.grant), MAX_SETTINGS * 2);
      const grant = JSON.parse(decoder.decode(rawGrant));
      if (grant?.enabled !== true || typeof grant.epoch !== 'string' || !EPOCH.test(grant.epoch)
        || typeof grant.packageHash !== 'string' || !HASH.test(grant.packageHash)) return null;
      const rawManifest = bytes(path.join(installPath, files.manifest), limits.maxManifestBytes);
      const manifest = JSON.parse(decoder.decode(rawManifest));
      const declared = acceptedProviders(manifest);
      if (!declared || manifest.id !== id || manifest.level !== grant.level) return null;
      const policy = registry.levels[manifest.level];
      const dataAccess = manifest.dataAccess === undefined ? [] : manifest.dataAccess;
      const grantedData = grant.approvedDataAccess === undefined ? [] : grant.approvedDataAccess;
      const allowedData = declaresChatData(declared) ? policy.dataAccess || [] : [];
      if (!listAllowed(dataAccess, allowedData) || !listAllowed(grantedData, dataAccess)
        || grantedData.length !== dataAccess.length) return null;
      const full = manifest.level === 4;
      if (grant.fullAccess !== full || grant.nodeFullConfirmed !== full
        || !listAllowed(manifest.calls, policy.calls)
        || !listAllowed(grant.approvedProviders, Object.keys(declared))
        || !listAllowed(grant.approvedCalls, manifest.calls.filter(name => registry.calls[name].enabled !== false))
        || manifest.level === 3 && hasChatDataGrant(grant) && grant.chatConfirmed !== true) return null;
      const filename = path.join(installPath, policy.entry);
      const rawEntry = bytes(filename, policy.maxEntryBytes);
      if (digest(rawManifest) !== grant.manifestHash || digest(rawEntry) !== grant.entryHash) return null;
      const provides = Object.fromEntries(grant.approvedProviders.map(name => [name, declared[name]]));
      const settings = grant.settings;
      if (!object(settings) || Buffer.byteLength(JSON.stringify(settings)) > MAX_SETTINGS) return null;
      if (manifest.settingsSchema !== undefined) validateSettings(settings, manifest.settingsSchema);
      const executionTimeoutMs = manifest.executionTimeoutMs ?? 30000;
      if (!Number.isInteger(executionTimeoutMs) || executionTimeoutMs < limits.minExecutionTimeoutMs || executionTimeoutMs > limits.maxExecutionTimeoutMs) return null;
      return { id, level: manifest.level, name: manifest.name, author: manifest.author, version: manifest.version,
        description: manifest.description, provides, hooks: Object.keys(provides),
        calls: grant.approvedCalls.filter(name => registry.calls[name].enabled !== false),
        executionTimeoutMs, packageHash: grant.packageHash, hash: grant.packageHash, epoch: grant.epoch, settings,
        compat: manifest.compat,
        dataAccess: grantedData.slice(),
        authRevision: digest(rawGrant), source: full ? decoder.decode(rawEntry) : rawEntry.toString('base64'), filename, pluginData };
    } catch { return null; }
  }

  installed() {
    if (this.closed || !this.enabled()) {
      this.clearSessionStates();
      return [];
    }
    try {
      directory(path.dirname(this.root));
      directory(this.root);
      const result = [];
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory()) continue;
        const flow = this.read(entry.name);
        if (flow) result.push(flow);
        if (result.length >= MAX_INSTALLED) break;
      }
      // 停用/卸载/更新后已不在列表里的插件版本，内存 state 没有保留意义。
      const owners = new Set(result.map(flow => this.stateOwner(flow)));
      for (const owner of [...this.states.keys()]) if (!owners.has(owner)) this.states.delete(owner);
      return result;
    } catch { return []; }
  }

  current(flow) {
    const fresh = this.read(flow?.id);
    if (!fresh || fresh.packageHash !== (flow.packageHash ?? flow.hash) || fresh.epoch !== flow.epoch) {
      if (flow) this.clearSessionStates(flow);
      return null;
    }
    if (fresh.authRevision !== flow.authRevision) {
      if (flow) this.clearSessionStates(flow);
      return null;
    }
    return fresh;
  }

  isApproved(flow) { return Boolean(this.current(flow)); }

  isApprovedIdHash(id, packageHash) {
    return typeof packageHash === 'string' && HASH.test(packageHash) && this.read(id)?.packageHash === packageHash;
  }

  /** 外层 owner：插件 id 绑定当前安装包摘要，同 id 更新后旧 state 不再可见。 */
  stateOwner(flow) {
    if (typeof flow === 'string') return flow;
    if (!flow || typeof flow.id !== 'string') return '';
    const version = flow.packageHash ?? flow.hash;
    return typeof version === 'string' ? `${flow.id}${SESSION_SEPARATOR}${version}` : flow.id;
  }

  /** 读取插件在某个会话里的 state；没有时返回空对象（旧 Api3 的“首次为空”语义）。 */
  getSessionState(flow, scope) {
    if (!scope) return {};
    const sessions = this.states.get(this.stateOwner(flow));
    if (!sessions) return {};
    const entry = sessions.get(scope);
    if (!entry) return {};
    // 命中即刷新 LRU。
    sessions.delete(scope);
    sessions.set(scope, entry);
    return JSON.parse(entry.json);
  }

  /** 保存 state：只接受普通对象且 ≤8 KiB；超限/非对象按输出不合契约处理。 */
  saveSessionState(flow, scope, state) {
    if (!scope) return;
    if (!object(state)) throw error('invalid_capability_output');
    let json;
    try { json = JSON.stringify(state); } catch { throw error('invalid_capability_output'); }
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_STATE_BYTES) throw error('invalid_capability_output');
    const owner = this.stateOwner(flow);
    if (!owner) return;
    let sessions = this.states.get(owner);
    if (!sessions) this.states.set(owner, sessions = new Map());
    sessions.delete(scope);
    sessions.set(scope, { json, bytes });
    while (sessions.size > MAX_STATE_SESSIONS) sessions.delete(sessions.keys().next().value);
    // 只记字节数，state 内容和会话标识都不进日志。
    this.logger?.info?.(`[plugin-state] plugin=${typeof flow === 'string' ? flow : flow.id} bytes=${bytes}`);
  }

  clearSessionStates(flow) {
    if (!flow) { this.states.clear(); return; }
    if (typeof flow === 'string') {
      const prefix = `${flow}${SESSION_SEPARATOR}`;
      for (const owner of [...this.states.keys()]) {
        if (owner === flow || owner.startsWith(prefix)) this.states.delete(owner);
      }
      return;
    }
    const owner = this.stateOwner(flow);
    if (owner) this.states.delete(owner);
  }

  async invoke(flow, capability, input, { signal, deadline, chatId, validateOutput } = {}) {
    const invokedAt = Date.now();
    if (signal?.aborted) throw error('capability_aborted');
    const approved = this.current(flow);
    if (!approved) throw error('grant_revoked');
    if (!approved.hooks.includes(capability)) throw error('capability_not_declared');
    if (deadline !== undefined && !Number.isFinite(deadline)) throw error('invalid_deadline');
    deadline = Math.min(deadline ?? Infinity, invokedAt + approved.executionTimeoutMs);
    if (Date.now() >= deadline) throw error('capability_timeout');
    if (this.waiting.size >= MAX_WAITING) throw error('plugin_queue_limit');
    const stateCapability = STATE_CAPABILITIES.has(capability);
    const stateSession = stateCapability ? sessionScope(input, chatId) : '';
    const projected = projectDataAccess(capability, input, approved.dataAccess);
    // 这里只校验不含 state 的投影结果；state 在真正 spawn 前才读取并注入，
    // 排队期间同插件的上一次调用可能刚写完更新的一版。
    const payload = wire(projected, 'input_limit');
    const base = stateCapability && object(projected) ? projected : null;
    return new Promise((resolve, reject) => {
      const job = { invocation: randomUUID(), flow: approved, capability, base, payload, deadline, signal,
        state: stateCapability ? {} : null, stateSession,
        // 宿主（dispatcher）的完整输出校验：在 state 落库前执行，非法 text/action 不能写 state。
        validateOutput: typeof validateOutput === 'function' ? validateOutput : null,
        controller: new AbortController(), calls: new Set(), callsStarted: 0, resolve, reject };
      job.onAbort = () => this.finish(job, error('capability_aborted'));
      job.timer = setTimeout(() => this.finish(job, error('capability_timeout')), Math.max(1, deadline - Date.now()));
      this.waiting.add(job);
      signal?.addEventListener('abort', job.onAbort, { once: true });
      if (signal?.aborted) job.onAbort();
      this.drain();
    });
  }

  check(job) {
    if (job.done || job.signal?.aborted) throw error('capability_aborted');
    if (Date.now() >= job.deadline) throw error('capability_timeout');
    if (!this.isApproved(job.flow)) throw error('grant_revoked');
    if (Date.now() >= job.deadline) throw error('capability_timeout');
  }

  drain() {
    if (this.closed || this.draining) return;
    this.draining = true;
    try {
      for (const job of this.waiting) {
        if (this.workers.size >= this.maxConcurrent) break;
        if (this.workers.has(job.flow.id)) continue;
        this.waiting.delete(job);
        try { this.check(job); this.spawn(job); }
        catch (failure) { this.finish(job, failure); }
      }
    } finally { this.draining = false; }
  }

  /**
   * worker 真正启动前才读取 state：同插件多个调用排队时，invoke() 时的快照可能已被
   * 前一次调用重写。Node（4 级）把 state 注入 input，3 级 Wasm 由 invoke 信封单独携带。
   */
  prepare(job) {
    if (!job.base) return;
    if (job.stateSession) job.state = this.getSessionState(job.flow, job.stateSession);
    if (job.flow.level === 4) job.payload = wire({ ...job.base, state: job.state }, 'input_limit');
  }

  spawn(job) {
    const { filename, pluginData } = job.flow;
    try { this.prepare(job); }
    catch (failure) { this.finish(job, failure); return; }
    const child = spawn(process.execPath, ['--max-old-space-size=256', '--unhandled-rejections=strict',
      ...(job.flow.level === 4 ? [] : ['--wasm-max-mem-pages=64', '--wasm-max-table-size=8192']),
      path.join(__dirname, job.flow.level === 4 ? 'unifiedPluginWorker.js' : 'unifiedWasmWorker.js')], {
      cwd: pluginData, detached: process.platform !== 'win32', windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '', TEMP: process.env.TEMP || '',
        TMP: process.env.TMP || '', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    job.child = child;
    this.workers.set(job.flow.id, job);
    job.exited = new Promise(resolve => child.once('close', () => {
      this.finish(job, error('plugin_process_exit'));
      this.workers.delete(job.flow.id);
      resolve();
      this.drain();
    }));
    child.on('error', () => this.finish(job, error('plugin_process_error')));
    child.on('message', message => this.receive(job, message));
    this.send(job, { type: 'init', source: job.flow.source, filename, level: job.flow.level, compat: job.flow.compat });
  }

  send(job, message) {
    if (job.done) return;
    if (!job.child.connected) { this.finish(job, error('plugin_process_exit')); return; }
    job.child.send(message, failure => { if (failure) this.finish(job, error('plugin_process_error')); });
  }

  receive(job, message) {
    if (job.done || !object(message)) return;
    try {
      this.check(job);
      if (message.type === 'ready' && !job.running) {
        job.running = true;
        this.send(job, { type: 'invoke', invocation: job.invocation, capability: job.capability, input: job.payload,
          settings: job.flow.settings, state: job.state === null ? undefined : job.state });
      } else if (message.type === 'boot_failed' && !job.running) {
        this.finish(job, error('plugin_error'));
      } else if (job.running && message.invocation === job.invocation && message.type === 'complete') {
        if (message.ok !== true) { this.finish(job, error('plugin_error')); return; }
        const value = wire(message.value, 'output_limit');
        this.check(job);
        // 完整输出校验通过之前不写 state：非法 text/action（或 state 本身超限）的
        // complete 不能先污染会话状态；授权/取消也在落库前再确认一次。
        if (job.validateOutput) job.validateOutput(value);
        const contract = registry.providers[job.capability];
        const writesState = job.stateSession && object(value) && value.state !== undefined;
        // 不依赖调用方一定传 validateOutput：runtime 自己按注册表 outputSchema 再校验一次，
        // 直接 invoke 的调用方也不能让非法输出把 state 带进内存。
        if (writesState && contract) validate(contract.outputSchema, value, 'invalid_capability_output');
        this.check(job);
        if (writesState) {
          try { this.saveSessionState(job.flow, job.stateSession, value.state); }
          catch (failure) { this.finish(job, failure); return; }
        }
        this.finish(job, null, value);
      } else if (job.flow.level === 4 && job.running && message.invocation === job.invocation && message.type === 'call') {
        void this.request(job, message);
      } else this.finish(job, error('invalid_plugin_ipc'));
    } catch (failure) { this.finish(job, failure); }
  }

  async request(job, message) {
    const { id, name } = message;
    if (!Number.isSafeInteger(id) || id <= 0 || job.calls.has(id)) {
      this.finish(job, error('invalid_plugin_ipc')); return;
    }
    if (job.callsStarted++ >= limits.maxCallsPerInvocation) {
      this.finish(job, error('host_call_limit')); return;
    }
    const reply = fields => this.send(job, { type: 'response', invocation: job.invocation, id, ...fields });
    if (typeof name === 'string' && registry.calls[name]?.enabled === false) {
      reply({ ok: false, code: 'host_capability_disabled' }); return;
    }
    if (!job.flow.calls.includes(name)) { reply({ ok: false, code: 'host_capability_not_declared' }); return; }
    if (job.calls.size >= limits.maxConcurrentCallsPerInvocation) { reply({ ok: false, code: 'host_call_limit' }); return; }
    job.calls.add(id);
    try {
      this.check(job);
      if (typeof this.hostCall !== 'function') throw error('host_capability_unavailable');
      const value = await this.hostCall(name, wire(message.input, 'host_input_limit'), job.flow,
        { signal: job.controller.signal, deadline: job.deadline });
      this.check(job);
      reply({ ok: true, value: wire(value, 'host_output_limit') });
    } catch (failure) {
      const code = failure?.code;
      if (code === 'grant_revoked' || code === 'capability_timeout') this.finish(job, error(code));
      else reply({ ok: false, code: ['host_input_limit', 'host_output_limit', 'host_capability_unavailable'].includes(code)
        ? code : 'host_call_failed' });
    } finally { job.calls.delete(id); }
  }

  finish(job, failure, value) {
    if (job.done) return;
    job.done = true;
    this.waiting.delete(job);
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);
    job.controller.abort(failure || error('invocation_complete'));
    if (job.child?.pid && job.child.exitCode === null && job.child.signalCode === null) {
      const { child } = job;
      const kill = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === 'win32') {
          const systemRoot = process.env.SystemRoot || 'C:\\Windows';
          execFile(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 2000 }, () => {
              if (child.exitCode === null && child.signalCode === null) child.kill();
            });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
        }
      };
      if (failure && job.running && child.connected) {
        child.send({ type: 'cancel', invocation: job.invocation }, () => {});
        setTimeout(kill, 25).unref();
      } else kill();
    }
    if (failure) job.reject(failure);
    else job.resolve(value);
    if (!job.child) this.drain();
  }

  reconcile() {
    for (const job of [...this.waiting, ...this.workers.values()]) {
      if (job.done) continue;
      try { this.check(job); } catch (failure) { this.finish(job, failure); }
    }
  }

  start(onReconcile) {
    if (this.closed || this.timer) return;
    const reconcile = () => {
      this.reconcile();
      onReconcile?.();
    };
    this.timer = setInterval(reconcile, 500);
    this.timer.unref?.();
    reconcile();
  }

  async stop() {
    if (!this.closed) {
      this.closed = true;
      this.clearSessionStates();
      clearInterval(this.timer);
      for (const job of [...this.waiting, ...this.workers.values()]) this.finish(job, error('plugin_runtime_stopped'));
    }
    await Promise.allSettled([...this.workers.values()].map(job => job.exited));
  }
}

module.exports = { UnifiedPluginRuntime, PROVIDER_CAPABILITIES, HOST_CAPABILITIES, projectDataAccess,
  reconcileDataAccessOutput };
