'use strict';

const { postJson, searchError } = require('./transport');

// lite 接口只返回标题、链接和摘要，按请求计费，与条数无关。
const ENDPOINT = 'https://api.keirolabs.cloud/api/v2/search/lite';

async function search(query, opts = {}) {
  const key = String(opts.keirolabsApiKey || '').trim();
  if (!key) throw searchError('missing_api_key');
  const data = await postJson(ENDPOINT, { query, maxResults: 10 }, { ...opts, headers: { Authorization: 'Bearer ' + key } });
  if (!Array.isArray(data?.results)) throw searchError('parse_error');
  return data.results
    .filter(item => item && /^https?:\/\//i.test(String(item.url || '')))
    .map(item => ({ title: String(item.title || ''), url: String(item.url), snippet: String(item.snippet || '') }))
    .filter(item => item.title || item.snippet)
    .slice(0, 10);
}

module.exports = { search, ENDPOINT };
