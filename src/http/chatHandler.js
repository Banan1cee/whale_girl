'use strict';

const { json, readBody, sseInit, sseSend, sanitizeId } = require('../http/protocol');
const { describeError } = require('../infra/errors');

async function handleChat(runtime, req, res) {
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
  const senderName = mode === 'group' ? String(body.senderName || '阿螈').slice(0, 20) : String(body.senderName || '你').slice(0, 20);
  const msg = {
    platform: 'web',
    chatId: `${sessionId}:${mode}`,
    chatType: mode,
    senderId: mode === 'group' ? `web-g-${senderName}` : `web-u-${sessionId}`,
    senderName,
    text,
    atMe: Boolean(body.atMe),
    msgId: body.msgId ? String(body.msgId).slice(0, 100) : '',
    chatTitle: mode === 'group' ? runtime.config.persona.name + '的深海鱼塘' : '',
  };

  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.once('close', onClose);
  let streaming = false;
  try {
    for await (const event of runtime.chat.stream(msg, { signal: abort.signal })) {
      if (abort.signal.aborted) return;
      if (event.type === 'ignore') return json(res, 200, { ok: true, action: 'ignore', reason: event.reason });
      if (event.type === 'decision_error') return json(res, 500, { ok: false, error: '鲸鲸打了个结，稍后再试' });
      if (!streaming) {
        sseInit(res);
        streaming = true;
      }
      sseSend(res, event);
    }
    if (!res.destroyed) res.end();
  } catch (failure) {
    if (abort.signal.aborted) return;
    runtime.logger?.error('流式聊天失败：' + describeError(failure));
    if (!streaming) return json(res, 500, { ok: false, error: '鲸鲸打了个结，稍后再试' });
    sseSend(res, { type: 'done', error: true, reason: 'stream_error' });
    res.end();
  } finally {
    res.removeListener('close', onClose);
  }
}

module.exports = { handleChat };
