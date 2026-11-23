'use strict';

const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');
const registry = require('../../services/pluginProtocolRegistry.json');

/**
 * 本机插件控制口。
 *
 * 这里只暴露新协议的元信息、状态和「用户手动运行一次工具」。
 * 不再提供通用 /api/* 代理，也不认识旧 Api 3/4 的 hook。
 */
module.exports = function register(router) {
  router.pattern(/^\/api\/plugins(?:\/.*)?$/, async (runtime, req, res, info) => {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '插件控制仅允许本机访问' });
    const plugins = runtime.plugins;
    const capabilities = runtime.capabilities;
    if (!plugins || !capabilities) return json(res, 503, { ok: false, error: 'plugin_runtime_unavailable' });

    if (info.pathname === '/api/plugins/capabilities' && info.method === 'GET') return json(res, 200, {
      ok: true,
      protocol: registry.format,
      levels: registry.levels,
      levelNames: registry.levelNames,
      enabled: Boolean(plugins.enabled()),
      providers: registry.providers,
      calls: Object.fromEntries(Object.entries(registry.calls)
        .filter(([, call]) => call.enabled !== false)
        .map(([name, call]) => [name, { requiresConsent: call.requiresConsent === true, sideEffect: call.sideEffect }])),
      limits: registry.limits,
    });

    if (info.pathname === '/api/plugins/status' && info.method === 'GET') {
      return json(res, 200, {
        ok: true,
        enabled: Boolean(plugins.enabled()),
        active: plugins.active,
        workers: plugins.workers.size,
        items: plugins.installed().map(({ id, name, version, level, provides, calls, packageHash }) => ({
          id, name, version, level, provides, calls, packageHash,
        })),
      });
    }

    if (info.pathname === '/api/plugins/run' && info.method === 'POST') {
      if (!plugins.enabled()) return json(res, 409, { ok: false, error: '请先打开插件总开关' });
      const body = await readBody(req);
      if (body?.capability !== 'tool.run@1') return json(res, 400, { ok: false, error: 'only_tool_run_is_manually_executable' });
      const id = String(body?.id || '');
      if (!plugins.installed().some(plugin => plugin.id === id && plugin.provides['tool.run@1'])) {
        return json(res, 404, { ok: false, error: 'plugin_tool_not_installed' });
      }
      try {
        const result = await capabilities.runTool(id, body?.input ?? null);
        return json(res, 200, { ok: true, result });
      } catch (failure) {
        return json(res, 400, { ok: false, error: failure.code || 'plugin_error' });
      }
    }

    return json(res, 404, { ok: false, error: 'unknown plugin operation' });
  });
};
