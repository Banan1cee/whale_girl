'use strict';
// 编排层：一条微信消息进来之后发生什么。
// 前台（desk）负责谈，工人（worker）负责判断和干活；两边都是常驻 DSH SDK 会话，不是一轮一进程。
//
// 三个硬约束（都被真实事故逼出来过）：
// 1. 派单前必须快：前台直接答，需要工程判断就走「几秒钟的评估」，超时也先回一句。
// 2. 派单是时间标志：派单后立刻回话，工人在后台跑，客户有等待冗余。
// 3. 派单后客户再说话，直接插进工人正在跑的那一轮（followup），同时前台按真实进度回答。

const fs = require('fs');
const path = require('path');
const {
  parseDesk,
  parseWorker,
  cleanForWeChat,
  splitBubbles,
  buildDeskTask,
  buildWorkerTask,
  buildWorkerEvalTask,
} = require('./protocol');

const DEDUPE_TTL_MS = 30 * 60 * 1000;
const DEDUPE_MAX = 4000;
const FALLBACK_REPLY = '刚卡了一下，我确认完马上回你。';
// 前台最常见的失误：没有工程汇报却宣称完成。这种话术不能直接发给客户。
const CLAIM_RE = /(?:已经|已)(?:做好|建好|写完|改好|完成|发过去|跑通|处理好)/;

function createLogger(file) {
  let stream = null;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      stream = fs.createWriteStream(file, { flags: 'a' });
    } catch (err) {
      stream = null;
    }
  }
  const write = (level, message, extra) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, message, ...(extra || {}) });
    if (stream) stream.write(line + '\n');
    if (level === 'error') console.error(line);
    else console.log(line);
  };
  return {
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
    close: () => { if (stream) stream.end(); },
  };
}

function createKeyedQueue() {
  const tails = new Map();
  return {
    run(key, fn) {
      const prev = tails.get(key) || Promise.resolve();
      const next = prev.then(fn, fn);
      const tail = next.catch(() => {});
      tails.set(key, tail);
      tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return next;
    },
    size: () => tails.size,
  };
}

