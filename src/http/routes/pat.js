'use strict';

/**
 * 拍一拍的执行回执。
 *
 *   POST /api/pat/ack   桥接回执（只允许本机 + 桥接 token）
 *
 * 为什么需要它：拍一拍是内核决定、桥接执行的动作。以前桥接失败（会话没打开、
 * 当前界面没有可右键的对方行、抢不到前台）或者干脆没跑到，内核完全不知道：
 * 每小时额度照扣，【最近做过的事】里也没有这一笔，模型下一轮会以为自己拍过。
 * 现在桥接把结果回执回来，内核据此保留/回滚额度，并把结果记进动作账本（BUGS #128）。
 */

const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');

module.exports = function register(router) {
  router.pattern(/^\/api\/pat(?:\/.*)?$/, async (runtime, req, res, info) => {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '拍一拍回执仅允许本机访问' });
    const body = await readBody(req);
    const gw = runtime.gateways && runtime.gateways.get && runtime.gateways.get('wechat');
    if (!gw || typeof gw.verifyToken !== 'function' || !gw.verifyToken(req, body)) {
      return json(res, 403, { ok: false, error: '桥接 token 不正确' });
    }
    if (info.pathname !== '/api/pat/ack' || (req.method || 'GET') !== 'POST') {
      return json(res, 404, { ok: false, error: 'not found' });
    }
    const bot = runtime.bot;
    if (!bot || typeof bot.settlePat !== 'function') {
      return json(res, 503, { ok: false, error: '内核还没准备好' });
    }
    const patId = String((body && body.patId) || '').slice(0, 80);
    const ok = body && body.ok === true;
    const reason = String((body && body.reason) || '').slice(0, 60);
    const settled = bot.settlePat(patId, ok, reason);
    return json(res, 200, { ok: true, settled: Boolean(settled) });
  });
};
