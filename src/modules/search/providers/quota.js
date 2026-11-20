'use strict';

/**
 * 搜索 API 的本地每日计数。
 *
 * 为什么不用官方额度做闸门：知乎的 /api/v1/quota 需要额外请求，失败时不能
 * 让搜索停摆；DeepSeek 也没有免费额度可查。本地计数是保守保护：到达上限就
 * 不再发业务请求，只留本地搜索。
 */
const fs = require('node:fs');
const path = require('node:path');
const time = require('../../../infra/time');

function today() {
  const p = time.parts(Date.now(), 'Asia/Shanghai');
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function fileOf(dataDir) {
  return path.join(dataDir || 'data', 'search-quota.json');
}

function read(dataDir) {
  const file = fileOf(dataDir);
  let value = null;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch { /* 首次运行或文件坏了：从空计数开始 */ }
  const date = today();
  if (!value || typeof value !== 'object' || value.date !== date || typeof value.counts !== 'object') {
    return { date, counts: {} };
  }
  return { date, counts: { ...value.counts } };
}

function write(dataDir, value) {
  const file = fileOf(dataDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 计数写不进去不该让搜索失败；最坏是当天多调几次 */ }
}

function used(dataDir, provider) {
  const value = read(dataDir);
  return Number(value.counts[provider]) || 0;
}

function available(dataDir, provider, limit) {
  const cap = Number(limit) || 0;
  if (cap <= 0) return true;
  return used(dataDir, provider) < cap;
}

/** 发请求前先占位：失败/超时也算一次，避免连续失败时无限重试。 */
function consume(dataDir, provider) {
  const value = read(dataDir);
  value.counts[provider] = (Number(value.counts[provider]) || 0) + 1;
  write(dataDir, value);
  return value.counts[provider];
}

module.exports = { today, read, used, available, consume };
