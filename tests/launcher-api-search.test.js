'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(ROOT, 'launcher', 'Views', 'SettingsPage.xaml.cs'), 'utf8');
const saver = fs.readFileSync(path.join(ROOT, 'launcher', 'ConfigSaver.cs'), 'utf8');

test('API 卡片均有测试入口，并先保存当前字段再测试', () => {
  assert.match(settings, /AddApiProbe\(voiceBody, "voice"/);
  assert.match(settings, /AddApiProbe\(panel, key/);
  assert.match(settings, /\/api\/settings\/test-service/);
  assert.match(settings, /foreach \(var saveField in _apiFieldSaves/);
  assert.match(settings, /await _saver.FlushAsync\(\)/);
  assert.match(settings, /模型调用成功/);
});

test('API 接入：四个页签 + 搜索 API 单开关 + 关闭清列表删 Key', () => {
  assert.match(settings, /Card\("API 接入"/);
  for (const tab of ['聊天（文本）', '看图（视觉）', '语音（识别）', '搜索']) {
    assert.ok(settings.includes(tab), '缺少页签：' + tab);
  }
  assert.match(settings, /websearch\.api\.enabled/);
  assert.match(settings, /websearch\.api\.providers/);
  assert.match(settings, /websearch\.deepseek\.apiKey/);
  assert.match(settings, /websearch\.zhihu\.accessSecret/);
  assert.match(settings, /ClearSecretsAsync/);
  assert.match(settings, /关闭搜索 API 会/);
  assert.match(settings, /DeepSeek 官方 deepseek-flash 时，走模型内建搜索，不会自动调用下方独立搜索服务/);
  assert.match(saver, /\/api\/config\/clear-secrets/);
  assert.ok(!/Path = "websearch\.enabled"/.test(settings), '本地搜索开关应删除');
});

test('ASR 开关和 DeepSeek 语音识别在语音页签', () => {
  assert.match(settings, /Path = "voice\.enabled"|voice\.enabled/);
  assert.match(settings, /DeepSeek 语音识别/);
  assert.match(settings, /\/v1\/tools\/asr/);
});

test('语音识别关闭时隐藏配置和测试入口', () => {
  assert.match(settings, /voiceBody = new StackPanel \{ Visibility = Visibility\.Collapsed \}/);
  assert.match(settings, /voiceBody\.Visibility = voiceSwitch\.IsChecked == true \? Visibility\.Visible : Visibility\.Collapsed/);
  assert.match(settings, /voiceBody\.Visibility = on \? Visibility\.Visible : Visibility\.Collapsed/);
});
