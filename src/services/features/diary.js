'use strict';

/**
 * 日记能力。日记在宿主内部由定时任务写、由提醒通道发出，插件只读状态或触发补写。
 */

const { text } = require('./helpers');

// readForChat 为聊天场景加了「【日期】」抬头；能力把日期拆成字段，正文单独给。
const HEADER = /^【([^】]*)】\r?\n?/;

function create(runtime) {
  return {
    'diary.status@1': () => ({ status: runtime.diary.status() }),

    // 生成可能跑几十秒：触发即返回，调用方随后用 diary.status@1 轮询，
    // 否则启动器的 HTTP 超时会比模型先到。失败详情由 DiaryService 写进 status，
    // 这里只兜住「生成 Promise 没人 await」可能产生的未处理 rejection。
    'diary.generate@1': () => {
      void Promise.resolve(runtime.diary.generate()).catch(() => {});
      return { status: runtime.diary.status() };
    },

    // day 支持 YYYY-MM-DD / today / latest（沿用已有 readForChat 的读接口）；
    // 读不到返回明确结果而不是抛异常：没写过日记不该看起来像权限或数据错误。
    'diary.read@1': input => {
      const token = text(input.day, 40);
      const content = runtime.diary.readForChat(token || 'latest');
      if (!content) return { day: token || 'latest', text: '', found: false };
      const header = HEADER.exec(content);
      return {
        day: header ? header[1] : (token || 'latest'),
        text: header ? content.slice(header[0].length) : content,
        found: true,
      };
    },
  };
}

module.exports = { create };
