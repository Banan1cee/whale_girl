'use strict';

const { sendDenial } = require('../core/wechatSendPolicy');
const { describeError } = require('../infra/errors');
const { tagName, textMeta } = require('../infra/privacy');

/**
 * 通用 HTTP 网关适配器：把微信中转服务发来的 JSON 变成统一消息，
 * 再把鲸鲸的回复 POST 回中转服务。
 *
 * 收消息：POST /webhook/{platform}  （协议见 docs/GATEWAY.md）
 * 发消息：POST {gateway.outboundUrl}  JSON:
 *   { platform, chat_id, chat_type, text, bubbles, reply_to, bot }
 */
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// 只保留微信：抖音桥接早已不适配，代码删掉后不再留一个永远连不上的平台名。
const PLATFORMS = ['wechat'];

function firstDefined(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
}

/** 从网关发来的任意 JSON 里提取统一消息 */
function normalizeInbound(payload, platform) {
  const root = payload && typeof payload === 'object' ? payload : {};
  const body = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? { ...root, ...root.data } : root;
  const rawChatId = firstDefined(body, ['chat_id', 'chatId', 'room_id', 'roomId', 'conversation_id', 'group_id', 'from_chat_id', 'session_id']);
  const explicitType = String(firstDefined(body, ['chat_type', 'chatType', 'type']) || '').toLowerCase();
  const hasRoom = Boolean(firstDefined(body, ['room_id', 'roomId', 'group_id', 'groupName', 'group_name']));
  const isGroup = explicitType === 'group' || explicitType === '群' || toBool(firstDefined(body, ['is_group', 'isGroup', 'from_group'])) || hasRoom;
  const text =
    firstDefined(body, ['text', 'content', 'message', 'msg', 'body', 'payload', 'text_content']) ?? '';
  const atMe = toBool(firstDefined(body, ['at_me', 'atMe', 'is_at', 'isAt', 'at', 'mentioned', 'addressed']));
  const replyToBot = toBool(firstDefined(body, ['reply_to_bot', 'replyToBot', 'quote_from_bot', 'is_reply_to_bot']));
  const replyToName = firstDefined(body, ['reply_to_name', 'replyToName', 'quote_sender_name', 'quoted_sender_name']);
  const replyToUserId = firstDefined(body, ['reply_to_user_id', 'replyToUserId', 'quote_sender_id', 'quoted_sender_id']);
  const mentions = firstDefined(body, ['mentioned_names', 'mentionedNames', 'mention_names', 'mentions']);
  const selfNames = firstDefined(body, ['self_names', 'selfNames', 'bot_names', 'botNames']);
  const noReply = toBool(firstDefined(body, ['no_reply', 'noReply']));

  return {
    platform,
    chatId: String(rawChatId ?? firstDefined(body, ['sender_id', 'user_id', 'from', 'sender']) ?? 'unknown'),
    chatType: isGroup ? 'group' : 'private',
    senderId: String(firstDefined(body, ['sender_id', 'user_id', 'userId', 'sender', 'from', 'wxid', 'author_id']) ?? 'unknown'),
    senderName: String(firstDefined(body, ['nickname', 'sender_name', 'senderName', 'user_name', 'userName', 'name', 'display_name', 'from_name']) ?? '群友'),
    text: typeof text === 'string' ? text : JSON.stringify(text),
    atMe,
    replyToBot,
    replyToName: String(replyToName || ''),
    replyToUserId: String(replyToUserId || ''),
    mentionedNames: Array.isArray(mentions) ? mentions : [],
    selfNames: Array.isArray(selfNames) ? selfNames.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20) : [],
    msgId: String(firstDefined(body, ['msg_id', 'msgId', 'message_id', 'messageId', 'id']) ?? ''),
    chatTitle: String(firstDefined(body, ['chat_title', 'chatTitle', 'room_name', 'roomName', 'group_name', 'groupName', 'title']) ?? ''),
    noReply,
  };
}

function postJson(urlString, payload, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      return reject(new Error('outboundUrl 不是合法地址：' + urlString));
    }
    const mod = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: text.slice(0, 500) });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('发送超时')));
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 单轮对话的默认预算与硬上限。0 表示不限（交给调用方自己的超时），
// 上限是给配置填错时的兜底：一轮占着会话队列太久，后面的消息会一直排队。
const TURN_TIMEOUT_DEFAULT_MS = 120000;
const TURN_TIMEOUT_MAX_MS = 600000;

/**
 * 解析本次轮次的预算：缺省 120000，0 = 不限，负数/非数字按缺省，
 * 超过 600000 一律压回上限。
 */
