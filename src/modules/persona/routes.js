'use strict';

const personaStore = require('../../persona/store');
const presets = require('../../persona/presets');
const { applyPersonaPatch, savePersonaPreset, deletePersonaPreset, renamePersonaPreset, currentPersonaWarnings } = require('./service');
const { checkPersonaTokens } = require('../../persona/tokenCheck');
const styleProfile = require('../../persona/styleProfile');
const { json, readBody } = require('../../http/util');
const { isLoopbackRequest } = require('../../http/security');
const { saveSettings } = require('../../infra/config');
const { saveConfigPatch } = require('../../infra/configPatch');
const { describeError, errorMessage } = require('../../infra/errors');

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
    const result = await applyPersonaPatch(runtime, body);
    return json(res, result && result.ok ? 200 : 400, result);
  });

  // 人设预设：assets/personas/ 下每个版本一个文件
  router.get('/api/persona/presets', (runtime, req, res) => {
    return json(res, 200, { ok: true, presets: presets.list(runtime.config) });
  });

  router.post('/api/persona/export', (runtime, req, res) => {
    const persona = presets.fromConfig(runtime.config);
    if (persona.customPrompt.length > 24000) return json(res, 400, { ok: false, error: '可分享包的自定义提示词最多 24000 字符，请先精简；当前人设未修改。' });
    return json(res, 200, { ok: true, persona });
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
    const preset = presets.load(runtime.config, body && body.id);
    if (!preset) return json(res, 404, { ok: false, error: '没有这个人设预设' });
    const patch = presets.toPatch(preset);
    if (!patch) return json(res, 400, { ok: false, error: '这个人设预设是空的' });
    // 记下来源，页面上能直接看到「现在用的是哪一版」
    patch.sourcePreset = preset.id;
    // 导入预设同样做一次精确 token 校验，避免导进一个会顶爆单轮上限的人设
    const tokenCheck = await checkPersonaTokens(runtime, patch);
    if (tokenCheck.overLimit) {
      runtime.logger.warn(`人设预设 ${preset.id} 太长，拒绝导入：${tokenCheck.tokens} token`);
      return json(res, 400, {
        ok: false,
        error: `这个人设预设太长：${tokenCheck.exact ? '' : '约 '}${tokenCheck.tokens} token，超过当前上限 ${tokenCheck.limit}。`,
        tokenCheck,
      });
    }
    personaStore.save(runtime.config, patch);
    if (patch.ownerName !== undefined) saveSettings(runtime.config, { userName: runtime.config.persona.ownerName });
    runtime.logger.info(`人设预设：已导入 ${preset.id}（${preset.version || '无版本号'}，${tokenCheck.tokens} token）`);
    return json(res, 200, {
      ok: true,
      applied: { id: preset.id, version: preset.version || '', name: preset.name || '' },
      persona: personaStore.summary(runtime.config),
      tokenCheck,
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

  /* ---------------------------- 聊天风格画像 ---------------------------- */

  router.get('/api/persona/style', (runtime, req, res) => {
    const mode = styleProfile.normalizeMode(runtime.config.persona && runtime.config.persona.styleMode);
    return json(res, 200, {
      ok: true,
      mode,
      profile: styleProfile.publicProfile(styleProfile.load(runtime.config), mode),
    });
  });

  // 分析会读本机聊天记录：只允许 loopback，远程 token 也不行。
  router.post('/api/persona/style/analyze', async (runtime, req, res) => {
    if (!isLoopbackRequest(req)) {
      return json(res, 403, { ok: false, error: '风格分析只允许在本机操作' });
    }
    const body = await readBody(req);
    const source = body && body.source;
    if (source !== 'memory' && source !== 'export') {
      return json(res, 400, { ok: false, error: 'source 只能是 memory 或 export' });
    }
    const options = {
      owner: typeof body.owner === 'string' ? body.owner : undefined,
      useLlm: body.useLlm === true,
      llm: runtime.llm || null,
    };
    const startedAt = Date.now();
    try {
      const profile = source === 'export'
        ? await styleProfile.analyzeExport(runtime.config, body.file, options)
        : await styleProfile.analyzeMemory(runtime.config, options);
      const saved = styleProfile.save(runtime.config, profile);
      runtime.styleProfile = saved;
      if (runtime.bot) runtime.bot.styleProfile = saved;
      const mode = styleProfile.normalizeMode(runtime.config.persona && runtime.config.persona.styleMode);
      runtime.logger.info(
        `风格画像已更新：来源=${source} 样本=${saved.sampleCount} 会话=${saved.chatCount} `
        + `推断主人=${saved.assumedOwner ? '是' : '否'} 耗时=${Date.now() - startedAt}ms`
      );
      return json(res, 200, { ok: true, mode, profile: styleProfile.publicProfile(saved, mode) });
    } catch (err) {
      const status = Number(err && err.statusCode) === 400 ? 400 : 500;
      runtime.logger.warn(`风格分析失败：${describeError(err)}`);
      return json(res, status, { ok: false, error: errorMessage(err, '风格分析失败') });
    }
  });

  router.post('/api/persona/style/mode', async (runtime, req, res) => {
    const body = await readBody(req);
    const mode = styleProfile.normalizeMode(body && body.mode);
    saveConfigPatch(runtime.config, { 'persona.styleMode': mode });
    return json(res, 200, { ok: true, mode });
  });

  router.post('/api/persona/style/clear', (runtime, req, res) => {
    styleProfile.clear(runtime.config);
    runtime.styleProfile = null;
    if (runtime.bot) runtime.bot.styleProfile = null;
    return json(res, 200, { ok: true });
  });
};
