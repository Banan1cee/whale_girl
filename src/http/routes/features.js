'use strict';

const features = require('../../infra/features');
const { applyFeatureToggle } = require('../../services/configCommands');
const { json, readBody } = require('../util');

module.exports = function register(router) {
  // ---- 功能开关（POST /api/features 可开关；关掉就回到旧行为）----
  router.get('/api/features', (runtime, req, res) => {
    return json(res, 200, { ok: true, features: features.list(runtime.config) });
  });

  router.post('/api/features', async (runtime, req, res) => {
    const body = await readBody(req);
    try {
      // 校验/落盘/热重载与离线保存共用同一份。
      const { key, value } = applyFeatureToggle(runtime, body);
      return json(res, 200, { ok: true, key, value, features: features.list(runtime.config) });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  });
};
