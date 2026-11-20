'use strict';

// Api 4 is trusted native JavaScript, NOT a vm/security sandbox. Its source is
// loaded only after the launcher recorded full-access consent for this hash.
const { createRequire } = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const calls = new Map();
const current = new AsyncLocalStorage();
let settings, exported, sdk, initialized = false, sequence = 0;
const MAX_MESSAGE = 512 * 1024;

function send(value) {
  if (!process.connected) return;
  try { process.send(value, () => {}); } catch { /* parent has exited */ }
}

function call(method, args) {
  if (calls.size >= 32) return Promise.reject(Error('host_call_limit'));
  let size;
  try { size = Buffer.byteLength(JSON.stringify(args ?? null)); } catch { return Promise.reject(Error('invalid_host_arguments')); }
  if (size > MAX_MESSAGE) return Promise.reject(Error('host_arguments_limit'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      calls.delete(id);
      reject(Error('host_timeout'));
    }, settings.timeoutMs + 1000);
    calls.set(id, { resolve, reject, timer });
    send({ type: 'call', id, invocation: current.getStore()?.id || null, method, args });
  });
}

function createSdk() {
  return Object.freeze({
    api: (url, options = {}) => call('api', { url, ...options }),
    capabilities: () => call('capabilities', {}),
    search: (query, options = {}) => call('search', { query, ...options }),
    model: options => call('model', options),
    send: options => call('send', options),
    sendText: (chatId, text, options = {}) => call('send', { ...options, chatId, text, type: 'text' }),
    sendVoice: (chatId, text, options = {}) => call('send', { ...options, chatId, text, type: 'voice' }),
    sendImage: (chatId, file, options = {}) => call('send', { ...options, chatId, file, type: 'image' }),
    delivery: id => call('delivery', { id }),
    paths: Object.freeze({ ...settings.paths }),
    get context() { return current.getStore()?.input || null; },
  });
}

function initialize(message) {
  if (initialized) throw Error('already_initialized');
  initialized = true;
  settings = message;
  sdk = createSdk();
  const filename = path.join(settings.paths.pluginData, 'plugin.js');
  // Bun 的 Module 实例没有 Node 的 .require / ._compile，所以自己拼 CommonJS 外壳。
  // createRequire 同时负责相对路径与 node: 内置模块，Node 下与原来的 entry.require 等价。
  const nativeRequire = createRequire(filename);
  const pluginRequire = name => name === 'whale' ? sdk : nativeRequire(name);
  // 保留 require.resolve / cache / main，插件按 Node 习惯用它们时不至于突然 undefined。
  pluginRequire.resolve = (request, options) => nativeRequire.resolve(request, options);
  pluginRequire.cache = nativeRequire.cache;
  pluginRequire.main = nativeRequire.main;
  pluginRequire.extensions = nativeRequire.extensions;
  const pluginModule = {
    id: filename,
    filename,
    path: settings.paths.pluginData,
    exports: {},
    loaded: false,
    children: [],
    parent: module,
    paths: [],
  };
  const source = String(message.source || '')
    .replace(/^\uFEFF/, '')
    .replace(/^#![^\n]*\n?/, '');
  const wrapper = new Function('require', 'module', 'exports', '__filename', '__dirname', source);
  wrapper.call(pluginModule.exports, pluginRequire, pluginModule, pluginModule.exports,
    filename, settings.paths.pluginData);
  pluginModule.loaded = true;
  exported = pluginModule.exports;
  send({ type: 'ready' });
}

async function invoke(message) {
  const input = message.input;
  try {
    const hooks = exported && typeof exported === 'object' ? exported.hooks : null;
    const fn = hooks?.[input.hook] || exported?.[input.hook]
      || (input.hook === 'app.start' && exported?.activate)
      || (input.hook === 'app.stop' && exported?.deactivate)
      || (input.hook === 'tool.run' && exported?.run)
      || (typeof exported === 'function' ? exported : exported?.onHook);
    let value = typeof fn === 'function'
      ? await current.run({ id: message.id, input }, () => fn({ ...input, whale: sdk, host: sdk })) : {};
    if (value === undefined) value = {};
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_MESSAGE) throw Error('output_limit');
    send({ type: 'complete', id: message.id, ok: true, value });
  } catch {
    // Raw plugin exceptions can contain messages, credentials or provider bodies.
    send({ type: 'complete', id: message.id, ok: false, code: 'plugin_error' });
  }
}

process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') {
    try { initialize(message); } catch { send({ type: 'boot_failed' }); process.exitCode = 1; process.disconnect(); }
  } else if (message.type === 'invoke' && initialized) {
    void invoke(message);
  } else if (message.type === 'shutdown') {
    void (async () => {
      try {
        const fn = exported?.hooks?.['app.stop'] || exported?.['app.stop'] || exported?.deactivate;
        if (message.notify && typeof fn === 'function') await fn({ ...message.input, whale: sdk, host: sdk });
      } catch { /* stopping must not keep the host alive */ }
      process.exit(0);
    })();
  } else if (message.type === 'response') {
    const pending = calls.get(message.id);
    if (!pending) return;
    calls.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(Object.assign(Error(message.code || 'host_call_failed'), { code: message.code, status: message.status }));
  }
});
process.on('disconnect', () => process.exit(0));
