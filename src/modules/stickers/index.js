'use strict';

/**
 * 表情包模块的公开入口。
 * 组合根（src/app.js）只从这里拿 StickerService；
 * 路由需要的 adapters 辅助函数留在 routes.js 内部，不扩大公开面。
 */
const { StickerService } = require('./service');
const manifest = require('./manifest');

module.exports = { StickerService, create: manifest.create };
