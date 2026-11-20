'use strict';

/**
 * 消息汇总模块的公开入口。
 * 组合根（src/app.js）只从这里拿 create；服务实现和路由细节留在模块内部。
 */
const manifest = require('./manifest');
const { DigestService, rangeWindow, dayKey } = require('./service');

function create(runtime, deps = {}) {
  return manifest.create(runtime, {
    store: deps.store || runtime.store,
    logger: deps.logger || runtime.logger,
  });
}

module.exports = { DigestService, rangeWindow, dayKey, create };
