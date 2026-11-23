'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const registry = require('./pluginProtocolRegistry.json');
const { validateSettings } = require('./capabilitySchema');
const { validateProviderInterval } = require('./pluginProtocol');

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

function acceptedProviders(manifest) {
  if (!object(manifest) || Object.keys(manifest).some(key => !manifestPolicy.allowed.includes(key))
    || manifestPolicy.required.some(key => !Object.hasOwn(manifest, key))
    || manifest.format !== registry.format || !Number.isInteger(manifest.level) || !registry.levels[manifest.level]
    || manifest.runtime !== registry.levels[manifest.level]?.runtime || manifest.entry !== registry.levels[manifest.level]?.entry
    || !validTitle(manifest.name, manifestPolicy.maxNameLength) || !validTitle(manifest.author, manifestPolicy.maxAuthorLength)
    || typeof manifest.description !== 'string' || manifest.description.length > manifestPolicy.maxDescriptionLength
    || !validAppCompatibility(manifest) || !object(manifest.provides)
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
      const allowedData = Object.hasOwn(declared, 'chat.reply@1') ? policy.dataAccess || [] : [];
      if (!listAllowed(dataAccess, allowedData) || !listAllowed(grantedData, dataAccess)
        || grantedData.length !== dataAccess.length) return null;
      const full = manifest.level === 4;
      if (grant.fullAccess !== full || grant.nodeFullConfirmed !== full
        || !listAllowed(manifest.calls, policy.calls)
        || !listAllowed(grant.approvedProviders, Object.keys(declared))
        || !listAllowed(grant.approvedCalls, manifest.calls.filter(name => registry.calls[name].enabled !== false))
        || manifest.level === 3 && grant.approvedProviders.includes('chat.reply@1') && grant.chatConfirmed !== true) return null;
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
        dataAccess: grantedData.slice(),
        authRevision: digest(rawGrant), source: full ? decoder.decode(rawEntry) : rawEntry.toString('base64'), filename, pluginData };
    } catch { return null; }
  }

  installed() {
    if (this.closed || !this.enabled()) return [];
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
      return result;
    } catch { return []; }
  }

  current(flow) {
    const fresh = this.read(flow?.id);
    if (!fresh || fresh.packageHash !== (flow.packageHash ?? flow.hash) || fresh.epoch !== flow.epoch) return null;
    return fresh.authRevision === flow.authRevision ? fresh : null;
  }

  isApproved(flow) { return Boolean(this.current(flow)); }

  isApprovedIdHash(id, packageHash) {
    return typeof packageHash === 'string' && HASH.test(packageHash) && this.read(id)?.packageHash === packageHash;
  }

  async invoke(flow, capability, input, { signal, deadline } = {}) {
    const invokedAt = Date.now();
    if (signal?.aborted) throw error('capability_aborted');
    const approved = this.current(flow);
    if (!approved) throw error('grant_revoked');
    if (!approved.hooks.includes(capability)) throw error('capability_not_declared');
    if (deadline !== undefined && !Number.isFinite(deadline)) throw error('invalid_deadline');
    deadline = Math.min(deadline ?? Infinity, invokedAt + approved.executionTimeoutMs);
    if (Date.now() >= deadline) throw error('capability_timeout');
    if (this.waiting.size >= MAX_WAITING) throw error('plugin_queue_limit');
    let projected = input;
    if (capability === 'chat.reply@1' && object(input)) {
      // 同轮提供者共享草稿，但历史和系统提示词只能按这次调用的目标授权发送。
      const { history, system, ...draft } = input;
      if (approved.dataAccess.includes('chat.history') && history !== undefined) draft.history = history;
      if (approved.dataAccess.includes('model.prompt') && system !== undefined) draft.system = system;
      projected = draft;
    }
    const payload = wire(projected, 'input_limit');
    return new Promise((resolve, reject) => {
      const job = { invocation: randomUUID(), flow: approved, capability, payload, deadline, signal,
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

  spawn(job) {
    const { filename, pluginData } = job.flow;
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
    this.send(job, { type: 'init', source: job.flow.source, filename, level: job.flow.level });
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
        this.send(job, { type: 'invoke', invocation: job.invocation, capability: job.capability, input: job.payload, settings: job.flow.settings });
      } else if (message.type === 'boot_failed' && !job.running) {
        this.finish(job, error('plugin_error'));
      } else if (job.running && message.invocation === job.invocation && message.type === 'complete') {
        if (message.ok === true) this.finish(job, null, wire(message.value, 'output_limit'));
        else this.finish(job, error('plugin_error'));
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
      clearInterval(this.timer);
      for (const job of [...this.waiting, ...this.workers.values()]) this.finish(job, error('plugin_runtime_stopped'));
    }
    await Promise.allSettled([...this.workers.values()].map(job => job.exited));
  }
}

module.exports = { UnifiedPluginRuntime, PROVIDER_CAPABILITIES, HOST_CAPABILITIES };
