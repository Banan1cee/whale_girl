'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');

const { extractUrls, parsePage, fetchUrl, describeLink, formatForPrompt, kindOf } = require('../src/adapters/links');

test('从聊天文字里提取链接，去掉句末标点、去重、最多两个', () => {
  assert.deepEqual(extractUrls('看看这个 https://v.douyin.com/abc123/ 好笑'), ['https://v.douyin.com/abc123/']);
  assert.deepEqual(extractUrls('https://example.com/a?x=1，真的'), ['https://example.com/a?x=1']);
  assert.deepEqual(extractUrls('https://example.com/a 和 https://example.com/a'), ['https://example.com/a']);
  assert.equal(extractUrls('a https://x.com/1 b https://y.com/2 c https://z.com/3').length, 2);
  assert.deepEqual(extractUrls('没有链接只有文字'), []);
  assert.deepEqual(extractUrls('ftp://example.com/x'), []);
});

test('识别链接类型（短视频 / 文章 / 普通网页）', () => {
  assert.equal(kindOf('https://v.douyin.com/abc/'), 'video');
  assert.equal(kindOf('https://www.bilibili.com/video/BV1xx'), 'video');
  assert.equal(kindOf('https://mp.weixin.qq.com/s/abc'), 'article');
  assert.equal(kindOf('https://example.com/a'), 'web');
});

test('parsePage 能解析 og 标题、描述和正文段落', () => {
  const html = `<html><head><title>普通标题</title>
    <meta property="og:title" content="OG 标题" />
    <meta name="description" content="这是页面描述" />
    </head><body>
    <p>第一段正文内容超过十二个字符了</p>
    <p>第二段正文内容也超过十二个字符</p>
    </body></html>`;
  const info = parsePage(html, 'https://mp.weixin.qq.com/s/abc');
  assert.equal(info.title, 'OG 标题');
  assert.match(info.description, /这是页面描述/);
  assert.match(info.article, /第一段正文/);
});

test('describeLink 能抓本地页面并返回标题描述', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><meta property="og:title" content="抖音视频标题"><meta property="og:description" content="视频文案在这里"></head></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // 测试用的就是这个进程里的临时服务器，显式允许私网（线上默认不允许）
  const info = await describeLink(`http://127.0.0.1:${port}/v/123`, { allowPrivate: true });
  assert.equal(info.ok, true);
  assert.equal(info.title, '抖音视频标题');
  assert.match(info.description, /视频文案/);
  const text = formatForPrompt(info);
  assert.match(text, /链接标题/);
  await new Promise((r) => server.close(r));
});

test('链接打不开时返回可读结果，不抛异常', async () => {
  const info = await describeLink('http://127.0.0.1:1/nope', { timeoutMs: 1500, allowPrivate: true });
  assert.equal(info.ok, false);
  assert.ok(info.error);
  assert.match(formatForPrompt(info), /打不开/);
});

test('短视频平台的提示里会说明「只看到文案，没看画面」', () => {
  const text = formatForPrompt({ ok: true, url: 'https://v.douyin.com/x', kind: 'video', title: '猫猫', description: '一只猫' });
  assert.match(text, /没有真的看完视频/);
});

