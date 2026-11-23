'use strict';

/**
 * 插件 SDK 的宿主能力门面。
 *
 * 实现已经迁到 src/services/features/*，与宿主内部（HTTP 路由、桥接、定时任务）
 * 共用同一条 UnifiedCapabilityDispatcher.invokeHost。这里只做转发，
 * 保证 PluginHost / hostCall 的老调用方式不变。
 *
 * 没有注入 runtime.capabilities 的场景（单元夹具、裁剪装配）就地组一个
 * 只含宿主能力的 dispatcher，校验与授权路径仍是同一份代码，不会出现两套行为。
 */

const { UnifiedCapabilityDispatcher } = require('./unifiedCapabilityDispatcher');
const { createFeatureCapabilities } = require('./features');

function localDispatcher(runtime, dependencies) {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: runtime.plugins, logger: runtime.logger });
  for (const [name, handler] of Object.entries(createFeatureCapabilities(runtime, dependencies))) {
    dispatcher.defineHost(name, handler);
  }
  return dispatcher;
}

function createHostCapabilities(runtime, dependencies = {}) {
  const dispatcher = typeof runtime.capabilities?.invokeHost === 'function'
    ? runtime.capabilities
    : localDispatcher(runtime, dependencies);

  async function call(name, input, plugin, { signal, deadline } = {}) {
    return dispatcher.invokeHost(name, input, { plugin, signal, deadline });
  }
  return Object.freeze({ call });
}

module.exports = { createHostCapabilities };
