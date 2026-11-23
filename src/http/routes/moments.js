'use strict';

const path = require('node:path');
const { EMOTIONS, safeDirectory } = require('../../adapters/stickers');
const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');
const { applyConfigPatch } = require('../../infra/configPatch');
const { prepareMomentsPublishPatch, prepareMomentsSettingsPatch, applyMomentsSettings } = require('../../services/configCommands');
const { hostCall } = require('../../services/features/hostCall');

/**
 * 朋友圈 HTTP 接口。
 *
 * 这一层只做传输：回环校验、桥接 token、readBody、状态码与响应形状。
 * 所有功能调用都走 runtime.capabilities.invokeHost(能力名, 输入)，
 * 和插件 host.call 是同一条路，避免路由和 SDK 各写一套实现。
 *
 * 夹具场景（单元测试只裁出 moments/momentsPublisher 的对象）没有装配
 * runtime.capabilities，这时就地为它组一个只含功能能力的 dispatcher：
 * 校验与分发仍是同一份代码，不是第二条实现路径。
 */


module.exports = function register(router) {
  // 即使启用了远程控制，朋友圈隐私也不随管理接口暴露到局域网。
  const local = req => { if (!isLoopbackRequest(req)) throw Object.assign(new Error('朋友圈仅允许本机访问'), { statusCode: 403 }); };
  const bridge = (runtime, req) => {
    local(req);
    if (!runtime.gateways.get('wechat')?.verifyToken(req, null)) throw Object.assign(new Error('桥接 token 不正确'), { statusCode: 403 });
  };
  const settings = async runtime => {
    const out = await hostCall(runtime, 'moments.settings@1', {});
    return { ok: true, ...out.settings };
  };
  const publishInfo = async runtime => {
    const out = await hostCall(runtime, 'moments.settings@1', {});
    return { ok: true, ...out.publish, ...out.status };
  };
  const publishAccount = runtime => {
    const gateway = runtime.gateways.get('wechat');
    return gateway?.bridgeStatus().online && gateway.bridge.accountOk === true ? gateway.bridge.account : '';
  };
  router.get('/api/moments/settings', async (runtime, req, res) => {
    local(req);
    return json(res, 200, await settings(runtime));
  });
  router.post('/api/moments/settings', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    // 与离线保存共用字段清单和写盘/热重载；在线这一侧保留设置页的类型过滤，
    // 只纠正「空白不等于零」。
    applyMomentsSettings(runtime, prepareMomentsSettingsPatch(body, { mode: 'online' }));
    return json(res, 200, await settings(runtime));
  });
  router.get('/api/moments/publish-settings', async (runtime, req, res) => {
    local(req);
    await runtime.momentsPublisher.prepareImages();
    return json(res, 200, await publishInfo(runtime));
  });
  router.post('/api/moments/publish-settings', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    const current = (await hostCall(runtime, 'moments.settings@1', {})).publish;
    const patch = prepareMomentsPublishPatch(body, current);
    const enabled = (patch['moments.publishFeatureEnabled'] ?? current.featureEnabled)
      && (patch['moments.publishEnabled'] ?? current.enabled);
    const explicitlyConfirmedEnable = body.featureEnabled === true && body.enabled === true;
    const wasEnabled = current.featureEnabled === true && current.enabled === true;
    if ((body.enabled === true && !explicitlyConfirmedEnable)
        || (enabled && !wasEnabled && !explicitlyConfirmedEnable)) {
      return json(res, 400, { ok: false, error: '开启定时发表需要同时确认开启选项' });
    }
    if (explicitlyConfirmedEnable) {
      const account = publishAccount(runtime);
      if (!account) {
        return json(res, 400, { ok: false, error: '请启动桥接，等待微信账号确认后再开启定时发表' });
      }
      patch['moments.publishAccount'] = account;
    }
    applyConfigPatch(runtime, patch);
    return json(res, 200, await publishInfo(runtime));
  });
  router.post('/api/moments/publish-test', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    if (body.confirm !== true) return json(res, 400, { ok: false, error: '立即生成并发表一条朋友圈' });
    const out = await hostCall(runtime, 'moments.publish@1', { action: 'test', withImage: body.withImage === true });
    if (out.ok) return json(res, 200, await publishInfo(runtime));
    const messages = {
      feature_disabled: '请先开启并保存朋友圈发表总开关',
      account_not_verified: '请先启动桥接并确认微信账号，或检查发表状态文件',
      busy: '还有一条朋友圈任务未完成',
      daily_limit: '今天已达到发表上限',
    };
    return json(res, 409, { ok: false, error: messages[out.code] || '发表没有开始，请稍后再试' });
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
    const out = await hostCall(runtime, 'moments.publish@1', { action: 'gate', id: body.id, account: body.account });
    return json(res, 200, { ok: true, allowed: Boolean(out.allowed) });
  });
  router.get('/api/moments/latest', async (runtime, req, res) => {
    local(req);
    const out = await hostCall(runtime, 'moments.snapshot@1', {});
    return json(res, 200, { ok: true, snapshot: out.snapshot });
  });
  router.post('/api/moments/read', async (runtime, req, res) => {
    local(req);
    return json(res, 200, await hostCall(runtime, 'moments.request@1', await readBody(req)));
  });
  router.post('/api/moments/action', async (runtime, req, res) => {
    local(req);
    return json(res, 200, await hostCall(runtime, 'moments.action@1', await readBody(req)));
  });
  router.get('/api/moments/result', async (runtime, req, res, info) => {
    local(req);
    return json(res, 200, await hostCall(runtime, 'moments.result@1', { id: info.url.searchParams.get('id') }));
  });
  router.post('/api/moments/claim', async (runtime, req, res) => {
    bridge(runtime, req);
    const out = await hostCall(runtime, 'moments.claim@1', await readBody(req));
    return json(res, 200, { ok: true, job: out.job });
  });
  router.post('/api/moments/complete', async (runtime, req, res) => {
    bridge(runtime, req);
    return json(res, 200, await hostCall(runtime, 'moments.complete@1', await readBody(req)));
  });
};
