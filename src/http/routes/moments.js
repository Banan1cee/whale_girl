'use strict';

const path = require('node:path');
const { EMOTIONS, safeDirectory } = require('../../adapters/stickers');
const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');
const { applyConfigPatch } = require('../../infra/configPatch');

module.exports = function register(router) {
  // 即使启用了远程控制，朋友圈隐私也不随管理接口暴露到局域网。
  const local = req => { if (!isLoopbackRequest(req)) throw Object.assign(new Error('朋友圈仅允许本机访问'), { statusCode: 403 }); };
  const bridge = (runtime, req) => {
    local(req);
    if (!runtime.gateways.get('wechat')?.verifyToken(req, null)) throw Object.assign(new Error('桥接 token 不正确'), { statusCode: 403 });
  };
  const settings = (runtime) => {
    const m = (runtime.config && runtime.config.moments) || {};
    return {
      ok: true,
      autoLike: m.autoLike === true,
      autoLikeMaxPerDay: Number(m.autoLikeMaxPerDay) || 0,
      autoReadEveryHours: Number(m.autoReadEveryHours) || 0,
    };
  };
  router.get('/api/moments/settings', (runtime, req, res) => {
    local(req);
    return json(res, 200, settings(runtime));
  });
  router.post('/api/moments/settings', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    const patch = {};
    if (typeof body.autoLike === 'boolean') patch['moments.autoLike'] = body.autoLike;
    if (body.autoLikeMaxPerDay !== undefined) patch['moments.autoLikeMaxPerDay'] = Number(body.autoLikeMaxPerDay);
    if (body.autoReadEveryHours !== undefined) patch['moments.autoReadEveryHours'] = Number(body.autoReadEveryHours);
    if (Object.keys(patch).length) {
      applyConfigPatch(runtime, patch);
      // 改完立即按新间隔重排，不用重启内核。
      runtime.moments.startAutoRead();
    }
    return json(res, 200, settings(runtime));
  });
  const publishInfo = runtime => ({
    ok: true, ...runtime.momentsPublisher.settings(), ...runtime.momentsPublisher.status(),
  });
  const accountReady = runtime => {
    const gateway = runtime.gateways.get('wechat');
    return gateway?.bridgeStatus().online && gateway.bridge.accountOk === true ? gateway.bridge.account : '';
  };
  router.get('/api/moments/publish-settings', async (runtime, req, res) => {
    local(req);
    await runtime.momentsPublisher.prepareImages();
    return json(res, 200, publishInfo(runtime));
  });
  router.post('/api/moments/publish-settings', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    const featureEnabled = body.featureEnabled === true;
    const enabled = featureEnabled && body.enabled === true;
    const account = enabled ? accountReady(runtime) : runtime.momentsPublisher.settings().account;
    if (enabled && !account) {
      return json(res, 400, { ok: false, error: '请启动桥接，等待微信账号确认后再开启定时发表' });
    }
    applyConfigPatch(runtime, {
      'moments.publishFeatureEnabled': featureEnabled, 'moments.publishEnabled': enabled,
      'moments.publishAccount': account, 'moments.publishWithImage': body.withImage === true,
      'moments.publishIntervalHours': body.interval, 'moments.publishMaxPerDay': body.maxPerDay,
    });
    return json(res, 200, publishInfo(runtime));
  });
  router.post('/api/moments/publish-test', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    if (body.confirm !== true) return json(res, 400, { ok: false, error: '立即生成并发表一条朋友圈' });
    const code = runtime.momentsPublisher.queueTest(accountReady(runtime), body.withImage === true);
    if (!code) return json(res, 200, publishInfo(runtime));
    const messages = {
      feature_disabled: '请先开启并保存朋友圈发表总开关',
      account_not_verified: '请先启动桥接并确认微信账号，或检查发表状态文件',
      busy: '还有一条朋友圈任务未完成',
      daily_limit: '今天已达到发表上限',
    };
    return json(res, 409, { ok: false, error: messages[code] });
  });
  router.post('/api/moments/publish-folder', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    if (!Object.hasOwn(EMOTIONS, body.emotion)) return json(res, 400, { ok: false, error: '分类无效' });
    await runtime.momentsPublisher.prepareImages();
    return json(res, 200, { ok: true,
      dir: safeDirectory(path.join(runtime.momentsPublisher.images, EMOTIONS[body.emotion])),
    });
  });
  router.post('/api/moments/publish-gate', async (runtime, req, res) => {
    bridge(runtime, req);
    const body = await readBody(req) || {};
    return json(res, 200, { ok: true, allowed: Boolean(body.account && body.account === accountReady(runtime)
      && runtime.momentsPublisher.allowed(body.id, body.account)) });
  });
  router.get('/api/moments/latest', (runtime, req, res) => {
    local(req);
    return json(res, 200, { ok: true, snapshot: runtime.moments.snapshot() });
  });
  router.post('/api/moments/read', async (runtime, req, res) => {
    local(req);
    return json(res, 200, runtime.moments.request(await readBody(req)));
  });
  router.post('/api/moments/action', async (runtime, req, res) => {
    local(req);
    return json(res, 200, runtime.moments.action(await readBody(req)));
  });
  router.get('/api/moments/result', (runtime, req, res, info) => {
    local(req);
    return json(res, 200, runtime.moments.result(info.url.searchParams.get('id')));
  });
  router.post('/api/moments/claim', async (runtime, req, res) => {
    bridge(runtime, req);
    const body = await readBody(req);
    const job = runtime.moments.claim(body.account)
      || (body.account && body.account === accountReady(runtime) ? runtime.momentsPublisher?.claim(body.account) : null);
    return json(res, 200, { ok: true, job });
  });
  router.post('/api/moments/complete', async (runtime, req, res) => {
    bridge(runtime, req);
    const body = await readBody(req);
    if (body?.publishStatus) return json(res, 200, { ok: runtime.momentsPublisher.complete(body) });
    return json(res, 200, runtime.moments.complete(body));
  });
};
