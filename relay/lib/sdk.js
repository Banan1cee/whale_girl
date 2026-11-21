'use strict';
// 常驻的 DSH SDK 运行时：一个进程 = 一个工作目录，里面可以开很多 session。
// 用它而不是 headless 的原因：headless 是「一轮一个进程」，跑起来之后就没法再往里塞话了；
// SDK 的 session/prompt 走的是 agent.followup()，消息会进正在跑的那一轮的收件箱，
// 当前工具调用一结束、下一步就读得到 —— 也就是桌面端那种「运行中插话」。
//
// 协议：stdio 上按换行分帧的 JSON-RPC 2.0。
//   initialize {provider, model, cwd} → {serverInfo}
//   session/query {sessionId, contentBlocks}   —— 我们只用来发 /permission 这种命令
//   session/prompt {sessionId, contentBlocks}  —— 排入一条用户消息（运行中就是插话）
//   session/resume {sessionId}                 —— 载入已持久化的会话
//   session/wait  {sessionId}                  —— 等到这一会话闲下来
//   shutdown
// 通知：session.status {sessionId, status:'running'|'idle'}、session.event {event:{type,...}}

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const DEFAULT_ELECTRON = 'D:/DeepSeek Harness/DeepSeek Harness.exe';
const DEFAULT_BIN = 'D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const DEFAULT_PROFILE = 'relay-sdk';
// API key 路由只认这两个模型名；pro 给工人，flash 给前台（前台要快）。
const DEFAULT_DESK_MODEL = 'deepseek-flash';
const DEFAULT_WORKER_MODEL = 'deepseek-v4-pro';

function reachable(filePath) {
  if (!filePath) return false;
  const i = filePath.toLowerCase().indexOf('.asar/');
  if (i === -1) return fs.existsSync(filePath);
  return fs.existsSync(filePath.slice(0, i + '.asar'.length));
}

// 找不到 CLI/桌面端时给出能直接照做的修法，而不是一句 ENOENT。
function resolveRuntime(configDsh) {
  const cfg = configDsh || {};
  const electron = String(cfg.electronPath || process.env.RELAY_DSH_ELECTRON || DEFAULT_ELECTRON);
  const bin = String(cfg.binPath || process.env.RELAY_DSH_BIN || DEFAULT_BIN);
  const profile = String(cfg.sdkProfile || DEFAULT_PROFILE);
  if (cfg.command) {
    return { command: String(cfg.command), args: ['--profile', profile], source: 'config.command', profile };
  }
  if (!fs.existsSync(electron)) {
    throw new Error('找不到 DeepSeek Harness 桌面端：' + electron + '（在 relay/config.json 的 dsh.electronPath 里改成实际路径）');
  }
  if (!reachable(bin)) {
    throw new Error('找不到 dsh CLI：' + bin + '（改 relay/config.json 的 dsh.binPath，或装一个全局 dsh 并填 dsh.command）');
  }
  return { command: electron, args: [bin, '--profile', profile], source: 'config.electron', profile };
}

