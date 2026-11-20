'use strict';

/**
 * 主动搭话（care）模块的公开入口。
 * 判定/白名单在 service.js，文案生成在 careChat.js；跨模块只从这里拿。
 */
const service = require('./service');
const { careForChat } = require('./careChat');

module.exports = { ...service, careForChat };
