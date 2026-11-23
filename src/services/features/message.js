'use strict';

/**
 * 发送能力。
 *
 * 插件要发消息只能排队到宿主的发送通道（桥接来领）：kind='plugin' 会带上
 * 插件 id + 安装包摘要，撤销授权后队列里未发出的任务会被取消、已领取的标未确认。
 * 返回 queued 只代表「已排队」，不是微信已送达；插件不得把它当送达证据。
 *
 * 语音发送只在这里用 delivery:'voice' 表达，队列项交给宿主发送通道处理，
 * 不另开一项能力（否则「发语音」会绕过发送队列的授权与额度语义）。
 *
 * 发言范围（禁言 / 白名单）不在能力里另判一套：排进队列不等于能发，桥接真正发送前
 * 用 src/core/wechatSendPolicy 的同一个规则核对；这里只保留插件身份（必须有插件上下文）。
 *
 * message.submit@1 保持注册表里的 enabled:false：它是已发布协议里的保留能力，
 * 故意不实现，插件调用时由分发层直接报 host_capability_disabled。
 */

const { error, text } = require('./helpers');

const MAX_TEXT = 16000;

function create(runtime) {
  return {
    'message.send@1': (input, plugin) => {
      // kind='plugin' 的队列项必须绑定具体插件：没有插件上下文就没有撤销依据。
      if (!plugin) throw error('plugin_required');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('invalid_host_capability_input');
      const chatId = text(input.chatId, 120).trim();
      const content = String(input.text ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_TEXT);
      if (!chatId || !content) throw error('invalid_host_capability_input');
      const item = runtime.reminders.enqueueNow({
        wxid: chatId,
        name: text(input.name, 80),
        chatType: input.chatType === 'group' ? 'group' : 'private',
        text: content,
        kind: 'plugin',
        pluginId: plugin.id,
        // 授权绑定用的是安装包摘要：撤销/重装后旧摘要的队列项会被拒绝。
        pluginHash: plugin.packageHash || plugin.hash,
        delivery: input.delivery === 'voice' ? 'voice' : 'text',
      });
      return { id: String(item.id ?? '').slice(0, 80), status: 'queued', confirmed: false };
    },
  };
}

module.exports = { create, MAX_TEXT };
