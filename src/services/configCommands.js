'use strict';

const features = require('../infra/features');
const { parseBoolean, parseNumber } = require('../infra/configValues');
const { applyConfigPatch } = require('../infra/configPatch');
const own = (body, key) => Object.prototype.hasOwnProperty.call(body || {}, key);

function prepareFeatureCommand(body) {
  const key = String((body && body.key) || '').trim();
  const entry = features.REGISTRY.find(item => item.key === key);
  if (!entry) throw Object.assign(new Error('没有这个开关：' + key), { statusCode: 400 });
  const value = parseBoolean(body.value);
  if (value === undefined) throw Object.assign(new Error('功能开关值无效'), { statusCode: 400 });
  return { key, entry, value, patch: { [entry.path]: value } };
}

/**
 * 功能开关：在线路由和离线保存共用「校验 → 落盘 → 热重载」。
 * 入口只决定响应形状，不各拼一套 patch。
 */
function applyFeatureToggle(runtime, body) {
  const { key, entry, value, patch } = prepareFeatureCommand(body);
  applyConfigPatch(runtime, patch);
  runtime.logger?.info?.(`功能开关 ${entry.label} → ${value ? '开' : '关'}`);
  return { key, entry, value };
}

function momentsSettings(config) {
  const m = config.moments || {};
  return { ok: true, autoLike: features.toBool(m.autoLike, false),
    autoLikeMaxPerDay: parseNumber(m.autoLikeMaxPerDay) ?? 0,
    autoReadEveryHours: parseNumber(m.autoReadEveryHours) ?? 0 };
}

/**
 * 朋友圈基础设置：在线设置页和离线保存共用字段清单与「空白不等于零」这条规则。
 *
 * 两侧对其它边界输入的既有口径本来就不同（在线设置页只收布尔/数字，离线保存把
 * 提交值原样交给 configPatch 校验），这里用 mode 显式保留，不互相改写：
 * - mode='online'：沿用设置页的类型过滤；空白数字直接拒绝，不能因 Number('') === 0
 *   被静默写成 0（显式 0 仍然保留）。
 * - mode='offline'（默认）：只挑本次提交的自有字段，类型/空白交给 configPatch 统一校验。
 */
function prepareMomentsSettingsPatch(body, { mode = 'offline' } = {}) {
  const patch = {};
  if (mode === 'online') {
    const source = body || {};
    if (typeof source.autoLike === 'boolean') patch['moments.autoLike'] = source.autoLike;
    for (const key of ['autoLikeMaxPerDay', 'autoReadEveryHours']) {
      if (source[key] === undefined) continue;
      if (typeof source[key] === 'string' && !source[key].trim()) {
        // 和 configPatch 对空白数字的既有拒绝保持同一文案/状态码。
        throw Object.assign(new Error('「moments.' + key + '」要填数字'), { statusCode: 400 });
      }
      patch['moments.' + key] = Number(source[key]);
    }
    return patch;
  }
  for (const key of ['autoLike', 'autoLikeMaxPerDay', 'autoReadEveryHours']) {
    if (own(body, key)) patch['moments.' + key] = body[key];
  }
  return patch;
}

/**
 * 把朋友圈基础设置写盘并热重载；在线/离线只有响应形状不同，写操作共用这一份。
 * 朋友圈重排由 reloadRuntimeConfig 统一调度（configPatch.js），这里不重复调 startAutoRead。
 */
function applyMomentsSettings(runtime, patch) {
  const pending = patch || {};
  if (Object.keys(pending).length) applyConfigPatch(runtime, pending);
  return pending;
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

module.exports = {
  prepareFeatureCommand,
  applyFeatureToggle,
  momentsSettings,
  prepareMomentsSettingsPatch,
  applyMomentsSettings,
  prepareMomentsPublishPatch,
};
