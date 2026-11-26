'use strict';

const Module = require('node:module');
const path = require('node:path');
const { limits } = require('./pluginProtocolRegistry.json');
const MAX_IO = limits.maxInvocationBytes;
let exported, initialized = false, invoked = false;

function json(value) {
  const text = JSON.stringify(value === undefined ? null : value);
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_IO) throw Error('plugin_ipc_limit');
  return JSON.parse(text);
}

function send(message) {
  if (process.connected) process.send(message, failure => { if (failure) process.exit(1); });
}

function initialize({ source, filename }) {
  initialized = true;
  const entry = new Module(filename, module);
  entry.filename = filename;
  entry.paths = Module._nodeModulePaths(path.dirname(filename));
  entry._compile(source, filename);
  exported = entry.exports;
  send({ type: 'ready' });
}

async function invoke({ invocation, capability, input, settings, state }) {
  invoked = true;
  const pending = new Map();
  const controller = new AbortController();
  let sequence = 0;
  let open = true;
  async function call(name, input) {
    if (!open) throw Error('invocation_expired');
    if (pending.size >= limits.maxConcurrentCallsPerInvocation || sequence >= limits.maxCallsPerInvocation) throw Error('host_call_limit');
    if (typeof name !== 'string' || name.length > 64) throw Error('invalid_host_capability');
    const payload = json(input);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: 'call', invocation, id, name, input: payload });
    });
  }
  const onResponse = response => {
    if (response?.invocation !== invocation) return;
    if (response.type === 'cancel') {
      open = false;
      const cancellation = Error('invocation_cancelled');
      controller.abort(cancellation);
      for (const job of pending.values()) job.reject(cancellation);
      pending.clear();
      return;
    }
    if (response.type !== 'response') return;
    const job = pending.get(response.id);
    if (!job) return;
    pending.delete(response.id);
    if (response.ok === true) job.resolve(response.value);
    else job.reject(Object.assign(Error(response.code || 'host_call_failed'), { code: response.code }));
  };
  process.on('message', onResponse);
  let result;
  try {
    const providers = exported?.providers;
    if (!providers || typeof providers !== 'object' || !Object.hasOwn(providers, capability)
      || typeof providers[capability] !== 'function') throw Error('missing_provider');
    const handler = providers[capability];
    const context = Object.freeze({ host: Object.freeze({ call }), signal: controller.signal, settings,
      state: state && typeof state === 'object' && !Array.isArray(state) ? state : {} });
    result = { ok: true, value: json(await handler(input, context)) };
  } catch {
    result = { ok: false };
  } finally {
    open = false;
    process.removeListener('message', onResponse);
  }
  send({ type: 'complete', invocation, ...result });
}

process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init' && !initialized) {
    try { initialize(message); } catch { send({ type: 'boot_failed' }); }
  } else if (message.type === 'invoke' && initialized && !invoked) void invoke(message);
});
process.on('disconnect', () => process.exit(0));
