'use strict';

// 只回答「这条要不要回」。宿主已经做完去重、禁言、静音和白名单，
// 这里只管时段：skip 压制本轮，pass 保留宿主的原判定，wake 能让本来不回复的消息开口。
const QUIET_FROM = 23;
const QUIET_TO = 8;

exports.providers = {
  'chat.pre_reply@1': ({ message, now }) => {
    if (message.chatType !== 'group') return { action: 'pass' };
    const hour = new Date(now).getHours();
    const quiet = hour >= QUIET_FROM || hour < QUIET_TO;
    if (!quiet || message.atMe || message.replyToBot) return { action: 'pass' };
    return { action: 'skip', reason: 'quiet_hours' };
  },
};
