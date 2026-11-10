'use strict';

// 离线配置复用内核的验证和保存规则，不启动聊天服务。
const { loadConfig } = require('../infra/config');
const { publicConfig, applyConfigPatch, resetConfig } = require('../infra/configPatch');
const { DeepSeekClient } = require('../llm/client');
const { getSettings, applySettings } = require('./settings');
const persona = require('../persona/store');
const presets = require('../persona/presets');
const features = require('../infra/features');
const { ReminderService } = require('./reminderService');

const { applyPersonaPatch } = require('./persona');
const { DiaryService } = require('./diary');
const { MomentsPublisher } = require('./momentsPublisher');

function momentsSettings(config) {
  const m = config.moments || {};
  return { ok: true, autoLike: m.autoLike === true,
    autoLikeMaxPerDay: Number(m.autoLikeMaxPerDay) || 0,
    autoReadEveryHours: Number(m.autoReadEveryHours) || 0 };
}

async function saveLocalConfiguration(root, { path, body }, env = process.env) {
  const config = loadConfig({ root, env, readOnly: true });
  persona.apply(config, persona.load(config));
  const llm = new DeepSeekClient({ config });
  // 离线保存只在本机估算人设长度，不调用模型服务。
  llm.countPromptTokens = undefined;
  const runtime = { config, llm, logger: { info() {}, warn() {} },
    gateways: new Map(), store: { summary: () => ({}) }, startedAt: Date.now() };
  const save = patch => { applyConfigPatch(runtime, patch); return { ok: true, ...publicConfig(config) }; };
  switch (path) {
    case '/api/config': return save(body.patch);
    case '/api/config/reset': {
      const result = resetConfig(runtime, body.paths);
      return { ok: true, ...result, ...publicConfig(config) };
    }
    case '/api/settings': return applySettings(runtime, body);
    case '/api/persona': return applyPersonaPatch(runtime, body);
    case '/api/persona/preset': {
      const patch = presets.toPatch(presets.load(config, body.id));
      return patch ? applyPersonaPatch(runtime, { ...patch, sourcePreset: body.id })
        : { ok: false, error: '没有可导入的人设预设' };
    }
    case '/api/features': {
      const feature = features.REGISTRY.find(entry => entry.key === body.key);
      if (!feature || typeof body.value !== 'boolean') return { ok: false, error: '无效的功能设置' };
      save({ [feature.path]: body.value });
      return { ok: true, features: features.list(config) };
    }
    case '/api/moments/settings':
      save({ 'moments.autoLike': body.autoLike, 'moments.autoLikeMaxPerDay': body.autoLikeMaxPerDay,
        'moments.autoReadEveryHours': body.autoReadEveryHours });
      return momentsSettings(config);
    case '/api/moments/publish-settings': {
      const publisher = new MomentsPublisher({ config });
      const current = publisher.settings();
      const enabled = body.featureEnabled === true && body.enabled === true;
      if (enabled && !current.account) {
        return { ok: false, error: '首次开启定时发表需要启动桥接并确认微信账号；可先保存其他发表设置。' };
      }
      save({ 'moments.publishFeatureEnabled': body.featureEnabled === true,
        'moments.publishEnabled': enabled, 'moments.publishWithImage': body.withImage === true,
        'moments.publishIntervalHours': body.interval, 'moments.publishMaxPerDay': body.maxPerDay });
      return { ok: true, ...publisher.settings(), ...publisher.status() };
    }
    default: return { ok: false, error: '此操作需要启动内核。' };
  }
}

function readSnapshot(root, env = process.env) {
  const config = loadConfig({ root, env, readOnly: true });
  Object.defineProperty(config, 'readOnly', { value: true });
  persona.apply(config, persona.load(config));
  const runtime = { config, llm: new DeepSeekClient({ config }) };
  const pub = publicConfig(config);
  const reminders = new ReminderService(config);
  const rules = reminders.rules();
  const publisher = new MomentsPublisher({ config });
  return {
    '/api/diary': { ok: true, ...new DiaryService(config, {}).status(), message: '启动内核后可生成日记' },
    '/api/moments/settings': momentsSettings(config),
    '/api/moments/publish-settings': { ok: true, ...publisher.settings(), ...publisher.status() },
    '/api/config': { ok: true, config: pub.config, secrets: pub.secrets },
    '/api/settings': getSettings(runtime),
    '/api/persona': { ok: true, persona: persona.summary(config) },
    '/api/persona/presets': { ok: true, presets: presets.list(config) },
    '/api/features': { ok: true, features: features.list(config) },
    '/api/reminders': { ok: true, items: reminders.list(), rules: {
      enabled: rules.enabled, maxPerDay: rules.dailyCap,
      quietAfterMinutes: rules.quietAfterMinutes, sentToday: rules.sentToday,
    } },
  };
}

if (require.main === module) {
  (async () => {
    if (process.argv[2] !== '--save') return readSnapshot(process.cwd());
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    try { return await saveLocalConfiguration(process.cwd(), JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (error) { return { ok: false, error: error.message }; }
  })().then(result => process.stdout.write(JSON.stringify(result))).catch(() => {
    process.stderr.write('无法读取本地配置，请检查配置文件格式与目录权限。');
    process.exitCode = 1;
  });
}

module.exports = { readSnapshot, saveLocalConfiguration };
