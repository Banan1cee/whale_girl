'use strict';
// 编排层：把「一条微信消息」变成「前台一轮 + 可能的工人一轮 + 前台再回一轮」。
// 这里只做顺序和状态，不碰 HTTP、不碰 DSH 细节、不碰磁盘格式——所以可以直接用假的 dsh/orders 测。

const fs = require('fs');
const path = require('path');
const {
  parseDesk,
  parseWorker,
  cleanForWeChat,
  splitBubbles,
  buildDeskTask,
  buildWorkerTask,
} = require('./protocol');

const DEDUPE_TTL_MS = 30 * 60 * 1000;
const DEDUPE_MAX = 4000;
const FALLBACK_REPLY = '刚卡了一下，我确认完马上回你。';

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
    // 日志只打长度和结构，不打聊天正文；排查靠 events.jsonl 里的订单级记录。
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

// 同一个会话严格串行：桥接本身也是每会话串行，但重试和并发可能越过来。
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

function createRelay(opts) {
  const config = opts.config;
  const orders = opts.orders;
  const dsh = opts.dsh;
  const log = opts.logger || createLogger(config && config.logPath);
  const queue = createKeyedQueue();
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

  // 所有对外回复都从这里出去：统一清洗、统一截断、统一拆成微信气泡。
  function respond(text) {
    const max = Number(config.orders.maxReplyChars) || 1200;
    const clean = cleanForWeChat(text, max);
    const bubbles = splitBubbles(clean, Number(config.orders.bubbleChars) || 180);
    if (!bubbles.length) bubbles.push(FALLBACK_REPLY);
    return { ok: true, action: 'reply', reply: bubbles.join('\n'), bubbles };
  }

  function orderOf(result) {
    return result && result.order ? result.order : result;
  }

  // DSH 在 Windows 上要先给工作区目录写 ACL 才能进沙箱；有些卷上这一步直接失败（Win32 5），
  // workspace-write 就永远跑不起来。遇到这种失败就把本轮换成 fallback 模式重跑一次，
  // 并记在 roleCfg 上，后面几轮不再先失败一次（每轮多花的是一次无用的模型调用）。
  const SANDBOX_PROVISION_FAIL = /grantWrite|SetNamedSecurityInfoW/i;

  async function runWithFallback(role, roleCfg, opts) {
    if (roleCfg._fallbackActive) {
      return dsh.runTurn(Object.assign({}, opts, { permissionMode: roleCfg.fallbackPermissionMode }));
    }
    const first = await dsh.runTurn(Object.assign({}, opts, { permissionMode: roleCfg.permissionMode }));
    if (first && !first.ok && SANDBOX_PROVISION_FAIL.test(String(first.error || '')) && roleCfg.fallbackPermissionMode) {
      log.warn('沙箱无法在工作区落地，改用回退权限重跑本轮', {
        role,
        from: roleCfg.permissionMode,
        to: roleCfg.fallbackPermissionMode,
        error: String(first.error).slice(0, 160),
      });
      roleCfg._fallbackActive = true;
      return dsh.runTurn(Object.assign({}, opts, { sessionId: null, permissionMode: roleCfg.fallbackPermissionMode }));
    }
    return first;
  }

  async function runDeskTurn(order, customerText, extra) {
    const e = extra || {};
    let orderMd = '';
    try { orderMd = orders.readOrderMd(order.orderId); } catch (err) { orderMd = ''; }
    const prompt = buildDeskTask({
      orderMd,
      status: e.status || order.status,
      workerReport: e.workerReport,
      workerQuestions: e.workerQuestions,
      customerText,
    });
    const sessionId = deskSessions[order.chatId] || null;
    // session 事件一到就落盘：进程半路被杀时，下一轮还能续上同一个会话，不会凭空另开一个。
    const onEvent = (event) => {
      if (event && event.type === 'session' && event.sessionId && deskSessions[order.chatId] !== event.sessionId) {
        deskSessions[order.chatId] = event.sessionId;
        saveDeskSessions();
      }
    };
    const res = await runWithFallback('desk', config.desk, {
      cwd: config.deskCwd,
      prompt,
      sessionId,
      approvalPolicy: config.desk.approvalPolicy,
      timeoutMs: config.desk.timeoutMs,
      env: config.dsh && config.dsh.env ? config.dsh.env : null,
      onEvent,
    });
    if (res && res.sessionId && res.sessionId !== sessionId) {
      deskSessions[order.chatId] = res.sessionId;
      saveDeskSessions();
    }
    return res;
  }

  async function runWorkerTurn(order, dispatch, customerText) {
    const p = orders.paths(order.orderId);
    const orderMd = (() => { try { return orders.readOrderMd(order.orderId); } catch (err) { return ''; } })();
    const prompt = buildWorkerTask({
      orderMd,
      dispatch,
      customerText,
      workspace: orders.paths(order.orderId).workspace,
      answers: (order.pendingQuestions || []).slice(),
    });
    const res = await runWithFallback('worker', config.worker, {
      cwd: p.workspace,
      prompt,
      sessionId: order.workerSessionId || null,
      approvalPolicy: config.worker.approvalPolicy,
      timeoutMs: config.worker.timeoutMs,
      env: config.dsh && config.dsh.env ? config.dsh.env : null,
      onEvent: (event) => {
        if (orders.appendWorkerEvent) orders.appendWorkerEvent(order.orderId, event);
        if (event && event.type === 'session' && event.sessionId && order.workerSessionId !== event.sessionId) {
          orders.updateOrder(order.orderId, { workerSessionId: event.sessionId });
        }
      },
    });
    if (res && res.ok && res.sessionId && res.sessionId !== order.workerSessionId) {
      orders.updateOrder(order.orderId, { workerSessionId: res.sessionId });
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
    const summary = [
      '订单 ' + order.orderId,
      '状态 ' + order.status,
      '客户 ' + (order.nickname || order.chatId),
      '会话 desktop=' + (deskSessions[order.chatId] || '无') + ' worker=' + (order.workerSessionId || '无'),
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
    // 私聊里 at_me 恒为 false（桥接不填），所以只能按「群聊才看 at_me」来判：群里没叫我就别插嘴。
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
      return respond(FALLBACK_REPLY);
    }
    const desk = parseDesk(deskRes.text);
    orders.appendThread(order.orderId, '**前台**：' + (desk.dispatch ? desk.reply + '\n\n（派单：' + desk.dispatch + '）' : desk.reply));
    if (desk.requirements.length) {
      orders.appendRequirement(order.orderId, desk.requirements);
      log.info('需求更新', { orderId: order.orderId, count: desk.requirements.length });
    }

    const wanted = Boolean(desk.dispatch) || (order.status === 'working' && (order.pendingQuestions || []).length > 0);
    if (!wanted) {
      // 前台最常见的失误是「把需求记下来」当成「活干完了」：没有工程汇报却宣称完成，客户会当真。
      // 这种话术不能发给客户，换成不承诺进度的一句，并留证据。
      const claim = /(?:已经|已)(?:做好|建好|写完|改好|完成|发过去|跑通|处理好)/;
      if (claim.test(desk.reply || '')) {
        log.warn('前台虚报完成，已拦下', { orderId: order.orderId, chars: desk.reply.length });
        return respond('我这就安排，弄好马上发你。');
      }
      return respond(desk.reply || FALLBACK_REPLY);
    }
    if (!canDispatch(order)) {
      log.info('派单被拦下，等老板确认', { orderId: order.orderId });
      return respond(desk.reply || '需求我记下了，我确认一下安排马上回你。');
    }

    if (order.status !== 'working') orders.updateOrder(order.orderId, { status: 'working' });
    const dispatch = desk.dispatch || ('客户回答：' + text);
    orders.appendEvent(order.orderId, { type: 'dispatch', chars: dispatch.length });

    const workerRes = await runWorkerTurn(order, dispatch, text);
    if (!workerRes || !workerRes.ok) {
      log.error('工人轮失败', {
        orderId: order.orderId,
        durationMs: workerRes && workerRes.durationMs,
        error: (workerRes && workerRes.error) || 'unknown',
        timedOut: workerRes && workerRes.timedOut,
      });
      const msg = desk.dispatch
        ? '收到，我先把这版做出来，做完跟你对一下。'
        : '我这边刚才没跑通，正在处理，稍后给你结果。';
      return respond(msg);
    }

    const worker = parseWorker(workerRes.text);
    orders.appendThread(order.orderId, '**工人**：' + worker.report + (worker.outputs.length ? '\n\n产出：' + worker.outputs.join('、') : ''));
    // 工人被前台的绝对路径带跑偏是真实发生过的事：产出落到了工作区外。
    // 不改回复（前台已经在转述），但要留下证据，便于事后核对。
    const escaped = worker.outputs.filter((p) => /^[a-zA-Z]:|^\\\\|^\//.test(p) || p.includes('..'));
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
    orders.updateOrder(order.orderId, {
      pendingQuestions: worker.questions,
      pendingReport: worker.report,
    });

    // 让前台把工程话翻成客户话：人格隔离靠这一步，不靠模型自觉。
    const refreshed = orders.loadOrder(order.orderId);
    const desk2Res = await runDeskTurn(refreshed, text, {
      workerReport: worker.report,
      workerQuestions: worker.questions,
      status: 'working',
    });
    if (!desk2Res || !desk2Res.ok) {
      const fallback = worker.report + (worker.questions.length ? '\n\n需要你确认：' + worker.questions.join('；') : '');
      return respond(fallback);
    }
    const desk2 = parseDesk(desk2Res.text);
    if (desk2.requirements.length) orders.appendRequirement(order.orderId, desk2.requirements);
    const final = respond(desk2.reply || worker.report);
    orders.appendThread(order.orderId, '**前台**：' + final.reply);
    return final;
  }

  async function handleIncoming(body) {
    const chatId = String((body && (body.chat_id || body.chatId)) || '').trim();
    if (!chatId) return { ok: false, error: 'missing chat_id' };
    try {
      return await queue.run(chatId, () => turn(body || {}));
    } catch (err) {
      log.error('处理入站消息异常', { error: err && err.message, stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : '' });
      return respond(FALLBACK_REPLY);
    }
  }

  return {
    handleIncoming,
    deskSessionOf: (chatId) => deskSessions[chatId] || null,
    logger: log,
  };
}

module.exports = { createRelay, createLogger, createKeyedQueue };