// 一个工作目录里的一个运行时进程。所有 session 共用它，但各自独立排队、独立状态。
function createRuntime(options) {
  const opts = options || {};
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const model = opts.model;
  const cwd = opts.cwd;
  const resolved = opts.resolved || resolveRuntime(opts.dsh);
  const env = Object.assign({}, process.env, opts.dsh && opts.dsh.env ? opts.dsh.env : {}, {
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  });
  const sessions = new Map();
  const waiters = [];
  const pending = new Map();
  let child = null;
  let nextId = 0;
  let seq = 0;
  let ready = null;
  let closed = false;
  let stderrTail = [];

  function sessionState(sessionId) {
    let st = sessions.get(sessionId);
    if (!st) {
      st = { running: false, turn: 0, step: 0, lastTool: '', texts: [], lastAssistant: '', lastReason: null, injected: 0 };
      sessions.set(sessionId, st);
    }
    return st;
  }

  function settleWaiters(sessionId) {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w.sessionId !== sessionId) continue;
      if (w.turn !== null && sessionState(sessionId).turn <= w.turn) continue;
      waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(true);
    }
  }

  // 事件的 sessionId 在外层 params 上（params.sessionId + params.event），不在 event 自己身上。
  function handleEvent(params) {
    const event = (params && params.event) || {};
    if (!event.type) return;
    const data = event.data || {};
    const sessionId = (params && params.sessionId) || event.sessionId || (event.session && event.session.id);
    if (!sessionId) return;
    const st = sessionState(sessionId);
    st.seq = event.seq || st.seq;
    if (event.type === 'turn/start') {
      st.running = true;
      st.texts = [];
      st.lastTool = '';
    } else if (event.type === 'step/start') {
      st.step = data.step || st.step;
    } else if (event.type === 'assistant/message') {
      const blocks = (data.message && data.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) st.texts.push(b.text);
        else if (b.type === 'tool-call') st.lastTool = b.name || st.lastTool;
      }
    } else if (event.type === 'tool/call') {
      st.lastTool = data.name || st.lastTool;
    } else if (event.type === 'agent/inbox/spliced') {
      st.injected += 1;
    } else if (event.type === 'turn/end') {
      st.running = false;
      st.turn += 1;
      st.lastAssistant = st.texts.join('\n').trim();
      st.lastReason = data.reason || null;
      settleWaiters(sessionId);
    }
    if (opts.onEvent) {
      try { opts.onEvent(sessionId, event); } catch (err) { /* 监听方出错不能影响运行时 */ }
    }
  }

  function onLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch (err) { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error('SDK 调用失败：' + JSON.stringify(msg.error).slice(0, 300)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'session.status') {
      const params = msg.params || {};
      const st = sessionState(params.sessionId);
      st.running = params.status === 'running';
      if (params.status === 'idle') settleWaiters(params.sessionId);
      return;
    }
    if (msg.method === 'session.event') {
      handleEvent(msg.params || {});
    }
  }

  function request(method, params, timeoutMs) {
    if (closed) return Promise.reject(new Error('运行时已关闭'));
    const id = ++nextId;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + ' 超时（' + Math.round((timeoutMs || 30000) / 1000) + ' 秒）'));
      }, timeoutMs || 30000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  function start() {
    if (ready) return ready;
    child = spawn(resolved.command, resolved.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    readline.createInterface({ input: child.stdout }).on('line', onLine);
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString().trim();
      if (!s) return;
      stderrTail.push(s);
      if (stderrTail.length > 40) stderrTail = stderrTail.slice(-40);
    });
    child.on('exit', (code) => {
      closed = true;
      const tail = stderrTail.slice(-3).join(' | ');
      for (const [, p] of pending) p.reject(new Error('SDK 运行时退出（code=' + code + '）' + (tail ? '：' + tail : '')));
      pending.clear();
      for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve(false); }
    });
    ready = request('initialize', { provider: opts.provider || 'deepseek-official', model, cwd }, 60000)
      .then((info) => {
        log.info('SDK 运行时就绪', { cwd: path.basename(cwd), model, source: resolved.source });
        return info;
      });
    return ready;
  }

  async function ensureSession(sessionId, permission) {
    await start();
    const st = sessionState(sessionId);
    if (st.prepared) return st;
    st.prepared = true;
    // 新会话默认权限是 workspace-write；在 D: 盘这类卷上沙箱建不起来，必须显式改成配置的模式。
    if (permission) {
      try {
        await request('session/query', { sessionId, contentBlocks: [{ type: 'text', text: '/permission ' + permission }] }, 30000);
      } catch (err) {
        log.warn('设置会话权限失败', { permission, error: err.message.slice(0, 160) });
      }
    }
    return st;
  }

  async function resume(sessionId, permission) {
    await start();
    // 同一会话只能 resume 一次：运行时里已经打开过的会话再 resume 会报「already open」。
    const st = sessionState(sessionId);
    if (st.prepared) return st;
    try {
      await request('session/resume', { sessionId }, 30000);
      log.info('已续接会话', { sessionId: String(sessionId).slice(0, 24) });
    } catch (err) {
      log.warn('续接会话失败，将按新会话处理', { error: err.message.slice(0, 160) });
    }
    return ensureSession(sessionId, permission);
  }

  // 传 opts.resume=true 表示这个 sessionId 是磁盘上已有的（持久化的），要先 session/resume 载入历史，
  // 否则 session/prompt 会因为「同名会话已存在」直接报错。
  async function prompt(sessionId, text, permission, opts) {
    const wantResume = Boolean(opts && opts.resume);
    const st = wantResume ? await resume(sessionId, permission) : await ensureSession(sessionId, permission);
    const before = st.turn;
    const result = await request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text }] }, 30000);
    return { messageId: result && result.messageId, turnBefore: before };
  }

  // 等「某一轮结束」：不靠 status 的瞬时翻转，靠 turn 计数长了没有。
  function waitTurn(sessionId, turnBefore, timeoutMs) {
    const st = sessionState(sessionId);
    if (st.turn > turnBefore) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { sessionId, turn: turnBefore, resolve, timer: null };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        resolve(false);
      }, Math.max(1000, timeoutMs || 120000));
      waiters.push(w);
    });
  }

  function state(sessionId) {
    const st = sessionState(sessionId);
    return { running: st.running, turn: st.turn, step: st.step, lastTool: st.lastTool, lastAssistant: st.lastAssistant, lastReason: st.lastReason, injected: st.injected };
  }

  function close() {
    closed = true;
    try { if (child && child.stdin.writable) child.stdin.end(); } catch (err) { /* ignore */ }
    setTimeout(() => { try { if (child) child.kill(); } catch (err) { /* ignore */ } }, 500);
  }

  return { start, prompt, resume, waitTurn, state, close, request, sessionState };
}

module.exports = { createRuntime, resolveRuntime, DEFAULT_ELECTRON, DEFAULT_BIN, DEFAULT_PROFILE, DEFAULT_DESK_MODEL, DEFAULT_WORKER_MODEL };
