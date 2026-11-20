'use strict';

/**
 * 对话预算模块的公开入口。
 *
 * 目前只有 HTTP 路由（routes.js），没有跨模块服务：估算逻辑仍在平台层
 * src/services/budget.js。这里导出空对象，跨模块调用方不要从这里拿估算实现；
 * 路由注册由组合根按原 order 接入。
 */
module.exports = {};
