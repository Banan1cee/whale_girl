'use strict';

/**
 * 调试模块的公开入口。
 *
 * 目前只有 HTTP 路由（routes.js），没有跨模块服务：调试快照与会话列表仍在平台层
 * src/services/debug.js，模块内不另建实例。这里导出空对象，跨模块调用方不要从这里
 * 拿平台层的实现。
 *
 * 路由已由本模块 manifest.js 按原 order 注册；这里只作为公开入口占位。
 */
module.exports = {};
