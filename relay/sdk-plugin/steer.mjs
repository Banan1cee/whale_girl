// DSH 插件：把「插到下一步」暴露成一个本地 TCP 接口。
// 为什么需要它：SDK 协议的 session/prompt 走的是 agent.followup()（排到下一轮开始前），
// 而桌面端那种「当前工具调用结束、下一步就读到」走的是 agent.steer()（收件箱的 next-step 队列）。
// SDK 协议没暴露 steer，所以我们在同一个进程里挂一个插件，直接拿到 live agent 调 steer()。
import net from 'node:net';
import { randomUUID } from 'node:crypto';

export const name = 'relay-steer';

// createUserMessage 的等价物：{ role:'user', content, source:{kind:'user'}, id }，冻结后入队。
function userMessage(text) {
  const content = Object.freeze([Object.freeze({ type: 'text', text: String(text) })]);
  return Object.freeze({
    role: 'user',
    content,
    source: Object.freeze({ kind: 'user' }),
    id: randomUUID(),
  });
}

export function apply(ctx, config = {}) {
  const port = Number(config.port) || 8791;
  const token = String(config.token || '');
  const log = (msg, extra) => {
    try { console.log('[relay-steer] ' + msg + (extra ? ' ' + JSON.stringify(extra) : '')); } catch (err) { /* ignore */ }
  };

  function findAgent(sessionId) {
    const agents = (ctx.get && ctx.get('agents')) || ctx.agents;
    if (!agents) return null;
    const tryList = typeof agents.list === 'function' ? agents.list() : [];
    for (const agent of tryList) {
      if (agent && agent.session && agent.session.id === sessionId) return agent;
    }
    return null;
  }

  function handle(req) {
    if (token && req.token !== token) return { ok: false, error: 'token 不匹配' };
    if (req.op === 'ping') return { ok: true, pong: true, port };
    if (req.op !== 'steer') return { ok: false, error: 'unknown op' };
    const agent = findAgent(String(req.sessionId || ''));
    if (!agent) return { ok: false, delivered: false, reason: 'no-agent' };
    if (typeof agent.steer !== 'function') return { ok: false, delivered: false, reason: 'no-steer' };
    agent.steer(userMessage(req.text));
    log('steered', { sessionId: String(req.sessionId).slice(0, 20), chars: String(req.text).length });
    return { ok: true, delivered: true };
  }

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch (err) { continue; }
        let reply;
        try { reply = Object.assign({ id: req.id }, handle(req)); } catch (err) { reply = { id: req.id, ok: false, error: String((err && err.message) || err) }; }
        try { socket.write(JSON.stringify(reply) + '\n'); } catch (err) { /* 对端走了 */ }
      }
    });
    socket.on('error', () => { /* 忽略断连 */ });
  });
  server.on('error', (err) => log('监听失败', { port, error: String((err && err.message) || err) }));
  server.listen(port, '127.0.0.1', () => log('已监听', { port }));
  ctx.effect(() => () => new Promise((resolve) => server.close(resolve)));
}
