'use strict';

const { loadSettings, resolveVoiceConfig, resolveSearchConfig } = require('../infra/config');
const { deepseek, zhihu } = require('../modules/search');

function voiceKey(config, url) {
  if ((config.voice?.provider || 'auto') === 'follow') return resolveVoiceConfig(config).apiKey || '';
  const s = loadSettings(config);
  if (config.voice?.apiKey) return config.voice.apiKey;
  if (s.voiceApiKey || s.keys?.voice) return s.voiceApiKey || s.keys.voice;
  const origin = value => { try { return new URL(value).origin; } catch { return ''; } };
  let host;
  try { host = new URL(url).hostname; } catch { return ''; }
  if (['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(host) && s.keys?.qwen) return s.keys.qwen;
  if (origin(url) === origin(s.baseUrl) && s.apiKey) return s.apiKey;
  if (origin(url) === origin(config.deepseek?.baseUrl || 'https://api.deepseek.com')) return config.deepseek?.apiKey || '';
  return '';
}

async function probe(config, body = {}, deps = {}) {
  const provider = body.provider;
  if (provider === 'deepseek' || provider === 'zhihu') {
    const cfg = resolveSearchConfig(config);
    const key = provider === 'zhihu' ? cfg.zhihu?.accessSecret : cfg.deepseek?.apiKey;
    if (!key) throw new Error('请先保存该搜索 API 的 Key / Secret');
    const adapter = deps[provider] || (provider === 'zhihu' ? zhihu : deepseek);
    const rows = await adapter.search('天气', { apiKey: key, accessSecret: key, count: 1, timeoutMs: 15000, strictResponse: true });
    return { ok: true, message: `搜索接口调用成功，返回 ${rows.length} 条结果（不使用其他搜索源兜底）` };
  }
  if (provider !== 'voice') throw new Error('不支持的测试类型');
  if (config.voice?.enabled === false) throw new Error('请先开启语音识别');
  const audio = String(body.audio || '');
  if (!audio || audio.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/=\r\n]+$/.test(audio)) throw new Error('请选择不超过 2 MiB 的 WAV 测试音频');
  const bytes = Buffer.from(audio, 'base64');
  if (bytes.length > 2 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('测试文件必须是 WAV 音频');
  const v = resolveVoiceConfig(config);
  if (v.supported === false) throw new Error(v.hint);
  const url = new URL(v.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('语音接口地址无效');
  const key = v.auto ? v.apiKey : voiceKey(config, url.href);
  if (!key) throw new Error('没有可用的语音识别 Key');
  const mode = v.provider || 'auto';
  const multipart = mode === 'deepseek' || (mode === 'auto' && (url.hostname === 'api.deepseek.com' || url.hostname.endsWith('.deepseek.com') || url.pathname.replace(/\/$/, '').endsWith('/v1/tools/asr')));
  const headers = { Authorization: 'Bearer ' + key };
  let payload;
  if (multipart) {
    payload = new FormData();
    payload.append('file', new Blob([bytes], { type: 'audio/wav' }), 'test.wav');
  } else {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify({ model: v.model, input: { messages: [{ role: 'user', content: [{ audio: 'data:audio/wav;base64,' + audio }] }] } });
  }
  const response = await (deps.fetch || fetch)(url.href, { method: 'POST', headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('语音识别接口 HTTP ' + response.status);
  const data = await response.json();
  const text = multipart ? data?.text : data?.output?.choices?.[0]?.message?.content?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('接口已响应，但没有有效转写结果，请用有清晰人声的短音频重试');
  return { ok: true, message: '语音识别调用成功', sample: text.trim().slice(0, 200) };
}

module.exports = { probe, voiceKey };
