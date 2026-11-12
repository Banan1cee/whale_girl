'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../src/adapters/links');
const search = require('../src/adapters/search/html');
const { mergeConfigInPlace } = require('../src/infra/configPatch');
const { Router } = require('../src/http/router');
const { registerSecrets } = require('../src/infra/redact');

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
