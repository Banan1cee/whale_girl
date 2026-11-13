'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { HOOKS: WASM_HOOKS } = require('./messagePlugins');

const HOOKS = [...WASM_HOOKS, 'chat.search', 'chat.search_result', 'app.start', 'app.stop', 'timer.tick', 'tool.run'];
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_SOURCE = 8 * 1024 * 1024;
const MAX_IO = 512 * 1024;
const MAX_STATE = 65536;
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const MENTION_ALL = /[@＠][\s\u200B-\u200D\u2060\uFEFF]*(?:所有人|全体成员|all)(?![\p{L}\p{N}.])/iu;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function error(code) { return Object.assign(Error(code), { code }); }
function timeout(value) { return Number.isInteger(value) && value >= 100 && value <= 120000 ? value : 30000; }
function fileBytes(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw error('invalid_file');
  return fs.readFileSync(file);
}
function jsonFile(file, limit) { return JSON.parse(fileBytes(file, limit).toString('utf8')); }

class JavaScriptPlugins {
  constructor({ dataDir, logger, hostCall, enabled = () => true, maxConcurrent = 2 } = {}) {
    this.root = path.join(dataDir, 'plugins');
    this.logger = logger;
    this.hostCall = hostCall || (async () => { throw error('host_unavailable'); });
    this.enabled = enabled;
    this.workers = new Map();
    this.retiring = new Set();
    this.cache = new Map();
    this.failedUntil = new Map();
    this.started = new Set();
    this.ticks = new Map();
    this.chains = new Map();
    this.active = 0;
    this.waiters = [];
    this.maxConcurrent = Math.max(1, Math.min(8, Number(maxConcurrent) || 2));
    this.closed = false;
  }

