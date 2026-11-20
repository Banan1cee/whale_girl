'use strict';

/**
 * DeepSeek 搜索 API（POST /v1/tools/search）。
 *
 * 只负责「发请求 + 映射成项目统一结果」，不做路由、不做配额；
 * 开关由 modules/search/service.js 在调用前检查，关掉时这里根本不会被 require 到执行。
 */
const { postJson, searchError } = require('./transport');

const BASE_URL = 'https://api.deepseek.com';
const MAX_COUNT = 10;

function mapItem(row, fetchedAt) {
  const url = String(row?.url || '').trim();
  const title = String(row?.title || '').trim();
  if (!url || !title) return null;
  const published = String(row?.date || '').trim();
  return {
    title,
    url,
    snippet: String(row?.summary || row?.snippet || '').trim().slice(0, 800),
    provider: 'deepseek',
    fetchedAt,
    publishedAt: published || null,
    rerankScore: Number(row?.rerank_score) || 0,
    authority: Number(row?.authority) || 0,
    siteName: row?.site_name || '',
  };
}

async function search(query, opts = {}) {
  const key = String(opts.apiKey || '').trim();
  if (!key) throw searchError('deepseek_key_missing');
  const q = String(query || '').trim();
  if (!q) return [];
  const count = Math.max(1, Math.min(MAX_COUNT, Number(opts.count) || MAX_COUNT));
  const body = { query: q, count, need_content: false };
  const original = String(opts.oriQuestion || '').trim();
  if (original) body.ori_question = original.slice(0, 128);

  const json = await postJson(BASE_URL + '/v1/tools/search', body, {
    ...opts,
    headers: { Authorization: 'Bearer ' + key, ...(opts.headers || {}) },
  });
  if (opts.strictResponse && !Array.isArray(json?.results)) throw searchError('invalid_response');
  const rows = Array.isArray(json?.results) ? json.results : [];
  const fetchedAt = new Date().toISOString();
  return rows.map((row) => mapItem(row, fetchedAt)).filter(Boolean);
}

module.exports = { search, mapItem, BASE_URL };
