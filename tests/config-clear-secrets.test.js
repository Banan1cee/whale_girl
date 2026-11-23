'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/infra/config');
const { applyConfigPatch, clearSecrets, publicConfig } = require('../src/infra/configPatch');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-clear-secrets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    deepseek: { apiKey: 'chat-key' },
    vision: { apiKey: 'vision-key' },
    voice: { apiKey: 'voice-key' },
    websearch: {
      deepseek: { apiKey: 'search-key' },
      zhihu: { accessSecret: 'zhihu-secret' },
    },
  }, null, 2));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({
    apiKey: 'chat-settings-key',
    voiceApiKey: 'old-voice-key',
    keys: { voice: 'old-voice-key-2', deepseek: 'keep-me' },
    websearch: { deepseek: { apiKey: 'stale-search-key' } },
  }, null, 2));
  const config = loadConfig({ root, readOnly: true });
  const logger = { info() {}, warn() {}, error() {} };
  return { root, config, runtime: { config, logger, offlineConfiguration: true } };
}

test('清除搜索 Key 只删指定路径，保留聊天/看图 Key', (t) => {
  const f = fixture(t);
  const out = clearSecrets(f.runtime, ['websearch.deepseek.apiKey', 'websearch.zhihu.accessSecret']);
  assert.deepEqual(out.cleared, ['websearch.deepseek.apiKey', 'websearch.zhihu.accessSecret']);

  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'));
  assert.equal(saved.deepseek.apiKey, 'chat-key');
  assert.equal(saved.vision.apiKey, 'vision-key');
  assert.equal(saved.websearch?.deepseek?.apiKey, undefined);
  assert.equal(saved.websearch?.zhihu?.accessSecret, undefined);

  const settings = JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'settings.json'), 'utf8'));
  assert.equal(settings.apiKey, 'chat-settings-key');
  assert.equal(settings.websearch?.deepseek?.apiKey, undefined);

  const pub = publicConfig(f.runtime.config);
  assert.equal(pub.secrets['websearch.deepseek.apiKey'], false);
  assert.equal(pub.secrets['websearch.zhihu.accessSecret'], false);
  assert.equal(pub.secrets['deepseek.apiKey'], true);
});

test('清除 voice.apiKey 同时删 settings 的旧语音 Key 位置，保留其它 Key', (t) => {
  const f = fixture(t);
  clearSecrets(f.runtime, ['voice.apiKey']);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'));
  assert.equal(saved.voice?.apiKey, undefined);
  assert.equal(saved.deepseek.apiKey, 'chat-key');

  const settings = JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'settings.json'), 'utf8'));
  assert.equal(settings.voiceApiKey, undefined);
  assert.equal(settings.keys?.voice, undefined);
  assert.equal(settings.keys?.deepseek, 'keep-me');
  assert.equal(settings.apiKey, 'chat-settings-key');
});

test('搜索凭据不回显且不被空值或其他设置保存覆盖', (t) => {
  const { config, runtime } = fixture(t);
  applyConfigPatch(runtime, { websearch: { api: { followChat: false, providers: ['qwen'] }, qwen: { apiKey: 'test-qwen-search-secret' } } });
  applyConfigPatch(runtime, { 'websearch.qwen.apiKey': '', 'env.location': '上海' });
  assert.equal(config.env.location, '上海');
  assert.equal(config.websearch.qwen.apiKey, 'test-qwen-search-secret');
  const pub = publicConfig(config);
  assert.deepEqual(pub.config.websearch.api.providers, ['qwen']);
  assert.equal(pub.config.websearch.qwen.apiKey, '');
  assert.equal(pub.secrets['websearch.qwen.apiKey'], true);
  assert.doesNotMatch(JSON.stringify(pub), /test-qwen-search-secret/);
  clearSecrets(runtime, ['websearch.qwen.apiKey']);
  assert.equal(publicConfig(config).secrets['websearch.qwen.apiKey'], false);
});

test('不允许清除非密钥字段', (t) => {
  const f = fixture(t);
  assert.throws(() => clearSecrets(f.runtime, ['websearch.api.providers']), /不允许清除/);
});
