'use strict';

/**
 * 116 号用例的最小本地夹具（不参与 CI 的 `tests/*.test.js` glob）：
 *
 * - `loadPlugin()`：按宿主 worker（src/services/unifiedPluginWorker.js）的方式用
 *   `new Module()._compile()` 载入插件入口，而不是 `require()`。这样市场插件在模块加载时
 *   捕获的 `process.cwd()`（它们把 data 目录当 cwd）落在临时目录，不会写进仓库；
 *   同时也不会被 require 缓存串味，同一份源码可以在不同授权/设置下各载入一次。
 * - `createFakeHost()`：只实现 `host.call(能力名, 输入)` 的宿主替身。它按注册表
 *   `calls[name].inputSchema` 校验输入（真实宿主 invokeHost 也做这一步），未授权的调用
 *   直接以 `host_capability_not_declared` 拒绝，成功时返回符合 `message.submit.output@1`
 *   的排队结果。所有调用都留在 `calls` 里，供用例断言「插件到底要宿主做什么」。
 * - `fakeCoverCli`：市场翻唱插件会把 `cover.mjs` 当 CLI 子进程调用。这里给一条只回 JSON、
 *   不出网、不写文件的假 CLI，让 task.tick/tool.run 能在本机把队列逻辑真跑一遍。
 *
 * 夹具本身不做断言，也不读任何网络/宿主进程。
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const registry = require(path.join(ROOT, 'src', 'services', 'pluginProtocolRegistry.json'));
const { validate } = require(path.join(ROOT, 'src', 'services', 'capabilitySchema'));

const fakeCoverCli = path.join(__dirname, 'fake-cover.js');

const failure = (code, message) => Object.assign(new Error(message || code), { code });

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readManifest(pluginDir) {
  return readJson(path.join(pluginDir, 'plugin.json'));
}

/**
 * 与 unifiedPluginWorker.initialize() 一致的载入方式：独立 Module 实例 + _compile。
 * 市场插件的 STATE_DIR 在模块顶层取 process.cwd()，所以载入期间 cwd 必须先切到夹具目录。
 */
function loadPlugin(pluginDir, { stateDir } = {}) {
  const manifest = readManifest(pluginDir);
  if (manifest.level !== 4 || manifest.runtime !== 'node-full' || manifest.entry !== 'plugin.js') {
    throw failure('fixture_requires_level4', `夹具只支持 4 级 node-full：${pluginDir}`);
  }
  const filename = path.join(pluginDir, manifest.entry);
  const source = fs.readFileSync(filename, 'utf8');
  const cwd = stateDir || path.join(pluginDir, 'data');
  fs.mkdirSync(cwd, { recursive: true });

  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const entry = new Module(filename, module);
    entry.filename = filename;
    entry.paths = Module._nodeModulePaths(pluginDir);
    entry._compile(source, filename);
    return { manifest, source, exports: entry.exports, stateDir: cwd };
  } finally {
    process.chdir(previous);
  }
}

/**
 * 宿主替身。`authorized` 是宿主实际批准（grant）的 calls；不在名单里的能力按
 * 真实宿主的拒绝码 `host_capability_not_declared` 抛错，插件必须自己降级。
 */
function createFakeHost({ authorized = [], settings = {}, state = {} } = {}) {
  const calls = [];
  let delivered = 0;

  const host = Object.freeze({
    async call(name, input) {
      const record = { name, input: input === undefined ? undefined : structuredClone(input) };
      calls.push(record);
      const contract = registry.calls[name];
      if (!contract) {
        record.rejected = 'host_capability_unknown';
        throw failure('host_capability_unknown');
      }
      if (!authorized.includes(name)) {
        record.rejected = 'host_capability_not_declared';
        throw failure('host_capability_not_declared');
      }
      // 真实宿主在 invokeHost 里先校验输入再执行；这里照做，插件发出越界字段会在这里红。
      validate(registry.schemas[contract.inputSchema], input, 'invalid_host_capability_input');
      record.accepted = true;
      delivered++;
      // 与 message.submit.output@1 一致的排队结果（不是「微信已送达」）。
      return { id: `fake-msg-${delivered}`, status: 'queued', confirmed: false };
    },
  });

  return {
    host,
    calls,
    settings,
    state,
    accepted: () => calls.filter(call => call.accepted),
    rejected: () => calls.filter(call => call.rejected),
  };
}

/** worker 交给 provider 的 ctx 形状：Object.freeze({ host, signal, settings, state })。 */
function contextFor(fake, { signal } = {}) {
  return Object.freeze({
    host: fake.host,
    signal: (signal || new AbortController()).signal,
    settings: fake.settings,
    state: fake.state,
  });
}

/** 调用一个已声明的 provider，并按注册表 output schema 校验返回值（宿主会校验）。 */
async function invokeProvider(loaded, capability, input, context) {
  const handler = loaded.exports.providers?.[capability];
  if (typeof handler !== 'function') throw failure('missing_provider', `缺少 provider：${capability}`);
  const output = await handler(input, context);
  const spec = registry.providers[capability];
  if (!spec) throw failure('unknown_provider', capability);
  validate(registry.schemas[spec.outputSchema], output, 'invalid_capability_output');
  return output;
}

module.exports = {
  ROOT,
  registry,
  fakeCoverCli,
  loadPlugin,
  readManifest,
  createFakeHost,
  contextFor,
  invokeProvider,
};
