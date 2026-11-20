'use strict';

/**
 * 设置模块的公开入口。
 *
 * 目前只有 HTTP 路由（routes/features.js、routes/settings.js、routes/config.js），
 * 没有跨模块服务：设置读写仍在平台层 src/services/settings.js 与 src/infra/configPatch.js，
 * 模块内不另建实例。这里导出空对象，跨模块调用方不要从这里拿平台层的实现。
 *
 * 路由已由本模块 manifest.js 按原 order 注册；这里只作为公开入口占位。
 */
module.exports = {};
