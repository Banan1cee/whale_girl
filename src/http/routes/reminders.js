'use strict';

/**
 * 提醒的 HTTP 接口。
 *
 *   GET  /api/reminders          启动器列表（本机）
 *   POST /api/reminders/cancel   取消一条（本机）
 *   GET  /api/reminders/due      桥接来领到点的（只允许本机 + 桥接 token）
 *   POST /api/reminders/ack      桥接回执（只允许本机 + 桥接 token）
 *
 * 发送在桥接那边做，服务端只存状态，不直接发消息。
 * 业务调用一律走宿主能力（runtime.capabilities.invokeHost）；这里只留下
 * 本机/桥接 token 校验、HTTP 状态码和日志。
 */

const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');
const { textMeta } = require('../../infra/privacy');
const { hostCall } = require('../../services/features/hostCall');

const BRIDGE_ONLY = new Set(['/api/reminders/due', '/api/reminders/ack', '/api/reminders/permission']);

module.exports = function register(router) {
  router.pattern(/^\/api\/reminders(?:\/.*)?$/, async (runtime, req, res, info) => {
    const service = runtime.reminders;
    if (!service) return json(res, 404, { ok: false, error: '提醒未启用' });
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '提醒接口仅允许本机访问' });
    if (BRIDGE_ONLY.has(info.pathname)) {
      const gw = runtime.gateways && runtime.gateways.get && runtime.gateways.get('wechat');
      if (!gw || !gw.verifyToken(req, null)) {
        return json(res, 403, { ok: false, error: '桥接 token 不正确' });
      }
    }
    const method = req.method || 'GET';
    if (info.pathname === '/api/reminders/permission' && method === 'POST') {
      const body = await readBody(req);
      const out = await hostCall(runtime, 'reminders.permission@1', { id: body && body.id });
      return json(res, 200, out);
    }

    if (info.pathname === '/api/reminders' && method === 'GET') {
      const out = await hostCall(runtime, 'reminders.rules@1', {});
      return json(res, 200, {
        ok: true,
        // 列表投影是启动器专用的（带 wxid/name/attempts/error 等界面字段），
        // 与插件契约 reminders.list@1 的精简投影故意不同，所以这里仍读服务层投影。
        items: service.list(),
        // 规则跟主动搭话同源同语义，但存在 config.reminder.*，界面也独立
        rules: out.rules,
      });
    }

    if (info.pathname === '/api/reminders/cancel' && method === 'POST') {
      const body = await readBody(req);
      // 取消的失败载荷和成功载荷都是「整条 item」，与插件契约 reminders.cancel@1（{ok,id}）不同，
      // 走能力会改变启动器依赖的响应体，因此这一条留在路由里调服务层。
      const out = service.cancel(body && body.id);
      if (!out.ok) return json(res, out.statusCode || 400, out);
      runtime.logger.info(`提醒已取消：id=${out.item.id} ${textMeta(out.item.text)}`);
      return json(res, 200, { ok: true, item: out.item });
    }

    if (info.pathname === '/api/reminders/due' && method === 'GET') {
      const out = await hostCall(runtime, 'reminders.due@1', {});
      if (out.items.length) runtime.logger.info(`提醒到期 ${out.items.length} 条，等桥接发送`);
      return json(res, 200, { ok: true, ...out });
    }

    if (info.pathname === '/api/reminders/ack' && method === 'POST') {
      const body = await readBody(req);
      const out = await hostCall(runtime, 'reminders.ack@1', {
        id: body && body.id,
        ok: Boolean(body && body.ok),
        error: (body && body.error) || '',
        uncertain: body?.uncertain === true,
      });
      if (!out.ok) return json(res, out.statusCode || 400, out);
      const it = out.item;
      runtime.logger.info(`提醒回执：${it.status}${it.error ? '（' + it.error + '）' : ''} id=${it.id} ${textMeta(it.text)}`);
      return json(res, 200, { ok: true, item: it });
    }

    return json(res, 404, { ok: false, error: '没有这个接口' });
  });
};
