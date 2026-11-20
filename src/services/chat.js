'use strict';

const { json, readBody, sseInit, sseSend, sanitizeId } = require('../http/protocol');
const { describeError } = require('../infra/errors');

/* ---------------- 本机聊天口（SSE 流式，只认桥接 token） ---------------- */

async function handleChat(runtime, req, res) {
  const { bot, config, logger } = runtime;
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, err.statusCode || 400, { ok: false, error: err.message });
  }
  const text = String(body.text || '').trim();
  if (!text) return json(res, 400, { ok: false, error: '说点什么呀~' });

  const mode = body.mode === 'group' ? 'group' : 'private';
  const sessionId = sanitizeId(body.sessionId || 'default');
  const chatId = `${sessionId}:${mode}`;
  const senderName =
    mode === 'group' ? String(body.senderName || '阿螈').slice(0, 20) : String(body.senderName || '你').slice(0, 20);

  const msg = {
    platform: 'web',
    chatId,
    chatType: mode,
    senderId: mode === 'group' ? `web-g-${senderName}` : `web-u-${sessionId}`,
    senderName,
    text,
    atMe: Boolean(body.atMe),
    msgId: body.msgId ? String(body.msgId).slice(0, 100) : '',
    chatTitle: mode === 'group' ? config.persona.name + '的深海鱼塘' : '',
  };

  const abort = new AbortController();
  let closed = false;
  res.on('close', () => {
    closed = true;
    abort.abort();
  });

  let decision;
  try {
    try {
      decision = await bot.decide(msg, { signal: abort.signal });
    } catch (err) {
      logger.error('decide 失败：' + (err && err.stack ? err.stack : err));
      if (closed) return res.end();
      return json(res, 500, { ok: false, error: '出了点问题，稍后再试' });
    }
    if (closed) return res.end();
    if (decision.action === 'ignore') {
      return json(res, 200, { ok: true, action: 'ignore', reason: decision.reason });
    }

    sseInit(res);
    sseSend(res, {
      type: 'meta', action: decision.action, mock: Boolean(decision.mock),
      reason: decision.reason, mode, senderName, commandType: decision.commandType || '',
    });

    let result;
    try {
      // 保留真实上游流和取消；先定稿再发正文，避免插件改写或控制标记已经外泄。
      let full = '';
      for await (const piece of bot.generate(decision, { signal: abort.signal })) {
        if (closed) break;
        const text = String(piece == null ? '' : piece);
        bot.checkReplyLength(full.length + text.length);
        full += text;
      }
      if (closed) return res.end();
      if (decision.action !== 'command') full = await bot.transformPluginReply(decision, full.trim());
      if (closed) return res.end();
      result = bot.finalizeReply(decision, full);
    } catch (err) {
      if (closed) return res.end();
      logger.error('生成失败：' + describeError(err));
      result = bot.finalizeReply(decision, bot.failureReplyText(err), { error: true });
    }

    // 首个 text delta 延迟至定稿；meta 仍先发，不增加 reset/retraction 事件。
    for (let i = 0; i < result.text.length; i += 3) {
      if (closed) return res.end();
      sseSend(res, { type: 'delta', text: result.text.slice(i, i + 3) });
    }
    if (closed) return res.end();
    sseSend(res, { type: 'done', text: result.text, bubbles: [...result.bubbles],
      reason: result.reason, mock: Boolean(decision.mock),
      ...(decision.action === 'command' || decision.canned ? { commandType: decision.commandType || '' } : {}),
      ...(result.error ? { error: true } : {}),
      ...(result.stickerCategory ? { stickerCategory: result.stickerCategory } : {}),
      ...(result.separateText ? { separateText: true } : {}),
    });
    res.end();
  } finally {
    bot.releaseReply(decision);
  }
}

module.exports = { handleChat };