function short(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRelay(opts) {
  const config = opts.config;
  const orders = opts.orders;
  const agents = opts.agents;
  const log = opts.logger || createLogger(config && config.logPath);
  const queue = createKeyedQueue();      // 一个客户一条线
  const deskQueue = createKeyedQueue();  // 前台 session 不能被两个进程同时写
  const watchers = new Map();            // orderId -> Promise
  const bgTasks = new Set();
  const seen = new Map();
  const deskFile = config ? path.join(config.stateRoot, 'desk.json') : null;
  let deskSessions = loadDeskSessions(deskFile);

  function loadDeskSessions(file) {
    if (!file) return {};
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (err) { return {}; }
  }
  function saveDeskSessions() {
    if (!deskFile) return;
    try {
      fs.mkdirSync(path.dirname(deskFile), { recursive: true });
      const tmp = deskFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(deskSessions, null, 2));
      fs.renameSync(tmp, deskFile);
    } catch (err) {
      log.warn('保存前台 session 映射失败', { error: err.message });
    }
  }

  function duplicated(msgId) {
    if (!msgId) return false;
    const now = Date.now();
    const hit = seen.get(msgId);
    if (hit && now - hit < DEDUPE_TTL_MS) return true;
    seen.set(msgId, now);
    if (seen.size > DEDUPE_MAX) {
      for (const [k, t] of seen) { if (now - t > DEDUPE_TTL_MS) seen.delete(k); }
    }
    return false;
  }

  function orderOf(result) {
    return result && result.order ? result.order : result;
  }

  function respond(text) {
    const max = Number(config.orders.maxReplyChars) || 1200;
    const clean = cleanForWeChat(text, max);
    const bubbles = splitBubbles(clean, Number(config.orders.bubbleChars) || 180);
    if (!bubbles.length) bubbles.push(FALLBACK_REPLY);
    return { ok: true, action: 'reply', reply: bubbles.join('\n'), bubbles };
  }

  // 工人干完时没法主动发微信（桥接没有推送通道）：结果写进待发话术，客户下次说话时补发。
  function pendingPath(orderId) {
    return path.join(orders.paths(orderId).dir, 'pending-reply.txt');
  }
  function pendingOf(orderId) {
    try { return fs.readFileSync(pendingPath(orderId), 'utf8').trim(); } catch (err) { return ''; }
  }
  function writePending(orderId, text) {
    const merged = [pendingOf(orderId), text].filter(Boolean).join('\n');
    try {
      fs.writeFileSync(pendingPath(orderId), merged);
      return true;
    } catch (err) {
      log.warn('待发话术没写出去', { orderId, error: err.message });
      return false;
    }
  }
  function clearPending(orderId) {
    try { fs.unlinkSync(pendingPath(orderId)); } catch (err) { /* 已经发过就算了 */ }
  }
  function withPending(order, result) {
    const pending = pendingOf(order.orderId);
    if (!pending) return result;
    clearPending(order.orderId);
    const extra = respond(pending);
    const bubbles = extra.bubbles.concat((result && result.bubbles) || []);
    orders.appendThread(order.orderId, '**前台（补发工程结果）**：' + pending);
    return { ok: true, action: 'reply', reply: bubbles.join('\n'), bubbles };
  }

  function workspaceFiles(orderId) {
    try {
      return fs.readdirSync(orders.paths(orderId).workspace)
        .filter((n) => !n.startsWith('.') && !n.startsWith('_'))
        .slice(0, 8);
    } catch (err) {
      return [];
    }
  }

  // 前台说进度时只能照着这里说：真实的步骤、工具、产出，不许自己编。
  function progressText(orderId, order) {
    const st = agents.workerState ? agents.workerState(orderId) : {};
    const files = workspaceFiles(orderId);
    const parts = [];
    if (st.running) parts.push('正在做（第 ' + (st.step || 1) + ' 步' + (st.lastTool ? '，刚在用 ' + st.lastTool : '') + '）');
    else if (st.turn) parts.push('已完成 ' + st.turn + ' 轮');
    else parts.push('还没开工');
    if (files.length) parts.push('已产出：' + files.join('、'));
    if (st.injected > 1) parts.push('客户插话已送达工程 ' + (st.injected - 1) + ' 次');
    if (order && order.pendingReport) parts.push('最近一次汇报：' + short(order.pendingReport, 200));
    return parts.join('\n');
  }

  async function runDeskTurn(order, customerText, extra) {
    const e = extra || {};
    let orderMd = '';
    try { orderMd = orders.readOrderMd(order.orderId); } catch (err) { orderMd = ''; }
    const prompt = buildDeskTask({
      orderMd,
      status: e.status || order.status,
      progress: progressText(order.orderId, order),
      workerReport: e.workerReport,
      workerQuestions: e.workerQuestions,
      customerText,
    });
    const sessionId = deskSessions[order.chatId] || null;
    const res = await deskQueue.run(order.chatId, () => agents.deskTurn({
      chatId: order.chatId,
      sessionId,
      prompt,
      timeoutMs: config.desk.timeoutMs,
    }));
    if (res && res.sessionId && res.sessionId !== sessionId) {
      deskSessions[order.chatId] = res.sessionId;
      saveDeskSessions();
    }
    if (res && res.text) {
      const pg = agents.workerState ? agents.workerState(order.orderId) : null;
      if (pg) {}
    }
    return res;
  }

  // 工人干完一轮 / 中途结束一轮：把它的汇报翻成客户话，排进待发话术。
  async function handleWorkerReport(order, text) {
    const worker = parseWorker(text);
    orders.appendThread(order.orderId, '**工人**：' + worker.report + (worker.outputs.length ? '\n\n产出：' + worker.outputs.join('、') : ''));
    const escaped = worker.outputs.filter((x) => /^[a-zA-Z]:|^\\|^\//.test(x) || x.includes('..'));
    if (escaped.length) {
      log.warn('工人产出路径在工作区外', { orderId: order.orderId, count: escaped.length });
      orders.appendEvent(order.orderId, { type: 'output_outside_workspace', count: escaped.length });
    }
    orders.appendEvent(order.orderId, {
      type: 'worker_done',
      chars: worker.report.length,
      questions: worker.questions.length,
      outputs: worker.outputs.length,
    });
    orders.updateOrder(order.orderId, { pendingQuestions: worker.questions, pendingReport: worker.report });

    const refreshed = orders.loadOrder(order.orderId);
    const deskRes = await runDeskTurn(refreshed, '（工程刚才做了这些，没有新的客户消息）', {
      workerReport: worker.report,
      workerQuestions: worker.questions,
      status: 'working',
    });
    let say;
    if (deskRes && deskRes.ok) {
      const parsed = parseDesk(deskRes.text);
      if (parsed.requirements.length) orders.appendRequirement(order.orderId, parsed.requirements);
      say = parsed.reply || worker.report;
    } else {
      say = worker.report + (worker.questions.length ? '\n\n需要你确认：' + worker.questions.join('；') : '');
    }
    writePending(order.orderId, say);
    orders.appendThread(order.orderId, '**前台（待发）**：' + say);
    orders.appendEvent(order.orderId, { type: 'reply_queued', chars: say.length });
    log.info('工人一轮结束，结果已排队等客户下一条消息', { orderId: order.orderId, chars: say.length });
  }

  // 每个订单一个后台观察者：工人一轮结束就把结果转述成客户话。
  function ensureWatcher(order) {
    const id = order.orderId;
    if (watchers.has(id)) return watchers.get(id);
    const task = (async () => {
      let turn = agents.workerState(id).turn || 0;
      for (;;) {
        const r = await agents.workerWaitTurn(id, turn, Number(config.worker.idleWatchMs) || 1800000);
        if (!r || !r.ok) break;
        turn = r.turn;
        if (r.text) await handleWorkerReport(order, r.text);
        await sleep(200);
        if (!agents.workerState(id).running) break;
      }
    })()
      .catch((err) => log.error('工人观察者异常', { orderId: id, error: err && err.message }))
      .finally(() => { watchers.delete(id); });
    watchers.set(id, task);
    bgTasks.add(task);
    task.then(() => bgTasks.delete(task), () => bgTasks.delete(task));
    return task;
  }

  // 派单：把活排给工人，立刻回客户；后台观察者负责把结果转述回来。
  async function startWork(order, dispatch, customerText) {
    const p = orders.paths(order.orderId);
    let orderMd = '';
    try { orderMd = orders.readOrderMd(order.orderId); } catch (err) { orderMd = ''; }
    const prompt = buildWorkerTask({
      orderMd,
      dispatch,
      customerText,
      workspace: p.workspace,
      answers: (order.pendingQuestions || []).slice(),
    });
    const res = await agents.workerStart({
      orderId: order.orderId,
      cwd: p.workspace,
      sessionId: order.workerSessionId || null,
      prompt,
    });
    if (res && res.sessionId && res.sessionId !== order.workerSessionId) {
      order.workerSessionId = res.sessionId;
      orders.updateOrder(order.orderId, { workerSessionId: res.sessionId });
    }
    orders.appendEvent(order.orderId, { type: 'dispatch_start', ok: Boolean(res && res.ok) });
    if (!res || !res.ok) {
      log.error('开工失败', { orderId: order.orderId, error: (res && res.error) || 'unknown' });
      return { ok: false, error: (res && res.error) || 'unknown' };
    }
    ensureWatcher(order);
    return { ok: true };
  }

  async function injectToWorker(order, text) {
    const res = await agents.workerInject(order.orderId, text);
    if (res && res.ok) {
      orders.appendEvent(order.orderId, { type: 'inject', chars: text.length });
      ensureWatcher(order);
    } else {
      log.warn('插话失败', { orderId: order.orderId, error: res && res.error });
    }
    return res;
  }

  function canDispatch(order) {
    if (config.orders.confirmMode === 'frontdesk') return true;
    return order.status === 'working';
  }

  function ownerCommand(order, text) {
    if (!config.owner || !config.owner.chatId || config.owner.chatId !== order.chatId) return null;
    const m = /^#\s*(确认|暂停|恢复|完成|状态)\s*(.*)$/.exec(String(text || '').trim());
    if (!m) return null;
    return { command: m[1], arg: m[2] };
  }

  async function handleOwnerCommand(order, cmd) {
    if (cmd.command === '暂停') { config.owner.paused = true; return { ok: true, action: 'reply', reply: '已暂停自动回复。' }; }
    if (cmd.command === '恢复') { config.owner.paused = false; return { ok: true, action: 'reply', reply: '已恢复自动回复。' }; }
    if (cmd.command === '确认') {
      const target = cmd.arg ? [cmd.arg] : [order.orderId];
      for (const id of target) { try { orders.updateOrder(id, { status: 'working' }); } catch (err) { /* 不存在就跳过 */ } }
      return { ok: true, action: 'reply', reply: '已确认，开始做。' };
    }
    if (cmd.command === '完成') {
      const target = cmd.arg ? [cmd.arg] : [order.orderId];
      for (const id of target) { try { orders.updateOrder(id, { status: 'delivered' }); } catch (err) { /* 不存在就跳过 */ } }
      return { ok: true, action: 'reply', reply: '已标记交付。' };
    }
    const st = agents.workerState(order.orderId);
    const summary = [
      '订单 ' + order.orderId,
      '状态 ' + order.status,
      '客户 ' + (order.nickname || order.chatId),
      '前台 session ' + (deskSessions[order.chatId] || '无'),
      '工人 session ' + (order.workerSessionId || '无'),
      '工人 ' + (st.running ? '在干活（第 ' + (st.step || 1) + ' 步）' : '空闲') + '，已完成 ' + (st.turn || 0) + ' 轮',
      '待确认 ' + ((order.pendingQuestions || []).length) + ' 条',
    ].join('\n');
    return { ok: true, action: 'reply', reply: summary };
  }

  async function turn(body) {
    const chatId = String(body.chat_id || body.chatId || '').trim();
    const text = String(body.text || body.content || '').trim();
    const nickname = String(body.nickname || body.sender_name || '').trim();
    const msgId = String(body.msg_id || body.msgId || '').trim();

    if (!chatId || !text) return { ok: true, action: 'ignore' };
    // 私聊里 at_me 恒为 false（桥接不填），所以只能按「群聊才看 at_me」来判。
    if (String(body.chat_type || '') === 'group' && !body.at_me) return { ok: true, action: 'ignore' };
    if (config.owner && config.owner.paused) return { ok: true, action: 'ignore' };
    if (duplicated(msgId)) return { ok: true, action: 'ignore' };

    const ensured = orders.ensureOrder({ chatId, nickname });
    const order = orderOf(ensured);

    const owner = ownerCommand(order, text);
    if (owner) {
      log.info('老板指令', { orderId: order.orderId, command: owner.command });
      return handleOwnerCommand(order, owner);
    }

    orders.appendEvent(order.orderId, { type: 'inbound', chatId, nickname, chars: text.length, msgId });
    orders.appendThread(order.orderId, '**客户**：' + text);

    const deskRes = await runDeskTurn(order, text);
    if (!deskRes || !deskRes.ok) {
      log.error('前台轮失败', {
        orderId: order.orderId,
        durationMs: deskRes && deskRes.durationMs,
        error: (deskRes && deskRes.error) || 'unknown',
        timedOut: deskRes && deskRes.timedOut,
      });
      return withPending(order, respond(FALLBACK_REPLY));
    }
    const desk = parseDesk(deskRes.text);
    const marks = [];
    if (desk.evaluate) marks.push('（问工程：' + desk.evaluate + '）');
    if (desk.dispatch) marks.push('（派单：' + desk.dispatch + '）');
    orders.appendThread(order.orderId, '**前台**：' + desk.reply + (marks.length ? '\n\n' + marks.join('\n') : ''));
    if (desk.requirements.length) {
      orders.appendRequirement(order.orderId, desk.requirements);
      log.info('需求更新', { orderId: order.orderId, count: desk.requirements.length });
    }

    // 1) 开工。派单就是时间标志：这一刻起客户有等待冗余，回复不用再等工人。
    if (desk.dispatch) {
      if (!canDispatch(order)) {
        log.info('派单被拦下，等老板确认', { orderId: order.orderId });
        return withPending(order, respond(desk.reply || '需求我记下了，我确认一下安排马上回你。'));
      }
      if (order.status !== 'working') orders.updateOrder(order.orderId, { status: 'working' });
      orders.appendEvent(order.orderId, { type: 'dispatch', chars: desk.dispatch.length });
      await startWork(order, desk.dispatch, text);
      return withPending(order, respond(desk.reply || '收到，我这就开工，弄完把结果发你。'));
    }

    // 2) 问工程。派单前要快：评估有硬超时，超了就先用前台这句话顶住。
    //    派单后是插话：直接进工人正在跑的那一轮，同时前台按真实进度回答。
    if (desk.evaluate) {
      const working = order.status === 'working';
      if (working) {
        await injectToWorker(order, '客户补充：' + text + (desk.evaluate ? '\n（前台要你回答：' + desk.evaluate + '）' : ''));
        return withPending(order, respond(desk.reply || '收到，我把它加进手里的事了。'));
      }
      const p = orders.paths(order.orderId);
      let orderMd = '';
      try { orderMd = orders.readOrderMd(order.orderId); } catch (err) { orderMd = ''; }
      const evalRes = await agents.workerEval({
        orderId: order.orderId,
        cwd: p.workspace,
        sessionId: order.workerSessionId || null,
        prompt: buildWorkerEvalTask({ orderMd, evaluate: desk.evaluate, customerText: text }),
        timeoutMs: config.worker.evalTimeoutMs,
      });
      if (evalRes && evalRes.sessionId && evalRes.sessionId !== order.workerSessionId) {
        order.workerSessionId = evalRes.sessionId;
        orders.updateOrder(order.orderId, { workerSessionId: evalRes.sessionId });
      }
      if (!evalRes || !evalRes.ok) {
        log.warn('工程评估没赶上，先回一句', { orderId: order.orderId, error: evalRes && evalRes.error, timedOut: evalRes && evalRes.timedOut });
        return withPending(order, respond(desk.reply || '这个我确认一下再回你。'));
      }
      orders.appendThread(order.orderId, '**工人（评估）**：' + evalRes.text);
      const desk2Res = await runDeskTurn(orders.loadOrder(order.orderId), text, {
        workerReport: evalRes.text,
        status: order.status,
      });
      let reply = evalRes.text;
      if (desk2Res && desk2Res.ok) {
        const desk2 = parseDesk(desk2Res.text);
        if (desk2.requirements.length) orders.appendRequirement(order.orderId, desk2.requirements);
        reply = desk2.reply || evalRes.text;
      }
      orders.appendThread(order.orderId, '**前台**：' + reply);
      return withPending(order, respond(reply));
    }

    // 3) 派单后客户只是补充/细化需求：插进工人正在跑的那一轮。
    if (order.status === 'working') {
      await injectToWorker(order, '客户补充（前台已记档，请一并处理）：' + text);
      return withPending(order, respond(desk.reply || '收到，我把它加进手里的事了。'));
    }

    // 4) 普通问答（含问进度：前台已经拿到了真实的工程状态）。
    if (CLAIM_RE.test(desk.reply || '') && !order.pendingReport) {
      log.warn('前台虚报完成，已拦下', { orderId: order.orderId, chars: desk.reply.length });
      return withPending(order, respond('我这就安排，弄好马上发你。'));
    }
    return withPending(order, respond(desk.reply || FALLBACK_REPLY));
  }

  async function handleIncoming(body) {
    const chatId = String((body && (body.chat_id || body.chatId)) || '').trim();
    if (!chatId) return { ok: false, error: 'missing chat_id' };
    try {
      return await queue.run(chatId, () => turn(body || {}));
    } catch (err) {
      log.error('处理入站消息异常', {
        error: err && err.message,
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : '',
      });
      return respond(FALLBACK_REPLY);
    }
  }

  // 测试与运维用：等所有后台观察者跑完。
  function drain() {
    const wait = () => (bgTasks.size ? Promise.all(Array.from(bgTasks)).then(wait) : Promise.resolve());
    return wait();
  }

  return {
    handleIncoming,
    drain,
    deskSessionOf: (chatId) => deskSessions[chatId] || null,
    logger: log,
  };
}

module.exports = { createRelay, createLogger, createKeyedQueue };
