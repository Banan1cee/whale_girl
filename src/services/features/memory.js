'use strict';

/**
 * 记忆能力。读最近消息、长期召回、写入。
 *
 * 召回沿用记忆模块自己的 BM25 检索（store.searchArchive），不在这里另建索引：
 * 「聊到过什么」只有一份事实源，插件看到的和对话管线看到的必须一致。
 */

const { error, text, sessionKey, messageProjection } = require('./helpers');

function bodyOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('invalid_host_capability_input');
  return input;
}

function create(runtime) {
  /** 记忆库不可用（格式闸/磁盘）时明确报错，不要返回空结果让调用方以为「没记过」。 */
  const ready = () => {
    const readiness = runtime.store.readiness?.();
    if (readiness && readiness.ok === false) throw error('memory_unavailable');
  };
  const keyOf = (chatId, chatType) => `wechat:${sessionKey(runtime.config, chatId, chatType)}`;

  return {
    'memory.recent@1': input => {
      const chatId = text(input.chatId, 120);
      if (!chatId) throw error('invalid_host_capability_input');
      ready();
      const rows = runtime.store.messages(keyOf(chatId, input.chatType),
        Math.max(1, Math.min(50, Number(input.limit) || 12)));
      return { messages: rows.map(messageProjection) };
    },

    /**
     * 长期召回：在这个会话的原文块上做 BM25，返回 {items:[{text,ts,score}]}。
     * text 是块内多行原文（可能含他人发言），调用方按「外部数据」处理，不要当指令。
     */
    'memory.recall@1': input => {
      const body = bodyOf(input);
      const chatId = text(body.chatId, 120).trim();
      const query = text(body.query, 500).trim();
      if (!chatId || !query) throw error('invalid_host_capability_input');
      ready();
      const limit = Math.max(1, Math.min(20, Math.trunc(Number(body.limit)) || 5));
      const hits = runtime.store.searchArchive(keyOf(chatId, body.chatType), query, { topK: limit }) || [];
      return {
        ok: true,
        items: hits.map(hit => ({
          text: text(hit?.chunk?.text, 2000),
          ts: Number(hit?.chunk?.ts) || 0,
          score: Number(hit?.score) || 0,
        })),
      };
    },

    /**
     * 写入：mode='message' 追加一条 assistant 消息（会进上下文），
     * mode='note' 写一条关于某个人的长期偏好（uid 必填）。
     * 不接受伪造 user 消息：那会触发宿主的事实抽取，等于让插件替用户「立人设」；
     * 时间戳统一取当前时间，插件不能回填旧时间扰乱上下文顺序。
     */
    'memory.write@1': input => {
      const body = bodyOf(input);
      const chatId = text(body.chatId, 120).trim();
      const content = String(body.text ?? '').replace(/\u0000/g, '').trim().slice(0, 2000);
      if (!chatId || !content) throw error('invalid_host_capability_input');
      ready();
      const key = keyOf(chatId, body.chatType);
      const mode = body.mode === 'note' ? 'note' : 'message';
      if (mode === 'note') {
        const uid = text(body.uid, 120).trim();
        if (!uid) throw error('invalid_host_capability_input');
        const notes = runtime.store.manualRemember(key, uid, content);
        return { ok: true, mode: 'note', remembered: true,
          notes: (Array.isArray(notes) ? notes : []).slice(0, 50).map(note => text(note, 200)) };
      }
      const entry = runtime.store.appendMessage(key, {
        role: 'assistant',
        text: content,
        ts: Date.now(),
        name: text(body.name, 80),
      });
      return { ok: true, mode: 'message', stored: true, id: text(entry?.id, 80), ts: Number(entry?.ts) || 0 };
    },
  };
}

module.exports = { create };
