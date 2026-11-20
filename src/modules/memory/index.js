'use strict';

/**
 * 记忆模块的公开入口。
 *
 * 目前只有 HTTP 路由（routes.js），没有跨模块服务：记忆读写仍在平台层
 * src/memory/，模块内不另建实例。这里导出空对象，跨模块调用方不要从这里
 * 拿平台库的实现。
 */
module.exports = {};
