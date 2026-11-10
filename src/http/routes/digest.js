'use strict';

const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');

const RANGES = new Set(['today', 'yesterday']);

/**
 * 消息汇总（全局日报）。
 *   GET  /api/digest           只读状态：idle / running / done / empty / failed + 计数
 *   POST /api/digest/generate  开始生成，body: { range: 'today' | 'yesterday' }
 *
 * 模型调用可能超过启动器的 HTTP 超时，所以生成放到后台，202 立刻返回，
 * 页面再轮询 GET（和日记的用法一致）。只允许本机调用：会读聊天记录。
 */
module.exports = function register(router) {
  const local = (req) => {
    if (!isLoopbackRequest(req)) {
      throw Object.assign(new Error('消息汇总只允许在本机操作'), { statusCode: 403 });
    }
  };

  router.get('/api/digest', (runtime, req, res) => {
    local(req);
    return json(res, 200, { ok: true, ...runtime.digest.status() });
  });

  router.post('/api/digest/generate', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req);
    const range = RANGES.has(body.range) ? body.range : 'today';
    void runtime.digest.generate(range);
    return json(res, 202, { ok: true, ...runtime.digest.status() });
  });
};
