'use strict';

/**
 * 搜索 API 聚合：只有总开关打开、且 provider 出现在列表里时才发请求。
 * 关闭或列表为空时返回 skipped，绝不构造 HTTP 请求。
 */
const { result } = require('../core/result');
const { remaining, errorInfo, report } = require('./transport');
const deepseek = require('./deepseek');
const zhihu = require('./zhihu');
const qwen = require('./qwen');
const quota = require('./quota');

const KNOWN = new Set(['deepseek', 'zhihu', 'qwen']);

function cleanProviders(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((x) => String(x || '').trim().toLowerCase()).filter((x) => KNOWN.has(x)))];
}

async function runOne(provider, { query, text, websearch, dataDir, options, timeoutMs }) {
  const started = Date.now();
  const base = { provider, status: 'ok', elapsedMs: 0 };
  const site = (String(query || '').match(/\bsite:([a-z0-9.-]+)/i) || [])[1] || '';
  // 用户明确限定 B 站/微博等站点时，知乎站内搜索不可能满足，别把无关结果混进来。
  if (provider === 'zhihu' && site && !/(^|\.)zhihu\.com$/i.test(site)) {
    return { ...base, status: 'skipped', code: 'site_mismatch', elapsedMs: 0 };
  }
  if (provider === 'deepseek') {
    const apiKey = String(websearch?.deepseek?.apiKey || '').trim();
    if (!apiKey) return { ...base, status: 'failed', code: 'deepseek_key_missing' };
    const items = await deepseek.search(query, { ...options, timeoutMs, apiKey, oriQuestion: text, count: 10 });
    return { ...base, items, elapsedMs: Date.now() - started };
  }
  if (provider === 'qwen') {
    const cfg = websearch.qwen || {};
    const items = await qwen.search(query, { ...options, ...cfg, timeoutMs });
    return { ...base, items, elapsedMs: Date.now() - started };
  }
  if (provider === 'zhihu') {
    const accessSecret = String(websearch?.zhihu?.accessSecret || '').trim();
    if (!accessSecret) return { ...base, status: 'failed', code: 'zhihu_secret_missing' };
    const limit = Number(websearch?.zhihu?.dailyLimit) || 0;
    if (!quota.available(dataDir, 'zhihu', limit)) {
      return { ...base, status: 'skipped', code: 'quota_exceeded', elapsedMs: Date.now() - started };
    }
    quota.consume(dataDir, 'zhihu');
    const q = String(query || '').replace(/\bsite:[a-z0-9.-]+/gi, '').trim();
    const items = await zhihu.search(q, { ...options, timeoutMs, accessSecret, count: 10 });
    return { ...base, items, elapsedMs: Date.now() - started };
  }
  return { ...base, status: 'skipped', code: 'unknown_provider', elapsedMs: Date.now() - started };
}

async function apiSearch({ query, text = '', websearch = {}, dataDir = 'data', deadline, signal, timeoutMs, trace } = {}) {
  const api = websearch.api || {};
  if (api.enabled !== true) return result([], { status: 'skipped', reason: 'api_disabled' });
  const providers = cleanProviders(api.providers);
  if (!providers.length) return result([], { status: 'skipped', reason: 'api_empty' });

  const started = Date.now();
  const options = { deadline, signal, timeoutMs: remaining({ timeoutMs, deadline }) };
  const settled = await Promise.allSettled(providers.map((provider) => runOne(provider, {
    query, text, websearch, dataDir, options, timeoutMs: options.timeoutMs,
  })));

  const items = [];
  const attempts = [];
  const seen = new Set();
  settled.forEach((out, index) => {
    const provider = providers[index];
    if (out.status === 'fulfilled') {
      const value = out.value;
      attempts.push({
        provider,
        status: value.status,
        selected: (value.items || []).length,
        code: value.code || '',
        elapsedMs: value.elapsedMs,
      });
      report(trace, 'api', { provider, status: value.status, count: (value.items || []).length });
      for (const item of value.items || []) {
        if (!item?.url || seen.has(item.url)) continue;
        seen.add(item.url);
        items.push(item);
      }
    } else {
      const info = errorInfo(out.reason);
      attempts.push({ provider, status: 'failed', code: info.code, error: info, elapsedMs: Date.now() - started });
      report(trace, 'api_failed', { provider, ...info });
    }
  });

  const status = items.length ? 'ok' : attempts.every((a) => a.status !== 'failed') ? 'empty' : 'failed';
  const reason = items.length ? 'available'
    : attempts.some((a) => a.code === 'quota_exceeded') ? 'quota_exceeded'
      : attempts.every((a) => a.status === 'failed') ? attempts[0]?.code || 'api_failed'
        : 'no_results';
  return result(items, { status, reason, attempts, elapsedMs: Date.now() - started });
}

module.exports = { apiSearch, cleanProviders };