function turnTimeoutMs(config) {
  const raw = Number(config && config.chat && config.chat.turnTimeoutMs !== undefined
    ? config.chat.turnTimeoutMs : TURN_TIMEOUT_DEFAULT_MS);
  if (!Number.isFinite(raw)) return TURN_TIMEOUT_DEFAULT_MS;
  if (raw === 0) return 0;
  if (raw < 0) return TURN_TIMEOUT_DEFAULT_MS;
  return Math.min(TURN_TIMEOUT_MAX_MS, Math.floor(raw));
}

class Gateway {
  constructor({ platform, options = {}, bot, logger, chat }) {
    this.platform = platform;
    this.options = {
      enabled: true,
      inboundToken: '',
      outboundUrl: '',
      outboundHeaders: {},
      sendBubbles: false,
      ...options,
    };
    this.bot = bot;
    this.chat = chat;
    this.logger = logger;
    this.stats = { received: 0, replied: 0, sent: 0, failed: 0, lastMessageAt: 0, lastError: '' };
    // 被单轮预算取消的次数：诊断页据此判断「是不是模型太慢」，只计数不含正文。
    this.turnTimeouts = 0;
    // 本地桥接的存活信息：桥接每 20 秒来一次心跳，状态接口据此报告「桥接在线 / 离线」
    this.bridge = {
      lastSeen: 0, uia: null, rest: false, listener: null, ffmpeg: null,
      // 多账号：桥接当前用的是哪个号、窗口认没认出来
      account: '', accountWxid: '', accountNick: '', accountOk: null, accountWhy: '', accountGuard: true,
      // 微信主窗现场（可见 / 最小化 / 托盘 / 句柄失效）：诊断包和自检都要它
      window: '',
    };
  }

  /** 桥接心跳：带 UIA / ffmpeg 状态，方便在状态接口里一眼看出「能不能发出去」 */
  heartbeat(info = {}) {
    const now = Date.now();
    this.bridge = {
      lastSeen: now,
      uia: typeof info.uia === 'boolean' ? info.uia : (info.uia === null ? null : this.bridge.uia),
      rest: typeof info.rest === 'boolean' ? info.rest : Boolean(this.bridge.rest),
      listener: typeof info.listener === 'boolean' ? info.listener : this.bridge.listener,
      ffmpeg: typeof info.ffmpeg === 'boolean' ? info.ffmpeg : this.bridge.ffmpeg,
      account: String(info.account || this.bridge.account || ''),
      accountWxid: String(info.account_wxid || this.bridge.accountWxid || ''),
      accountNick: String(info.account_nick || this.bridge.accountNick || ''),
      accountOk: typeof info.account_ok === 'boolean' ? info.account_ok : this.bridge.accountOk,
      accountWhy: String(info.account_why || this.bridge.accountWhy || ''),
      accountGuard: typeof info.account_guard === 'boolean' ? info.account_guard : this.bridge.accountGuard,
      window: String(info.window || this.bridge.window || ''),
    };
    return { ok: true, online: true, serverTime: now };
  }

  /**
   * 桥接当前的可用状态：在线 / UIA 能不能用 / ffmpeg 找没找到。
   * 复用心跳里已有的字段，不另存一份，免得界面显示和提示词里的说法对不上。
   * 20 秒一次心跳，45 秒没动静就算掉线（和 status() 同一口径）。
   */
  bridgeStatus() {
    const ageSec = this.bridge.lastSeen ? Math.round((Date.now() - this.bridge.lastSeen) / 1000) : null;
    const online = ageSec !== null && ageSec <= 45;
    return {
      online,
      uia: online ? this.bridge.uia : null,
      ffmpeg: online ? this.bridge.ffmpeg : null,
    };
  }

  verifyToken(req, body) {
    const expected = String(this.options.inboundToken || '');
    if (!expected.trim()) return false; // 空凭据不能变成免鉴权入口。
    if (/^change-me-wechat$/.test(expected)) {
      const ip = String(req.socket && req.socket.remoteAddress || '');
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false;
    }
    const header = req.headers['x-bot-token'] || req.headers['x-bot-signature'];
    const query = req.url && req.url.includes('token=')
      ? new URL(req.url, 'http://localhost').searchParams.get('token')
      : null;
    const fromBody = body && (body.token || body.verify_token || body.signature);
    return [header, query, fromBody].some((v) => String(v || '') === expected);
  }

