'use strict';

const { json } = require('../util');
const { isLoopbackRequest } = require('../security');
const { hostCall, respond } = require('../../services/features/hostCall');

module.exports = function register(router) {
  const local = (req) => {
    if (!isLoopbackRequest(req)) throw Object.assign(new Error('日记接口仅允许本机访问'), { statusCode: 403 });
  };
  router.get('/api/diary', (runtime, req, res) => {
    local(req);
    return respond(hostCall(runtime, 'diary.status@1', {}), out => json(res, 200, { ok: true, ...out.status }));
  });
  router.post('/api/diary/generate', (runtime, req, res) => {
    local(req);
    // 模型调用可能超过启动器 HTTP 超时，先返回任务状态，再由原页面轮询结果。
    return respond(hostCall(runtime, 'diary.generate@1', {}), out => json(res, 202, { ok: true, ...out.status }));
  });
};
