'use strict';

// 单向 shim：pipeline/chat.js 仍从这里取 search；实现已迁到 modules/search。
module.exports = require('../modules/search');