  async handleInbound(payload, { local = false } = {}) {
    const msg = normalizeInbound(payload, this.platform);
    if (local) {
      // 桥接来取消息也算一次心跳（它一定是活着的）
      this.bridge.lastSeen = Date.now();
    }
    // 桥接状态跟着这一条消息走：管线的提示词尾部据此说「现在能不能发出去」，
    // 不用模型自己猜，也不会把「桥接离线」当成「消息已发出」。
    msg.bridgeStatus = this.bridgeStatus();
    this.stats.received += 1;
    this.stats.lastMessageAt = Date.now();
    if (msg.noReply) return { ok: true, skipped: 'no_reply_flag' };
    this.logger &&
      this.logger.info(
        `[${this.platform}] 收到 ${msg.chatType === 'group' ? '群' : '私聊'}消息 sender=${tagName(msg.senderName)} ${textMeta(msg.text)}`
      );
    const localWechat = local && this.platform === 'wechat';
    // 每轮一个取消源：超时只是「叫停这一轮」，不会改动消息内容或回复结构；
    // 下游（Bot.handle → decide → 能力调用）按同一个 signal 协作式退出。
    // timeoutMs=0 表示不限，此时不建 timer，只把 signal 交下去（仍然可被外部取消）。
    const timeoutMs = turnTimeoutMs(this.bot && this.bot.config);
    const controller = new AbortController();
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        this.turnTimeouts = (this.turnTimeouts || 0) + 1;
        this.logger?.warn?.(`[${this.platform}] 单轮超出预算 ${timeoutMs}ms，取消本轮`);
        controller.abort();
      }, timeoutMs);
    }
    const turnCtx = { signal: controller.signal, deadline: timeoutMs > 0 ? Date.now() + timeoutMs : null };
    // 生产环境由 app 注入统一聊天入口；单独构造 Gateway（测试/嵌入式）时退回 Bot，
    // 不在这里复制插件调度逻辑，避免两条接管路径。
    let result;
    try {
      result = this.chat && typeof this.chat.handle === 'function'
        ? await this.chat.handle(msg, { localWechat, signal: turnCtx.signal, deadline: turnCtx.deadline })
        : await this.bot.handle(msg, { localWechat, signal: turnCtx.signal, deadline: turnCtx.deadline });
    } finally {
      // 正常完成 / 抛错 / 调用方断开都要清掉：泄漏的 timer 会一直攥着 AbortController。
      if (timer) { clearTimeout(timer); timer = null; }
    }
    this.logger?.debug?.(`[${this.platform}] event=gateway.result action=${result.action || '-'} reason=${result.reason || '-'} bubbles=${(result.bubbles || []).length}`);
    if (result.action !== 'reply' || !result.reply) {
      return { ok: true, action: 'ignore', reason: result.reason || 'ignored' };
    }
    // 发送前再问一次共享规则（桥接排队期间名单可能已改）；事实形状与内核一致。
    const reason = sendDenial(this.bot.config, msg);
    if (reason) return { ok: true, action: 'ignore', reason };
    if (localWechat && result.reason === 'sticker_request' && result.sticker) {
      return { ok: true, action: 'reply', reply: result.reply, stickerOnly: true, sticker: result.sticker };
    }
    const out = await this.send({
      chatId: msg.chatId,
      chatType: msg.chatType,
      text: result.reply,
      bubbles: result.bubbles || [result.reply],
      replyTo: msg.msgId,
      senderName: msg.senderName,
      local,
    });
    // 新协议没有「已提交」回调：发送结果只在宿主账本与本条响应里，不另外通知插件。
    // 文字回执：发成功的她自己能从聊天记录里看见，不用记账；
    // 只有「根本没到微信」和「发失败」记下来，否则下一轮她会以为消息已经发出去了。
    try {
      const store = this.bot && this.bot.store;
      const failed = out && out.ok === false;
      const stranded = out && out.dryRun && !out.local;
      if (store && (failed || stranded)) {
        const key = result.key || (typeof this.bot.sessionKey === 'function' ? this.bot.sessionKey(msg) : '');
        store.appendEvent(key, {
          type: 'send',
          detail: `${(result.bubbles || [result.reply]).length} 条：${String(result.reply).slice(0, 40)}`,
          status: failed ? 'failed' : 'blocked',
        });
      }
    } catch { /* 记账失败不影响发送 */ }
    // 表情包（实验性）：总闸关着返回 null，桥接就看不到这个字段
    let sticker = null;
    try {
      if (localWechat && result.reason !== 'sticker_request' && result.reason !== 'command'
          && typeof this.bot.stickerFor === 'function') {
        sticker = this.bot.stickerFor({
          msg,
          stickerCategory: result.stickerCategory,
          stickerDemand: Boolean(result.stickerDemand),
          error: Boolean(result.error),
        }, result.reply);
      }
    } catch (err) {
      this.logger && this.logger.warn && this.logger.warn('挑表情包失败：' + describeError(err));
    }
    return {
      ok: true,
      action: 'reply',
      reply: result.reply,
      bubbles: result.bubbles || [result.reply],
      ...(sticker ? { sticker } : {}),
      ...(localWechat && result.separateText ? { separateText: true } : {}),
      // 群里要真的 @ 某人时，桥接据此调 at_member
      mention: result.mention || '',
      ...(result.commandType ? { commandType: result.commandType } : {}),
      // 演示模式（没配 Key，说的是内置台词）：桥接据此在日志里提醒一次，
      // 不然用户会以为「没填 Key 居然也能真聊」。
      mock: Boolean(this.bot && this.bot.llm && this.bot.llm.isMock),
      outbound: out,
    };
  }

  async send({ chatId, chatType, text, bubbles = [text], replyTo = '', senderName = '', local = false }) {
    const payload = {
      platform: this.platform,
      chat_id: chatId,
      chat_type: chatType,
      text,
      bubbles,
      reply_to: replyTo,
      reply_to_name: senderName,
      bot: '鲸鲸',
      ts: Date.now(),
    };
    const lines = this.options.sendBubbles && Array.isArray(bubbles) && bubbles.length > 1 ? bubbles : [text];
    if (!this.options.outboundUrl) {
      // 本地桥接（examples/wechatauto_bridge.py）模式下，回复是通过这个 HTTP 响应交还给桥接、
      // 由桥接用 UIA 发出去的 —— 没配 outboundUrl 属于正常。以前这里一律打 WARN「只打印在控制台」，
      // 害得用户以为没发出去（实际发了，或者根本没开桥接）。
      if (local) {
        this.logger && this.logger.info(`[${this.platform}] 回复已交给本地桥接发送（${bubbles.length} 条）`);
      } else {
        this.logger &&
          this.logger.warn(
            `[${this.platform}] 这条回复不会到微信：既没有 gateway.outboundUrl，也不是本地桥接请求。` +
            `本地用法请在启动器里点「启动」拉起桥接；自建中转才需要 outboundUrl。回复${textMeta(text)}`
          );
      }
      return { ok: true, dryRun: true, local };
    }
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      // sendBubbles=true 时每条请求只带当前气泡；第一条也带完整 bubbles 会让
      // 接收端把全部气泡发一遍，随后循环再逐条发，消息重复。
      const body = lines.length > 1
        ? { ...payload, text: lines[i], bubbles: [lines[i]] }
        : payload;
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await postJson(
            this.options.outboundUrl,
            body,
            this.options.outboundHeaders || {}
          );
          results.push(r);
          if (r.ok) {
            this.stats.sent += 1;
            this.stats.lastError = '';
            lastErr = null;
            break;
          }
          lastErr = new Error(`HTTP ${r.status} ${r.body}`);
        } catch (err) {
          lastErr = err;
        }
        if (attempt === 0) await sleep(500);
      }
      if (lastErr) {
        this.stats.failed += 1;
        this.stats.lastError = lastErr.message;
        this.logger && this.logger.error(`[${this.platform}] 发送失败：${describeError(lastErr)}`);
      }
      if (lines.length > 1 && i < lines.length - 1) await sleep(400);
    }
    // 部分成功不能算整体成功：否则上层不会补发缺的气泡，模型也以为已经送达。
    const ok = results.length === lines.length && results.every((r) => r && r.ok);
    return {
      ok,
      partial: !ok && results.some((r) => r && r.ok),
      sent: results.filter((r) => r && r.ok).length,
      failed: lines.length - results.filter((r) => r && r.ok).length,
      results,
    };
  }

  status() {
    const ageSec = this.bridge.lastSeen ? Math.round((Date.now() - this.bridge.lastSeen) / 1000) : null;
    // 20 秒一次心跳，45 秒没动静就算掉线（给一点网络抖动余量）
    const online = ageSec !== null && ageSec <= 45;
    return {
      platform: this.platform,
      enabled: Boolean(this.options.enabled),
      outboundConfigured: Boolean(this.options.outboundUrl),
      inboundPath: `/webhook/${this.platform}`,
      // 启动器据此显示「桥接在线 · UIA 正常 / 桥接离线」，以及「当前用的是哪个号」
      bridge: {
        online,
        lastSeenSec: ageSec,
        uia: online ? this.bridge.uia : null,
        rest: online ? Boolean(this.bridge.rest) : false,
        listener: online ? this.bridge.listener : null,
        ffmpeg: online ? this.bridge.ffmpeg : null,
        account: this.bridge.account,
        accountWxid: this.bridge.accountWxid,
        accountNick: this.bridge.accountNick,
        accountOk: this.bridge.accountOk,
        accountWhy: this.bridge.accountWhy,
        accountGuard: this.bridge.accountGuard,
        accountStale: !online,
        window: online ? this.bridge.window : '',
      },
      ...this.stats,
    };
  }
}

function createGateways({ config, bot, logger, chat }) {
  const gateways = new Map();
  for (const platform of PLATFORMS) {
    const options = config.gateway?.[platform];
    if (!options) continue;
    const gateway = new Gateway({ platform, options, bot, logger, chat });
    gateways.set(platform, gateway);
  }
  return gateways;
}

module.exports = { Gateway, createGateways, normalizeInbound, postJson, PLATFORMS };
