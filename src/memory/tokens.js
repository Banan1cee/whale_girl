'use strict';

/**
 * 兼容入口：token 估算实现已移到 `src/infra/textBudget.js`，
 * 让 core 层也能共用同一套口径（core 不允许直接依赖 memory）。
 */
module.exports = require('../infra/textBudget');
