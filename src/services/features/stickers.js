'use strict';

/**
 * 表情包能力。表情包的实际发送由桥接领取后完成，内核只负责排队与状态。
 *
 * 代次校验（generation）、开关（requireEnabled）仍由 StickerService 自己做：
 * 能力层只清洗入参，不复制业务判断，否则开关切换时的 409/404 会分叉。
 */

const features = require('../../infra/features');
const { text } = require('./helpers');

function create(runtime) {
  return {
    'stickers.status@1': () => {
      if (!features.isOn(runtime.config, 'stickers')) return { status: { ok: true, enabled: false, jobs: [] } };
      return { status: runtime.stickerService.status() };
    },

    // 桥接开工前问一次：总开关、代次、还有哪些任务在飞。
    'stickers.gate@1': input => ({ gate: runtime.stickerService.gate(text(input.id, 80)) }),

    // 手动排一张图进队列（启动器「发送测试」）；emotion 的合法值由 service 校验。
    // 插件调用时记下归属：授权一旦撤回，reconcile 会把还没发出的任务作废。
    'stickers.enqueue@1': (input, plugin) => ({
      queued: runtime.stickerService.enqueue(text(input.emotion, 40), text(input.chat, 160),
        plugin ? { pluginId: plugin.id, pluginHash: plugin.packageHash } : null),
    }),

    'stickers.pending@1': () => ({ items: runtime.stickerService.pending() }),

    'stickers.claim@1': input => ({ item: runtime.stickerService.claim(text(input.id, 80)) }),

    'stickers.ack@1': input => ({
      item: runtime.stickerService.ack(text(input.id, 80), text(input.status, 40), text(input.error, 500)),
    }),

    'stickers.cancel@1': input => ({
      item: runtime.stickerService.cancelReserved(
        text(input.id, 80), text(input.generation, 80), text(input.chatUsername, 160),
      ),
    }),
  };
}

module.exports = { create };
