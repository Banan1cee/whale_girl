'use strict';

/**
 * 日记模块的公开入口。
 * 组合根只从这里拿服务实现，文件读写细节留在 service.js。
 */
const { DiaryService, dayKey } = require('./service');

module.exports = { DiaryService, dayKey };
