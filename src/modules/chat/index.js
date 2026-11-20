'use strict';

/**
 * 聊天模块的公开入口。
 *
 * 目前只有 HTTP 路由（routes.js），没有跨模块服务：对话管线仍在平台层
 * src/pipeline/ 与 src/services/chat.js。这里导出空对象，跨模块调用方不要
 * 从这里拿管线实现；路由注册由组合根按原 order 接入。
 */
module.exports = {};
