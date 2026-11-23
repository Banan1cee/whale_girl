'use strict';

/**
 * 功能能力的唯一装配点。
 *
 * 每个领域模块导出 create(runtime, deps) → { '能力名': handler }。
 * 能力名必须已登记在 pluginProtocolRegistry.json 的 calls 里，
 * 否则 UnifiedCapabilityDispatcher.defineHost 会直接拒绝（拼写错误不会静默失效）。
 *
 * 新增功能的标准做法：
 *   1. 注册表加 calls 条目（要开放给插件再进 levels.4.calls）；
 *   2. 在对应领域模块加 handler；
 *   3. 路由/桥接/插件 SDK 都调用 runtime.capabilities.invokeHost(能力名, 输入)。
 */

const core = require('./core');
const reminders = require('./reminders');
const stickers = require('./stickers');
const diary = require('./diary');
const digest = require('./digest');
const moments = require('./moments');
const contacts = require('./contacts');
const personaSettings = require('./personaSettings');
const memory = require('./memory');
const message = require('./message');

// 顺序固定，便于排查；同名能力重复登记时 dispatcher 会抛 invalid_capability_contract。
const MODULES = [core, reminders, stickers, diary, digest, moments, contacts, personaSettings, memory, message];

function createFeatureCapabilities(runtime, dependencies = {}) {
  const handlers = {};
  for (const module of MODULES) {
    for (const [name, handler] of Object.entries(module.create(runtime, dependencies))) {
      if (typeof handler !== 'function') throw new Error(`功能能力实现不是函数：${name}`);
      if (Object.hasOwn(handlers, name)) throw new Error(`功能能力重复实现：${name}`);
      handlers[name] = handler;
    }
  }
  return handlers;
}

module.exports = { createFeatureCapabilities, MODULES };
