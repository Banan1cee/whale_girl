'use strict';

const { describeError } = require('../infra/errors');

const CHUNK = 3;
// 模型一次吐出的正文超过这个长度就按失败处理：既防内存被撑爆，也避免把半截
// 带标记的文本发给用户。错误路径只发统一兜底文案。
const MAX_PENDING_TEXT = 200000;

function createStreamingChat(bot, logger, { takeOver = () => false, handle = null } = {}) {
  return async function* stream(message, { signal } = {}) {
    // 请求开始前就取消：不判题、不落库、不占配额，零 SSE 事件（连 ignore 都不发）。
    if (signal?.aborted) return;
    if (takeOver()) {
      let result;
      try {
        result = await handle(message, { localWechat: false, signal });
      } catch (failure) {
        // 取消/断线不算接管失败：静默结束，不产生 decision_error。
        if (signal?.aborted) return;
        logger?.error('接管链路失败：' + describeError(failure));
        yield { type: 'decision_error' };
        return;
      }
      // 取消（含排队中被取消）零事件收尾；空/拒绝回复只发 ignore，不占配额。
      if (result?.cancelled || signal?.aborted) return;
      // 接管入口是宿主内部的确定性 seam：返回非对象属于真实故障（宿主 bug），
      // 不能当成「故意忽略」静默掉，也不能按插件输出不合契约处理。
      if (!result || typeof result !== 'object') {
        logger?.error?.('接管链路返回了无效结果');
        yield { type: 'decision_error' };
        return;
      }
      if (result.action !== 'reply' || !result.reply) {
        yield { type: 'ignore', reason: result.reason || 'ignored' };
        return;
      }
      yield {
        type: 'meta', action: 'reply', mock: Boolean(result.mock), reason: result.reason || 'plugin',
        mode: message.chatType, senderName: message.senderName, commandType: result.commandType || '',
      };
      for (let index = 0; index < result.reply.length; index += CHUNK) {
        if (signal?.aborted) return;
        yield { type: 'delta', text: result.reply.slice(index, index + CHUNK) };
      }
      yield {
        type: 'done', text: result.reply, bubbles: result.bubbles || [result.reply],
        reason: result.reason || 'plugin', mention: result.mention || '',
        // 宿主已处理的结果（管理员命令等）原样带回 commandType；插件契约没有这个字段，取不到就是空。
        ...(result.commandType ? { commandType: result.commandType } : {}),
        ...(result.stickerCategory ? { stickerCategory: result.stickerCategory } : {}),
        ...(result.separateText ? { separateText: true } : {}),
      };
      return;
    }

    let decision;
    try {
      decision = await bot.decide(message, { signal });
    } catch (failure) {
      // 判定阶段也可能因断线被取消（搜索/生成插件收到 abort 后抛 capability_aborted）：
      // 取消不发 decision_error，否则调用方会把一次正常断开记成故障。
      if (signal?.aborted) return;
      logger?.error('流式回复判定失败：' + describeError(failure));
      yield { type: 'decision_error' };
      return;
    }
    if (decision.action === 'ignore') {
      yield { type: 'ignore', reason: decision.reason };
      return;
    }

    // 一旦 decide 返回 reply/command，本轮就占着一个配额租约。这个 finally 覆盖
    // 所有提前返回（meta 后断线、生成中断、规范化取消、只读消费方提前 break）：
    // 已经 finalize 的 decision 由 _finalReplies 挡住，不会二次退款；
    // 没提交的则releaseReply 归还租约，避免迟到结果继续占着并发名额。
    try {
      if (signal?.aborted) return;
      const commandType = decision.commandType || '';
      yield {
        type: 'meta', action: decision.action, mock: Boolean(decision.mock), reason: decision.reason,
        mode: message.chatType, senderName: message.senderName, commandType,
      };
      if (signal?.aborted) return;

      // 只把「规范化之后」的正文按增量下发。原始增量里可能还带着
      // [[sticker:]] / [[diary:]] / ((silence:)) 标记，先下发会让网页端看到内部语法，
      // 也会让流式结果和非流式结果对不上。统一结果阶段在 Bot.finishReply。
      const emit = function* (text) {
        for (let index = 0; index < text.length; index += CHUNK) {
          if (signal?.aborted) return;
          yield { type: 'delta', text: text.slice(index, index + CHUNK) };
        }
      };

      // 命令路径与普通回复一样，要先走 finalize 才能拿到最终正文和气泡。
      if (decision.action === 'command') {
        const full = decision.text || '';
        const bubbles = bot.finalize(decision, full);
        const text = decision.finalText != null ? decision.finalText : full;
        if (signal?.aborted) return;
        for (const event of emit(text)) yield event;
        if (signal?.aborted) return;
        yield { type: 'done', text, bubbles, reason: decision.reason, commandType };
        return;
      }

      let full = '';
      let overflow = false;
      try {
        for await (const piece of bot.generate(decision, { signal })) {
          if (signal?.aborted) return;
          full += piece;
          if (full.length > MAX_PENDING_TEXT) { overflow = true; break; }
        }
      } catch (failure) {
        if (signal?.aborted) return;
        logger?.error('生成失败：' + describeError(failure));
        const failed = bot.finishFailure(decision, failure);
        for (const event of emit(failed.reply || '')) yield event;
        yield {
          type: 'done', text: failed.reply || '', bubbles: failed.bubbles || [],
          error: true, reason: failed.reason || 'llm_error', commandType,
        };
        return;
      }
      if (signal?.aborted) return;
      if (overflow) {
        const failure = Object.assign(new Error('stream_output_limit'), { code: 'stream_output_limit' });
        logger?.error('流式输出超长：' + describeError(failure));
        const failed = bot.finishFailure(decision, failure);
        for (const event of emit(failed.reply || '')) yield event;
        yield {
          type: 'done', text: failed.reply || '', bubbles: failed.bubbles || [],
          error: true, reason: failed.reason || 'llm_error', commandType,
        };
        return;
      }

      const finished = await bot.finishReply(decision, full, { signal });
      if (finished.cancelled || signal?.aborted) return;
      if (finished.error) {
        for (const event of emit(finished.text || finished.reply || '')) yield event;
        yield {
          type: 'done', text: finished.text || finished.reply || '', bubbles: finished.bubbles || [],
          error: true, reason: finished.reason || 'llm_error', commandType,
        };
        return;
      }
      const text = finished.text != null ? finished.text : '';
      for (const event of emit(text)) yield event;
      if (signal?.aborted) return;
      yield {
        type: 'done', text, bubbles: finished.bubbles || [], reason: decision.reason,
        mock: Boolean(decision.mock), commandType,
        ...(decision.stickerCategory ? { stickerCategory: decision.stickerCategory } : {}),
        ...(decision.separateText ? { separateText: true } : {}),
      };
    } finally {
      // releaseReply 会先看 _finalReplies：已提交的回复不退款，只清未提交的租约。
      bot.releaseReply?.(decision);
    }
  };
}

module.exports = { createStreamingChat };
