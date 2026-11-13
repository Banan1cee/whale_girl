'use strict';

const { Router } = require('../router');

const modules = [
  require('./status'),
  require('./features'),
  require('./settings'),
  require('./vision'),
  require('./persona'),
  require('./wechat'),
  require('./config'),
  require('./debug'),
  require('./care'),
  require('./chat'),
  require('./bridge'),
  require('./stickers'),
  require('./reminders'),
  require('./diary'),
  require('./digest'),
  require('./budget'),
  require('./memory'),
  require('./moments'),
  require('./plugins'),
];

/** 组装路由表：每个领域一个文件，server 只负责启动。 */
function createRouter(runtime) {
  const router = new Router(runtime);
  for (const register of modules) register(router);
  runtime.pluginApiRoutes = [
    ...router.routes.map(({ method, path }) => ({ method, path })),
    ...router.patterns.map(({ regex }) => ({ method: '*', pattern: regex.source })),
  ];
  return router;
}

module.exports = { createRouter };
