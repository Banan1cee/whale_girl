'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const deepseek = require('../src/modules/search/providers/deepseek');
const zhihu = require('../src/modules/search/providers/zhihu');
const qwen = require('../src/modules/search/providers/qwen');
const { apiSearch } = require('../src/modules/search/providers/apiSearch');
const quota = require('../src/modules/search/providers/quota');
const { loadConfig } = require('../src/infra/config');

function fakePost(t, handler) {
  const calls = [];
  t.mock.method(https, 'request', (url, options, callback) => {
    const call = { url: String(url), options, body: '' };
    calls.push(call);
    const req = new EventEmitter();
    req.write = (chunk) => { call.body += chunk.toString(); };
    req.end = () => {
      const spec = handler(call) || {};
      const res = new EventEmitter();
      res.statusCode = spec.status || 200;
      res.headers = {};
      res.complete = true;
      res.destroy = () => {};
      callback(res);
      queueMicrotask(() => {
        res.emit('data', Buffer.from(JSON.stringify(spec.body || {})));
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  });
  return calls;
}

function fakeGet(t, handler) {
  const calls = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    const call = { url: String(url), options };
    calls.push(call);
    const req = new EventEmitter();
    req.destroy = () => {};
    const spec = handler(call) || {};
    const res = new EventEmitter();
    res.statusCode = spec.status || 200;
    res.headers = {};
    res.complete = true;
    res.destroy = () => {};
    res.resume = () => res;
    callback(res);
    queueMicrotask(() => {
      res.emit('data', Buffer.from(JSON.stringify(spec.body || {})));
      res.complete = true;
      res.emit('end');
    });
    return req;
  });
  return calls;
}

test('千问搜索使用原生来源列表，不能把生成正文中的链接当搜索证据', async t => {
  let valid = true;
  const calls = fakePost(t, () => ({ body: { output: {
    choices: [{ message: { content: '模型自己生成的 https://invented.example/' } }],
    ...(valid ? { search_info: { search_results: [
      { title: '来源标题', url: 'https://source.example/news', site_name: '测试来源' },
      { title: '非法链接', url: 'javascript:alert(1)' },
    ] } } : {}),
  } } }));
  const opts = { apiKey: 'unit-qwen', model: 'qwen3.7-plus', baseUrl: 'https://dashscope.aliyuncs.com', timeoutMs: 1000 };
  const rows = await qwen.search('测试搜索', opts);
  assert.equal(rows.length, 1); assert.equal(rows[0].url, 'https://source.example/news');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, opts.model);
  assert.equal(body.parameters.enable_search, true); assert.equal(body.parameters.search_options.enable_source, true);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer unit-qwen');
  assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.deepEqual(body.input.messages[0].content, [{ text: '测试搜索' }]);
  valid = false;
  await assert.rejects(qwen.search('测试', opts), err => err.code === 'invalid_response');
});

test('DeepSeek 搜索：POST 到 /v1/tools/search，带 query/ori_question 并映射结果', async (t) => {
  const calls = fakePost(t, () => ({
    body: {
      results: [{
        title: 'DeepSeek V4', url: 'https://example.com/a', summary: '长摘要',
        snippet: '短摘要', rerank_score: 2.4, authority: 3,
        date: '2026-06-01T00:00:00+00:00', site_name: 'Example',
      }],
    },
  }));
  const items = await deepseek.search('DeepSeek V4', {
    apiKey: 'sk-test', oriQuestion: 'DeepSeek 最新消息', timeoutMs: 3000,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.query, 'DeepSeek V4');
  assert.equal(body.ori_question, 'DeepSeek 最新消息');
  assert.equal(body.need_content, false);
  assert.equal(items[0].provider, 'deepseek');
  assert.equal(items[0].publishedAt, '2026-06-01T00:00:00+00:00');
  assert.equal(items[0].authority, 3);
});

test('知乎搜索：GET 官方 zhihu_search，带 Bearer 和秒级时间戳，映射字段', async (t) => {
  const calls = fakeGet(t, () => ({
    body: {
      Code: 0,
      Data: {
        Items: [{
          Title: '怎么理解 RAG', Url: 'https://www.zhihu.com/question/1',
          ContentText: '<em>RAG</em> 是检索增强生成', ContentType: 'Answer',
          VoteUpCount: 12, CommentCount: 3, AuthorName: '某人',
          EditTime: 1760000000, AuthorityLevel: '3', RankingScore: 2.1,
        }],
      },
    },
  }));
  const items = await zhihu.search('RAG', { accessSecret: 'zh-secret', timeoutMs: 3000 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/developer\.zhihu\.com\/api\/v1\/content\/zhihu_search\?/);
  assert.match(calls[0].url, /Query=RAG/);
  assert.match(calls[0].url, /Count=10/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer zh-secret');
  assert.match(calls[0].options.headers['X-Request-Timestamp'], /^\d{10}$/);
  assert.equal(items[0].provider, 'zhihu');
  assert.equal(items[0].snippet, 'RAG 是检索增强生成');
  assert.equal(items[0].voteUp, 12);
  assert.ok(items[0].publishedAt.endsWith('Z'));
});

test('搜索 API 总开关关闭时，即使列表有 provider 也不发请求', async (t) => {
  const deep = t.mock.method(deepseek, 'search', async () => []);
  const zh = t.mock.method(zhihu, 'search', async () => []);
  const out = await apiSearch({
    query: 'test', text: 'test', dataDir: os.tmpdir(),
    websearch: {
      api: { enabled: false, providers: ['deepseek', 'zhihu'] },
      deepseek: { apiKey: 'k' }, zhihu: { accessSecret: 's' },
    },
  });
  assert.equal(out.status, 'skipped');
  assert.equal(out.reason, 'api_disabled');
  assert.equal(deep.mock.callCount(), 0);
  assert.equal(zh.mock.callCount(), 0);
});

test('老配置把本地搜索写成 false，加载后仍强制开启', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-search-force-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ websearch: { enabled: false } }));
  const config = loadConfig({ root: dir, readOnly: true });
  assert.equal(config.websearch.enabled, true);
});

test('知乎到达 4999 本地上限后跳过请求，DeepSeek 仍可用', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-search-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'search-quota.json'), JSON.stringify({
    date: quota.today(), counts: { zhihu: 4999 },
  }));
  const deep = t.mock.method(deepseek, 'search', async () => [{
    title: 'D', url: 'https://example.com/d', snippet: 'd', provider: 'deepseek',
  }]);
  const zh = t.mock.method(zhihu, 'search', async () => [{ title: 'Z', url: 'https://zhihu.com/z' }]);
  const out = await apiSearch({
    query: 'test', text: 'test', dataDir: dir,
    websearch: {
      api: { enabled: true, providers: ['deepseek', 'zhihu'] },
      deepseek: { apiKey: 'k' },
      zhihu: { accessSecret: 's', dailyLimit: 4999 },
    },
  });
  assert.equal(deep.mock.callCount(), 1);
  assert.equal(zh.mock.callCount(), 0);
  assert.equal(out.items.length, 1);
  assert.ok(out.attempts.some((a) => a.provider === 'zhihu' && a.code === 'quota_exceeded'));
});
