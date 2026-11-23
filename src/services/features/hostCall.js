'use strict';

/**
 * HTTP 路由 / 桥接调用宿主能力的唯一入口。
 *
 * 生产装配一定有 runtime.capabilities；单元夹具和裁剪装配没有分发器时，
 * 就在这里就地组装同一个 UnifiedCapabilityDispatcher，而不是直接跑 handler ——
 * 否则夹具路径会绕过 schema 校验和错误码，出现两套行为。
 */

const { createFeatureCapabilities } = require('./index');
const { UnifiedCapabilityDispatcher } = require('../unifiedCapabilityDispatcher');

const local = new WeakMap();

function dispatcherFor(runtime) {
  if (runtime && runtime.capabilities && typeof runtime.capabilities.invokeHost === 'function') {
    return runtime.capabilities;
  }
  let dispatcher = local.get(runtime);
  if (!dispatcher) {
    dispatcher = new UnifiedCapabilityDispatcher({ plugins: runtime.plugins || {}, logger: runtime.logger });
    for (const [name, handler] of Object.entries(createFeatureCapabilities(runtime))) {
      dispatcher.defineHost(name, handler);
    }
    local.set(runtime, dispatcher);
  }
  return dispatcher;
}

function hostCall(runtime, name, input) {
  return dispatcherFor(runtime).invokeHost(name, input);
}

/**
 * handler 经 dispatcher 一定是 Promise；这里仍兼容同步返回值，
 * 避免夹具/裁剪装配下路由写出响应时「有时同步、有时异步」。
 */
function respond(value, write) {
  return value && typeof value.then === 'function' ? Promise.resolve(value).then(write) : write(value);
}

module.exports = { hostCall, respond, dispatcherFor };
