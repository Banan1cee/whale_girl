'use strict';

const { json, readBody } = require('../util');
const { hostCall } = require('../../services/features/hostCall');

/**
 * 设置 HTTP 接口。
 *
 * 读/写都走宿主能力（settings.read@1 / settings.write@1），和插件 host.call 同一条路；
 * 这里只保留 HTTP 传输层：请求体上限、错误映射成 400 的 `{ok:false,error}`。
 */
module.exports = function register(router) {
  const write = (runtime, body) => hostCall(runtime, 'settings.write@1', body);

  router.post('/api/settings/test-service', async (runtime, req, res) => {
    const body = await readBody(req, 4 * 1024 * 1024);
    try {
      return json(res, 200, await require('../../services/apiProbe').probe(runtime.config, body));
    } catch (err) {
      const { errorMessage } = require('../../infra/errors');
      return json(res, 400, { ok: false, error: errorMessage(err) });
    }
  });
  router.get('/api/settings', async (runtime, req, res) => json(res, 200,
    await hostCall(runtime, 'settings.read@1', {})));

  router.post('/api/settings', async (runtime, req, res) => {
    const body = await readBody(req);
    try {
      const data = await write(runtime, body);
      return json(res, 200, data);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  });

  router.post('/api/settings/test', async (runtime, req, res) => {
    const body = await readBody(req);
    if (body && Object.keys(body).length) {
      try {
        await write(runtime, body);
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    const probe = await runtime.llm.probe();
    if (!probe.ok) {
      // 启动器只认顶层 error 字段；只回 probe 对象的话它拿不到文案，
      // 会把整段原始 JSON 当提示贴出来（用户看到的就是一串看不懂的字符）。
      const detail = String(probe.detail || '').trim();
      const message = String(probe.message || '连接测试没通过').trim();
      return json(res, 200, {
        ok: false,
        error: detail && !message.includes(detail) ? message + '（原始错误：' + detail.slice(0, 200) + '）' : message,
        probe,
      });
    }
    return json(res, 200, { ok: true, probe });
  });
};
