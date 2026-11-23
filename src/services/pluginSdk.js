'use strict';

/**
 * 插件 SDK 目录（能力清单的唯一派生来源）。
 *
 * pluginProtocolRegistry.json 是唯一事实源；这里只把它翻译成
 * 作者 CLI / 启动器 / 文档都能直接读的扁平行，避免三处各抄一份能力表。
 *
 * 刻意不 require 任何运行时装配（app / features / hostCapabilities），
 * 也不在 server 启动路径上调用：implemented 只有拿到运行中的 runtime 才有意义，
 * 静态导入它不该把功能模块和文件 IO 拖进启动。
 */

const registry = require('./pluginProtocolRegistry.json');

/** levels.4.calls 就是插件可声明的白名单；1–3 级 calls 为空。 */
const PLUGIN_VISIBLE = new Set(registry.levels?.['4']?.calls || []);

function staticRow(name) {
  const spec = registry.calls?.[name] || {};
  return {
    name,
    sideEffect: typeof spec.sideEffect === 'string' ? spec.sideEffect : 'unknown',
    requiresConsent: spec.requiresConsent === true,
    enabled: spec.enabled !== false,
    pluginVisible: PLUGIN_VISIBLE.has(name),
    // 静态清单不知道宿主装了哪些实现：null = 需要 createSdkCatalog(runtime) 才能判断。
    implemented: null,
  };
}

/**
 * 静态能力表：结构完整，但 implemented 恒为 null。
 * 需要真实实现状态（作者 CLI 自检、启动器能力页）时用 createSdkCatalog(runtime)。
 */
const CAPABILITIES = Object.freeze(
  Object.keys(registry.calls || {}).sort().map(name => Object.freeze(staticRow(name))),
);

function hostsOf(runtime) {
  const contracts = runtime?.capabilities?.hostContracts;
  return contracts && typeof contracts.has === 'function' ? contracts : null;
}

/** 运行期目录：同上，但 implemented 取 runtime.capabilities.hostContracts。 */
function createSdkCatalog(runtime) {
  const hosts = hostsOf(runtime);
  return Object.keys(registry.calls || {}).sort()
    .map(name => ({ ...staticRow(name), implemented: Boolean(hosts && hosts.has(name)) }));
}

function missingHosts(runtime) {
  const hosts = hostsOf(runtime);
  return Object.keys(registry.calls || {}).sort()
    .filter(name => registry.calls[name].enabled !== false && !(hosts && hosts.has(name)));
}

/**
 * 自检：注册表里已启用却没有实现的能力必须抛错。
 * 只用于测试与显式启动自检；不要挂到正常启动路径上（缺一项就起不来太脆）。
 */
function assertCatalogueComplete(runtime) {
  const missing = missingHosts(runtime);
  if (missing.length) {
    throw Object.assign(new Error('capability_catalogue_incomplete: ' + missing.join(', ')), {
      code: 'capability_catalogue_incomplete',
      missing,
    });
  }
  return true;
}

module.exports = { CAPABILITIES, createSdkCatalog, assertCatalogueComplete, missingHosts };
