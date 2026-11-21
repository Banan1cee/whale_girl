'use strict';
// agents.js —— 把「常驻运行时」包装成前台/工人两种角色，编排层只跟它打交道。
// 关键区别（和之前的 headless 方案）：
//   · 前台：一个常驻进程 + 每个客户一个 session；每轮 prompt 后等这一轮结束取文本。
//   · 工人：一个订单一个常驻进程（cwd = 订单工作区）；派单后不等待，
//     客户再说话就用 prompt 插进去（agent.followup），当前工具调用结束后它自然读到。

const crypto = require('crypto');
const { createRuntime, resolveRuntime, DEFAULT_DESK_MODEL, DEFAULT_WORKER_MODEL } = require('./sdk');

function newSessionId() {
  return 'session-' + crypto.randomUUID();
}

function reasonText(reason) {
  if (!reason) return 'unknown';
  if (reason.kind === 'completed') return null;
  const err = reason.error || reason.failure;
  return String((err && (err.message || err.code)) || reason.kind);
}

function createAgents(options) {
  const opts = options || {};
  const config = opts.config;
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const factory = opts.createRuntime || createRuntime;
  const resolved = opts.resolved || resolveRuntime(config.dsh);
  // 每个运行时进程都要一个独立的本地口（插件监听在回环上）；token 由本次启动随机生成。
  const steerBase = Number(config.dsh && config.dsh.steerPortBase) || 8791;
  const steerToken = crypto.randomUUID();
  let nextSteerPort = steerBase + 1;
  function takeSteerPort() {
    const port = nextSteerPort;
    nextSteerPort += 1;
    return port;
  }
  let deskRuntime = null;
  let workerEventSink = opts.onWorkerEvent || null;
  const workers = new Map();

  function ensureDesk() {
    if (!deskRuntime) {
      deskRuntime = factory({
        cwd: config.deskCwd,
        model: config.desk.model || DEFAULT_DESK_MODEL,
        dsh: config.dsh,
        resolved,
        log,
        steerPort: takeSteerPort(),
        steerToken,
      });
    }
    return deskRuntime;
  }

  function ensureWorker(orderId, cwd) {
    let w = workers.get(orderId);
    if (!w) {
      w = {
        runtime: factory({
          cwd,
          model: config.worker.model || DEFAULT_WORKER_MODEL,
          dsh: config.dsh,
          resolved,
          log,
          steerPort: takeSteerPort(),
          steerToken,
          onEvent: (sessionId, event) => {
            if (workerEventSink) workerEventSink(sessionId, event);
          },
        }),
        sessionId: null,
        cwd,
      };
      workers.set(orderId, w);
    }
    return w;
  }

  // 前台一轮：prompt → 等这一轮结束 → 取这轮最后的助手文本。
  async function deskTurn(job) {
    const started = Date.now();
    const runtime = ensureDesk();
    const sessionId = job.sessionId || newSessionId();
    try {
      const p = await runtime.prompt(sessionId, job.prompt, config.desk.permissionMode, { resume: Boolean(job.sessionId) });
      const done = await runtime.waitTurn(sessionId, p.turnBefore, Number(job.timeoutMs) || Number(config.desk.timeoutMs) || 120000);
      const st = runtime.state(sessionId);
      const text = st.lastAssistant || '';
      const durationMs = Date.now() - started;
      if (!done) return { ok: false, sessionId, text, error: '前台轮超时', timedOut: true, durationMs };
      const bad = reasonText(st.lastReason);
      if (bad) return { ok: false, sessionId, text, error: bad, durationMs };
      return { ok: true, sessionId, text, durationMs };
    } catch (err) {
      return { ok: false, sessionId, error: err.message, durationMs: Date.now() - started };
    }
  }

  // 工人评估：只判断不开工，必须快（调用方给短超时）。
  async function workerEval(job) {
    const started = Date.now();
    const w = ensureWorker(job.orderId, job.cwd);
    const sessionId = job.sessionId || w.sessionId || newSessionId();
    w.sessionId = sessionId;
    try {
      const p = await w.runtime.prompt(sessionId, job.prompt, config.worker.evalPermissionMode || config.worker.permissionMode, { resume: Boolean(job.sessionId) });
      const done = await w.runtime.waitTurn(sessionId, p.turnBefore, Number(job.timeoutMs) || Number(config.worker.evalTimeoutMs) || 90000);
      const st = w.runtime.state(sessionId);
      const durationMs = Date.now() - started;
      if (!done) return { ok: false, sessionId, text: st.lastAssistant || '', error: '评估超时', timedOut: true, durationMs };
      const bad = reasonText(st.lastReason);
      if (bad) return { ok: false, sessionId, text: st.lastAssistant || '', error: bad, durationMs };
      return { ok: true, sessionId, text: st.lastAssistant || '', durationMs };
    } catch (err) {
      return { ok: false, sessionId, error: err.message, durationMs: Date.now() - started };
    }
  }

  // 开工：只负责把任务排进去，立刻返回。真干活在后台那一轮里。
  async function workerStart(job) {
    const w = ensureWorker(job.orderId, job.cwd);
    const sessionId = job.sessionId || w.sessionId || newSessionId();
    w.sessionId = sessionId;
    try {
      // 已经在跑就别再排一轮：直接把任务插进当前这一轮。
      if (w.runtime.state(sessionId).running) {
        const steered = await w.runtime.steer(sessionId, job.prompt);
        if (steered && steered.delivered) return { ok: true, sessionId, via: 'steer' };
        log.warn('开工时工人正在跑，steer 没送到，改为排队', { orderId: job.orderId, error: steered && steered.error });
      }
      await w.runtime.prompt(sessionId, job.prompt, config.worker.permissionMode, { resume: Boolean(job.sessionId) });
      return { ok: true, sessionId };
    } catch (err) {
      return { ok: false, sessionId, error: err.message };
    }
  }

  // 运行中插话：工人正在跑就用 steer（当前工具调用结束、下一步立刻读到）；
  // 已经闲下来了就退回普通 prompt —— 反正它马上会开始新的一轮。
  async function workerInject(orderId, text) {
    const w = workers.get(orderId);
    if (!w || !w.sessionId) return { ok: false, error: '工人还没开工' };
    try {
      if (w.runtime.state(w.sessionId).running) {
        const steered = await w.runtime.steer(w.sessionId, text);
        if (steered && steered.delivered) return { ok: true, via: 'steer' };
        log.warn('steer 没送到，退回下一轮排队', { orderId, error: steered && steered.error });
      }
      await w.runtime.prompt(w.sessionId, text, config.worker.permissionMode);
      return { ok: true, via: 'followup' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function workerState(orderId) {
    const w = workers.get(orderId);
    if (!w || !w.sessionId) return { running: false, turn: 0, step: 0, lastTool: '', lastAssistant: '', injected: 0 };
    return w.runtime.state(w.sessionId);
  }

  // 等工人的下一次「一轮结束」：不阻塞 HTTP，给后台观察者用。
  async function workerWaitTurn(orderId, turnBefore, timeoutMs) {
    const w = workers.get(orderId);
    if (!w || !w.sessionId) return { ok: false };
    const done = await w.runtime.waitTurn(w.sessionId, turnBefore, Number(timeoutMs) || 900000);
    const st = w.runtime.state(w.sessionId);
    return { ok: done, turn: st.turn, text: st.lastAssistant || '', running: st.running, reason: reasonText(st.lastReason) };
  }

  function close() {
    if (deskRuntime) deskRuntime.close();
    for (const [, w] of workers) w.runtime.close();
    workers.clear();
  }

  return {
    deskTurn,
    workerEval,
    workerStart,
    workerInject,
    workerState,
    workerWaitTurn,
    workerSessionOf: (orderId) => { const w = workers.get(orderId); return w ? w.sessionId : null; },
    setWorkerEventSink: (fn) => { workerEventSink = fn; },
    close,
    resolved,
  };
}

module.exports = { createAgents, newSessionId };
