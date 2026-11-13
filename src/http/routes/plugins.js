'use strict';

const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');

module.exports = function register(router) {
  router.pattern(/^\/api\/plugins(?:\/.*)?$/, async (runtime, req, res, info) => {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '插件控制仅允许本机访问' });
    const service = runtime.bot.javascriptPlugins;
    if (info.pathname === '/api/plugins/capabilities' && info.method === 'GET') return json(res, 200, {
      ok: true, api: 4, enabled: service.enabled(), access: 'system.full',
      methods: ['api', 'search', 'model', 'send', 'delivery'],
      hooks: require('../../services/javascriptPlugins').HOOKS, apiRoutes: runtime.pluginApiRoutes,
    });
    if (info.pathname === '/api/plugins/status' && info.method === 'GET') return json(res, 200, {
      ok: true, enabled: service.enabled(), active: service.active, workers: service.workers.size,
      items: service.installed().map(({ id, kind, hooks, hash }) => ({ id, kind, hooks, hash })),
    });
    if (info.pathname === '/api/plugins/run' && info.method === 'POST') {
      if (!service.enabled()) return json(res, 409, { ok: false, error: '请先打开 JavaScript 插件总开关' });
      const body = await readBody(req);
      try { return json(res, 200, { ok: true, result: await service.runTool(String(body?.id || ''), body?.input) }); }
      catch (failure) { return json(res, 400, { ok: false, error: failure.code || 'plugin_error' }); }
    }
    return json(res, 404, { ok: false, error: 'unknown plugin operation' });
  });
};
