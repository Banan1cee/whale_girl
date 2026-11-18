'use strict';

const { saveSettings } = require('../infra/config');
const personaStore = require('../persona/store');
const presets = require('../persona/presets');
const { checkPersonaTokens } = require('../persona/tokenCheck');
const { LIMITS } = require('../memory/constants');
const { describeError } = require('../infra/errors');
const { identityPatch, usesNewPersona } = require('../persona/profile');
const { portableFields } = require('../persona/portable');
const { legacyPatch } = require('../persona/legacy');
const { checkCustomPrompt } = require('../persona/conflict');

/* ---------------- 人设调教（/api/persona 用） ---------------- */

/** 用「即将保存的值」覆盖当前配置，提醒才对得上用户刚改的内容。 */
function conflictInput(config, patch = {}) {
  const persona = config.persona || {};
  const chat = config.chat || {};
  const pick = (key, fallback) => (patch[key] === undefined ? fallback : patch[key]);
  return {
    customPrompt: pick('customPrompt', persona.customPrompt),
    name: pick('name', persona.name),
    ownerName: pick('ownerName', persona.ownerName),
    personality: pick('personality', persona.personality),
    appearance: pick('appearance', persona.appearance),
    background: pick('background', persona.background),
    privateMaxChars: pick('privateMaxChars', chat.privateMaxChars),
    groupMaxChars: pick('groupMaxChars', chat.groupMaxChars),
  };
}

/** 读取人设页时也要显示已存在的冲突，不能只在保存后提示。 */
function currentPersonaWarnings(config) {
  return usesNewPersona(config) ? checkCustomPrompt(conflictInput(config)) : [];
}

async function applyPersonaPatch(runtime, body) {
  if (body && body.reset) {
    personaStore.clear(runtime.config);
    runtime.logger.info('人设调教：恢复默认');
    return { ok: true, persona: personaStore.summary(runtime.config) };
  }
  const patch = identityPatch(body);
  if (typeof body.newBehavior === 'boolean') patch.newBehavior = body.newBehavior;
  Object.assign(patch, legacyPatch(body, runtime.config.persona.customPrompt || ''));
  const portable = portableFields(body);
  for (const key of ['ownerName', 'aliases', 'masterRoast', 'proactive', 'opinions', 'emojiChance', 'maxBubbles', 'discussionMaxChars']) {
    if (Object.hasOwn(portable, key)) patch[key] = portable[key];
  }
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  if (body.emoji !== undefined) patch.emoji = ['关', '少', '正常', '多'].includes(body.emoji) ? body.emoji : '正常';
  if (body.historyTurns !== undefined) patch.historyTurns = Math.max(4, Math.min(400, Number(body.historyTurns) || 200));
  if (body.groupHistoryTurns !== undefined) patch.groupHistoryTurns = Math.max(2, Math.min(300, Number(body.groupHistoryTurns) || 150));
  if (body.privateMaxChars !== undefined) patch.privateMaxChars = Math.max(40, Math.min(800, Number(body.privateMaxChars) || 140));
  if (body.groupMaxChars !== undefined) patch.groupMaxChars = Math.max(20, Math.min(300, Number(body.groupMaxChars) || 70));
  for (const k of ['proactive', 'opinions', 'links', 'freeChat']) {
    if (body[k] !== undefined) patch[k] = Boolean(body[k]);
  }
  if (Array.isArray(body.mutedGroups)) patch.mutedGroups = body.mutedGroups.map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
  // 记住「这一版是从哪个预设载入的」，页面上能直接显示当前生效的是哪一版
  if (body.sourcePreset !== undefined) patch.sourcePreset = str(body.sourcePreset, 80);
  // 人设保存/导入时才做精确 token 校验；每轮聊天仍然用轻量估算。
  const tokenCheck = await checkPersonaTokens(runtime, patch);
  const warnings = (patch.newBehavior ?? usesNewPersona(runtime.config))
    ? checkCustomPrompt(conflictInput(runtime.config, patch)) : [];
  if (tokenCheck.overLimit) {
    runtime.logger.warn(
      `人设太长，拒绝保存：${tokenCheck.tokens} token（上限 ${tokenCheck.limit}，${tokenCheck.exact ? '官方计数' : '估算'}）`
    );
    return {
      ok: false,
      error: `人设太长：${tokenCheck.exact ? '' : '约 '}${tokenCheck.tokens} token，超过当前上限 ${tokenCheck.limit}。`
        + `单人设（system）不计入对话预算，但单轮合计不能超过 ${LIMITS.hardTotalTokens.toLocaleString('en-US')} token，请精简设定或自定义提示词。`,
      tokenCheck,
      warnings,
    };
  }
  personaStore.save(runtime.config, patch);
  if (patch.ownerName !== undefined) saveSettings(runtime.config, { userName: runtime.config.persona.ownerName });
  if (body.model) {
    try {
      saveSettings(runtime.config, { model: String(body.model).slice(0, 80), mock: false });
      runtime.llm.reload();
    } catch (err) {
      runtime.logger.warn('人设调教：切模型失败 ' + describeError(err));
    }
  }
  runtime.logger.info('人设调教：已保存 ' + Object.keys(patch).join(','));
  runtime.logger.info(
    `人设 token：${tokenCheck.tokens}（${tokenCheck.exact ? '官方计数' : '估算'}，上限 ${tokenCheck.limit}）`
  );
  return {
    ok: true,
    persona: personaStore.summary(runtime.config),
    tokenCheck,
    warnings,
    llm: {
      provider: runtime.llm.provider,
      providerLabel: runtime.llm.providerLabel,
      model: runtime.llm.model,
      mock: runtime.llm.isMock,
    },
  };
}

