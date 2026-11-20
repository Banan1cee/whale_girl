'use strict';

/**
 * 人设模块的公开入口。
 * 人设调教 / 预设管理在 service.js，HTTP 路由在 routes.js。
 * 旧路径 src/services/persona.js 与这里指向同一个对象；跨模块调用只从这里拿。
 */
module.exports = require('./service');
