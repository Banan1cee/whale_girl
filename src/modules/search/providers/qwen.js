'use strict';

const { postJson, searchError } = require('./transport');

// 使用 DashScope 原生协议获取可核对的来源；不能把模型自由生成的 URL 当搜索结果。
async function search(query, opts = {}) {
  if (!opts.apiKey) throw searchError('qwen_key_missing');
  const multimodal = /^qwen(?:4-|3\.(?:5|6|8)-|3\.7-(?:plus|flash)(?:-|$)|.*-vl)/i.test(opts.model || '');
  const text = String(query).slice(0, 4000);
  const body = { model: opts.model, input: { messages: [{ role: 'user', content: multimodal ? [{ text }] : text }] },
    parameters: { enable_search: true, enable_thinking: false, max_tokens: 256, result_format: 'message',
      search_options: { forced_search: true, enable_source: true } } };
  const data = await postJson(opts.baseUrl + '/api/v1/services/aigc/' + (multimodal ? 'multimodal-generation' : 'text-generation') + '/generation', body,
    { ...opts, headers: { Authorization: 'Bearer ' + opts.apiKey } });
  const rows = data?.output?.search_info?.search_results;
  if (!Array.isArray(rows)) throw searchError('invalid_response');
  const fetchedAt = new Date().toISOString();
  return rows.filter(r => r && r.title && /^https?:\/\//i.test(r.url || '')).slice(0, 10).map(r => ({
    title: String(r.title), url: String(r.url), snippet: String(r.snippet || r.summary || '').slice(0, 800),
    provider: 'qwen', fetchedAt, publishedAt: r.date || null, siteName: r.site_name || '',
  }));
}

module.exports = { search };
