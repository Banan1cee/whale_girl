'use strict';

const fs = require('node:fs');
const path = require('node:path');

function safeLink(value, allowLocal = false) {
  if (typeof value !== 'string') return false;
  if (allowLocal && /^(?:plugins|downloads|team|support)\/$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

function validateSupport(config, site) {
  if (!config || !['title', 'lead', 'message'].every(key => typeof config[key] === 'string' && config[key].trim())
    || !Array.isArray(config.channels) || !Array.isArray(config.contributions) || !Array.isArray(config.faq)) throw new Error('支持页面配置无效');
  if (!safeLink(config.contactUrl)) throw new Error('支持联系链接无效');
  const rootKeys = new Set(['title', 'lead', 'message', 'defaultChannel', 'contactUrl', 'channels', 'contributions', 'faq']);
  if (Object.keys(config).some(key => !rootKeys.has(key))) throw new Error('支持配置包含未定义字段');
  const ids = new Set();
  for (const channel of config.channels) {
    const keys = new Set(['id', 'name', 'type', 'url', 'image', 'description', 'button', 'instructions', 'enabled', 'order']);
    if (Object.keys(channel).some(key => !keys.has(key))) throw new Error('支持渠道包含未定义字段');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(channel.id) || ids.has(channel.id)) throw new Error('支持渠道 ID 无效或重复');
    ids.add(channel.id);
    if (!['link', 'qrcode'].includes(channel.type) || typeof channel.enabled !== 'boolean'
      || !Number.isSafeInteger(channel.order) || channel.order < 0
      || !['name', 'description', 'button'].every(key => typeof channel[key] === 'string' && channel[key].trim())
      || (channel.instructions !== undefined && typeof channel.instructions !== 'string')) throw new Error(`支持渠道配置无效：${channel.id}`);
    if ((channel.type === 'link' || channel.url) && !safeLink(channel.url)) throw new Error(`支持渠道链接无效：${channel.id}`);
    if (channel.type === 'qrcode') {
      if (!/^images\/support\/[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|webp)$/.test(channel.image || '')
        || !fs.existsSync(path.join(site, channel.image))) throw new Error(`支持渠道二维码文件无效：${channel.id}`);
    }
  }
  if (!ids.has(config.defaultChannel)) throw new Error('默认公示渠道未在支持配置中登记');
  for (const item of config.contributions) {
    if (!['title', 'description', 'button'].every(key => typeof item[key] === 'string' && item[key].trim())
      || !safeLink(item.url, true)) throw new Error('非资金支持方式或链接无效');
  }
  if (config.faq.some(item => typeof item.question !== 'string' || typeof item.answer !== 'string')) throw new Error('支持页面常见问题格式无效');
  return { ...config, channels: [...config.channels].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) };
}

module.exports = { validateSupport };
