'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../src/adapters/links');
const search = require('../src/adapters/search/html');
const { mergeConfigInPlace } = require('../src/infra/configPatch');
const { Router } = require('../src/http/router');
const { registerSecrets } = require('../src/infra/redact');
const dns = require('node:dns');
const https = require('node:https');
const { EventEmitter } = require('node:events');

test('网页实体只解码一层，链接与搜索使用同一规则', () => {
  for (const decode of [links.decodeEntities, search.decodeEntities]) {
    assert.equal(decode('&amp;#60;'), '&#60;');
    assert.equal(decode('&#38;amp;'), '&amp;');
    assert.equal(decode('&#x4e2d;&quot;'), '中"');
  }
});

test('链接与搜索丢弃带空白结束标签的脚本和样式', () => {
  for (const strip of [links.stripTags, search.stripTags]) {
    const text = strip('hello<script>secretScript()</script >world<style>secretCss</style\n >end');
    assert.doesNotMatch(text, /secretScript|secretCss/);
    assert.match(text, /hello.*world.*end/);
  }
});

test('配置热重载拒绝根部、嵌套和环境段的原型键', () => {
  const target = { group: {}, env: Object.create({ PROCESS_TEST: 'retained' }) };
  const input = JSON.parse('{"__proto__":{"polluted":true},"group":{"constructor":{"prototype":{"polluted":true}},"safe":1},"env":{"__proto__":{"polluted":true},"location":"test"}}');
  mergeConfigInPlace(target, input);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.getPrototypeOf(target), Object.prototype);
  assert.equal(target.group.safe, 1);
  assert.equal(Object.hasOwn(target.group, 'constructor'), false);
  assert.equal(target.env.PROCESS_TEST, 'retained');
  assert.equal(target.env.location, 'test');
});

test('HTTP 错误响应先脱敏再截断，且不返回后续堆栈', async () => {
  const secret = ['fixture', 'opaque', 'credential'].join('-');
  registerSecrets({ apiKey: secret });
  const router = new Router({ config: {}, logger: { error() {} } });
  const long = 'x'.repeat(190) + secret + '\r\nprivate stack';
  router.get('/api/regression', () => { throw Object.assign(new Error(long), { statusCode: 400 }); });
  let status, body;
  await router.handle({ method: 'GET', url: '/api/regression', headers: { host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1' } }, {
    setHeader() {}, writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); },
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'x'.repeat(190) + '***');
  assert.doesNotMatch(body.error, /fixture|private stack|[\r\n]/);
});

test('链接预览拒绝映射为私网的 IPv6，正常域名不按 IPv6 前缀误拦', () => {
  for (const host of ['::ffff:127.0.0.1', '[::ffff:7f00:1]', '::ffff:c0a8:101',
    '0:0:0:0:0:0:0:1', 'fe90::1']) assert.equal(links.isPrivateHost(host), true, host);
  for (const host of ['fc-example.com', 'fd-example.com', '::ffff:808:808'])
    assert.equal(links.isPrivateHost(host), false, host);
});

test('链接预览连接固定为已验证的 DNS 地址，防止二次解析转入内网', async (t) => {
  let lookups = 0;
  t.mock.method(dns, 'lookup', (_host, cb) => { lookups++; cb(null, '8.8.8.8', 4); });
  t.mock.method(https, 'request', (options, onResponse) => {
    assert.equal(typeof options.lookup, 'function', '连接必须使用通过验证的地址');
    options.lookup('fixture.invalid', { all: true }, (err, addresses) => {
      assert.ifError(err);
      assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
    });
    options.lookup('fixture.invalid', {}, (err, address, family) => {
      assert.ifError(err);
      assert.equal(address, '8.8.8.8');
      assert.equal(family, 4);
    });
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { 'content-type': 'text/html' };
      onResponse(res);
      queueMicrotask(() => { res.emit('data', Buffer.from('fixture')); res.emit('end'); });
    };
    return req;
  });
  const result = await links.fetchUrl('https://fixture.invalid/');
  assert.equal(result.ok, true);
  assert.equal(lookups, 1);
});

test('链接预览拒绝非 HTTP 协议，恶意重定向不引起未捕获异常', async (t) => {
  let lookups = 0;
  t.mock.method(dns, 'lookup', (_host, cb) => { lookups++; cb(null, '8.8.8.8', 4); });
  assert.equal((await links.fetchUrl('ftp://fixture.invalid/')).error, 'bad_protocol');
  assert.equal(lookups, 0);
  let location = 'http://[';
  t.mock.method(https, 'request', (_options, onResponse) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 302;
      res.headers = { location };
      res.resume = () => {};
      onResponse(res);
    };
    return req;
  });
  assert.equal((await links.fetchUrl('https://fixture.invalid/')).error, 'bad_url');
  location = 'ftp://fixture.invalid/';
  assert.equal((await links.fetchUrl('https://fixture.invalid/')).error, 'bad_protocol');
});

test('链接预览的硬超时覆盖 DNS 等待和持续不结束的响应', async (t) => {
  let lateLookup;
  let requests = 0;
  t.mock.method(dns, 'lookup', (_host, cb) => { lateLookup = cb; });
  const request = t.mock.method(https, 'request', (_options, onResponse) => {
    requests++;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      onResponse(res);
      res.emit('data', Buffer.from('partial'));
    };
    return req;
  });
  assert.equal((await links.fetchUrl('https://fixture.invalid/', { timeoutMs: 20 })).error, 'timeout');
  lateLookup(null, '8.8.8.8', 4);
  assert.equal(requests, 0, '超时后迟到的 DNS 结果不能再发起连接');
  dns.lookup.mock.restore();
  t.mock.method(dns, 'lookup', (_host, cb) => cb(null, '8.8.8.8', 4));
  assert.equal((await links.fetchUrl('https://fixture.invalid/', { timeoutMs: 20 })).error, 'timeout');
  assert.equal(request.mock.calls.length, 1);
});
