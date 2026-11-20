'use strict';

/**
 * 微信模块的公开入口。
 * 账号扫描在 service.js，联系人缓存在 contacts.js；跨模块只从这里拿。
 */
const service = require('./service');
const contacts = require('./contacts');

module.exports = { ...service, ...contacts };
