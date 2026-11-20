'use strict';

/**
 * 插件模块的公开入口。
 *
 * 目前只有 HTTP 路由（routes.js），没有跨模块服务：JavaScript 插件宿主仍在
 * src/services/javascriptPlugins.js。这里导出空对象，跨模块调用方不要从这里
 * 拿宿主实现；路由注册由组合根按原 order 接入。
 */
module.exports = {};
