'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskKey, DEFAULT_CONFIG } = require('../src/infra/config');
const { publicConfig } = require('../src/infra/configPatch');
test('密钥只显示首尾两位，短密钥全隐藏，配置响应不含明文', () => {
  assert.equal(maskKey('ab123456yz'), 'ab********yz');
  assert.equal(maskKey('abcd'), '****');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.voice.apiKey = 'ab123456yz';
  const result = publicConfig(cfg);
  assert.equal(result.config.voice.apiKey, '');
  assert.equal(result.secretMasks['voice.apiKey'], 'ab********yz');
  assert.doesNotMatch(JSON.stringify(result), /ab123456yz/);
});
