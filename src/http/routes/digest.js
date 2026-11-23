'use strict';

const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');
const { hostCall } = require('../../services/features/hostCall');

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

  router.get('/api/digest', async (runtime, req, res) => {
    local(req);
    const out = await hostCall(runtime, 'digest.status@1', {});
    return json(res, 200, { ok: true, ...out.status });
  });

  router.post('/api/digest/generate', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req);
    const range = RANGES.has(body.range) ? body.range : 'today';
    // 202 不能等模型：触发后立刻读一次状态，生成在后台继续。
    // 失败详情由 DigestService 自己写进 status，这里只防一个悬空的 rejection。
    void Promise.resolve(hostCall(runtime, 'digest.generate@1', { range }))
      .catch((err) => runtime.logger?.warn?.('消息汇总生成触发失败：' + String(err?.code || 'error')));
    const out = await hostCall(runtime, 'digest.status@1', {});
    return json(res, 202, { ok: true, ...out.status });
  });
};
