'use strict';

/**
 * 消息汇总（全局日报）能力。生成走模型，计费，因此必须逐个插件授权。
 */

function create(runtime) {
  return {
    'digest.status@1': () => ({ status: runtime.digest.status() }),

    // 生成可能超过启动器 HTTP 超时；这里等生成结束是为了让插件拿到 result，
    // 宿主路由不直接 await 这一条（它先回 202，页面再轮询 digest.status@1）。
    'digest.generate@1': async input => {
      const range = input.range === 'yesterday' ? 'yesterday' : 'today';
      return { status: await runtime.digest.generate(range) };
    },
  };
}

module.exports = { create };
