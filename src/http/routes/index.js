'use strict';

const { Router } = require('../router');
const { loadModules } = require('../../bootstrap/modules');

/**
 * 旧路由已全部迁入 src/modules/<id>/manifest.js；这里保留空列表与撞车检查，
 * 防止以后有人把 legacy 注册和模块清单同时挂上同一个 id/order。
 */
const LEGACY_ROUTES = [];

/** 组装路由表：每个领域一个文件，server 只负责启动。 */
function createRouter(runtime) {
  const router = new Router(runtime);
  const mods = loadModules();
  const moduleIds = new Set(mods.map((mod) => mod.id));
  for (const legacy of LEGACY_ROUTES) {
    if (moduleIds.has(legacy.id)) {
      throw new Error(`路由模块 id 与 legacy 重复：${legacy.id}`);
    }
  }
  const entries = [
    ...LEGACY_ROUTES,
    ...mods.flatMap((mod) => mod.routeEntries.map((item) => ({
      order: item.order,
      id: mod.id,
      register: item.register,
    }))),
  ];

  // 顺序号撞车时直接失败：静默覆盖会让某组接口凭空消失，比启动失败更难查。
  // 同一模块可以有多个注册项（settings/wechat），id 唯一性由发现器与上面的 legacy 检查保证。
  const byOrder = new Map();
  for (const entry of entries) {
    if (byOrder.has(entry.order)) {
      throw new Error(`路由顺序重复：order=${entry.order}（${byOrder.get(entry.order)} 与 ${entry.id}）`);
    }
    byOrder.set(entry.order, entry.id);
  }
  entries.sort((a, b) => a.order - b.order);
  for (const entry of entries) entry.register(router);

  runtime.pluginApiRoutes = [
    ...router.routes.map(({ method, path }) => ({ method, path })),
    ...router.patterns.map(({ regex }) => ({ method: '*', pattern: regex.source })),
  ];
  return router;
}

module.exports = { createRouter };
