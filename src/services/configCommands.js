'use strict';

const features = require('../infra/features');
const { parseBoolean } = require('../infra/configValues');
// 朋友圈配置命令随朋友圈路由一起迁到模块；这里保留旧入口，离线启动器不用改。
const { momentsSettings, prepareMomentsSettingsPatch, prepareMomentsPublishPatch } = require('../modules/moments');

function prepareFeatureCommand(body) {
  const key = String((body && body.key) || '').trim();
  const entry = features.REGISTRY.find(item => item.key === key);
  if (!entry) throw Object.assign(new Error('没有这个开关：' + key), { statusCode: 400 });
  const value = parseBoolean(body.value);
  if (value === undefined) throw Object.assign(new Error('功能开关值无效'), { statusCode: 400 });
  return { key, entry, value, patch: { [entry.path]: value } };
}

module.exports = { prepareFeatureCommand, momentsSettings, prepareMomentsSettingsPatch, prepareMomentsPublishPatch };
