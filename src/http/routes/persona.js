'use strict';

const personaStore = require('../../persona/store');
const presets = require('../../persona/presets');
const {
  savePersonaPreset, deletePersonaPreset, renamePersonaPreset, currentPersonaWarnings,
  shareDocument, importPersonaPreset,
} = require('../../services/persona');
const { json, readBody } = require('../util');
const { hostCall } = require('../../services/features/hostCall');

module.exports = function register(router) {
  router.get('/api/persona', (runtime, req, res) => {
    const persona = personaStore.summary(runtime.config);
    return json(res, 200, {
      ok: true,
      persona,
      // 打开人设页就提示已有冲突，而不是等用户改完保存才看到。
      warnings: currentPersonaWarnings(runtime.config),
      // 区分来源以便显示各预设可用的操作。
      presetSource: presets.sourceOf(runtime.config, persona.sourcePreset),
      llm: {
        provider: runtime.llm.provider,
        providerLabel: runtime.llm.providerLabel,
        model: runtime.llm.model,
        mock: runtime.llm.isMock,
      },
    });
  });

  router.post('/api/persona', async (runtime, req, res) => {
    const body = await readBody(req);
    // 人设保存与插件 host.call 走同一个能力：校验、限长、落盘只有一份实现。
    const result = await hostCall(runtime, 'persona.write@1', body);
    return json(res, result && result.ok ? 200 : 400, result);
  });

  // 人设预设：assets/personas/ 下每个版本一个文件
  router.get('/api/persona/presets', (runtime, req, res) => {
    return json(res, 200, { ok: true, presets: presets.list(runtime.config) });
  });

  router.post('/api/persona/export', (runtime, req, res) => {
    // 限长规则与离线保存共用同一份（services/persona.js）。
    const { document, overLimit } = shareDocument(runtime.config);
    if (overLimit) return json(res, 400, { ok: false, error: '可分享包的自定义提示词最多 24000 字符，请先精简；当前人设未修改。' });
    return json(res, 200, { ok: true, persona: document });
  });

  // 预览：只回内容、不写盘 —— 页面选到哪版就先把那版填进输入框，
  // 用户看一眼再点保存，不用先点「导入」。
  router.get('/api/persona/preset', (runtime, req, res, info) => {
    const preset = presets.load(runtime.config, info.url.searchParams.get('id'));
    if (!preset) return json(res, 404, { ok: false, error: '没有这个人设预设' });
    const patch = presets.toPatch(preset);
    if (!patch) return json(res, 400, { ok: false, error: '这个人设预设是空的' });
    return json(res, 200, {
      ok: true,
      preset: {
        id: preset.id,
        version: preset.version || '',
        name: preset.name || '',
        description: preset.description || '',
      },
      patch,
    });
  });

  router.post('/api/persona/preset', async (runtime, req, res) => {
    const body = await readBody(req);
    // 取预设、token 闸、写盘、热更新与离线保存共用同一份实现。
    const result = await importPersonaPreset(runtime, body);
    if (!result.ok) {
      if (result.code === 'too_long') {
        const check = result.tokenCheck || {};
        return json(res, 400, {
          ok: false,
          error: `这个人设预设太长：${check.exact ? '' : '约 '}${check.tokens} token，超过当前上限 ${check.limit}。`,
          tokenCheck: result.tokenCheck,
        });
      }
      return json(res, result.status || 400, {
        ok: false,
        // 在线保持原有的预览/导入文案；离线才用“没有可导入的人设预设”。
        error: result.error || (result.code === 'preset_empty' ? '这个人设预设是空的' : '没有这个人设预设'),
      });
    }
    return json(res, 200, {
      ok: true,
      applied: result.applied,
      persona: result.persona,
      tokenCheck: result.tokenCheck,
    });
  });

  router.post('/api/persona/preset/reset-market', async (runtime, req, res) => {
    const body = await readBody(req);
    const result = presets.resetMarketCopy(runtime.config, body && body.id);
    return json(res, result.ok ? 200 : 400, result);
  });

  // 另存为 / 更新自建预设
  router.post('/api/persona/preset/save', async (runtime, req, res) => {
    const body = await readBody(req);
    const result = await savePersonaPreset(runtime, body);
    return json(res, result && result.ok ? 200 : 400, result);
  });

  // 删除预设：自建物理删，内置/市场隐藏；正在使用的不许删
  router.post('/api/persona/preset/delete', async (runtime, req, res) => {
    const body = await readBody(req);
    const result = deletePersonaPreset(runtime, body);
    return json(res, result && result.ok ? 200 : 400, result);
  });

  // 重命名自建预设
  router.post('/api/persona/preset/rename', async (runtime, req, res) => {
    const body = await readBody(req);
    const result = renamePersonaPreset(runtime, body);
    return json(res, result && result.ok ? 200 : 400, result);
  });
};
