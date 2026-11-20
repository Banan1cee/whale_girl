'use strict';

const features = require('../../infra/features');
const { parseNumber } = require('../../infra/configValues');

const own = (body, key) => Object.prototype.hasOwnProperty.call(body || {}, key);

/**
 * 朋友圈专用配置命令：离线启动器（launcherSnapshot）与在线路由共用。
 * 只做「请求体 → 配置补丁」的纯转换，不读文件、不碰 runtime。
 */
function momentsSettings(config) {
  const m = config.moments || {};
  return { ok: true, autoLike: features.toBool(m.autoLike, false),
    autoLikeMaxPerDay: parseNumber(m.autoLikeMaxPerDay) ?? 0,
    autoReadEveryHours: parseNumber(m.autoReadEveryHours) ?? 0 };
}

function prepareMomentsSettingsPatch(body) {
  const patch = {};
  for (const key of ['autoLike', 'autoLikeMaxPerDay', 'autoReadEveryHours']) {
    if (own(body, key)) patch['moments.' + key] = body[key];
  }
  return patch;
}

function prepareMomentsPublishPatch(body, current = {}) {
  const patch = {};
  // 发表授权仍要求显式布尔确认；缺失字段只保留原值，不能伪造账号或桥接确认。
  const featureEnabled = own(body, 'featureEnabled') ? body.featureEnabled === true : current.featureEnabled === true;
  if (own(body, 'featureEnabled')) patch['moments.publishFeatureEnabled'] = featureEnabled;
  if (own(body, 'enabled') || (own(body, 'featureEnabled') && !featureEnabled)) {
    patch['moments.publishEnabled'] = featureEnabled && body.enabled === true;
  }
  if (own(body, 'withImage')) patch['moments.publishWithImage'] = body.withImage === true;
  if (own(body, 'interval')) patch['moments.publishIntervalHours'] = body.interval;
  if (own(body, 'maxPerDay')) patch['moments.publishMaxPerDay'] = body.maxPerDay;
  return patch;
}

module.exports = { momentsSettings, prepareMomentsSettingsPatch, prepareMomentsPublishPatch };
