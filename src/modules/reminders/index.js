'use strict';

/**
 * 提醒模块的公开入口。
 * 组合根只从这里拿服务实现，状态机细节留在 service.js。
 */
const { ReminderService, normalizeRules, RETRY_DELAY_MS, CLAIM_TIMEOUT_MS, MAX_TOTAL, MAX_ACTIVE_PER_CHAT } = require('./service');
const manifest = require('./manifest');

module.exports = {
  ReminderService,
  normalizeRules,
  RETRY_DELAY_MS,
  CLAIM_TIMEOUT_MS,
  MAX_TOTAL,
  MAX_ACTIVE_PER_CHAT,
  create: manifest.create,
};
