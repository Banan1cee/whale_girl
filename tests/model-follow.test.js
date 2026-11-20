'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG, loadConfig, resolveVoiceConfig, resolveSearchConfig, resolveVisionConfig } = require('../src/infra/config');
const vision = require('../src/modules/vision');
const { probe } = require('../src/services/apiProbe');

function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-follow-'));
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
  const settingsFile = path.join(dataDir, 'settings.json');
  const write = s => fs.writeFileSync(settingsFile, JSON.stringify(s));
  write(settings); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { ...structuredClone(DEFAULT_CONFIG), readOnly: true, env: {}, paths: { root, dataDir, settingsFile } };
  return { cfg, root, write };
}

test('默认跟随聊天服务，切换服务商立即解析新地址、模型和 Key，不修改手动字段', t => {
  const { cfg, write } = fixture(t, { provider: 'deepseek', apiKey: 'unit-ds', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  cfg.voice.apiKey = 'unit-old-manual';
  const before = JSON.stringify(cfg);
  assert.equal(resolveVoiceConfig(cfg).apiKey, 'unit-ds');
  assert.equal(resolveVoiceConfig(cfg).baseUrl, 'https://api.deepseek.com/v1/tools/asr');
  write({ provider: 'qwen', apiKey: 'unit-qw', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus', visionAuto: true, visionManual: false, visionModel: 'deepseek-flash', visionBaseUrl: 'https://api.deepseek.com' });
  assert.equal(resolveVoiceConfig(cfg).model, 'qwen3-asr-flash');
  assert.equal(resolveVoiceConfig(cfg).apiKey, 'unit-qw');
  assert.match(resolveVoiceConfig(cfg).baseUrl, /^https:\/\/dashscope-intl\.aliyuncs\.com\//);
  assert.equal(resolveVisionConfig(cfg).model, 'qwen3.7-plus');
  assert.equal(resolveVisionConfig(cfg).baseUrl, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  assert.deepEqual(resolveSearchConfig(cfg).api.providers, ['qwen']);
  assert.equal(resolveSearchConfig(cfg).qwen.apiKey, 'unit-qw');
  assert.equal(JSON.stringify(cfg), before);
});

test('手动模型、独立 Key 和关闭开关不被跟随覆盖', t => {
  const { cfg, write } = fixture(t, { provider: 'qwen', apiKey: 'unit-main', model: 'qwen3.7-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', visionManual: true, visionAuto: false, visionModel: 'manual-vl', visionBaseUrl: 'https://images.example/v1', visionProvider: 'custom' });
  cfg.voice = { enabled: false, provider: 'custom', baseUrl: 'https://asr.example/recognize', model: 'manual-asr', apiKey: 'unit-manual' };
  cfg.websearch.api = { enabled: false, followChat: false, providers: ['zhihu'] };
  const check = () => {
    assert.equal(resolveVoiceConfig(cfg).apiKey, 'unit-manual');
    assert.equal(resolveVoiceConfig(cfg).model, 'manual-asr');
    assert.equal(resolveVoiceConfig(cfg).enabled, false);
    assert.equal(resolveVisionConfig(cfg).model, 'manual-vl');
    assert.deepEqual(resolveSearchConfig(cfg).api.providers, ['zhihu']);
    assert.equal(resolveSearchConfig(cfg).api.enabled, false);
  };
  check(); write({ provider: 'deepseek', apiKey: 'unit-different' });
  assert.equal(resolveVoiceConfig(cfg).baseUrl, 'https://asr.example/recognize');
});

test('不支持/尚未适配的语音服务清楚提示；中转和非官方地址绝不搬运聊天 Key', t => {
  const { cfg, write } = fixture(t);
  for (const [provider, baseUrl] of [
    ['deepseek', 'https://proxy.example/v1'], ['deepseek', 'http://api.deepseek.com'],
    ['qwen', 'https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1'],
    ['deepseek', 'https://api.deepseek.com:444'], ['qwen', 'https://' + 'user:pass' + '@' + 'dashscope.aliyuncs.com/compatible-mode/v1'],
    ['zhipu', 'https://open.bigmodel.cn/api/paas/v4'], ['custom', 'https://api.deepseek.com'],
  ]) {
    write({ provider, baseUrl, apiKey: 'unit-private' });
    const v = resolveVoiceConfig(cfg);
    assert.equal(v.supported, false, baseUrl); assert.equal(v.apiKey, ''); assert.match(v.hint, /尚未适配/);
    assert.deepEqual(resolveSearchConfig(cfg).api.providers, []);
  }
});

test('已知聊天模型不支持识图时提示并自动使用同服务商视觉模型，可另行修改', t => {
  const { cfg } = fixture(t, { provider: 'deepseek', apiKey: 'unit-ds', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com', visionAuto: true, visionManual: false });
  const v = vision.status(cfg);
  assert.match(v.hint, /deepseek-v4-pro 不支持识图/);
  assert.equal(v.model, 'deepseek-flash');
  assert.equal(v.auto, true);
});

test('手动误选已知纯文本模型时提示并阻止图片请求，不擅自替换用户模型', async t => {
  const { cfg } = fixture(t, { provider: 'deepseek', apiKey: 'unit-main', baseUrl: 'https://api.deepseek.com',
    visionManual: true, visionAuto: false, visionProvider: 'deepseek', visionModel: 'deepseek-v4-pro', visionBaseUrl: 'https://api.deepseek.com' });
  const v = vision.status(cfg);
  assert.equal(v.model, 'deepseek-v4-pro'); assert.equal(v.supported, false);
  assert.match(v.hint, /不支持识图/);
  await assert.rejects(vision.describe(cfg, { imageBase64: vision.TEST_IMAGE }), /不支持识图/);
});

test('清空聊天 Key 时不回退到旧专用 Key；ASR 测试调用与生产解析一致', async t => {
  const { cfg, write } = fixture(t, { provider: 'deepseek', apiKey: 'unit-ds', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  cfg.vision.apiKey = 'unit-stale';
  write({ provider: 'deepseek', apiKey: '', visionAuto: true, visionManual: false, baseUrl: 'https://api.deepseek.com' });
  assert.equal(vision.resolveKey(cfg), '');
  assert.equal(resolveVoiceConfig(cfg).apiKey, '');
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8);
  const body = { provider: 'voice', audio: wav.toString('base64') };
  await assert.rejects(probe(cfg, body), /没有可用/);
  write({ provider: 'qwen', apiKey: 'unit-qw', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
  const out = await probe(cfg, body, { fetch: async (url, opts) => {
    assert.equal(url, resolveVoiceConfig(cfg).baseUrl);
    assert.equal(opts.headers.Authorization, 'Bearer unit-qw');
    assert.equal(JSON.parse(opts.body).model, 'qwen3-asr-flash');
    return { ok: true, json: async () => ({ output: { choices: [{ message: { content: [{ text: '识别测试' }] } }] } }) };
  } });
  assert.equal(out.ok, true);
});

test('升级保留旧版手动语音和搜索设置，新安装默认开启跟随', t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ voice: { enabled: false, model: 'legacy', apiKey: 'unit-legacy' }, websearch: { api: { enabled: true, providers: ['zhihu'] } } }));
  const c = loadConfig({ root, env: {}, readOnly: true });
  assert.equal(c.voice.provider, 'auto'); assert.equal(c.voice.enabled, false);
  assert.equal(c.websearch.api.followChat, false);
  assert.equal(DEFAULT_CONFIG.voice.provider, 'follow'); assert.equal(DEFAULT_CONFIG.voice.enabled, true);
});

test('搜索跟随进入实际服务调用，关闭总闸后不调用搜索 API', async t => {
  const { cfg } = fixture(t, { provider: 'deepseek', apiKey: 'unit-ds', baseUrl: 'https://api.deepseek.com' });
  const api = require('../src/modules/search/providers/apiSearch');
  const original = api.apiSearch; t.after(() => { api.apiSearch = original; });
  let calls = 0;
  api.apiSearch = async opts => {
    calls++; assert.deepEqual(opts.websearch.api.providers, ['deepseek']);
    assert.equal(opts.websearch.deepseek.apiKey, 'unit-ds');
    return { items: [{ title: '来源', url: 'https://example.org/news', snippet: '测试证据' }], status: 'ok' };
  };
  const search = require('../src/modules/search').search;
  const args = { text: '查一下新闻', force: true, llm: { config: cfg }, config: cfg.websearch };
  const deps = { route: async () => ({ need: true, query: '新闻' }), providers: { searchResult: async () => ({ items: [], status: 'empty' }) } };
  const out = await search(args, deps); assert.equal(out.status, 'ok'); assert.equal(calls, 1);
  cfg.websearch.api.enabled = false;
  await search(args, deps); assert.equal(calls, 1);
});
