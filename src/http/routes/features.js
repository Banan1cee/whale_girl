'use strict';

const features = require('../../infra/features');
const { applyConfigPatch } = require('../../infra/configPatch');
const { prepareFeatureCommand } = require('../../services/configCommands');
const { json, readBody } = require('../util');

module.exports = function register(router) {
  // ---- 功能开关（POST /api/features 可开关；关掉就回到旧行为）----
  router.get('/api/features', (runtime, req, res) => {
    return json(res, 200, { ok: true, features: features.list(runtime.config) });
  });

  router.post('/api/features', async (runtime, req, res) => {
    const body = await readBody(req);
    try {
      const { key, entry, value, patch } = prepareFeatureCommand(body);
      applyConfigPatch(runtime, patch);
      runtime.logger.info(`功能开关 ${entry.label} → ${value ? '开' : '关'}`);
      return json(res, 200, { ok: true, key, value, features: features.list(runtime.config) });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  });
};
