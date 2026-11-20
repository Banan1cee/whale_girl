'use strict';

/**
 * 模块清单：只描述「怎么创建、挂哪些路由」。
 * 这里不创建实例、不启动任务 —— 发现器在启动时才按需调用 create。
 * order=150 保持它在原路由列表里的位置：diary 之后、budget 之前。
 */
module.exports = {
  id: 'digest',
  order: 150,
  create(runtime, { store, logger }) {
    const { DigestService } = require('./service');
    return new DigestService(runtime.config, { store, llm: runtime.llm, logger: logger.child('digest') });
  },
  routes: require('./routes'),
};
