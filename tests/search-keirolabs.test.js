'use strict';

// 真实的搜索流程，只替换 https：Keirolabs 走 POST（https.request），Bing / 360 走 GET（https.get）。
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const web = require('../src/adapters/websearch');
const keirolabs = require('../src/adapters/search/keirolabs');
const { search } = require('../src/services/search');
const { result } = require('../src/core/search/result');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { FIELDS, validate, checkValue } = require('../src/infra/configSchema');

const KEY = 'keiro-test-1234';
const HITS = [
  { position: 1, title: '鲸鱼 迁徙 路线 研究', url: 'https://a.example/1', snippet: '鲸鱼每年迁徙', domain: 'a.example', score: null },
  { position: 2, title: '鲸鱼迁徙的秘密', url: 'https://b.example/2', snippet: '关于鲸鱼迁徙' },
  { position: 3, title: '没有链接', url: '', snippet: '鲸鱼迁徙' },
];
const BING = `<li class="b_algo"><h2><a href="https://bing.example/1">鲸鱼 迁徙 百科</a></h2><p>鲸鱼迁徙的路线</p></li>`
  + `<li class="b_algo"><h2><a href="https://bing.example/2">鲸鱼 迁徙 新闻</a></h2><p>今年鲸鱼迁徙</p></li>`;

function response(callback, { status = 200, body = '' }) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.headers = {};
  res.complete = false;
  res.resume = () => res;
  res.destroy = () => res.emit('close');
  callback(res);
  setImmediate(() => {
    res.emit('data', Buffer.from(body));
    res.complete = true;
    res.emit('end');
    res.emit('close');
  });
}

function fakeHttps(t, { keirolabs: keiro = { body: JSON.stringify({ results: HITS, count: 3 }) }, bing = { body: BING } } = {}) {
  const posts = [], gets = [];
  const request = () => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.setTimeout = () => req;
    return req;
  };
  t.mock.method(https, 'request', (url, options, callback) => {
    const req = request();
    req.end = body => {
      posts.push({ url: String(url), options, body: JSON.parse(body) });
      response(callback, keiro);
    };
    return req;
  });
  t.mock.method(https, 'get', (url, options, callback) => {
    gets.push(String(url));
    setImmediate(() => response(callback, /bing\.com/.test(String(url)) ? bing : { body: '' }));
    return request();
  });
  return { posts, gets };
}

test('配了 Key 时先 POST Keirolabs lite 接口，两条有效结果就不再爬 Bing', async (t) => {
  const net = fakeHttps(t);
  const value = await web.searchResult('鲸鱼 迁徙', { keirolabsApiKey: ` ${KEY} `, timeoutMs: 2000 });

  assert.equal(net.posts.length, 1);
  assert.equal(net.posts[0].url, 'https://api.keirolabs.cloud/api/v2/search/lite');
  assert.equal(net.posts[0].options.method, 'POST');
  assert.equal(net.posts[0].options.headers.Authorization, 'Bearer ' + KEY);
  assert.equal(net.posts[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(net.posts[0].body, { query: '鲸鱼 迁徙', maxResults: 10 });
  assert.deepEqual(net.gets, []);
  assert.equal(value.status, 'ok');
  assert.deepEqual(value.items.map(x => [x.provider, x.url]), [['keirolabs', 'https://a.example/1'], ['keirolabs', 'https://b.example/2']]);
});

test('Keirolabs 拒绝 Key 时记下 401，照旧回落到 Bing', async (t) => {
  const net = fakeHttps(t, { keirolabs: { status: 401, body: '{"error":"Invalid API key"}' } });
  const value = await web.searchResult('鲸鱼 迁徙', { keirolabsApiKey: KEY, timeoutMs: 2000 });

  assert.equal(net.posts.length, 1);
  assert.ok(net.gets.some(url => url.startsWith('https://cn.bing.com/search')));
  assert.deepEqual(value.attempts[0], { ...value.attempts[0], provider: 'keirolabs', status: 'failed', code: 'http_error' });
  assert.equal(value.attempts[0].error.status, 401);
  assert.equal(value.status, 'ok');
  assert.ok(value.items.every(x => x.provider === 'bing'));
});

test('Keirolabs 结果不够两条时补 Bing，两边结果按链接去重合并', async (t) => {
  const net = fakeHttps(t, { keirolabs: { body: JSON.stringify({ results: HITS.slice(0, 1) }) } });
  const value = await web.searchResult('鲸鱼 迁徙', { keirolabsApiKey: KEY, timeoutMs: 2000 });

  assert.equal(net.posts.length, 1);
  assert.ok(net.gets.length >= 1);
  assert.deepEqual(value.items.map(x => x.provider).slice(0, 2), ['keirolabs', 'bing']);
});

test('没配 Key 时行为不变：不发 POST，直接走 Bing', async (t) => {
  const net = fakeHttps(t);
  const value = await web.searchResult('鲸鱼 迁徙', { timeoutMs: 2000 });

  assert.equal(net.posts.length, 0);
  assert.ok(net.gets[0].startsWith('https://cn.bing.com/search'));
  assert.ok(value.items.every(x => x.provider === 'bing'));
});

test('适配器：丢弃没有链接或没有内容的结果，空 Key 不发请求', async (t) => {
  const net = fakeHttps(t, { keirolabs: { body: JSON.stringify({ results: [...HITS, { title: '', url: 'https://c.example', snippet: '' }, null] }) } });
  assert.deepEqual(await keirolabs.search('鲸鱼', { keirolabsApiKey: KEY, timeoutMs: 1000 }), [
    { title: '鲸鱼 迁徙 路线 研究', url: 'https://a.example/1', snippet: '鲸鱼每年迁徙' },
    { title: '鲸鱼迁徙的秘密', url: 'https://b.example/2', snippet: '关于鲸鱼迁徙' },
  ]);
  await assert.rejects(keirolabs.search('鲸鱼', { keirolabsApiKey: '  ' }), { code: 'missing_api_key' });
  assert.equal(net.posts.length, 1);
});

test('适配器：缺 results 或返回非 JSON 时报 parse_error', async (t) => {
  for (const body of ['{"error":"x"}', '<html>oops</html>']) {
    const inner = t.mock;
    inner.restoreAll();
    fakeHttps(t, { keirolabs: { body } });
    await assert.rejects(keirolabs.search('鲸鱼', { keirolabsApiKey: KEY, timeoutMs: 1000 }), { code: 'parse_error' });
  }
});

test('搜索服务把 websearch.keirolabsApiKey 交给网页检索', async () => {
  const calls = [];
  const deps = {
    route: async () => ({ need: true, query: '鲸鱼 迁徙', fresh: 'normal' }),
    providers: { searchResult: async (...args) => { calls.push(args); return result([{ title: 't', url: 'https://x.example', snippet: 's', provider: 'keirolabs' }]); } },
    places: { geocodeCity: async () => null, ipCity: async () => '' },
  };
  await search({ text: '鲸鱼怎么迁徙', config: { semanticRoute: true, timeoutMs: 1000, keirolabsApiKey: KEY } }, deps);
  assert.equal(calls[0][1].keirolabsApiKey, KEY);
});

test('配置：默认不填 Key，schema 收下合法值，报错时不回显 Key', () => {
  assert.equal(DEFAULT_CONFIG.websearch.keirolabsApiKey, '');
  assert.deepEqual(validate({ websearch: { keirolabsApiKey: KEY } }), []);
  const message = checkValue(KEY.repeat(30), FIELDS['websearch.keirolabsApiKey']);
  assert.ok(message);
  assert.doesNotMatch(message, new RegExp(KEY));
});
