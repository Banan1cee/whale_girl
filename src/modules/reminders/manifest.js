'use strict';

module.exports = {
  id: 'reminders',
  order: 130,
  create(runtime, { store, logger }) {
    const { ReminderService } = require('./service');
    return new ReminderService(runtime.config, {
      logger: logger.child('reminder'),
      // 「刚聊过先跳过」规则要看会话最后一条消息的时间
      lastActiveAt: (wxid) => {
        const keys = [`wechat:u:${wxid}`, `wechat:g:${wxid}`];
        let last = 0;
        for (const key of keys) {
          try {
            const msgs = store.messages(key, 1);
            const ts = Number(msgs && msgs[0] && msgs[0].ts) || 0;
            if (ts > last) last = ts;
          } catch { /* 读不到就算了 */ }
        }
        return last;
      },
    });
  },
  routes: require('./routes'),
};