test('域名解析到内网/回环要拦下（SSRF），解析失败按网络错误返回', async (t) => {
  t.mock.method(dns, 'lookup', (host, cb) => cb(null, '10.1.2.3'));
  const blocked = await fetchUrl('http://public.example/', { timeoutMs: 500 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'private_host');

  dns.lookup.mock.restore();
  t.mock.method(dns, 'lookup', (host, cb) => {
    const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    cb(err);
  });
  const failed = await fetchUrl('http://no-such-host.example/', { timeoutMs: 500 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'ENOTFOUND', '解析失败不能吞成 private_host');
});

test('allowPrivate 语义不变：显式放行时不做 DNS 拦截', async (t) => {
  const server = http.createServer((req, res) => { res.end('<title>ok</title>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  const info = await describeLink(`http://127.0.0.1:${port}/p`, { allowPrivate: true, timeoutMs: 1000 });
  assert.equal(info.ok, true);
  assert.equal(info.title, 'ok');
});

test('重定向链共用一个总预算，不会每跳重新计时', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    setTimeout(() => {
      if (req.url === '/0') { res.writeHead(302, { location: '/1' }); res.end(); return; }
      if (req.url === '/1') { res.writeHead(302, { location: '/2' }); res.end(); return; }
      if (req.url === '/2') { res.writeHead(302, { location: '/3' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>done</title>');
    }, 120);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const started = Date.now();
  // 4 跳 × 120ms = 480ms；总预算 200ms，旧实现每跳重新计时才会全部跑完
  const res = await fetchUrl(`http://127.0.0.1:${port}/0`, { timeoutMs: 200, allowPrivate: true });
  const elapsed = Date.now() - started;
  await new Promise((r) => server.close(r));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
  assert.ok(hits < 4, '不该把每一跳都跑满：实际请求了 ' + hits + ' 次');
  assert.ok(elapsed < 600, '总耗时应该接近总预算，实际 ' + elapsed + 'ms');
});

test('取消链接读取会立即销毁挂起请求，不等到网络超时', async t => {
  const server = http.createServer(() => {});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController();
  const start = Date.now();
  const pending = fetchUrl(`http://127.0.0.1:${server.address().port}/hang`, { allowPrivate: true, timeoutMs: 2000, signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  const result = await pending;
  assert.equal(result.error, 'aborted');
  assert.ok(Date.now() - start < 1000);
});

test('恶意网页解析超时不会冻结内核，线程可中止并返回失败说明', () => {
  // 子进程是外层测试保险；旧解析器在主线程遇到此网页会连超时回调都跑不了。
  const { spawnSync } = require('node:child_process');
  const adapter = require.resolve('../src/adapters/links');
  const script = `
    const http=require('node:http'),{describeLink}=require(${JSON.stringify(adapter)});
    const s=http.createServer((q,r)=>r.end('<meta '.repeat(25000)));
    s.listen(0,'127.0.0.1',async()=>{
      const heartbeat=setInterval(()=>{},10);
      try {
        const value=await describeLink('http://127.0.0.1:'+s.address().port+'/',{allowPrivate:true,timeoutMs:300});
        console.log(JSON.stringify({ok:value.ok,error:value.error}));
      } finally { clearInterval(heartbeat);s.closeAllConnections();s.close(); }
    });`;
  const result = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.error?.code || result.stderr);
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.ok, false);
  assert.match(value.error, /parse_timeout|timeout/);
});

test('链接阅读器永不返回时，当前消息降级继续，同会话后续消息也能处理', async () => {
  const { Bot } = require('../src/pipeline/bot');
  const bot = Object.create(Bot.prototype);
  const events = [], signals = [];
  bot.config = { links: { timeoutMs: 30 } };
  bot._handleChains = new Map();
  bot.store = { appendEvent: (_key, event) => events.push(event) };
  bot.logger = { info() {}, warn() {} };
  bot.linkReader = (_url, { signal }) => { signals.push(signal); return new Promise(() => {}); };
  bot._handleOnce = async msg => ({ action: 'reply', text: msg.text === 'link'
    ? await bot.readLink('https://example.org/test', 'fixture') : '继续回复' });
  let timer;
  try {
    const results = await Promise.race([
      Promise.all([bot.handle({ platform: 'wechat', chatId: 'fixture', text: 'link' }), bot.handle({ platform: 'wechat', chatId: 'fixture', text: 'next' })]),
      new Promise(resolve => { timer = setTimeout(() => resolve('hung'), 1000); }),
    ]);
    assert.notEqual(results, 'hung');
    assert.match(results[0].text, /打不开|读取失败/);
    assert.equal(results[1].text, '继续回复');
    assert.equal(events[0].status, 'failed');
    assert.equal(signals[0].aborted, true);
    assert.equal(bot._handleChains.size, 0);
  } finally { clearTimeout(timer); }
});

test('链接读取或记账抛错时也可继续回复，不出现未处理拒绝', async () => {
  const { Bot } = require('../src/pipeline/bot');
  const result = await Bot.prototype.readLink.call({ config: {}, linkReader: async () => { throw new Error('fixture failure'); },
    store: { appendEvent() { throw new Error('fixture disk failure'); } }, logger: { info() {}, warn() {} } }, 'https://example.org/', 'fixture');
  assert.match(result, /读取失败/);
});
