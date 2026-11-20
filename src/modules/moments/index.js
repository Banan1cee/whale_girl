'use strict';

/**
 * 朋友圈模块的公开入口。
 * 读取/互动在 service.js，定时发表与草稿生成在 publisher.js。
 */
const { MomentsService } = require('./service');
const { MomentsPublisher, parseDraft } = require('./publisher');
const { momentsSettings, prepareMomentsSettingsPatch, prepareMomentsPublishPatch } = require('./config');

module.exports = {
  MomentsService,
  MomentsPublisher,
  parseDraft,
  momentsSettings,
  prepareMomentsSettingsPatch,
  prepareMomentsPublishPatch,
};
