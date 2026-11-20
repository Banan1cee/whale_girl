'use strict';

/**
 * 知乎开放平台站内搜索（GET /api/v1/content/zhihu_search）。
 *
 * 鉴权是 Bearer Access Secret + 秒级 X-Request-Timestamp。
 * 官方返回 Code/Message/Data.Items，字段是 PascalCase；这里统一转成项目结果协议。
 */
const { getJson, searchError } = require('./transport');
const { stripTags } = require('../../../adapters/search/html');

const BASE_URL = 'https://developer.zhihu.com';
const MAX_COUNT = 10;

function timeOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 官方是秒级时间戳；兼容误传毫秒的旧数据。
  const ms = n > 1e12 ? n : n * 1000;
  return new Date(ms).toISOString();
}

function mapItem(row, fetchedAt) {
  const url = String(row?.Url || '').trim();
  const title = String(row?.Title || '').trim();
  if (!url || !title) return null;
  return {
    title,
    url,
    snippet: stripTags(String(row?.ContentText || '')).slice(0, 800),
    provider: 'zhihu',
    fetchedAt,
    publishedAt: timeOf(row?.EditTime),
    contentType: String(row?.ContentType || ''),
    author: String(row?.AuthorName || ''),
    voteUp: Number(row?.VoteUpCount) || 0,
    commentCount: Number(row?.CommentCount) || 0,
    authority: Number(row?.AuthorityLevel) || 0,
    rankingScore: Number(row?.RankingScore) || 0,
  };
}

function codeError(code, status) {
  const n = Number(code) || 0;
  if (n === 20001) return searchError('zhihu_auth', status);
  if (n === 30001) return searchError('zhihu_rate_limit', status);
  if (n === 10001) return searchError('zhihu_invalid_request', status);
  return searchError('zhihu_error', status);
}

async function search(query, opts = {}) {
  const secret = String(opts.accessSecret || '').trim();
  if (!secret) throw searchError('zhihu_secret_missing');
  const q = String(query || '').trim();
  if (!q) return [];
  const count = Math.max(1, Math.min(MAX_COUNT, Number(opts.count) || MAX_COUNT));
  const url = BASE_URL + '/api/v1/content/zhihu_search?Query=' + encodeURIComponent(q) + '&Count=' + count;
  const json = await getJson(url, {
    ...opts,
    timeoutMs: opts.timeoutMs,
    deadline: opts.deadline,
    signal: opts.signal,
    headers: {
      Authorization: 'Bearer ' + secret,
      'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const code = json?.Code;
  if (Number(code) !== 0) throw codeError(code, 200);
  if (opts.strictResponse && !Array.isArray(json?.Data?.Items)) throw searchError('invalid_response');
  const rows = Array.isArray(json?.Data?.Items) ? json.Data.Items : [];
  const fetchedAt = new Date().toISOString();
  return rows.map((row) => mapItem(row, fetchedAt)).filter(Boolean);
}

/** 查询官方每日免费额度，不消耗业务次数。失败时抛结构化错误，调用方自行忽略。 */
async function quota(secret, opts = {}) {
  const key = String(secret || '').trim();
  if (!key) throw searchError('zhihu_secret_missing');
  const json = await getJson(BASE_URL + '/api/v1/quota?APIIDs=zhihu_search', {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + key,
      'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (Number(json?.Code) !== 0) throw codeError(json?.Code, 200);
  const row = Array.isArray(json?.Data) ? json.Data.find((x) => x?.APIID === 'zhihu_search') : null;
  return row ? {
    apiId: row.APIID,
    total: Number(row.TotalQuota) || 0,
    used: Number(row.TotalUsed) || 0,
    remaining: Number(row.RemainingQuota) || 0,
  } : null;
}

module.exports = { search, quota, mapItem, timeOf, BASE_URL };
