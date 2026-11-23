'use strict';

/**
 * 提醒能力。宿主内部（HTTP 路由、桥接取件）与插件 host.call 共用这一份实现。
 *
 * 拼装点只做字段清洗和状态映射；真正的规则（额度、时间段、过期）在 ReminderService 里。
 */

const { error, text, list } = require('./helpers');

function create(runtime) {
  return {
    'reminders.list@1': input => ({ reminders: list(runtime.reminders.list({ limit: Number(input.limit) || 100 }), 100)
      .map(item => ({ id: item.id, chatId: item.wxid, text: item.text, dueAt: item.dueAt, status: item.status })) }),

    'reminders.create@1': input => {
      const chatId = text(input.chatId, 120);
      const body = text(input.text, 200);
      const at = Number(input.at);
      if (!chatId || !body || !Number.isFinite(at)) throw error('invalid_host_capability_input');
      const item = runtime.reminders.add({ wxid: chatId, name: text(input.name, 80) || chatId,
        chatType: input.chatType === 'group' ? 'group' : 'private', text: body, at,
        atName: text(input.atName, 80) });
      return { id: item.id, dueAt: item.dueAt, status: item.status };
    },

    'reminders.cancel@1': input => {
      const id = text(input.id, 80);
      if (!id) throw error('invalid_host_capability_input');
      const result = runtime.reminders.cancel(id);
      if (!result || result.ok === false) throw error('reminder_not_found');
      return { ok: true, id };
    },

    // 某个会话还没发的提醒：聊天里的「取消提醒 / 提醒列表」和宿主内部用它。
    'reminders.pendingFor@1': input => ({
      items: list(runtime.reminders.pendingFor(text(input.chatId, 120)), 50)
        .map(item => ({ id: item.id, text: item.text, dueAt: item.dueAt, status: item.status })),
    }),

    // 启动器「提醒」页按这几个字段回填；dailyCap 是服务层内部叫法，这里换成界面用的名字。
    'reminders.rules@1': () => {
      const rules = runtime.reminders.rules();
      return {
        rules: {
          enabled: rules.enabled,
          maxPerDay: rules.dailyCap,
          quietAfterMinutes: rules.quietAfterMinutes,
          sentToday: rules.sentToday,
        },
      };
    },

    // 内核自己产生的内容（日记等）直接进发送队列：不受提醒开关和每日额度限制。
    'reminders.enqueue@1': input => {
      const item = runtime.reminders.enqueueNow({
        wxid: text(input.chatId, 120),
        name: text(input.name, 80),
        chatType: input.chatType === 'group' ? 'group' : 'private',
        // 正文允许换行（日记全文），上限交给服务层再 strip / trim 一次。
        text: text(input.text, 20000),
        kind: text(input.kind, 20) || 'diary',
        pluginId: text(input.pluginId, 80) || undefined,
        pluginHash: text(input.pluginHash, 128) || undefined,
        delivery: input.delivery === 'voice' ? 'voice' : 'text',
      });
      return { id: item.id, dueAt: item.dueAt, status: item.status };
    },

    // 一次取走本轮到点任务并把它们标成 sending；桥接据 nextDueAt 睡到下一个点。
    'reminders.due@1': () => ({
      items: runtime.reminders.due(),
      nextDueAt: runtime.reminders.nextDueAt(),
      now: Date.now(),
    }),

    // 失败原因原样带回：路由要按 statusCode 决定 404/409，桥接也要看到服务层的文案。
    'reminders.ack@1': input => runtime.reminders.ack(text(input.id, 80), {
      ok: Boolean(input.ok),
      error: text(input.error, 200),
      uncertain: input.uncertain === true,
    }),

    // 只对 kind=plugin 的在途任务回答「授权还在不在」，别把普通提醒也当成插件任务。
    'reminders.permission@1': input => {
      const service = runtime.reminders;
      const id = text(input.id, 80);
      const item = service.items.find(row => row.id === id && row.kind === 'plugin');
      return { ok: Boolean(item && item.status === 'sending' && service.pluginAllowed?.(item)) };
    },
  };
}

module.exports = { create };