  installed() {
    if (!this.enabled()) return [];
    try {
      for (const directory of [path.dirname(this.root), this.root]) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
      }
      return fs.readdirSync(this.root).filter(name => name.endsWith('.flow.json')).sort().flatMap(name => {
        try {
          const id = name.slice(0, -10);
          if (!ID.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) return [];
          fileBytes(path.join(this.root, id + '.enabled'), 64);
          const filename = path.join(this.root, name);
          const stat = fs.lstatSync(filename);
          const signature = [stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino].join(':');
          let cached = this.cache.get(id);
          if (!cached || cached.signature !== signature) {
            const bytes = fileBytes(filename, 64 * 1024 * 1024);
            cached = { signature, flow: JSON.parse(bytes.toString('utf8')),
              hash: crypto.createHash('sha256').update(bytes).digest('hex') };
            if (cached.flow.api === 4) this.cache.set(id, cached);
            while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
          }
          const flow = cached.flow;
          if (flow.id !== id || flow.api !== 4 || !['message', 'tool'].includes(flow.kind)
            || !Array.isArray(flow.hooks) || !flow.hooks.length || flow.hooks.length > HOOKS.length
            || new Set(flow.hooks).size !== flow.hooks.length || flow.hooks.some(h => !HOOKS.includes(h))
            || !Array.isArray(flow.permissions) || flow.permissions.length !== 1 || flow.permissions[0] !== 'system.full'
            || typeof flow.javascript !== 'string' || Buffer.byteLength(flow.javascript) > MAX_SOURCE) return [];
          const grant = jsonFile(path.join(this.root, id + '.flow-grant.json'), 128 * 1024);
          if (grant.hash !== cached.hash || grant.enabled !== true || grant.fullAccess !== true
            || !object(grant.settings || {}) || Buffer.byteLength(JSON.stringify(grant.settings || {})) > MAX_STATE) return [];
          return [{ ...flow, hash: cached.hash, grant: JSON.stringify(grant), settings: grant.settings || {},
            signature, executionTimeoutMs: timeout(flow.executionTimeoutMs) }];
        } catch { return []; }
      }).slice(0, 16);
    } catch { return []; }
  }

  approved(flow) {
    return !this.closed && this.installed().some(p => p.id === flow.id && p.hash === flow.hash && p.grant === flow.grant);
  }
  isApproved(id, hash) { return !this.closed && this.installed().some(p => p.id === id && p.hash === hash); }
  supports(hook) { return this.installed().some(p => p.hooks.includes(hook)); }

  dataDirectory(id) {
    const directory = path.join(this.root, id + '.data');
    fs.mkdirSync(directory, { recursive: true });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('invalid_data_directory');
    return directory;
  }

  worker(flow) {
    const previous = this.workers.get(flow.id);
    if (previous && previous.flow.grant === flow.grant && previous.flow.hash === flow.hash) return previous;
    if (previous) this.terminate(previous, 'grant_changed');
    if (!this.approved(flow)) throw error('grant_revoked');
    const directory = this.dataDirectory(flow.id);
    const child = spawn(process.execPath, ['--max-old-space-size=256', '--unhandled-rejections=strict',
      path.join(__dirname, 'javascriptPluginWorker.js')], {
      cwd: directory, windowsHide: true, detached: process.platform !== 'win32',
      env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '',
        TEMP: process.env.TEMP || '', TMP: process.env.TMP || '', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const record = { child, flow, pending: new Map(), calls: new Map(), sequence: 0, stopped: false, readyReceived: false };
    record.exited = new Promise(resolve => child.once('close', () => {
      clearTimeout(record.killTimer);
      this.retiring.delete(record);
      resolve();
    }));
    record.ready = new Promise((resolve, reject) => { record.resolveReady = resolve; record.rejectReady = reject; });
    // A caller can time out before boot completes; avoid an unhandled rejection.
    record.ready.catch(() => {});
    record.bootTimer = setTimeout(() => this.terminate(record, 'boot_timeout'), 10000);
    child.on('message', message => this.receive(record, message));
    child.once('error', () => this.terminate(record, 'process_error'));
    child.once('exit', () => this.terminate(record, 'process_exit'));
    this.workers.set(flow.id, record);
    child.send({ type: 'init', source: flow.javascript, timeoutMs: flow.executionTimeoutMs,
      paths: { pluginData: directory, appData: path.dirname(this.root), appRoot: path.dirname(path.dirname(this.root)) } }, () => {});
    return record;
  }

  receive(record, message) {
    if (record.stopped || !object(message)) return;
    if (message.type === 'ready') {
      record.readyReceived = true;
      clearTimeout(record.bootTimer);
      record.resolveReady();
    } else if (message.type === 'boot_failed') this.terminate(record, 'plugin_error');
    else if (message.type === 'complete') {
      const pending = record.pending.get(message.id);
      if (!pending) return;
      record.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (!this.approved(record.flow)) pending.reject(error('grant_revoked'));
      else if (!message.ok) pending.reject(error('plugin_error'));
      else {
        try {
          if (Buffer.byteLength(JSON.stringify(message.value)) > MAX_IO) throw error('output_limit');
          pending.resolve(message.value);
        } catch { pending.reject(error('invalid_output')); }
      }
    } else if (message.type === 'call') void this.hostRequest(record, message);
  }

  async hostRequest(record, message) {
    if (!Number.isSafeInteger(message.id) || record.calls.has(message.id)) return this.terminate(record, 'invalid_rpc');
    if (!this.approved(record.flow) || record.calls.size >= 32) return this.respond(record, message.id, { ok: false, code: 'grant_or_call_limit' });
    const pending = message.invocation == null ? null : record.pending.get(message.invocation);
    if (message.invocation != null && !pending) return this.respond(record, message.id, { ok: false, code: 'invocation_expired' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), record.flow.executionTimeoutMs);
    record.calls.set(message.id, controller);
    try {
      if (Buffer.byteLength(JSON.stringify(message.args)) > MAX_IO) throw error('arguments_limit');
      const value = await this.hostCall(message.method, message.args, record.flow, pending?.input || {}, controller.signal);
      if (!this.approved(record.flow) || controller.signal.aborted) throw error('grant_revoked');
      if (Buffer.byteLength(JSON.stringify(value ?? null)) > MAX_IO) throw error('host_result_limit');
      this.respond(record, message.id, { ok: true, value: value ?? null });
    } catch (failure) {
      const code = /^(host_[a-z_]+|grant_revoked|arguments_limit|[A-Z_]+)$/.test(failure.code || '') ? failure.code : 'host_call_failed';
      this.respond(record, message.id, { ok: false, code, status: Number(failure.statusCode || failure.status) || 0 });
    } finally { clearTimeout(timer); record.calls.delete(message.id); }
  }

  respond(record, id, result) {
    if (!record.stopped && record.child.connected) record.child.send({ type: 'response', id, ...result }, () => {});
  }

  terminate(record, code = 'stopped') {
    if (record.stopped) return record.exited;
    record.stopped = true;
    clearTimeout(record.bootTimer);
    record.rejectReady(error(code));
    for (const pending of record.pending.values()) { clearTimeout(pending.timer); pending.reject(error(code)); }
    record.pending.clear();
    for (const controller of record.calls.values()) controller.abort();
    record.calls.clear();
    if (this.workers.get(record.flow.id) === record) this.workers.delete(record.flow.id);
    this.retiring.add(record);
    const child = record.child;
    const kill = () => {
      if (child.exitCode === null && child.pid) {
        if (process.platform === 'win32') {
          execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
            if (child.exitCode === null) child.kill();
          });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
        }
      }
    };
    if (record.readyReceived && child.connected) {
      child.send({ type: 'shutdown', notify: record.flow.hooks.includes('app.stop'),
        input: { api: 4, hook: 'app.stop', now: Date.now(), settings: record.flow.settings, reason: code } }, () => {});
      record.killTimer = setTimeout(kill, 300);
    } else kill();
    return record.exited;
  }

  async slot(deadline) {
    if (this.active < this.maxConcurrent) { this.active += 1; return true; }
    if (deadline <= Date.now() || this.waiters.length >= 32) return false;
    return new Promise(resolve => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      }, deadline - Date.now());
      this.waiters.push(waiter);
    });
  }
  release() {
    const waiter = this.waiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(true); }
    else this.active = Math.max(0, this.active - 1);
  }

  async execute(flow, input) {
    const deadline = Date.now() + flow.executionTimeoutMs;
    const previous = this.chains.get(flow.id) || Promise.resolve();
    const task = previous.then(async () => {
      if (!this.approved(flow) || !await this.slot(deadline)) throw error('grant_or_queue_limit');
      let worker;
      try {
        if (Date.now() >= deadline) throw error('timeout');
        worker = this.worker(flow);
        await Promise.race([worker.ready, new Promise((_, reject) => {
          const timer = setTimeout(() => reject(error('timeout')), Math.max(1, deadline - Date.now()));
          worker.ready.finally(() => clearTimeout(timer)).catch(() => {});
        })]);
        if (!this.approved(flow) || worker.stopped) throw error('grant_revoked');
        if (Buffer.byteLength(JSON.stringify(input)) > MAX_IO) throw error('input_limit');
        const id = ++worker.sequence;
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => this.terminate(worker, 'timeout'), Math.max(1, deadline - Date.now()));
          worker.pending.set(id, { resolve, reject, timer, input });
          worker.child.send({ type: 'invoke', id, input }, failure => { if (failure) this.terminate(worker, 'process_error'); });
        });
      } catch (failure) {
        if (failure.code === 'timeout' && worker) this.terminate(worker, 'timeout');
        throw failure;
      } finally { this.release(); }
    });
    const guard = task.catch(() => {});
    this.chains.set(flow.id, guard);
    try { return await task; }
    finally { if (this.chains.get(flow.id) === guard) this.chains.delete(flow.id); }
  }

  input(flow, hook, context) {
    const key = String(context.key || 'app');
    const file = path.join(this.root, flow.id + '.' + crypto.createHash('sha256').update(key).digest('hex') + '.state.json');
    let state = {};
    try { state = jsonFile(file, MAX_STATE); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    return { file, value: { ...context, api: 4, hook, now: context.now || Date.now(),
      settings: flow.settings, state, key } };
  }

  persist(flow, file, value) {
    if (value === undefined) return;
    if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_STATE) throw error('state_limit');
    if (!fs.existsSync(file) && fs.readdirSync(this.root).filter(name => name.startsWith(flow.id + '.') && name.endsWith('.state.json')).length >= 200)
      throw error('state_limit');
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }

  failed(flow, hook, failure) {
    if (!this.approved(flow)) return;
    this.failedUntil.set(flow.id, Date.now() + 30000);
    const worker = this.workers.get(flow.id);
    if (worker && worker.flow.hash === flow.hash && worker.flow.grant === flow.grant) this.terminate(worker, 'plugin_error');
    const code = ['timeout', 'plugin_error', 'input_limit', 'output_limit', 'state_limit', 'grant_revoked'].includes(failure.code)
      ? failure.code : 'plugin_error';
    this.logger?.warn?.('[plugin] api=4 id=' + flow.id + ' hook=' + hook + ' result=fallback code=' + code);
  }

  async run(hook, context = {}) {
    if (!HOOKS.includes(hook)) throw error('unknown_hook');
    const result = { action: 'pass', text: context.text, system: context.system, search: context.search };
    for (const flow of this.installed().filter(p => p.hooks.includes(hook))) {
      if ((this.failedUntil.get(flow.id) || 0) > Date.now()) continue;
      try {
        const input = this.input(flow, hook, { ...context, text: result.text, system: result.system, search: result.search });
        let output = await this.execute(flow, input.value);
        if (typeof output === 'string') output = { text: output };
        if (!object(output) || Object.keys(output).some(k => !['action', 'text', 'system', 'search', 'state', 'data'].includes(k))) throw error('invalid_output');
        if (output.action !== undefined && (hook !== 'chat.pre_reply' || !['wake', 'skip', 'pass'].includes(output.action))) throw error('invalid_action');
        if (output.text !== undefined && (!['chat.generate', 'chat.reply', 'chat.before_send', 'tool.run'].includes(hook)
          || typeof output.text !== 'string' || output.text.length > 16000 || UNSAFE.test(output.text) || MENTION_ALL.test(output.text))) throw error('invalid_text');
        if (output.system !== undefined && (hook !== 'chat.prompt' || typeof output.system !== 'string'
          || output.system.length > 64000 || UNSAFE.test(output.system))) throw error('invalid_system');
        if (output.search !== undefined && (!['chat.search', 'chat.search_result'].includes(hook)
          || !object(output.search) || !Array.isArray(output.search.items) || output.search.items.length > 30
          || typeof output.search.text !== 'string' || output.search.text.length > 32000)) throw error('invalid_search');
        if (!this.approved(flow)) continue;
        this.persist(flow, input.file, output.state);
        if (output.text !== undefined) result.text = output.text;
        if (output.system !== undefined) result.system = output.system;
        if (output.search !== undefined) result.search = output.search;
        if (output.action && output.action !== 'pass') { result.action = output.action; break; }
      } catch (failure) { this.failed(flow, hook, failure); }
    }
    return result;
  }

  async runTool(id, input) {
    const flow = this.installed().find(p => p.id === id && p.hooks.includes('tool.run'));
    if (!flow) throw error('plugin_not_enabled');
    if ((this.failedUntil.get(id) || 0) > Date.now()) throw error('plugin_cooldown');
    try {
      const state = this.input(flow, 'tool.run', { key: 'tool:' + id, input });
      const output = await this.execute(flow, state.value);
      if (!this.approved(flow)) throw error('grant_revoked');
      if (object(output)) this.persist(flow, state.file, output.state);
      return output;
    } catch (failure) { this.failed(flow, 'tool.run', failure); throw failure; }
  }

  async reconcile() {
    if (this.closed) return;
    const flows = this.installed();
    for (const worker of this.workers.values()) if (!flows.some(p => p.id === worker.flow.id
      && p.hash === worker.flow.hash && p.grant === worker.flow.grant)) this.terminate(worker, 'grant_revoked');
    for (const flow of flows) {
      if ((this.failedUntil.get(flow.id) || 0) > Date.now()) continue;
      const identity = flow.id + ':' + flow.hash + ':' + flow.grant;
      if (!this.started.has(identity) && flow.hooks.includes('app.start')) {
        this.started.add(identity);
        void this.runSingle(flow, 'app.start');
      }
      if (flow.hooks.includes('timer.tick')) {
        const seconds = Number.isInteger(flow.intervalSeconds) && flow.intervalSeconds >= 1 && flow.intervalSeconds <= 86400 ? flow.intervalSeconds : 60;
        const next = this.ticks.get(identity);
        if (next === undefined) this.ticks.set(identity, Date.now() + seconds * 1000);
        else if (Date.now() >= next) {
          this.ticks.set(identity, Date.now() + seconds * 1000);
          if (!this.chains.has(flow.id)) void this.runSingle(flow, 'timer.tick');
        }
      }
    }
    for (const key of this.started) if (!flows.some(p => key === p.id + ':' + p.hash + ':' + p.grant)) this.started.delete(key);
    for (const key of this.ticks.keys()) if (!this.started.has(key) && !flows.some(p => key === p.id + ':' + p.hash + ':' + p.grant)) this.ticks.delete(key);
  }

  async runSingle(flow, hook) {
    if ((this.failedUntil.get(flow.id) || 0) > Date.now()) return;
    try {
      const input = this.input(flow, hook, { key: 'app' });
      const output = await this.execute(flow, input.value);
      if (this.approved(flow) && object(output)) this.persist(flow, input.file, output.state);
    } catch (failure) { this.failed(flow, hook, failure); }
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.reconcile(); }, 500);
    this.timer.unref?.();
    void this.reconcile();
  }
  async stop() {
    if (this.closed) return;
    clearInterval(this.timer);
    this.timer = null;
    this.closed = true;
    for (const worker of [...this.workers.values()]) this.terminate(worker);
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(false); }
    await Promise.allSettled([...this.chains.values()]);
    await Promise.allSettled([...this.retiring].map(record => record.exited));
  }
}

class PluginRuntime {
  constructor(wasm, javascript) { this.wasm = wasm; this.javascript = javascript; }
  supports(hook) { return this.javascript.supports(hook); }
  async run(hook, context = {}) {
    const first = WASM_HOOKS.includes(hook) ? await this.wasm.run(hook, context)
      : { action: 'pass', text: context.text, system: context.system, search: context.search };
    const second = await this.javascript.run(hook, { ...context, ...first });
    return { ...first, ...second, action: second.action === 'pass' ? first.action : second.action };
  }
}

module.exports = { JavaScriptPlugins, PluginRuntime, HOOKS };
