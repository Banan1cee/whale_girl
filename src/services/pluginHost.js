'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const searchService = require('./search');
const stickers = require('../adapters/stickers');
const { HOOKS } = require('./javascriptPlugins');

const LIMIT = 512 * 1024;
function fail(code, statusCode = 400) { return Object.assign(Error(code), { code, statusCode }); }

class PluginHost {
  constructor(runtime, { search = searchService.search, fetcher = fetch } = {}) {
    this.runtime = runtime;
    this.search = search;
    this.fetcher = fetcher;
  }

  async call(method, args = {}, flow, context = {}, signal) {
    const r = this.runtime;
    if (!r.bot.javascriptPlugins.isApproved(flow.id, flow.hash)) throw fail('grant_revoked', 403);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('host_invalid_arguments');
    if (method === 'capabilities') return {
      api: 4, runtime: 'javascript', access: 'system.full', appVersion: r.version, hooks: HOOKS,
      methods: ['api', 'capabilities', 'search', 'model', 'send', 'delivery'],
      apiRoutes: r.pluginApiRoutes || [],
      delivery: 'queued/submitted is not proof of WeChat delivery',
    };
    if (method === 'api') return this.api(args, flow, signal);
    if (method === 'search') {
      const query = String(args.query || '').trim();
      if (!query || query.length > 2000) throw fail('host_invalid_query');
      const range = args.dateRange;
      if (range !== undefined && (!range || typeof range !== 'object'
        || !/^\d{4}-\d{2}-\d{2}$/.test(range.start) || !/^\d{4}-\d{2}-\d{2}$/.test(range.end)
        || !Number.isFinite(Date.parse(range.start)) || !Number.isFinite(Date.parse(range.end)) || range.end < range.start))
        throw fail('host_invalid_date_range');
      const freshness = String(args.freshness || '');
      if (freshness && !['today', 'yesterday', 'week', 'month', 'year'].includes(freshness)) throw fail('host_invalid_freshness');
      const hint = range ? `${range.start} 至 ${range.end}`
        : ({ today: '今天', yesterday: '昨天', week: '最近一周', month: '最近一月', year: '最近一年' })[freshness];
      const out = await this.search({ text: hint ? `${hint} ${query}` : query, force: true, llm: r.llm,
        config: { ...(r.config.websearch || {}), enabled: true,
          timeoutMs: Math.min(flow.executionTimeoutMs, Math.max(500, Number(args.timeoutMs) || 10000)) },
        now: new Date(context.now || Date.now()), timeZone: String(args.timeZone || ''), signal });
      return { ...out, items: (out.items || []).map(item => ({ ...item,
        publishedAt: item.publishedAt || null, fetchedAt: item.fetchedAt || null })),
        requested: { query, freshness: args.freshness || null, dateRange: args.dateRange || null },
        // 查询词可以包含比赛/事件日期，不能把检索日期当成文章发布时间。
        dateFilter: 'query_hint_only',
      };
    }
    if (method === 'model') {
      const turns = args.turns || args.messages;
      if (!Array.isArray(turns) || turns.length > 100 || turns.some(turn => !turn
        || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string')) throw fail('host_invalid_turns');
      return r.llm.complete({ system: String(args.system || ''), turns, signal,
        maxTokens: Math.max(1, Math.min(32000, Number(args.maxTokens) || 2000)),
        thinking: args.thinking, purpose: 'plugin' });
    }
    if (method === 'send') return this.send(args, flow);
    if (method === 'delivery') {
      const item = r.reminders.items.find(row => row.id === args.id && row.pluginId === flow.id);
      if (item) return { id: item.id, status: item.status === 'done' ? 'submitted' : item.status,
        error: item.error || '', confirmed: false };
      const image = r.stickerService.jobs.get(String(args.id || ''));
      if (!image || image.pluginId !== flow.id) throw fail('host_unknown_delivery', 404);
      return { id: image.id, status: image.status, error: image.error, confirmed: image.status === 'confirmed' };
    }
    throw fail('host_unknown_method');
  }

  async api(args, flow, signal) {
    if (!this.runtime.pluginApiUrl) throw fail('host_api_unavailable', 503);
    const base = new URL(this.runtime.pluginApiUrl);
    const url = new URL(String(args.url || ''), base);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || url.origin !== base.origin || !url.pathname.startsWith('/api/') || url.hash || url.username || url.password)
      throw fail('host_invalid_api_url');
    const method = String(args.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw fail('host_invalid_method');
    const token = this.runtime.config.gateway?.wechat?.inboundToken || '';
    const response = await this.fetcher(url, { method, redirect: 'error', signal,
      headers: { 'content-type': 'application/json', 'x-bot-token': token, 'x-whale-plugin': flow.id },
      body: ['GET', 'HEAD'].includes(method) || args.body === undefined ? undefined : JSON.stringify(args.body) });
    const chunks = [];
    let bytes = 0;
    if (response.body) for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > LIMIT) throw fail('host_result_limit');
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, ok: response.ok, body };
  }

  send(args, flow) {
    const r = this.runtime;
    const chatId = String(args.chatId || '').trim();
    const name = String(args.name || chatId).trim();
    if (!chatId || chatId.length > 120 || /[\r\n\x00-\x1f]/.test(chatId)) throw fail('host_invalid_chat');
    if (args.type === 'image') {
      r.stickerService.requireEnabled();
      const file = path.resolve(String(args.file || ''));
      const stat = fs.statSync(file);
      if (!stat.isFile() || !stat.size || stat.size > stickers.MAX_UPLOAD_BYTES) throw fail('host_invalid_image');
      const extension = path.extname(file).toLowerCase();
      const filename = 'plugin-' + crypto.randomUUID() + extension;
      const uploaded = stickers.upload(r.config, r.config.root, 'happy', [{ name: filename, data: fs.readFileSync(file).toString('base64') }])[0];
      const approved = stickers.resolveImage(stickers.stickerDir(r.config, r.config.root), uploaded.emotion, uploaded.name);
      const item = r.stickerService.add({ path: approved, emotion: uploaded.emotion }, name, chatId,
        'plugin:' + flow.id + ':' + crypto.randomUUID(), 'queued');
      const stored = r.stickerService.jobs.get(item.id);
      stored.pluginId = flow.id; stored.pluginHash = flow.hash;
      return { id: item.id, status: 'queued', confirmed: false };
    }
    if (!['text', 'voice', undefined].includes(args.type)) throw fail('host_invalid_delivery_type');
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000) throw fail('host_invalid_text');
    const item = r.reminders.enqueueNow({ wxid: chatId, name, chatType: args.chatType,
      text: args.text, kind: 'plugin', pluginId: flow.id, pluginHash: flow.hash,
      delivery: args.type === 'voice' ? 'voice' : 'text' });
    return { id: item.id, status: 'queued', confirmed: false };
  }
}

module.exports = { PluginHost };
