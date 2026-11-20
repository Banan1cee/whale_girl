'use strict';

// 离线配置复用内核的验证和保存规则，不启动聊天服务。
const { loadConfig } = require('../infra/config');
const { publicConfig, applyConfigPatch, resetConfig } = require('../infra/configPatch');
const { DeepSeekClient } = require('../llm/client');
const { getSettings, applySettings } = require('./settings');
const persona = require('../persona/store');
const presets = require('../persona/presets');
const features = require('../infra/features');
const { ReminderService } = require('../modules/reminders');

const { applyPersonaPatch, savePersonaPreset, deletePersonaPreset, renamePersonaPreset, currentPersonaWarnings } = require('../modules/persona');
const { DiaryService } = require('../modules/diary');
const { MomentsPublisher } = require('../modules/moments');
const { prepareFeatureCommand, momentsSettings, prepareMomentsSettingsPatch, prepareMomentsPublishPatch } = require('./configCommands');

async function saveLocalConfiguration(root, { path, body }, env = process.env) {
  const config = loadConfig({ root, env, readOnly: true });
  persona.apply(config, persona.load(config));
  const llm = new DeepSeekClient({ config });
  // 离线保存只在本机估算人设长度，不调用模型服务。
  llm.countPromptTokens = undefined;
  const runtime = { config, llm, logger: { info() {}, warn() {} },
    gateways: new Map(), store: { summary: () => ({}) }, startedAt: Date.now(), offlineConfiguration: true };
  const save = patch => { applyConfigPatch(runtime, patch); return { ok: true, ...publicConfig(config) }; };
  switch (path) {
    case '/api/config': return save(body.patch);
    case '/api/config/reset': {
      const result = resetConfig(runtime, body.paths);
      return { ok: true, ...result, ...publicConfig(config) };
    }
    case '/api/settings': return applySettings(runtime, body);
    case '/api/persona': return applyPersonaPatch(runtime, body);
    case '/api/persona/preset/save': return savePersonaPreset(runtime, body);
    case '/api/persona/preset/delete': return deletePersonaPreset(runtime, body);
    case '/api/persona/preset/rename': return renamePersonaPreset(runtime, body);
    case '/api/persona/preset/reset-market': return presets.resetMarketCopy(config, body.id);
    case '/api/persona/export': {
      const document = presets.fromConfig(config);
      return document.customPrompt.length <= 24000 ? { ok: true, persona: document }
        : { ok: false, error: '可分享包的自定义提示词最多 24000 字符，请先精简。' };
    }
    case '/api/persona/preset': {
      const patch = presets.toPatch(presets.load(config, body.id));
      return patch ? applyPersonaPatch(runtime, { ...patch, sourcePreset: body.id })
        : { ok: false, error: '没有可导入的人设预设' };
    }
    case '/api/features': {
      let command;
      try { command = prepareFeatureCommand(body); }
      catch { return { ok: false, error: '无效的功能设置' }; }
      save(command.patch);
      return { ok: true, features: features.list(config) };
    }
    case '/api/moments/settings':
      save(prepareMomentsSettingsPatch(body));
      return momentsSettings(config);
    case '/api/moments/publish-settings': {
      const publisher = new MomentsPublisher({ config });
      const current = publisher.settings();
      const patch = prepareMomentsPublishPatch(body, current);
      const enabled = (patch['moments.publishFeatureEnabled'] ?? current.featureEnabled)
        && (patch['moments.publishEnabled'] ?? current.enabled);
      const changingEnablement = Object.hasOwn(patch, 'moments.publishFeatureEnabled') || Object.hasOwn(patch, 'moments.publishEnabled');
      if (changingEnablement && enabled && !current.account) {
        return { ok: false, error: '首次开启定时发表需要启动桥接并确认微信账号；可先保存其他发表设置。' };
      }
      save(patch);
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
    '/api/config': { ok: true, config: pub.config, secrets: pub.secrets, secretMasks: pub.secretMasks },
    '/api/settings': getSettings(runtime),
    '/api/persona': (() => {
      const p = persona.summary(config);
      return { ok: true, persona: p, warnings: currentPersonaWarnings(config), presetSource: presets.sourceOf(config, p.sourcePreset) };
    })(),
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
