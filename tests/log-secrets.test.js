'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { registerSecrets, redactSecrets } = require('../src/infra/redact');
const { createLogger } = require('../src/infra/logger');
const { describeError } = require('../src/infra/errors');
const { LlmError } = require('../src/llm/client');

test('供应商映射、任意格式和 URL 编码的密钥都会遮住', () => {
  const value = 'fixture-opaque/credential+42';
  registerSecrets({ keys: { provider: value } });
  assert.equal(redactSecrets(value + ' ' + encodeURIComponent(value)), '*** ***');
  for (const text of ['api_key=unregistered-value', 'Bearer opaque-header-value', 'brz_' + 'abcdefgh12345678']) {
    assert.ok(!redactSecrets(text).includes(text.split(/[= ]/).pop()));
  }
});

test('错误摘要截断前脱敏，HTTP 状态仍保留', () => {
  const value = 'fixture-long-opaque-secret-value';
  registerSecrets({ apiKey: value });
  const err = new LlmError('failed', { status: 401, detail: value + ' rejected' });
  assert.doesNotMatch(err.detail, /fixture-long/);
  assert.doesNotMatch(err.message + err.stack, /fixture-long/);
  assert.match(describeError(err, { maxDetail: 12 }), /status=401.*detail=\*\*\*/);
});

test('日志正常入口同时保护控制台和落盘的对象密钥', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-secret-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.log');
  const original = fs.createWriteStream;
  let stream;
  t.mock.method(fs, 'createWriteStream', (...args) => { stream = original(...args); return stream; });
  const output = [];
  t.mock.method(console, 'log', line => output.push(line));
  const logger = createLogger({ file });
  const value = 'fixture-opaque-logger-value';
  logger.error({ keys: { provider: value } });
  const finished = once(stream, 'finish');
  logger.close();
  await finished;
  for (const text of [output.join('\n'), fs.readFileSync(file, 'utf8')]) {
    assert.ok(text.includes('***'));
    assert.ok(!text.includes(value));
  }
});