/** 把当前人设另存为（或更新）自建预设；超 token 上限的预设导入不回来，先拒绝 */
async function savePersonaPreset(runtime, body = {}) {
  const id = String(body.id || '').trim();
  const name = String(body.name == null ? '' : body.name).replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);
  const description = String(body.description == null ? '' : body.description).replace(/[\r\n\t]/g, ' ').trim().slice(0, 300);
  if (!id && !name) return { ok: false, error: '给预设起个名字（1~40 个字）' };

  const fields = presets.fromConfig(runtime.config);
  const preview = presets.toPatch(fields) || {};
  const tokenCheck = await checkPersonaTokens(runtime, preview);
  if (tokenCheck.overLimit) {
    runtime.logger.warn(`人设预设太长，拒绝保存：${tokenCheck.tokens} token`);
    return {
      ok: false,
      error: `这份人设太长：${tokenCheck.exact ? '' : '约 '}${tokenCheck.tokens} token，超过当前上限 ${tokenCheck.limit}。先精简自定义提示词再保存为预设。`,
      tokenCheck,
    };
  }

  const result = presets.saveUser(runtime.config, { id, name, description });
  if (!result.ok) return result;
  // 存完直接把来源指向这条预设：之后改人设会回写它，不用再手动点更新
  personaStore.save(runtime.config, { sourcePreset: result.preset.id });
  runtime.logger.info(`人设预设：${id ? '已更新' : '已保存'} ${result.preset.id}（${tokenCheck.tokens} token）`);
  return {
    ok: true,
    preset: result.preset,
    presets: presets.list(runtime.config),
    persona: personaStore.summary(runtime.config),
    tokenCheck,
  };
}

/** 删除预设：自建物理删除；内置/市场只写隐藏标记；正在使用的预设拒绝删除 */
function deletePersonaPreset(runtime, body = {}) {
  const id = String(body.id || '').trim();
  const currentId = String((runtime.config.persona && runtime.config.persona.sourcePreset) || '');
  const result = presets.removePreset(runtime.config, id, { currentId });
  if (!result.ok) {
    runtime.logger.warn('人设预设删除失败：' + result.error);
    return result;
  }
  runtime.logger.info(`人设预设：已删除 ${result.id}（${result.kind}）`);
  return { ok: true, id: result.id, kind: result.kind, presets: presets.list(runtime.config) };
}

/** 重命名自建预设：只改标题，不碰内容 */
function renamePersonaPreset(runtime, body = {}) {
  const id = String(body.id || '').trim();
  const name = String(body.name == null ? '' : body.name).replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);
  const result = presets.renamePreset(runtime.config, id, name);
  if (!result.ok) return result;
  runtime.logger.info(`人设预设：已重命名 ${id} → ${result.preset.name}`);
  return { ok: true, preset: result.preset, presets: presets.list(runtime.config) };
}

module.exports = { applyPersonaPatch, savePersonaPreset, deletePersonaPreset, renamePersonaPreset, currentPersonaWarnings };
