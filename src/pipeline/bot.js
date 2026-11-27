'use strict';

/**
 * 机器人核心：判断要不要接话 → 组装提示词 → 由 DeepSeek 生成 → 写入记忆。
 * 这里不关心消息从哪来（网页 / 微信等），只处理统一后的消息对象。
 *
 * 统一消息对象：
 * {
 *   platform: 'web'|'wechat',
 *   chatId:   '123456',              // 群 id 或用户 id
 *   chatType: 'private'|'group',
 *   senderId: 'wxid_xxx',
 *   senderName: '阿螈',
 *   text: '在吗',
 *   atMe: false,                     // 是否 @ 了鲸鲸 / 回复了鲸鲸
 *   msgId: '可选，用于去重',
 *   chatTitle: '深海鱼塘',            // 可选，群名
 * }
 */
const path = require('node:path');
const persona = require('../persona');
const { usesNewPersona } = require('../persona/profile');
const features = require('../infra/features');
const { matchMaster, isVerifiedOwner } = require('../core/master');
const links = require('../adapters/links');
const searchService = require('../services/search');
const { LlmError } = require('../llm/client');
const { describeError } = require('../infra/errors');
const { tagId, tagName, textMeta, urlHost } = require('../infra/privacy');
const { saveSettings } = require('../infra/config');
const time = require('../infra/time');
const personaStore = require('../persona/store');
const { sanitizeForModel, nameMatches, stripInternalTimestamps } = require('../core/text');
const { sendDenial } = require('../core/wechatSendPolicy');
const trigger = require('../core/trigger');
const { INSULT_RE } = require('../core/trigger');
const addressing = require('../core/addressing');
const sessionState = require('../core/sessionState');
const context = require('../core/context');
const { isEcho } = require('../core/echo');
const { extractMentionNames } = require('../core/mentions');
const { cannedReply, dismissReply } = require('./stages/canned');
const reminderCore = require('../core/reminder');
const stickers = require('../adapters/stickers');
const voiceReply = require('../core/voiceReply');
const envInfo = require('../services/envInfo');
const { LIMITS } = require('../memory/constants');
const memory = require('../memory');
const tokenCalibration = require('../memory/calibration');
const budgetPricing = require('../services/budget');
const { UnifiedPluginRuntime } = require('../services/unifiedPluginRuntime');
const { UnifiedCapabilityDispatcher } = require('../services/unifiedCapabilityDispatcher');
const adminModule = require('./admin');
const admin = adminModule.createAdmin({ isVerifiedOwner, nameMatches, personaStore, saveSettings, tagName });
const stickerOps = require('./stickers').createStickerOps({ stickers });
const { adminCommandList } = admin;
const SEPARATE_REPLY_RE = /(?:^|[，。！？\s])(?:请|麻烦|能不能|可以|记得)?\s*你?\s*(?:要|给我)?\s*(?:分[条段开](?:来)?(?:发(?:送)?|回(?:复)?|说)|(?:一条一条|一句一句)地?[发回]|每(?:条|句|段)(?:话)?单独[发回]|分(?:成)?[两二三四五六七八九十\d]+[条段](?:气泡|发|回)?)(?:一下)?(?=$|[\s，。！？?!吧嘛哦啊,])/;

// 主人私聊问起朋友圈时才注入快照；普通聊天和群聊都不带，避免第三方内容乱入。
// 私聊「拍拍我」：只有整句就是这个请求才直接回拍，避免误伤正常聊天。
const PAT_COMMAND_RE = /^(?:快|来|给我|再)?\s*(?:拍一拍|拍拍|拍|戳一戳|戳戳)\s*我(?:一下|一下下|嘛|呗|吧|呀|啊)?[\s。！!？?~～]*$/u;
// 拍一拍回执最多等多久：桥接的硬截止是 9 秒，30 秒还没回执就当「没拍到」把额度还回去。
const PAT_ACK_WAIT_MS = 30000;

const MOMENTS_INTENT_RE = /朋友圈|动态|谁发了|发了(?:什么|啥)|最近发了|看看.*(?:朋友圈|动态)|点赞/;

/**
 * 把模型写的 ((silence:分钟)) 标记抠出来，返回 { text, minutes }。
 * 标记只用于「群里被赶走」：宿主校验会话和时长后才落盘，正文里绝不外泄。
 *
 * 用圆括号而不是方括号：表情包的 [[sticker:分类]] 也用 [[]]，两套语法必须分开。
 * 只认 ((silence))，不保留旧的 [[silence:]] 写法 —— 4.1.0 还没发布，没有历史用户，
 * 同时认两种只会让弱模型更爱写错。
 * 不用一条大正则：模型常见的写法（少一边括号、写「10分钟」、没有冒号）都要能认，
 * 没闭合时只删到这一行末尾，不吞后面的段落。
 */
const { stripSilenceMark, stripStickerMarks, stripPatMark } = require('../core/replyMarks');
const { ReplyQuota, recentReplyCount } = require('../core/replyQuota');
const replyDecision = require('../core/replyDecision');

function momentsIntent(text) {
  return MOMENTS_INTENT_RE.test(String(text == null ? '' : text));
}

/**
 * 服务商报「上下文超长」时，不能把整段历史原样再发一次，也不该退化成只留当前一句。
 * 这里只认明确的上下文错误，别把普通 400 内容审核也当成超长。
 */
function isContextLengthError(err) {
  const text = [
    err && err.message,
    err && err.detail,
    err && err.userMessage,
    err && err.code,
  ].filter(Boolean).join(' ');
  return /context[_\s-]?length|maximum\s+context|context\s+(?:window|size).*(?:exceed|too\s+long)|too\s+many\s+tokens|(?:request|prompt|input|message|context)\s+(?:is\s+)?too\s+long|exceed(?:s|ed)?\s+(?:the\s+)?(?:maximum\s+)?context/i.test(text);
}

// 全局硬上限：所有会话加起来每分钟最多这么多条回复。
// 单会话上限（group.maxRepliesPerMinute，5–30）防的是「一个群里爆刷」，
// 这个是防「同时开了几十个群，每个都没超但加起来停不下来」。固定 30，不给配。
const GLOBAL_REPLY_CAP_PER_MINUTE = 30;
const memoryBudget = require('../memory/budget');
const buildPromptDecision = require('./decisionPrompt').createPromptStage({ persona, features, envInfo, memoryBudget, momentsIntent, separateReplyRe: SEPARATE_REPLY_RE, describeError });
const usage = require('./usage').createUsage({ memoryBudget, budgetPricing });
const finalizer = require('./finalize').createFinalizer({ persona, LIMITS, isEcho, stripInternalTimestamps, stripSilenceMark, stripStickerMarks, stripPatMark, isFeatureOn: features.isOn, textMeta, describeError });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 程序版本：环境块里要报给模型（问「你是什么版本」时不能瞎说）。
// app.js 构造 Bot 时会显式传进来；测试里直接 new Bot 时用这个默认值。
const VERSION = require('../../package.json').version;

class Bot {
  constructor({ config, store, llm, logger, trace = null, now = () => new Date(), rng = Math.random, mockChunkDelayMs = 12, linkReader = null, calibration = null, moments = null, version = VERSION }) {
    this.config = config;
    this.store = store;
    this.llm = llm;
    this.logger = logger;
    // 程序版本：环境块里要报给模型（问「你是什么版本」时不能瞎说）
    this.version = version;
    // 判定链落盘（src/core/trace.js）。测试/接口里可以不传，没有 trace 只是少一份证据。
    this.trace = trace;
    this.now = now;
    this.nativeLinkHistory = new Map();
    this.nativeLinkTag = Symbol('nativeLink');
    this.rng = rng;
    this.mockChunkDelayMs = mockChunkDelayMs;
    this.linkReader = linkReader || ((url, { signal } = {}) => links.describeLink(url, {
      timeoutMs: (config.links && config.links.timeoutMs) || 6000,
      cacheMinutes: (config.links && config.links.cacheMinutes) || 60,
      allowPrivate: Boolean(config.links && config.links.allowPrivate),
      signal,
    }));
    this.calibration = calibration || null;
    // 朋友圈快照：只在主人私聊问到朋友圈时读取，不参与普通记忆。
    this.moments = moments || null;
    this.startedAt = Date.now();
    // handle() 的按会话串行队列：key → 上一条的收尾 promise（M21）
    this._handleChains = new Map();
    this._adminSpellGrants = new WeakMap();
    // 清空记忆会删掉会话对象（连同它的 state），授权按会话 key 再记一份，
    // 否则刚清完记忆，下一条管理命令就被要求重新发魔咒。
    this._adminGrantsByKey = new Map();
    // 全局回复时间戳（跨会话共用），只留在内存里：重启后重新数
    this.globalReplyTimes = [];
    this._replyTurns = new WeakMap();
    this._finalReplies = new WeakMap();
    this._replyQuota = new ReplyQuota({ now: () => this.now().getTime(),
      getGlobal: () => this.globalReplyTimes, setGlobal: values => { this.globalReplyTimes = values; },
      globalCap: GLOBAL_REPLY_CAP_PER_MINUTE });
    this.lastBudget = null;
    this.lastUsage = null;
    const pluginOptions = { dataDir: config.paths?.dataDir || path.join(process.cwd(), 'data'), logger,
      enabled: () => features.isOn(this.config, 'plugins'), appVersion: version, appEpoch: 1 };
    this.pluginRuntime = new UnifiedPluginRuntime(pluginOptions);
    this.plugins = this.pluginRuntime;
    this.capabilities = new UnifiedCapabilityDispatcher({ plugins: this.pluginRuntime, logger });
    this.capabilities
      .define('chat.handle@1', {
        builtin: (input, { signal }) => this.handle(input.message, { signal, localWechat: input.localWechat }),
      })
      .define('chat.generate@1', {
        builtin: async input => ({ text: await this.llm.complete({ system: input.system, turns: input.turns, purpose: 'chat' }) }),
      })
      .define('chat.reply@1', { builtin: async input => ({ text: input.text }) })
      .define('chat.search@1', {
        builtin: input => this.searchForChat(input),
      })
      .define('chat.pre_reply@1', { builtin: async () => ({ action: 'pass' }) })
      .define('chat.received@1', { builtin: async () => ({}) })
      .define('chat.prompt@1', { builtin: async input => ({ system: input.system }) })
      .define('chat.before_send@1', { builtin: async input => ({ text: input.text }) })
      .define('chat.dispatched@1', { builtin: async () => ({}) })
      .define('app.start@1', { builtin: async () => ({}) })
      .define('app.stop@1', { builtin: async () => ({}) })
      .define('tool.run@1', { builtin: async () => null })
      .define('task.tick@1', { builtin: async () => null });
  }

  /** 按 provider|model 分别学习估算倍数；默认落在 data/calibration.json。 */
  calibrationEngine() {
    if (!this.calibration) {
      const dataDir = (this.config && this.config.paths && this.config.paths.dataDir)
        || path.join(process.cwd(), 'data');
      this.calibration = tokenCalibration.createCalibration({
        file: path.join(dataDir, 'calibration.json'),
      });
    }
    return this.calibration;
  }

  modelContext() {
    return {
      provider: String((this.llm && this.llm.provider) || (this.config && this.config.provider) || ''),
      model: String((this.llm && this.llm.model) || ''),
    };
  }

  sessionKey(msg) {
    const type = msg.chatType === 'group' ? 'g' : 'u';
    return `${msg.platform}:${type}:${msg.chatId}`;
  }

  /**
   * 设提醒：「十点半提醒我开会」→ 落库，并回一句确认。
   * 不在提醒范围内的普通消息原样返回 null，交给后面的正常流程。
   */
  async tryReminder({ msg, clean, key, now, isGroup, atMe, signal }) {
    const service = this.reminders;
    if (!service) return null;
    // 设提醒 / 取消 / 列表走宿主能力，和路由、插件是同一个口子。
    // 单元夹具可能没有装配 capabilities，这时退回服务层（生产装配一定有）。
    const feature = async (name, input, options) => (this.capabilities?.hasHost?.(name)
      ? this.capabilities.invokeHost(name, input, options) : null);
    // 读能力跟随本轮取消：宿主入口已按 signal 拒绝时不要再占用名额。
    // 但「提醒列表 / 取消提醒」是闲聊里的顺手查询，池满或超时不能把整轮判定打挂，
    // 所以任何宿主准入失败都退回本地服务层读同一份待发提醒。
    const pendingFor = async chatId => {
      try {
        const out = await feature('reminders.pendingFor@1', { chatId }, { signal });
        if (out && Array.isArray(out.items)) return out.items;
      } catch { /* 下面退回服务层读取 */ }
      return service.pendingFor(chatId);
    };
    // 写能力不接 signal：取消/落库中途被掐会留下半条状态。改为独立截止时间，
    // 让「池满」最多等 5 秒就失败，而不是无限排在一个可能永远不释放的名额后面。
    const writeOptions = () => ({ deadline: Date.now() + 5000 });
    const tz = time.resolveTimeZone(this.config);
    const text = String((clean && clean.text) || '').trim();
    if (!text || text.length > 120) return null;

    // 取消 / 查看：只处理「取消提醒」「提醒列表」这种整句
    if (/^(?:取消|删除|清空)(?:所有|全部)?提醒[。.!！~～]*$/.test(text)) {
      if (isGroup && !isVerifiedOwner(this.config, msg)) {
        return { action: 'reply', key, msg, atMe, canned: '群里的提醒统一由已绑定 ID 的主人取消，避免误删其他人的提醒。', reason: 'not_owner' };
      }
      const pending = await pendingFor(msg.chatId);
      if (!pending.length) return { action: 'reply', key, msg, atMe, canned: '这个会话没有待发的提醒。', reason: 'reminder_cancel' };
      let cancelled = 0;
      for (const item of pending) {
        // 写能力自己有时限；它失败（超时/池满）只影响这一条，不能把整轮「取消提醒」判成异常。
        // 计数会照实少加，下面那句「另有 N 条正在发送」就是给用户的诚实话术。
        let out = null;
        try { out = await feature('reminders.cancel@1', { id: item.id }, writeOptions()); }
        catch { /* 退回本地取消，不把宿主准入失败冒到决策主路径 */ }
        if (out ? out.ok : service.cancel(item.id).ok) cancelled += 1;
      }
      const sending = pending.length - cancelled;
      return { action: 'reply', key, msg, atMe, canned: `取消了 ${cancelled} 条提醒。${sending ? `另有 ${sending} 条正在发送，无法保证撤回，请等待发送结果。` : ''}`, reason: 'reminder_cancel' };
    }
    const cancellation = reminderCore.parseReminderCancellation(text);
    if (cancellation) {
      if (isGroup && !isVerifiedOwner(this.config, msg)) {
        return { action: 'reply', key, msg, atMe, canned: '群里的提醒统一由已绑定 ID 的主人取消，避免误删其他人的提醒。', reason: 'not_owner' };
      }
      const result = service.cancelMatching(msg.chatId, cancellation);
      if (result.ambiguous) {
        const lines = result.candidates.slice(0, 5).map((it) => `${reminderCore.describeWhen(new Date(it.dueAt), now, tz)} ${it.text}`);
        return { action: 'reply', key, msg, atMe, canned: '我找到多条提醒，请说清楚要取消哪一条：' + lines.join('；'), reason: 'reminder_cancel_ambiguous' };
      }
      if (!result.cancelled) return { action: 'reply', key, msg, atMe, canned: '没有找到对应的待发提醒。', reason: 'reminder_cancel' };
      return { action: 'reply', key, msg, atMe, canned: `已经取消 ${result.cancelled} 条提醒。`, reason: 'reminder_cancel' };
    }
    if (/^(?:提醒列表|我的提醒|有哪些提醒)[。.!！~～?？]*$/.test(text)) {
      const pending = await pendingFor(msg.chatId);
      if (!pending.length) return { action: 'reply', key, msg, atMe, canned: '这会儿没有待发的提醒。', reason: 'reminder_list' };
      const lines = pending.slice(0, 5).map((it) => `${reminderCore.describeWhen(new Date(it.dueAt), now, tz)} ${it.text}`);
      return { action: 'reply', key, msg, atMe, canned: '还有这些：' + lines.join('；'), reason: 'reminder_list' };
    }

    if (!reminderCore.looksLikeReminder(text)) return null;
    let parsed = reminderCore.parseReminder(text, now, tz);
    if (!parsed) parsed = await this.reminderFromModel(text, now, tz);
    if (!parsed) return null;

    // 本地登记与宿主能力写的是同一份服务层数据；宿主准入失败（池满 / 5 秒排队超时）
    // 或执行异常时退回这里，提醒不能因为一次排队失败就丢掉。
    const addLocally = () => service.add({
      wxid: msg.chatId,
      name: msg.chatTitle || msg.senderName || msg.chatId,
      chatType: msg.chatType,
      text: parsed.what,
      at: parsed.at,
      atName: msg.senderName || '',
    });

    let item = null;
    try {
      const created = await feature('reminders.create@1', {
        chatId: msg.chatId,
        name: msg.chatTitle || msg.senderName || msg.chatId,
        chatType: msg.chatType,
        text: parsed.what,
        at: parsed.at,
        atName: msg.senderName || '',
      }, writeOptions());
      item = created || addLocally();
    } catch {
      // 宿主侧失败只降级、不中断：本地登记成功就照常回执。
      try { item = addLocally(); } catch { item = null; }
    }

    // 连本地都登不上才是真的失败。话术用固定中文原因，不把英文错误码拼给用户。
    if (!item) {
      return { action: 'reply', key, msg, atMe, canned: '这个提醒没设上，稍后再和我说一次。', reason: 'reminder_error' };
    }
    this.logger && this.logger.info(`提醒已登记：id=${item.id} ${textMeta(item.text || parsed.what)} @ ${reminderCore.describeWhen(new Date(item.dueAt), now, tz)}`);
    return {
      action: 'reply',
      key,
      msg,
      atMe,
      canned: reminderCore.confirmText(parsed, { now, group: isGroup, who: msg.senderName || '', timeZone: tz }),
      reason: 'reminder_set',
    };
  }

  /** 规则解析不出来时，让模型把时间和事情抽成 JSON（模型不可用就放弃，不瞎猜） */
  async reminderFromModel(text, now, timeZone = '') {
    if (!this.llm || this.llm.isMock || typeof this.llm.complete !== 'function') return null;
    const nowText = time.formatDateTime(now.getTime(), timeZone);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const raw = await this.llm.complete({
        system: [
          '你是一个提醒解析器。把用户这句话里的「提醒时间」和「提醒内容」抽出来。',
          `现在是 ${nowText}（本地时间）。只说今天/明天/后天/几点，按这个基准换成绝对时间。`,
          '只输出 JSON，不要解释、不要代码块围栏：{"at":"YYYY-MM-DD HH:mm","what":"要提醒的事"}',
          '如果这句话不是在让人提醒某件事，输出 {"at":"","what":""}。',
        ].join('\n'),
        turns: [{ role: 'user', content: String(text).slice(0, 120) }],
        maxTokens: 120,
        signal: controller.signal,
      });
      const jsonText = (String(raw || '').match(/\{[\s\S]*\}/) || [''])[0];
      if (!jsonText) return null;
      const obj = JSON.parse(jsonText);
      const atMs = time.parseDateTimeLoose(obj.at, timeZone);
      const what = String(obj.what || '').trim().slice(0, 200);
      if (!what || atMs === null) return null;
      if (atMs <= now.getTime()) return null;
      return { at: new Date(atMs), what, when: obj.at };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 拍一拍的设置（设置页 /pat）：回话概率、回拍概率、间隔与每小时次数上限。
   * 非法值按默认值处理；设置接口已经校验过一遍，这里兜底防手改 config。
   */
  patSettings() {
    const raw = (this.config && this.config.pat) || {};
    const clamp = (value, fallback, min, max) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    return {
      replyChance: clamp(raw.replyChance, 1, 0, 1),
      backChance: clamp(raw.backChance, 1, 0, 1),
      cooldownSec: clamp(raw.cooldownSec, 8, 0, 3600),
      maxPerHour: clamp(raw.maxPerHour, 0, 0, 200),
    };
  }

  /** 这一次被拍：摇一次「回不回话 / 回不回拍」，回拍还要过冷却和每小时次数上限。 */
  planPatReply(early) {
    const cfg = this.patSettings();
    const roll = () => (typeof this.rng === 'function' ? this.rng() : Math.random());
    const key = String((early && early.chatId) || '');
    const text = roll() < cfg.replyChance;
    const isPrivate = Boolean(early) && early.chatType === 'private';
    const back = isPrivate && cfg.backChance > 0
      && this.patBudgetAllows(key, cfg) && roll() < cfg.backChance;
    return { text, back, key, cfg };
  }

  /** 回拍额度：同一会话冷却 + 每小时次数上限。 */
  patBudgetAllows(key, cfg, now = Date.now()) {
    // 先处理「桥接一直没回执」的占位：额度还回去，别让一次失败把这一小时扣掉。
    this.expirePatPending(now);
    if (cfg.cooldownSec <= 0 && cfg.maxPerHour <= 0) return true;
    const rec = this._patBudget && this._patBudget.get(key);
    if (!rec) return true;
    const last = Number(rec.last || 0);
    if (cfg.cooldownSec > 0 && now - last < cfg.cooldownSec * 1000) return false;
    if (cfg.maxPerHour > 0) {
      const hour = Math.floor(now / 3600000);
      if (rec.hour === hour && Number(rec.count || 0) >= cfg.maxPerHour) return false;
    }
    return true;
  }

  /**
   * 回拍前先占额度，返回回执单号。
   *
   * 不能在这里直接 count+1：桥接其实可能根本没拍（会话没打开、当前界面没有可右键的
   * 对方行、被群里规则跳过），额度却已经扣掉了。所以先占位，等桥接 `/api/pat/ack`
   * 回来再决定保留还是回滚（BUGS #128）。
   */
  reservePat(early, now = Date.now()) {
    if (!this._patBudget) this._patBudget = new Map();
    if (!this._patPending) this._patPending = new Map();
    const key = String((early && early.chatId) || '');
    const hour = Math.floor(now / 3600000);
    const prev = this._patBudget.get(key) || { last: 0, hour, count: 0 };
    const sameHour = prev.hour === hour;
    const prevLast = sameHour ? Number(prev.last || 0) : 0;
    const prevCount = sameHour ? Number(prev.count || 0) : 0;
    this._patBudget.set(key, { last: now, hour, count: prevCount + 1 });
    this._patSeq = (Number(this._patSeq) || 0) + 1;
    const patId = `pat-${now.toString(36)}-${this._patSeq}`;
    let sessionKey = '';
    try {
      sessionKey = String(this.sessionKey(early) || '');
    } catch { sessionKey = ''; }
    this._patPending.set(patId, {
      key, sessionKey, at: now, prevLast, prevCount,
      name: String((early && early.senderName) || '').slice(0, 40),
    });
    while (this._patPending.size > 500) this._patPending.delete(this._patPending.keys().next().value);
    return patId;
  }

  /** 桥接回执：拍到保留额度，没拍到把额度还回去；两种都记进动作账本。 */
  settlePat(patId, ok, reason = '', now = Date.now()) {
    if (!this._patPending || !patId) return false;
    const pending = this._patPending.get(String(patId));
    if (!pending) return false;
    this._patPending.delete(String(patId));
    if (!ok) {
      const rec = this._patBudget && this._patBudget.get(pending.key);
      if (rec) {
        rec.count = Number(pending.prevCount || 0);
        rec.last = Number(pending.prevLast || 0);
      }
    }
    this.notePatEvent(pending, ok ? 'confirmed' : 'failed', reason, now);
    return true;
  }

  /**
   * 回执超时：桥接崩了 / 根本没跑到，额度回滚，并记一条「没回执」——
   * 不能假装拍到了，下一轮模型也不能声称自己拍过。
   */
  expirePatPending(now = Date.now()) {
    if (!this._patPending || !this._patPending.size) return 0;
    let expired = 0;
    for (const [patId, pending] of this._patPending) {
      if (now - Number(pending.at || 0) < PAT_ACK_WAIT_MS) continue;
      this._patPending.delete(patId);
      const rec = this._patBudget && this._patBudget.get(pending.key);
      if (rec) {
        rec.count = Number(pending.prevCount || 0);
        rec.last = Number(pending.prevLast || 0);
      }
      this.notePatEvent(pending, 'unconfirmed', '', now);
      expired += 1;
    }
    return expired;
  }

  /** 把一次回拍结果记进动作账本（提示词里的【最近做过的事】）。 */
  notePatEvent(pending, status, reason, now = Date.now()) {
    const key = pending && pending.sessionKey;
    if (!key) return;
    const who = String((pending && pending.name) || '对方');
    let detail = who;
    if (status === 'failed') detail = `${who}（${String(reason || '原因未知').slice(0, 40)}）`;
    else if (status === 'unconfirmed') detail = `${who}（没收到桥接回执）`;
    try {
      if (this.store && typeof this.store.appendEvent === 'function') {
        this.store.appendEvent(key, { type: 'pat', detail, status, ts: now });
      }
    } catch (err) {
      this.logger?.warn?.('[pat] 动作账本写入失败 ' + describeError(err));
    }
  }

  /** 最近别人说过的原话（含当前这条），用来判断她是不是在复读 */
  recentHeard(decision, limit = 6) {
    const msg = (decision && decision.msg) || {};
    const list = [];
    const current = String(msg.cleanText || msg.text || '').trim();
    if (current) list.push(current);
    try {
      const key = decision && decision.key;
      if (key) {
        const recent = this.store.messages(key, 20)
          .filter((m) => m.role === 'user' && m.text)
          .map((m) => String(m.text).trim())
          .filter((t) => t && t !== current);
        list.push(...recent.slice(-limit));
      }
    } catch { /* ignore */ }
    return list;
  }

  /** 她最近说过的几句，用来避免自己复读自己 */
  recentOwn(decision, limit = 4) {
    try {
      const key = decision && decision.key;
      if (!key) return [];
      return this.store.messages(key, 20)
        .filter((m) => m.role === 'assistant' && m.text && !m.error)
        .map((m) => String(m.text).trim())
        .slice(-limit);
    } catch {
      return [];
    }
  }

  normalize(msg) {
    const at = msg.atMe === true || msg.atMe === 1 || msg.atMe === '1' || msg.atMe === 'true';
    const pat = msg.pat === true || msg.pat === 1 || msg.pat === '1' || msg.pat === 'true';
    return {
      platform: String(msg.platform || 'web').slice(0, 20),
      chatId: String(msg.chatId ?? 'default').slice(0, 120),
      chatType: msg.chatType === 'group' ? 'group' : 'private',
      senderId: String(msg.senderId ?? 'anonymous').slice(0, 100),
      senderName: String(msg.senderName ?? '群友').slice(0, 60),
      text: String(msg.text ?? '').slice(0, 2000),
      // 拍一拍不是消息：桥接把「谁拍了我」解析成这个标记，正文可能为空；被拍也算「点到她」。
      pat,
      atMe: at || pat,
      msgId: msg.msgId ? String(msg.msgId).slice(0, 120) : '',
      chatTitle: msg.chatTitle ? String(msg.chatTitle).slice(0, 60) : '',
      replyToBot: msg.replyToBot === true,
      replyToName: String(msg.replyToName || msg.reply_to_name || '').slice(0, 60),
      replyToUserId: String(msg.replyToUserId || msg.reply_to_user_id || '').slice(0, 100),
      mentionedNames: (Array.isArray(msg.mentionedNames) ? msg.mentionedNames : Array.isArray(msg.mention_names) ? msg.mention_names : [])
        .map((x) => String(x && typeof x === 'object' ? (x.name || x.nickname || '') : x).trim()).filter(Boolean).slice(0, 4),
      selfNames: (Array.isArray(msg.selfNames) ? msg.selfNames : Array.isArray(msg.self_names) ? msg.self_names : [])
        .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20),
    };
  }

  buildTurns(msg, history, memoryBlock, tailBlock) {
    const cached = this.llm.supportsWebSearch?.() && this.config.links?.enabled !== false && msg.chatType !== 'group'
      ? this.nativeLinkHistory.get(this.sessionKey(msg)) : null;
    const scopedHistory = cached && cached.expires > this.now().getTime()
      ? history.map(entry => entry.role === 'assistant' && entry[this.nativeLinkTag] === cached.token
        ? { ...entry, server_tool_calls: cached.calls } : entry) : history;
    return context.buildTurns(
      { ...msg, botName: this.config.persona.name },
      scopedHistory,
      memoryBlock,
      tailBlock,
      time.resolveTimeZone(this.config)
    );
  }

  /**
   * 记忆拉取失败时的兜底上下文：整块放弃记忆（人物卡 / 事件 / 摘要 / 关系），
   * 只带这个会话最近的原文继续回复。
   *
   * 记忆读不出来是「少了一点了解」，不是「不能说话」；宁可回得普通一点，
   * 也不能让整条消息静默丢掉。原文也读不出来时返回空 recent，至少还能回当前这条。
   */
  recentOnlyContext(key, { isGroup = false } = {}) {
    const chat = (this.config && this.config.chat) || {};
    const configured = Number(isGroup ? chat.groupHistoryTurns : chat.historyTurns) || 20;
    const cap = Math.max(4, Math.min(800, configured));
    let recent = [];
    try {
      recent = (this.store.messages(key, cap) || []).filter((m) => m && m.text && !m.error);
    } catch { /* 连原文都读不出来就只回当前这条 */ }
    // 记忆块没了，历史再灌满也没意义，还容易把单轮预算顶爆：只留最近 6,000 字
    const kept = [];
    let chars = 0;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const len = String(recent[i].text || '').length;
      if (kept.length && chars + len > 6000) break;
      kept.unshift(recent[i]);
      chars += len;
    }
    return {
      chatId: key,
      card: null,
      events: [],
      block: '',
      relationsBlock: '',
      relations: [],
      mentions: [],
      summary: '',
      recent: kept,
      recentTokens: 0,
      summaryTokens: 0,
      memoryTokens: 0,
      relationsTokens: 0,
      notes: [],
      memoryFailed: true,
    };
  }

  /**
   * 回复前门禁：宿主基础闸（魔咒/禁言/白名单/去重/静音）之后、触发判定之后调用。
   * 返回 pass/skip/wake；插件故障 fail-open（pass），cancellation 原样抛出。
   */
  async preReplyAction(msg, { signal, localWechat = false } = {}) {
    if (!this.capabilities?.hasProviders?.('chat.pre_reply@1')) return 'pass';
    try {
      const input = this.withTurnContext({
        message: this.providerMessage(msg),
        localWechat: Boolean(localWechat),
      }, this.sessionKey(msg));
      const result = await this.capabilities.invoke('chat.pre_reply@1', input,
        { key: this.sessionKey(msg), signal, chatId: String(msg?.chatId || '').slice(0, 120) });
      return ['skip', 'wake'].includes(result?.action) ? result.action : 'pass';
    } catch (err) {
      // 宿主取消必须原样抛出；插件门禁自身故障不得把正常回复判死。
      if (signal?.aborted) throw err;
      this.logger?.warn('[pre_reply] 插件门禁失败，按 pass 继续：' + describeError(err));
      return 'pass';
    }
  }

  /** 消息通过宿主基础检查后、触发判定前 observe 一次；失败只记日志。 */
  async observeReceived(msg, { localWechat = false } = {}) {
    if (!this.capabilities?.hasProviders?.('chat.received@1')) return;
    try {
      await this.capabilities.invoke('chat.received@1', {
        message: this.providerMessage(msg),
        localWechat: Boolean(localWechat),
      }, { key: this.sessionKey(msg), chatId: String(msg?.chatId || '').slice(0, 120) });
    } catch (err) {
      this.logger?.warn('[chat.received] 观察失败（不影响主流程）：' + describeError(err));
    }
  }

  /** system 组装完成后、生成之前增强提示词；history 只在插件声明会话历史权限时提供。 */
  async applyPromptHooks(decision, { signal } = {}) {
    if (!this.capabilities?.hasProviders?.('chat.prompt@1') || !decision?.system) return decision;
    const input = { system: String(decision.system).slice(0, 64000), message: this.providerMessage(decision.msg) };
    try {
      const providers = typeof this.capabilities.providers === 'function'
        ? this.capabilities.providers('chat.prompt@1', 'all') : [];
      const granted = new Set((providers || []).flatMap(plugin => plugin.dataAccess || []));
      if (granted.has('conversation-history') || granted.has('chat.history')) {
        try {
          input.history = this.store.messages(decision.key, 12).map(row => ({
            role: row.role === 'assistant' ? 'assistant' : 'user',
            text: String(row.text || '').slice(0, 16000),
          }));
        } catch { input.history = []; }
      }
      const result = await this.capabilities.invoke('chat.prompt@1',
        this.withTurnContext(input, decision.key), {
          key: decision.key, signal, chatId: String(decision.msg?.chatId || '').slice(0, 120),
        });
      if (typeof result?.system === 'string') decision.system = result.system.slice(0, 64000);
      return decision;
    } catch (err) {
      if (signal?.aborted) throw err;
      this.logger?.warn('[chat.prompt] 提示词增强失败，沿用原 system：' + describeError(err));
      return decision;
    }
  }

  /** finalize 之后、交给网关之前改写最终文本；enhance 失败退回原文本。 */
  async applyBeforeSend(decision, text, { signal } = {}) {
    if (!this.capabilities?.hasProviders?.('chat.before_send@1')) return text;
    try {
      const input = this.withTurnContext({
        message: this.providerMessage(decision.msg),
        text: String(text == null ? '' : text).slice(0, 16000),
      }, decision.key);
      const result = await this.capabilities.invoke('chat.before_send@1', input,
        { key: decision.key, signal, chatId: String(decision.msg?.chatId || '').slice(0, 120) });
      return typeof result?.text === 'string' ? result.text : text;
    } catch (err) {
      if (signal?.aborted) throw err;
      this.logger?.warn('[chat.before_send] 发送前改写失败，保留原文本：' + describeError(err));
      return text;
    }
  }

  /** 记录 bot 已 observe 的 ignore，避免网关再 observe 一次。 */
  markDispatchedIgnore(msg = {}) {
    if (!this._dispatchedIgnores) this._dispatchedIgnores = new Map();
    const key = [msg.platform, msg.chatType, msg.chatId, msg.senderId, msg.msgId, String(msg.text || '').slice(0, 80)].join('|');
    this._dispatchedIgnores.set(key, Date.now());
    if (this._dispatchedIgnores.size > 128) {
      const oldest = this._dispatchedIgnores.keys().next().value;
      this._dispatchedIgnores.delete(oldest);
    }
  }

  consumeDispatchedIgnore(msg = {}) {
    if (!this._dispatchedIgnores) return false;
    const key = [msg.platform, msg.chatType, msg.chatId, msg.senderId, msg.msgId, String(msg.text || '').slice(0, 80)].join('|');
    const at = this._dispatchedIgnores.get(key);
    if (!at) return false;
    this._dispatchedIgnores.delete(key);
    return Date.now() - at < 60000;
  }

  /** 发送/忽略后的观察者；失败只记日志，绝不影响本轮结果。 */
  async observeDispatched(decision, { action, text = '', sent = false, reason = '' } = {}) {
    if (!this.capabilities?.hasProviders?.('chat.dispatched@1')) return;
    try {
      const payload = {
        message: this.providerMessage(decision?.msg),
        text: String(text || '').slice(0, 16000),
        action: String(action || 'ignore').slice(0, 40),
        sent: Boolean(sent),
      };
      if (reason) payload.reason = String(reason).slice(0, 80);
      await this.capabilities.invoke('chat.dispatched@1', payload, { key: decision?.key });
    } catch (err) {
      // 没有注入 logger 时也不能静默：schema 不匹配这类问题只在这里暴露一次。
      (this.logger?.warn ?? console.warn).call(this.logger || console,
        '[chat.dispatched] 观察者失败（不影响发送）：' + describeError(err));
    }
  }

  /** 运行时生命周期观察：对每个已启用且已授权的提供者各调用一次；失败只记日志。 */
  async observeAppLifecycle(name, { signal } = {}) {
    if (!this.capabilities?.hasProviders?.(name, 'all')) return;
    let providers = [];
    try { providers = this.capabilities.providers(name, 'all') || []; } catch { return; }
    await Promise.all(providers.map(plugin => {
      const settings = plugin && plugin.settings && typeof plugin.settings === 'object' && !Array.isArray(plugin.settings)
        ? plugin.settings : {};
      return Promise.resolve(this.capabilities.invoke(name, { at: this.now().getTime(), settings }, { pluginId: plugin.id, signal }))
        .catch(err => {
          if (signal?.aborted) return;
          this.logger?.warn('[' + name + '] 插件观察失败（不影响主流程）：' + describeError(err));
        });
    }));
  }

  /**
   * 判断并准备好这次回复（不调用模型）。返回 decision。
   */
  async decide(rawMsg, { signal, localWechat = false } = {}) {
    if (signal?.aborted) return { action: 'ignore', reason: 'cancelled' };
    const turn = { signal, cancelled: false, lease: null };
    const abort = () => { turn.cancelled = true; this._replyQuota.release(turn.lease); };
    signal?.addEventListener('abort', abort, { once: true });
    turn.detach = () => signal?.removeEventListener('abort', abort);
    let decision;
    try {
      decision = await this._decide(rawMsg, turn, { localWechat });
      this._replyTurns.set(decision, turn);
      if (decision.action === 'reply') {
        decision = await this.applyPromptHooks(decision, { signal });
      }
      // 生成插件对「决定要回」的所有普通回复生效，包括固定话术：旧 chat.generate 钩子
      // 就是这样覆盖 canned 的，配额/授权回归依赖它（插件返回空时要能回滚 consent 等草稿）。
      if (decision.action === 'reply' && !decision.mock && this.capabilities.hasProviders('chat.generate@1')) {
        const { platform, chatType, chatId, senderId, text } = this.providerMessage(decision.msg);
        const generated = await this.capabilities.invoke('chat.generate@1', {
          message: { platform, chatType, chatId, senderId, text }, system: String(decision.system || ''),
          turns: (Array.isArray(decision.turns) ? decision.turns : []).slice(-100).map(({ role, content }) => ({ role, content })),
        }, { key: decision.key, signal, builtin: async () => ({ text: await this.completeChat(decision, { signal }) }) });
        decision.canned = generated.text;
        decision.text = generated.text;
        if (!generated.text.trim()) { decision.action = 'ignore'; decision.reason = 'plugin_empty'; }
      }
      if (turn.cancelled) decision = { ...decision, action: 'ignore', reason: 'cancelled' };
      if (decision.action === 'ignore') {
        this._replyQuota.release(turn.lease);
        turn.detach();
      } else {
        if (turn.draft) {
          const plan = replyDecision.replyPlan(decision.action, decision.reason, turn.before, turn.draft);
          replyDecision.applyReplyPlan(turn.state, plan);
        }
        this._replyQuota.idle(turn.lease);
      }
    } catch (err) {
      this._replyQuota.release(turn.lease);
      turn.detach();
      throw err;
    }
    // 判定链：为什么回 / 为什么不回。只记原因、长度和状态，正文交给 trace 的短期原文副本
    // （默认不进导出包）。追踪本身出错也绝不能影响回消息。
    try {
      if (this.trace) {
        this.trace.record({
          msg: decision.msg || this.normalize(rawMsg),
          decision,
          state: this._lastTraceState || null,
        });
      }
    } catch { /* 追踪失败不影响回消息 */ }
    return decision;
  }

  prepareIncoming(rawMsg) {
    const msg = this.normalize(rawMsg);
    // normalize() 只保留固定字段，桥接状态（gateway 挂在消息上的 {online,uia,ffmpeg}）会丢；
    // 这里补回来，供本轮状态里那句「桥接在线 / 离线」用。
    if (rawMsg && rawMsg.bridgeStatus && typeof rawMsg.bridgeStatus === 'object') {
      msg.bridgeStatus = rawMsg.bridgeStatus;
    }
    // 管理员动态改窗口后，存储限额也要跟上；不会恢复之前已被丢弃的记录。
    if (this.store.limits) {
      this.store.limits.maxMessages = Math.min(800, Math.max(
        this.store.limits.maxMessages,
        Number(this.config.chat.historyTurns || 200) + 2,
        Number(this.config.chat.groupHistoryTurns || 150) + 2,
      ));
      if (this.store.chatStore) this.store.chatStore.maxMessages = this.store.limits.maxMessages;
    }
    const key = this.sessionKey(msg);
    const now = this.now();
    const nowMs = now.getTime();
    // 群消息常带 "wxid_xxx:\n正文" 前缀，先去掉再识别 @/名字，否则别名不在行首会漏判。
    // 以前这里用 \s*（零空白也吞）："https://example.com" 被剥成 "//example.com"、
    // "Note: xxx" 也被截断，残缺文本进了提示词/搜索/记忆。wxid 前缀后面本来就有换行/空格，
    // 改成 \s+ 就够了（H8）。
    const rawText = String(msg.text || '').replace(/^[A-Za-z0-9_\-]{4,}:\s+/, '');
    const spell = String(this.config.admin?.spell || '').trim();
    const isAdminSpell = Boolean(spell && rawText.trim() === spell);
    if (isAdminSpell) msg.text = '（已隐藏：管理员魔咒）';
    const selfNames = addressing.herNames(this, msg);
    const clean = persona.cleanIncomingForPersona(isAdminSpell ? msg.text : rawText, this.config, selfNames);
    msg.cleanText = isAdminSpell ? msg.text : clean.text;
    let atMe = msg.atMe || clean.atMe;
    const isGroup = msg.chatType === 'group';
    // 群里：@ 名单 + 文本里出现的别名；私聊：只认桥接明确给的提及名单（不做别名猜测）。
    // 关系块两种会话都用同一套逻辑（当前说话人 → 提到的第三人）。
    const mentionedNames = isGroup
      ? addressing.filterSelfMentions([
        ...(Array.isArray(msg.mentionedNames) ? msg.mentionedNames : []),
        ...extractMentionNames(isAdminSpell ? msg.text : rawText, persona.aliasList(this.config, selfNames)),
      ], selfNames).slice(0, 4)
      : addressing.filterSelfMentions(msg.mentionedNames, selfNames).slice(0, 4);
    msg.mentionedNames = mentionedNames;
    const voiceRequested = msg.platform === 'wechat' && voiceReply.enabled(this.config, isGroup) && voiceReply.requested(clean.text);
    if (voiceRequested && !mentionedNames.length) {
      atMe = true;
      msg.atMe = true;                 // 插件和 trace 也读 msg.atMe，不能只改局部变量
    }
    msg.voiceRequested = Boolean(voiceRequested);
    msg.externalMentionNames = mentionedNames;
    msg.addressedToBot = addressing.isAddressed(atMe, msg);

    return { msg, key, now, nowMs, rawText, spell, isAdminSpell, clean, atMe, isGroup, mentionedNames, voiceRequested };
  }

  loadMemoryContext({ key, msg, clean, displayName, isGroup, mentionedNames, nowMs, tokenScale }) {
    const relationsOn = features.isOn(this.config, 'relations');
    let mem;
    try {
      // 记忆只走这一个入口（memory.recall）。pipeline 不再直接碰人物卡 / 事件 / 摘要结构，
      // 以后换检索方式或加共享池，改的是 memory 层，不是对话流程。
      mem = memory.recall(this.store, {
        key,
        uid: msg.senderId,
        name: displayName,
        query: clean.text,
        now: nowMs,
        isGroup,
        mentionedNames,
        relationsEnabled: relationsOn,
        // 形参叫 tokenScale：这个方法拆出来以后曾经误写成 trimScale，
        // 结果是必抛 ReferenceError → 每轮都静默退化成「只用 recent」。
        tokenScale,
        historyTurns: this.config.chat.historyTurns,
        groupHistoryTurns: this.config.chat.groupHistoryTurns,
        // 记忆 v2：在长期档案上多召回一段「相关回忆」。默认关，关掉时与改造前逐字一致。
        recallArchive: features.isOn(this.config, 'memoryV2'),
        // 共享池：只注入显式晋升过的公开事实，并按 audience 过滤
        sharedPool: features.isOn(this.config, 'memoryV2'),
      });
      this._memoryErrorLogged = false;
    } catch (err) {
      if (this.logger) {
        // 第一次带完整堆栈（能定位到具体模块），之后同一进程内只留一行 code/detail，别每条消息刷一遍
        const info = describeError(err);
        const detail = this._memoryErrorLogged ? info : `${info}\n${(err && err.stack) || ''}`;
        this.logger.error('拉取记忆失败（本轮放弃记忆块，只用 recent 消息回复）：' + detail);
      }
      this._memoryErrorLogged = true;
      mem = this.recentOnlyContext(key, { isGroup });
    }
    return mem;
  }

  async _decide(rawMsg, turn, { localWechat = false } = {}) {
    const prepared = this.prepareIncoming(rawMsg);
    const { msg, key, now, nowMs, rawText, spell, isAdminSpell, clean, atMe, isGroup, mentionedNames, voiceRequested } = prepared;
    // 新版人设行为随消息一路带给提示词/管理闸；只按当前配置取一次，避免同轮内变来变去。
    msg.newPersonaBehavior = usesNewPersona(this.config);

    // 功能关闭时拍一拍完全不参与：不识别、不回应、不发送（关闭语义见 features 登记表）。
    if (msg.pat && !features.isOn(this.config, 'pat')) {
      return { action: 'ignore', reason: 'pat_disabled', key, msg, atMe: true };
    }

    // 系统号 / 通知类消息（比如「微信团队」的自动推送）一律不接话
    const sysNames = new Set([
      '微信团队', '微信支付', '服务通知', '订阅号消息', '文件传输助手',
      '微信运动', '微信公众平台', '腾讯客服', '微信安全中心',
      ...((this.config.wechat && this.config.wechat.ignoreSenders) || []).map((x) => String(x)),
    ]);
    if (/<a\s+href=|weixin:\/\//i.test(rawText) || sysNames.has(String(msg.senderName || ''))) {
      return { action: 'ignore', reason: 'system_notice', key, msg, atMe };
    }

    const session = this.store.ensureSession(key, {
      platform: msg.platform,
      chatId: msg.chatId,
      chatType: msg.chatType,
      title: msg.chatTitle,
    });
    // 给 decide() 外面的 trace 用：会话状态（静默期/接话窗口/限流计数）在这里才是最新的
    this._lastTraceState = session.state;

    // 1) 去重
    if (msg.msgId && this.store.isDuplicate(key, msg.msgId)) {
      return { action: 'ignore', reason: 'duplicate', key, msg };
    }
    if (msg.msgId) this.store.markSeen(key, msg.msgId);
    // 魔咒优先于普通聊天与固定话术，避免口令被当成消息落库或送模型。
    // 发言范围只有一个共享规则：这里只补上会话标题（重启后可能只存在 session.title）。
    const denial = sendDenial(this.config, {
      chatId: msg.chatId,
      chatType: msg.chatType,
      chatTitle: msg.chatTitle || session.title,
      platform: msg.platform,
    });
    if (isAdminSpell) {
      if (denial) return { action: 'ignore', reason: denial, key, msg };
      const unlocked = this.unlockAdminSpell(msg, key, session.state, spell, nowMs);
      if (unlocked) return unlocked;
      // 未认证或不在微信私聊时，只用 prepareIncoming 已脱敏的文案继续普通路由。
    }

    // 每个说话人分别跟踪最近的显式 @ 对象；只作为短时路由提示，不当作确定事实。
    if (isGroup) {
      const targets = session.state.externalTargets || (session.state.externalTargets = {});
      for (const [uid, value] of Object.entries(targets)) {
        if (nowMs - Number(value.ts || 0) > 60000) delete targets[uid];
      }
      if (addressing.isAddressed(atMe, msg)) {
        delete targets[msg.senderId];
      } else if (mentionedNames.length) {
        targets[msg.senderId] = { names: mentionedNames, ts: nowMs };
        msg.directedElsewhere = true;
      } else if (targets[msg.senderId] && /你|您/.test(clean.text)) {
        msg.directedElsewhere = true;
        msg.inferredTargetNames = targets[msg.senderId].names;
      }
    }

    // 2) 记录收到的话（被忽略的也记，让它知道群里在聊什么）
    // 只 @ 不说话时：看看这个人刚才是不是问过什么，直接接着回答上一个问题。
    // 回填的是旧问题：标成 msg.recycled（M27），只拿它组装回复 —— 以前它会被当成新消息
    // 再落一次库、再抽一遍事实、再登记一遍提醒、再执行一遍命令（副作用全部重放）。
    // 纯「？」不要回填上一条问题：没 @ 她时它按不接处理（trigger 里的 question_mark），
    // @ 她时也只当成「叫了一声没说事」；先回填会把原始问号吃掉，
    // 用户 @ 她只发一个「？」却收到旧问题的答案。
    if (isGroup && addressing.isAddressed(atMe, msg) && !String(clean.text || '').trim()) {
      try {
        const recent = this.store
          .messages(key, 8)
          .filter((m) => m.role === 'user' && m.text && String(m.text).trim().length > 1)
          .filter((m) => String(m.text).trim() !== String(rawText).trim())
          .filter((m) => {
            if (msg.senderId && m.uid) return String(m.uid) === String(msg.senderId);
            return !msg.senderName || String(m.name || '') === String(msg.senderName);
          });
        const last = recent[recent.length - 1];
        if (last && this.now().getTime() - Number(last.ts || 0) < 180000) {
          clean.text = String(last.text).trim();
          msg.cleanText = clean.text;
          msg.recycled = true; // 回填的旧问题：只用于组装回复，不重放副作用
        }
      } catch { /* ignore */ }
    }

    const hasText = Boolean(clean.text);
    let appended = null;
    if (hasText && !msg.recycled) {
      // 落库失败不能拖死这一轮：记忆/原文是加分项，回复本身要继续。
      // 以前这里没兜底，磁盘满 / 文件被占用时整条消息直接变成「不回话」。
      try {
        appended = this.store.appendMessage(key, {
          role: 'user',
          name: msg.senderName,
          uid: msg.senderId,
          text: clean.text,
          ts: nowMs,
          msgId: msg.msgId,
          addressedToBot: msg.addressedToBot,
          mentionedNames,
          inferredTargetNames: msg.inferredTargetNames || [],
          replyToName: msg.replyToName,
          replyToUserId: msg.replyToUserId,
        });
      } catch (err) {
        if (this.logger) this.logger.error('写入用户消息失败（继续回复）：' + describeError(err));
      }
    }
    // 保留原有旁听记录，但在提醒、命令和固定回复之前拦住会话。
    if (denial) return { action: 'ignore', reason: denial, key, msg };
    // 人物卡也是记忆：读不出来就用空卡顶上（昵称退回微信昵称），别让整条消息陪葬。
    // 以前这里没兜底，记忆目录一坏（文件损坏 / 权限 / 迁移中）就直接抛到 _handleOnce。
    let profile = null;
    try {
      profile = this.store.profile(key, msg.senderId, msg.senderName);
    } catch (err) {
      if (this.logger) this.logger.error('读取人物卡失败（按空卡继续回复）：' + describeError(err));
      profile = { uid: msg.senderId, name: msg.senderName, nickname: '', notes: [], count: 0 };
    }
    // 群里用微信昵称区分说话人，避免用户改 profile.nickname 造成冒名；私聊仍沿用自报昵称。
    const displayName = isGroup
      ? (msg.senderName || profile.nickname || '')
      : (profile.nickname || msg.senderName || '');
    // 自述 / 纠正 / 手动记住的抽取在 Store.appendMessage 里同步完成：
    // 只写「当前 chat + 当前说话人」的卡，跨 chat 写入会直接抛错。
    // 回填的旧问题（recycled）在上面的 appendMessage 处整体跳过，不会重复抽事实。
    let state = session.state;
    const muted = sessionState.isMuted(state, nowMs);
    // 基础检查通过后、触发判定前 observe 一次；失败不影响后续。
    // 静音消息不 observe：静音属于宿主基础闸。但静音闸不能在这里提前 return，
    // 它必须排在提醒、退场话术和管理员命令之后（见下方），否则「闭嘴」不会应声、
    // 主人被静音时也发不出管理命令 —— 那是旧行为，2026-11 的回归就出在这里。
    if (!muted) await this.observeReceived(msg, { localWechat });

    // 识别「唯一的主人」（配置里 master.names / master.wxids）
    // 规则只写在 src/core/master.js，启动器的提示词预览用的是同一个函数，不会出现
    //「预览说认了、微信里却当陌生人」这种两边打架的情况。
    const masterHit = matchMaster(this.config, msg);
    const isMaster = masterHit.isMaster;
    // 每条微信私聊都留一行判定，出问题直接看日志，不用猜
    if (msg.platform === 'wechat' && msg.chatType === 'private' && this.logger) {
      this.logger.info(
        `[master] 私聊 sender=${tagId(msg.senderId)} name=${tagName(msg.senderName)} → ` +
        `${isMaster ? '主人' : '非主人'}${masterHit.reason ? '（' + masterHit.reason + '）' : ''}`
      );
    }
    // 昵称对上了、senderId 却没对上：八成是 master.wxids 里填了微信号或昵称，微信里认不出来。
    // 每个 id 只提醒一次，别刷日志。
    if (!isMaster && msg.platform === 'wechat' && masterHit.nameHit) {
      const sid = String(msg.senderId || '(没有 id)');
      this._masterWarned = this._masterWarned || new Set();
      if (!this._masterWarned.has(sid) && this.logger) {
        this._masterWarned.add(sid);
        this.logger.warn(
          `[master] name=${tagName(msg.senderName)} 命中主人名单，但 sender=${tagId(sid)} 和` +
          ` persona.master.wxids 里的 ${masterHit.wxids.length} 个 id 都对不上；微信里只认 senderId。` +
          '如果这是主人，在启动器「人设 · 主人」里重新选一次；具体 id 看诊断页最近发言者，不写日志。'
        );
      }
    }
    // 后面生成的文本要判断「是不是在对主人说话」（例如不许带脏字回骂）
    msg.isMaster = isMaster;

    // 提醒：任何会话、任何人都能设（「十点半提醒我开会」）。
    // 放在最前面：群里没 @ 她也要能设，且不能被后面的静默/忽略逻辑挡掉。
    // 回填的旧问题（recycled）不再登记一遍，否则只 @ 一下就多出一条重复提醒（M27）。
    if (hasText && !msg.recycled) {
      const reminderReply = await this.tryReminder({ msg, clean, key, now, nowMs, isGroup, atMe, signal: turn.signal });
      if (reminderReply) return reminderReply;
    }

    // 对别人的话仍然旁听存档，但不触发命令、回怼或接话。
    // 显式 @/回复她、主人说话、正叫她的名字、明确骂她时不能被 60 秒前的
    // 旧 @ 记录一票否决，否则主人刚 @ 过同事下一句就被无视。
    const _earlyNames = addressing.herNames(this, msg);
    const _earlyForHer = addressing.isAddressed(atMe, msg)
      || isMaster
      || addressing.namedHerIn(clean.text || '', _earlyNames)
      || INSULT_RE.test(clean.text || '');
    if (isGroup && msg.directedElsewhere && !_earlyForHer) {
      return { action: 'ignore', key, msg, reason: 'addressed_to_other' };
    }


    // 固定话术 · 退场分支：「让她滚 / 走吧 / 闭嘴」这类要先应一声再进静默，
    // 必须排在静音/禁言闸门之前（被赶走也得有交代）；实现见 pipeline/stages/canned.js。
    const dismiss = dismissReply(this, {
      msg,
      text: clean.text,
      isGroup,
      isMaster,
      atMe,
      state,
      nowMs,
      key,
    });
    if (dismiss) return dismiss;

    // 魔咒 / 管理员权限（只有绑定 ID 的主人在验证魔咒后可用）。
    // v4.1.8 契约（chat.js:432 设置 newPersonaBehavior，:1263 非主人直接 return null）：
    // 新版人设下非主人根本不进管理通道，连提示都不给，随后照常被静音/触发闸拦下。
    // 这里用 isVerifiedOwner 而不是 matchMaster 的 isMaster：昵称命中不算绑定，
    // 不能凭昵称给未绑定者发管理提示（权限判定仍在 handleAdmin 内，不在这里改）。
    const adminReply = (!isVerifiedOwner(this.config, msg) && msg.newPersonaBehavior) ? null : this.handleAdmin({ msg, clean, key, state, isMaster, nowMs });
    if (adminReply) return adminReply;

    // 静音消息属于宿主基础闸：不触发、不进入插件门禁、不产生接话窗口副作用。
    // 位置不能提前到提醒/退场话术/管理员命令之前：被静音时，「闭嘴」要先应一声再进静默，
    // 主人仍要能发管理命令（旧顺序如此）；插件 gate 也不能靠 wake 绕过静音。
    if (muted) return { action: 'ignore', reason: 'muted', key, msg, atMe };

    turn.state = state;
    const staged = replyDecision.draftReplyState(state);
    turn.before = staged.before;
    turn.draft = state = staged.draft;
    let triggerResult = this.computeTrigger({ msg, atMe, clean, isGroup, state, nowMs, isMaster, muted });
    // 门禁在触发判定之后问一次：skip 压制，wake 覆盖「本来不回复」的判定。
    const gate = await this.preReplyAction(msg, { signal: turn.signal, localWechat });
    if (gate === 'skip') return { action: 'ignore', reason: 'plugin_skip', key, msg, atMe };
    if (gate === 'wake') triggerResult = { ...triggerResult, wake: true, reason: 'plugin_wake' };
    // 旧版「被骂自动唤醒反击」已删除：不 @、不回复她时，不再因为群里的脏话主动插话。
    if (!triggerResult.wake) {
      return { action: 'ignore', reason: triggerResult.reason, key, msg, atMe };
    }
    // 被静音丢掉的消息不能产生「等静音结束再插话」的副作用。
    if (isGroup && ['addressed', 'directed', 'engaged', 'insulted'].includes(triggerResult.reason)) {
      sessionState.touchEngagement(
        state, msg.senderId, nowMs, this.config.group.engagedMinutes);
    }
    if (turn.cancelled) return { action: 'ignore', reason: 'cancelled', key, msg };
    const recentCount = recentReplyCount(this, { key, state, nowMs });
    const admission = this._replyQuota.reserve(key, recentCount, Number(this.config.group.maxRepliesPerMinute));
    if (admission.reason) return { action: 'ignore', reason: admission.reason, key, msg, atMe };
    turn.lease = admission.lease;
    turn.key = key;

    // 固定话术：查自己的号 / 同意被损 / 主人点名吐槽（canned.js）。
    // 以前这些排在所有闸门前面（M19）：mute、禁言群、静默期、burst_limit 全挡不住；
    // 现在挪到静音/禁言/限流之后 —— 被静音时一律不接，consent/self_wxid 等分支
    // 在 canned.js 里还补了「群聊没 @ 不接」的门。
    const canned = cannedReply(this, {
      msg,
      text: clean.text,
      isGroup,
      isMaster,
      atMe,
      state,
      nowMs,
      key,
    });
    if (canned) return canned;

    // 整条就是已知缩写时走固定短回法，保证 kskbl 只回 zdjd，不让模型多发挥。
    const fixedAbbrev = hasText && persona.abbrevReply ? persona.abbrevReply(clean.text) : '';
    if (fixedAbbrev) {
      return { action: 'reply', key, msg, atMe, canned: fixedAbbrev, reason: 'abbrev' };
    }

    // 5) 只 @ 了一下、没说话（或只发了一串省略号/感叹号）
    // 纯「？」不算「没说事」：它交给模型正常接，不再走固定话术。
    const questionOnly = hasText && /^[?？\s]+$/.test(String(clean.text || '').trim());
    if (!questionOnly && (!hasText || /^[?？!！.。…~～\s]+$/.test(clean.text || ''))) {
      const rawText = String(msg.text || '');
      // 被用「乐乐 / 小乐乐」这种外号点名 → 当挑衅
      if (/乐乐/.test(rawText)) {
        return {
          action: 'reply',
          key,
          msg,
          atMe,
          canned: isMaster ? `${this.config.persona.ownerName || '主人'}你叫谁乐乐呢，哼` : '乐乐你叫谁呢',
          reason: 'nickname_provoke',
        };
      }
      return {
        action: 'reply',
        key,
        msg,
        atMe,
        canned: isGroup ? '在，怎么啦' : (isMaster ? `在呢${this.config.persona.ownerName || '主人'}，怎么啦` : '在，怎么了'),
        reason: 'bare_mention',
      };
    }

    // 群里被叫到一次后，接下来继续聊就接着回；换话题/沉默超时就不接了
    const engagedMinutes = Math.max(1, Number(this.config.group.engagedMinutes) || 6);
    if (isGroup) {
      if (addressing.isAddressed(atMe, msg)) {
        sessionState.touchEngagement(state, msg.senderId, nowMs, engagedMinutes);
      } else if (/(换个话题|不说这个|不聊这个|算了不聊|聊点别的|跳过这个话题|别聊了|没你事|跟你没关系|不关你事|没问你|别接话|不用接)/.test(clean.text || '')) {
        sessionState.clearEngagement(state);
      }
    }

    // 群聊触发判定后再获取链接和插件资料，避免无关消息消耗网络预算。
    const nativeChat = Boolean(this.llm.supportsWebSearch?.());
    const linkUrls = this.config.links?.enabled === false ? [] : links.extractUrls(clean.text || '');
    msg.nativeReadUrl = nativeChat && linkUrls.length > 0;
    const linkTask = !nativeChat && linkUrls.length ? this.readLink(linkUrls[0], key) : Promise.resolve('');
    const shouldSearch = !nativeChat;
    // 搜索结果在 if 之后还要用（webText / 状态 / 原因），所以声明必须在外面
    let searchResult = null;
    if (shouldSearch) {
      const searchInput = {
        message: { platform: msg.platform, chatType: msg.chatType, chatId: msg.chatId, text: String(clean.text || '').slice(0, 16000) },
      };
      // 只有真有插件声明 chat.search@1 时才进统一调度器；否则普通路径直接走内置搜索，
      // 不能被调度器的「按会话 16 条待处理」上限误伤（并发 30 条普通回复会全部超限）。
      const pluginSearch = this.capabilities.hasProviders('chat.search@1');
      try {
        searchResult = pluginSearch
          ? await this.capabilities.invoke('chat.search@1', searchInput, { key, signal: turn.signal })
          : await this.searchForChat(searchInput);
      } catch (err) {
        // 取消照常向上抛：断线后继续搜索/回退内置搜索都是白花一次网络预算，
        // 也会让调用方把「取消」误当成「搜索故障」。
        if (turn.signal?.aborted || err?.code === 'capability_aborted') throw err;
        // 搜索是只读增强（sideEffect=network-read），没有用户可见副作用：插件失败时
        // 可以安全回退到宿主内置搜索；内置也失败就降级为「本轮没有联网资料」。
        // 不能因为一条搜索插件故障把整轮回复判死——回复本身不依赖搜索。
        this.logger?.warn('[search] stage=search_failed plugin=' + pluginSearch
          + ' code=' + String((err && err.code) || 'search_error') + ' ' + describeError(err));
        searchResult = { text: '', items: [], status: 'failed' };
        if (pluginSearch) {
          try {
            searchResult = await this.searchForChat(searchInput);
          } catch (fallbackErr) {
            if (turn.signal?.aborted || fallbackErr?.code === 'capability_aborted') throw fallbackErr;
            this.logger?.warn('[search] stage=builtin_failed code='
              + String((fallbackErr && fallbackErr.code) || 'search_error') + ' ' + describeError(fallbackErr));
          }
        }
      }
      if (searchResult?.status && searchResult.status !== 'empty') {
        try { this.store.appendEvent(key, { type: 'web', status: searchResult.status }); }
        catch (err) { this.logger?.warn('[search] stage=record_failed ' + describeError(err)); }
      }
    }
    const linkText = await linkTask;
    msg.linkText = linkText;
    msg.webText = searchResult?.text || '';
    msg.searchResult = searchResult;
    msg.webSearchStatus = searchResult?.status || '';
    msg.webSearchReason = searchResult?.reason;

    // 认真讨论（不是随口闲聊）→ 允许说长一点、有观点
    const discussPattern = /(讨论|探讨|你觉得|你怎么看|你认为|为什么|该不该|要不要|是不是应该|如何选择|怎么选|怎么看|有道理吗|值得吗|价值观|人生|意义|观点|看法|利弊|优缺点)/;
    // 只按本条请求判断，旧存档的讨论窗口不能把短句闲聊永久续成详细回答。
    const discussion = Boolean(clean.text && clean.text.length >= 8 && discussPattern.test(clean.text));
    state.discussUntil = 0;
    msg.discussion = discussion;

    // 6) 组装提示词：只加载「当前 chat + 当前说话人」的卡，绝不跨聊天取。
    // 记忆块（人物卡 + 相关事件 + 摘要）放进最后一条 user 消息，进 system 会打断前缀缓存。
    // 关系块（A 提到 B）挂在记忆块后面，同一个尾部位置；开关跟着 features.relations 走。
    const relationsOn = features.isOn(this.config, 'relations');
    const modelInfo = this.modelContext();
    const trimScale = this.calibrationEngine().trimScale(modelInfo);
    const mem = this.loadMemoryContext({ key, msg, clean, displayName, isGroup, mentionedNames, nowMs, tokenScale: trimScale });
    return buildPromptDecision(this, { msg, key, clean, atMe, isGroup, mentionedNames, voiceRequested, now, nowMs, session, profile, displayName, appended, triggerResult, linkText, discussion, isMaster, state, mem, relationsOn, modelInfo, trimScale });
  }

  computeTrigger(args) {
    return trigger.computeTrigger(this, args);
  }

  /** 管理魔咒必须由宿主先处理，不能让接管插件看到或改写口令。 */
  isAdminSpellMessage(msg = {}) {
    const spell = String(this.config.admin?.spell || '').trim();
    if (!spell) return false;
    return String(msg.text || '').replace(/^[A-Za-z0-9_-]{4,}:\s+/, '').trim() === spell;
  }

  providerMessage(msg = {}) {
    return {
      platform: String(msg.platform || '').slice(0, 24),
      chatType: msg.chatType === 'group' ? 'group' : 'private',
      chatId: String(msg.chatId || '').slice(0, 120),
      senderId: String(msg.senderId || '').slice(0, 120),
      senderName: String(msg.senderName || '').slice(0, 80),
      text: String(msg.cleanText || msg.text || '').slice(0, 16000),
      atMe: Boolean(msg.atMe),
      replyToBot: Boolean(msg.replyToBot),
      msgId: String(msg.msgId || '').slice(0, 200),
      chatTitle: String(msg.chatTitle || '').slice(0, 160),
      // 旧 Api3 的「在叫别人」判定依赖这个名字列表；宿主只给有界的名字，不给成员 id。
      mentionedNames: (Array.isArray(msg.mentionedNames) ? msg.mentionedNames : [])
        .slice(0, 4).map(name => String(name || '').slice(0, 40)).filter(Boolean),
    };
  }

  /**
   * 插件能看到的「上一条自己的回复」。
   *
   * 旧 Api3 宿主直接把数据库里的 history 尾条交出去；现在只收口成旧插件判定真正
   * 用到的三个字段（text/at/targetId），既不把整条记录（uid/seq/内部标记）泄给
   * 插件，也不会因为字段形状不同让 followup-window 这类插件永远拿不到 lastBot。
   * 读不到历史时返回 null：旧文档就是「没有 lastBot 就 pass」。
   */
  pluginLastBot(key) {
    if (!key) return null;
    let rows = [];
    try { rows = this.store.messages(key, 12) || []; } catch { return null; }
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (!row || row.role !== 'assistant') continue;
      const text = String(row.text || '');
      if (!text) continue;
      return {
        text: text.slice(0, 4000),
        at: Number(row.ts) || 0,
        targetId: String(row.replyToUserId || '').slice(0, 120),
      };
    }
    return null;
  }

  /**
   * 四个带 state 的聊天能力共用：把宿主的「现在」和上一条自己的回复一起交给插件。
   * 时间必须由宿主给，插件侧 Date.now() 既过不了假时钟测试，也和自己保存的
   * lastBot.at 不在同一条时间线上（旧 Api3 就是这么传的）。
   */
  withTurnContext(input, key) {
    return { ...input, now: this.now().getTime(), lastBot: this.pluginLastBot(key) };
  }

  async transformPluginReply(decision, text, { signal } = {}) {
    const providers = this.capabilities.providers('chat.reply@1', 'all');
    if (!providers.length) return text;
    const granted = new Set(providers.flatMap(plugin => plugin.dataAccess || []));
    const message = this.providerMessage(decision.msg);
    const input = {
      message: {
        platform: message.platform, chatType: message.chatType, chatId: message.chatId,
        senderId: message.senderId, senderName: message.senderName, text: message.text,
        atMe: message.atMe, replyToBot: message.replyToBot, msgId: message.msgId,
        mentionedNames: message.mentionedNames,
      },
      text: String(text || '').slice(0, 16000),
    };
    if (granted.has('model.prompt')) input.system = String(decision.system || '').slice(0, 64000);
    if (granted.has('chat.history')) {
      try {
        input.history = this.store.messages(decision.key, 12)
          .map(row => ({ role: row.role === 'assistant' ? 'assistant' : 'user', text: String(row.text || '').slice(0, 16000) }));
      } catch { input.history = []; }
    }
    const result = await this.capabilities.invoke('chat.reply@1',
      this.withTurnContext(input, decision.key), {
        key: decision.key, signal, chatId: String(decision.msg?.chatId || '').slice(0, 120),
      });
    return result.text;
  }

  /**
   * 全接管（chat.handle@1 的 replace 提供者）返回后的结果阶段。
   *
   * 插件已经生成完正文，这里只收口「发不发、怎么发」：仍然走正常回复的 finalize，
   * 配额准入、群聊输出兜底、气泡拆分、字数上限与落库都只有一份实现。插件自带的
   * bubbles 不直接下发，避免绕过 maxBubbles / 群聊输出校验。mention 是 chat.handle
   * 输出契约里的字段，宿主只原样转交给网关；真正能不能 @ 到人由桥接的 send_at
   * 结果决定（失败会退回普通文本），宿主这里不承诺「已 @」。
   *
   * 取消、配额拒绝（burst_limit / global_minute_cap）与空回复都不落库、不占配额；
   * 失败回退不在这里做，接管失败仍按 fail-closed 交给上层处理。
   */
  finishTakeoverReply(rawMsg, output = {}, { signal } = {}) {
    if (!this.capabilities?.hasProviders?.('chat.before_send@1')) {
      return this._finishTakeoverReplyCore(rawMsg, output, { signal });
    }
    const msg = this.normalize(rawMsg);
    const decision = { key: this.sessionKey(msg), msg };
    const text = String(output?.reply == null ? '' : output.reply).trim();
    return this.applyBeforeSend(decision, text, { signal })
      .then(clean => this._finishTakeoverReplyCore(rawMsg, { ...output, reply: clean }, { signal }));
  }

  _finishTakeoverReplyCore(rawMsg, output = {}, { signal } = {}) {
    if (signal?.aborted) return { cancelled: true, action: 'ignore', reason: 'cancelled' };
    let text = String(output?.reply == null ? '' : output.reply).trim();
    if (!text) return { action: 'ignore', reason: 'empty_reply' };
    const msg = this.normalize(rawMsg);
    const decision = { key: this.sessionKey(msg), msg, action: 'reply', reason: 'plugin' };
    const turn = { key: decision.key, state: this.store.getState(decision.key), signal,
      cancelled: false, lease: null, detach: () => {} };
    const abort = () => { turn.cancelled = true; this._replyQuota.release(turn.lease); };
    signal?.addEventListener('abort', abort, { once: true });
    turn.detach = () => signal?.removeEventListener('abort', abort);
    this._replyTurns.set(decision, turn);
    try {
      if (turn.cancelled || signal?.aborted) return { cancelled: true, action: 'ignore', reason: 'cancelled' };
      // 正常路径在 decide() 里先 reserve 再生成；接管要等插件返回才知道有没有正文，
      // 所以准入放在结果阶段（finalize 之前）。被拒绝时既不下发也不记一次配额。
      const recent = recentReplyCount(this, { key: decision.key, state: turn.state, nowMs: this.now().getTime() });
      const admission = this._replyQuota.reserve(decision.key, recent, Number(this.config.group.maxRepliesPerMinute));
      if (admission.reason) return { action: 'ignore', reason: admission.reason };
      turn.lease = admission.lease;
      // finalize 内部会 activate 这个租约，再按正常回复提交；落库、群聊输出兜底、
      // 气泡与字数上限也都走同一份实现。deferStore：先确认还有可发气泡再落库，
      // 避免「清理后没正文」仍留下一条助手记录（普通回复的存档顺序不受影响）。
      const bubbles = this.finalize(decision, text, { deferStore: true });
      if (!bubbles.length) {
        // finalize 在「没东西可发」时会自己 releaseReply（turn.cancelled 会被置位），
        // 所以这里只看真实取消信号，别把「清空后没有正文」误报成取消。
        if (signal?.aborted) return { cancelled: true, action: 'ignore', reason: 'cancelled' };
        return { action: 'ignore', reason: decision.reason === 'plugin' ? 'empty_reply' : decision.reason };
      }
      const result = { action: 'reply', reply: decision.finalText || text, bubbles, reason: 'plugin' };
      if (output.mention) result.mention = String(output.mention);
      if (decision.separateText) result.separateText = true;
      if (decision.stickerCategory) result.stickerCategory = decision.stickerCategory;
      return result;
    } finally {
      // 已提交的回复在 finalize 里 commit 过租约（并摘掉 abort 监听）；没提交的在这里归还。
      this.releaseReply(decision);
      this._replyTurns.delete(decision);
    }
  }

  unlockAdminSpell(...args) { return admin.unlockAdminSpell.call(this, ...args); }

  adminSpellActive(...args) { return admin.adminSpellActive.call(this, ...args); }

  restoreAdminGrant(...args) { return admin.restoreAdminGrant.call(this, ...args); }

  handleAdmin(...args) { return admin.handleAdmin.call(this, ...args); }
  /**
   * 上下文超长时砍掉一半历史，只重试一次。
   * 群聊的 buildTurns 把所有历史压进一条 user 消息，所以单条时按事件行砍一半；
   * 无论哪条路径都保留最后一条（当前消息），不会退化成「只留当前一句」。
   * @returns {boolean} 是否真的变短、可以重试
   */
  shrinkTurnsForContext(decision) {
    if (!decision) return false;
    const turns = Array.isArray(decision.turns) ? decision.turns : [];
    if (!turns.length) return false;
    let next = null;

    if (turns.length > 1) {
      const keep = Math.max(1, Math.ceil(turns.length / 2));
      next = turns.slice(-keep);
    } else {
      // 群聊：一条 user 里塞了历史事件 + 当前消息 + 记忆块，按历史行砍一半
      const only = turns[0] || {};
      const content = String(only.content || '');
      const splitAt = content.indexOf('【当前需要回应的消息】');
      const historyAt = content.indexOf('【按时间排序的历史】');
      if (splitAt > 0 && historyAt >= 0 && historyAt < splitAt) {
        const head = content.slice(0, historyAt + '【按时间排序的历史】'.length);
        const beforeCurrent = content.slice(historyAt + '【按时间排序的历史】'.length, splitAt);
        const afterCurrent = content.slice(splitAt);
        const lines = beforeCurrent.split('\n').filter((line) => line.trim());
        if (lines.length > 2) {
          const keep = Math.max(1, Math.ceil(lines.length / 2));
          next = [{
            ...only,
            content: head + '\n' + lines.slice(-keep).join('\n') + '\n' + afterCurrent,
          }];
        }
      }
    }

    if (!next || !next.length) return false;
    if (JSON.stringify(next) === JSON.stringify(turns)) return false;
    decision.turns = next;
    // 重试前的预算也要按新 turns 重算，否则 compareUsage 还会拿旧窗口估算
    decision.budget = memoryBudget.buildBudget(decision.system, {
      dialogueBudget: this.config && this.config.memory && this.config.memory.dialogueBudget,
      turns: next,
    });
    this.logger && this.logger.warn(`上下文超长，砍掉一半历史后重试（turns ${turns.length} → ${next.length}）`);
    return true;
  }

  /**
   * 流式生成回复文本片段（含演示模式）。
   */
  async completeChat(decision, { signal, system = decision.system, turns = decision.turns, accept = () => true } = {}) {
    const metadata = {};
    const text = await this.llm.complete({ system, turns, signal, purpose: 'chat', ...this.chatModelOptions(decision, metadata) });
    if (!accept(text)) return null;
    decision.generatedTitle = metadata.generatedTitle;
    decision.nativeLinkCalls = metadata.nativeLinkCalls;
    return text;
  }

  chatModelOptions(decision, metadata = decision) {
    const native = Boolean(this.llm.supportsWebSearch?.());
    if (!native) return { webSearch: false };
    const msg = decision.msg || {};
    const readUrl = Boolean(msg.nativeReadUrl);
    const date = this.now();
    const zone = time.resolveTimeZone(this.config);
    const day = time.dayKey(date.getTime(), zone);
    const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long', ...(zone ? { timeZone: zone } : {}) }).format(date);
    const place = features.isOn(this.config, 'envContext') ? envInfo.clampLocation(this.config.env?.location) : '';
    const platform = msg.platform === 'web' ? 'Web' : 'App';
    const title = msg.platform === 'web' && msg.chatType === 'private' && !this.store.ensureSession(decision.key).title;
    return {
      webSearch: !readUrl && !String(msg.webText || '').trim(), readUrl, safetyCheck: true, title,
      latestReminder: `${day},${weekday},${place},${platform},中文`,
      onTitle: value => { if (title) metadata.generatedTitle = value; },
      onWebSearch: ({ serverToolCalls }) => {
        if (!readUrl || msg.chatType === 'group' || !Array.isArray(serverToolCalls)) return;
        if (serverToolCalls.some(step => step.calls?.some(call => call.kind === 'read_link' && call.signature))
          && Buffer.byteLength(JSON.stringify(serverToolCalls)) <= 256 * 1024) metadata.nativeLinkCalls = serverToolCalls;
      },
    };
  }

  async *generate(decision, { signal } = {}) {
    if (decision.action === 'command') {
      yield decision.text;
      return;
    }
    if (decision.canned) {
      yield decision.canned;
      return;
    }
    if (decision.mock) {
      const text = decision.text || '';
      for (let i = 0; i < text.length; i += 2) {
        if (signal && signal.aborted) return;
        yield text.slice(i, i + 2);
        if (this.mockChunkDelayMs > 0) await sleep(this.mockChunkDelayMs);
      }
      return;
    }
    let retried = false;
    let sent = false;
    // 本轮从哪个 usage 水位开始：流式重试会再调一次模型，结束时按水位累加
    const usageMark = Number(this.llm && this.llm.usageSeq) || 0;
    // 流式请求可能还没吐字就报 context_length；此时可以安全地换半窗重试。
    // 已经吐过字就不能重试，否则用户会看到两段拼接的回复。
    while (true) {
      try {
        for await (const piece of this.llm.stream({ system: decision.system, turns: decision.turns, signal, purpose: 'chat', ...this.chatModelOptions(decision) })) {
          sent = true;
          yield piece;
        }
        break;
      } catch (err) {
        if (!sent && !retried && isContextLengthError(err) && this.shrinkTurnsForContext(decision)) {
          retried = true;
          continue;
        }
        throw err;
      }
    }
    this.recordUsage(decision, this.usageSince(usageMark));
  }

  /**
   * 这条回复要不要补一张表情包（实验性）。
   * 总闸关着直接返回 null，调用方不用判断。
   *
   * 分类优先用模型写的 [[sticker:分类]]；模型没写、但用户明确要表情包时，
   * 按原话里的分类名兜底（认不出就用有图的默认分类），避免“嘴上说发了、其实没发”。
   * @returns {{emotion: string, path: string}|null}
   */
  stickerFor(...args) { return stickerOps.stickerFor.call(this, ...args); }

  updateSeriousState(...args) { return stickerOps.updateSeriousState.call(this, ...args); }

  stickerDemandFor(...args) { return stickerOps.stickerDemandFor.call(this, ...args); }
  /**
   * 把模型写的 [[diary:日期]] 替换成日记原文。
   * 只有主人私聊允许读取；其他会话只把标记删掉，避免把日记泄露到群里。
   */
  expandDiaryMark(decision, text) {
    const msg = (decision && decision.msg) || {};
    const allowed = Boolean(this.diary && msg.isMaster && msg.chatType === 'private');
    return String(text == null ? '' : text).replace(/\[\[diary:([^\]]{1,32})\]\]/gi, (all, token) => {
      if (!allowed) return '';
      try {
        return this.diary.readForChat(String(token || '').trim()) || '（没找到那天的日记）';
      } catch {
        return '（没找到那天的日记）';
      }
    }).trim();
  }

  /**
   * 模型主动退场：只有群聊、且这条消息确实冲她说的（@ / 回复她 / 主人）才生效。
   * 时长夹在 1–60 分钟；写的是「延长」而不是覆盖，避免短请求把已有的长静默改短。
   */
  applyModelSilence(decision, minutes) {
    const msg = (decision && decision.msg) || {};
    if (!decision || decision.error || msg.chatType !== 'group') return false;
    if (!(msg.atMe || msg.replyToBot || msg.isMaster)) return false;
    const state = this.store.getState(decision.key);
    if (!state) return false;
    const mins = Math.max(1, Math.min(60, Math.round(Number(minutes) || 10)));
    const nowMs = this.now().getTime();
    state.silentUntil = Math.max(Number(state.silentUntil) || 0, nowMs + mins * 60000);
    state.dismissedAt = nowMs;
    sessionState.clearEngagement(state);
    this.store.markDirty();
    if (this.logger) this.logger.info(`[silence] 模型请求退场 ${mins} 分钟（来源=reply）`);
    return true;
  }

  activateReply(decision) {
    const turn = this._replyTurns.get(decision);
    if (!turn) return Boolean(decision?.key);
    if (turn.cancelled || decision.action === 'ignore') return false;
    if (!turn.lease || this._replyQuota.activate(turn.lease)) return true;
    const recent = recentReplyCount(this, { key: turn.key, state: turn.state, nowMs: this.now().getTime() });
    const admission = this._replyQuota.reserve(turn.key, recent, Number(this.config.group.maxRepliesPerMinute));
    if (admission.reason) {
      decision.reason = admission.reason;
      this.releaseReply(decision);
      return false;
    }
    turn.lease = admission.lease;
    return true;
  }

  releaseReply(decision) {
    const turn = this._replyTurns.get(decision);
    if (!turn || this._finalReplies.has(decision)) return;
    turn.cancelled = true;
    this._replyQuota.release(turn.lease);
    turn.detach();
  }

  /**
   * 生成失败时给用户看的统一文案。流式与非流式必须取同一句，否则两个入口的
   * done.text 和 handle().reply 会不一致（测试会直接比较两者）。
   */
  failureReply(err) {
    const errText = String((err && err.message) || '');
    const blocked = err?.code === 'refusal' || (/敏感|不安全|安全|内容/.test(errText) && /400/.test(errText));
    return blocked
      ? '这话我不敢接，换个说法'
      : (err instanceof LlmError ? err.userMessage : '呜…深海线路打结了，等会儿再来找人家嘛');
  }

  /** 生成或回复插件失败后的公共结果：落一条 error 回复并占用本轮配额。 */
  finishFailure(decision, err) {
    const reply = this.failureReply(err);
    const bubbles = this.finalize(decision, reply, { error: true });
    return { action: 'reply', reply: decision.finalText || reply, bubbles, reason: 'llm_error', error: true };
  }

  /**
   * 统一的「结果阶段」：插件改写 → 规范化/落库/配额提交。流式与非流式都走这里，
   * 保证两边拿到的是同一份最终正文与气泡。取消时返回 cancelled，不落库也不提交配额。
   */
  async finishReply(decision, text, { signal } = {}) {
    if (signal?.aborted) return { cancelled: true, text: '', bubbles: [] };
    let clean;
    try {
      clean = await this.transformPluginReply(decision, String(text == null ? '' : text).trim(), { signal });
    } catch (err) {
      // 断开导致的 abort 不是插件故障：不能让迟到结果变成一条错误回复并占用配额。
      if (signal?.aborted) return { cancelled: true, text: '', bubbles: [] };
      this.logger && this.logger.error('回复插件失败：' + describeError(err));
      return this.finishFailure(decision, err);
    }
    if (signal?.aborted) return { cancelled: true, text: '', bubbles: [] };
    clean = await this.applyBeforeSend(decision, clean, { signal });
    if (signal?.aborted) return { cancelled: true, text: '', bubbles: [] };
    const bubbles = this.finalize(decision, clean);
    // finalize 可能把正文清空（例如「米饭」在非吃饭话题里被整条丢弃），此时没有可发内容。
    // 拍一拍没有正文也算有效结果：交回 pat/patId，让网关去执行那一下。
    const pat = decision.pat ? { pat: true, ...(decision.patId ? { patId: decision.patId } : {}) } : {};
    if (!bubbles.length) return { text: '', bubbles, reason: decision.reason, ...pat };
    return { text: decision.finalText || clean, bubbles, reason: decision.reason, ...pat };
  }

  finalize(decision, text, options) {
    if (!decision?.key) return [];
    const previous = this._finalReplies.get(decision);
    if (previous) return [...previous];
    if (!this.activateReply(decision)) return [];
    const bubbles = this._guardGroupReply(decision, finalizer.finalize.call(this, decision, text, options));
    const turn = this._replyTurns.get(decision);
    if (bubbles.length) {
      this._replyQuota.commit(turn?.lease, decision.key);
      turn?.detach();
    } else this.releaseReply(decision);
    this._finalReplies.set(decision, [...bubbles]);
    return bubbles;
  }

  /**
   * 群聊输出兜底：返回最终应该公开/落库的正文（features.memoryV2 才启用）。
   *
   * 这里挡的不是「模型说了秘密」——秘密压根没进群聊上下文；挡的是模型把
   * 出处说出来（「你私聊跟我说过」）或漏出号码串。命中就整条换安全回复：
   * 少说一句远好过在群里解释。
   *
   * 关键：必须在落库和拆分气泡之前调用。只替换 bubbles 会让 handle().reply
   * 和 done.text 仍带原文，持久化也存原文——安全正文必须同时是唯一公开输出。
   */
  guardGroupText(decision, text) {
    const original = String(text == null ? '' : text);
    if (!decision || decision.action !== 'reply') return { text: original, leak: false };
    if (!features.isOn(this.config, 'memoryV2')) return { text: original, leak: false };
    const msg = decision.msg || {};
    if (!(msg.isGroup === true || msg.chatType === 'group')) return { text: original, leak: false };
    try {
      const result = memory.guardReply(original);
      if (!result.leak) return { text: original, leak: false };
      if (this.logger) {
        this.logger.warn(`[memory] 群聊回复命中输出校验（${result.reason}），整条替换为安全回复`);
      }
      return { text: memory.leakGuard.safeReply(), leak: true, reason: result.reason };
    } catch (err) {
      // 兜底本身失败时宁可放行原回复：不能因为校验器坏了让她不说话
      if (this.logger) this.logger.warn('[memory] 输出校验失败（放行原回复）：' + describeError(err));
      return { text: original, leak: false };
    }
  }

  _guardGroupReply(decision, bubbles) {
    if (!Array.isArray(bubbles) || !bubbles.length) return bubbles;
    const guarded = this.guardGroupText(decision, bubbles.join('\n'));
    if (!guarded.leak) return bubbles;
    bubbles.length = 0;
    bubbles.push(guarded.text);
    return bubbles;
  }

  /**
   * 非流式的完整处理，给微信网关用。
   * @param {{alreadyQueued?: boolean}} [options] alreadyQueued：调用方已经握着同一会话的队列
   *   （全接管的外层流程），此时直接跑本轮，避免二次排队把自己锁死。
   * @returns {{action: string, reply?: string, bubbles?: string[], reason: string, commandType?: string}}
   */
  async handle(rawMsg, { signal, localWechat = false, alreadyQueued = false } = {}) {
    const chainKey = this.sessionKey(this.normalize(rawMsg));
    if (alreadyQueued) return this._handleOnce(rawMsg, { signal, localWechat });
    return this.queueSession(chainKey, () => this._handleOnce(rawMsg, { signal, localWechat }));
  }

  /**
   * 同一会话串行、不同会话并发（M21）。
   *
   * 网关会并发调 handle，而 decide() 里多处 await 之间读改写共享 state，
   * 同会话两条消息并发处理会互相覆盖计数、双回复。全接管也要覆盖「插件调用 +
   * 宿主结果阶段」整段，否则两条消息的落库与配额提交可能乱序，所以队列放在这里共用。
   */
  queueSession(chainKey, run) {
    const prev = this._handleChains.get(chainKey) || Promise.resolve();
    const task = prev.then(run);
    // 链尾留在表里给后来者排队；跑完（成功或失败）把自己清掉，别把 Map 越攒越大
    const guard = task.then(() => null, () => null);
    this._handleChains.set(chainKey, guard);
    return task.finally(() => {
      if (this._handleChains.get(chainKey) === guard) this._handleChains.delete(chainKey);
    });
  }

  /**
   * 普通对话的搜索阶段。宿主内置实现同时作为 chat.search@1 的 builtin：
   * 没有插件声明该能力时直接调用，避免每条普通消息都排进插件的按会话队列。
   */
  async searchForChat(input) {
    if (this.llm.supportsWebSearch?.()) return { text: '', items: [], status: 'empty' };
    const message = input.message;
    const key = this.sessionKey(message);
    const result = await searchService.search({
      text: message.text,
      history: () => this.recentHeard({ msg: message, key }).filter(line => line !== message.text),
      llm: this.llm, config: this.config.websearch || {}, dataDir: this.config.paths?.dataDir || 'data',
      now: this.now(), timeZone: time.resolveTimeZone(this.config),
      trace: (stage, data) => this.logger?.info('[search] stage=' + stage + ' ' + JSON.stringify(data)),
    });
    return { text: String(result?.text || ''), items: (result?.items || []).slice(0, 30).map(item => ({
      title: String(item.title || ''), url: String(item.url || ''), snippet: String(item.snippet || item.text || ''),
      publishedAt: item.publishedAt || null, fetchedAt: item.fetchedAt || null,
    })), status: ['ok', 'empty', 'failed'].includes(result?.status) ? result.status : 'failed' };
  }

  /** 读一个链接并记账；失败也返回一句说明，绝不把异常抛给主流程 */
  async readLink(url, key) {
    const controller = new AbortController();
    const budget = Math.max(1, Math.min(60000, Number(this.config.links?.timeoutMs) || 6000));
    let timer;
    try {
      this.logger?.info(`[link] stage=start host=${urlHost(url)} budgetMs=${budget}`);
      const info = await Promise.race([
        Promise.resolve().then(() => this.linkReader(url, { signal: controller.signal })),
        new Promise(resolve => { timer = setTimeout(() => {
          resolve({ ok: false, url, error: 'timeout' });
          controller.abort();
        }, budget); }),
      ]);
      const text = links.formatForPrompt(info);
      this.logger && this.logger.info(`读取链接：host=${urlHost(url)} → ${info && info.ok ? 'ok' : (info && info.error) || 'failed'}`);
      const title = String((info && (info.title || info.site)) || '').slice(0, 60);
      this.store.appendEvent(key, {
        type: 'link',
        detail: title ? `${url.slice(0, 80)} → ${title}` : url.slice(0, 120),
        status: info && info.ok ? 'ok' : 'failed',
      });
      return text;
    } catch (err) {
      this.logger && this.logger.warn('读取链接失败：' + describeError(err));
      try { this.store.appendEvent(key, { type: 'link', detail: url.slice(0, 120), status: 'failed' }); }
      catch (recordErr) { this.logger?.warn('链接失败记录未写入：' + describeError(recordErr)); }
      return `对方发了一个链接（${url}），但读取失败。`;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /** handle 的实际处理体，由 handle() 按会话串行调用（不同会话仍然并发） */
  async _handleOnce(rawMsg, { signal, localWechat } = {}) {
    // 私聊「拍拍我」是明确动作，不需要过模型：直接让桥接拍一下。
    // 群聊不主动拍：微信只能按「最近一条好友消息的头像」拍，群里容易拍错人。
    const early = this.normalize(rawMsg);
    const patEnabled = features.isOn(this.config, 'pat');
    if (localWechat && early.platform === 'wechat' && early.chatType === 'private'
        && patEnabled
        && PAT_COMMAND_RE.test(early.text.trim())) {
      this.logger?.info('[pat] 私聊收到拍一拍请求，直接回拍');
      return { action: 'pat', pat: true, patId: this.reservePat(early), reason: 'pat_command' };
    }
    // 别人拍她：回不回话、回不回拍由设置页（/pat）的概率决定；
    // 群聊只回话、不主动拍（微信只能按最近一条好友消息的头像拍，容易拍错人）。
    const patReceived = localWechat && early.platform === 'wechat'
      && early.pat === true && patEnabled;
    let patPlan = null;
    if (patReceived) {
      patPlan = this.planPatReply(early);
      if (!patPlan.text) {
        if (patPlan.back) {
          this.logger?.info('[pat] 按设置这次只回拍、不生成长文');
          return { action: 'pat', pat: true, patId: this.reservePat(early), reason: 'pat_back_only' };
        }
        this.logger?.info('[pat] 按设置这次不回应拍一拍');
        return { action: 'ignore', reason: 'pat_skipped_by_chance' };
      }
    }
    let decision;
    try {
      decision = await this.decide(rawMsg, { signal, localWechat });
    } catch (err) {
      // 断线导致的 abort 不是处理故障：decide 里的插件分发/搜索会以
      // capability_aborted 抛出，这里按取消收尾，不记错误日志、也不回任何东西。
      if (signal?.aborted) return { action: 'ignore', reason: 'cancelled' };
      // 结构证据 + 堆栈：光看 stack 只能知道哪一行，不知道是配额、磁盘还是网络
      this.logger && this.logger.error('处理消息出错：' + describeError(err) + '\n' + ((err && err.stack) || ''));
      return { action: 'ignore', reason: 'error' };
    }
    if (decision.action === 'ignore') {
      this.logger?.info('[pipeline] result=skip reason=' + String(decision.reason || 'unspecified') + ' search=not_reached delivery=not_reached');
      void this.observeDispatched(decision, { action: 'ignore', sent: false, reason: decision.reason });
      this.markDispatchedIgnore(decision.msg);
      try { this.store.checkpoint(decision.key); } catch { /* 忽略的消息也要留断点 */ }
      // 模型这一轮不接（静音/配额/没接住）时，只要有回拍额度，就把这一下拍回去。
      if (patPlan && patPlan.back) {
        this.logger?.info('[pat] 这一轮只回拍不接话');
        return { action: 'pat', pat: true, patId: this.reservePat(early), reason: 'pat_back_only' };
      }
      const result = { action: 'ignore', reason: decision.reason };
      // app 层网关还会观察 sendDenial 等 ignore；这个标记只是给同进程测试/旧调用方看的防御。
      Object.defineProperty(result, '__pluginDispatched', { value: true, enumerable: false });
      return result;
    }
    if (patPlan && patPlan.back) {
      // 概率命中就回拍，不再依赖模型是否写了 [[pat]]；正文照常由模型生成（空了就只拍）。
      decision.pat = true;
      if (!decision.patId) decision.patId = this.reservePat(early);
      this.logger?.info('[pat] 收到拍一拍：回话 + 回拍');
    } else if (patPlan) {
      this.logger?.info('[pat] 收到拍一拍：只回话（按设置不回拍）');
    }
    if (signal?.aborted || !this.activateReply(decision)) {
      this.releaseReply(decision);
      return { action: 'ignore', reason: signal?.aborted ? 'cancelled' : decision.reason };
    }
    try {
      return await this._handleReply(decision, { signal, localWechat });
    } finally {
      this.releaseReply(decision);
    }
  }

  async _handleReply(decision, { signal, localWechat }) {
    if (decision.action === 'command') {
      const text = await this.applyBeforeSend(decision, decision.text, { signal });
      const bubbles = this.finalize(decision, text);
      return { action: 'reply', reply: text, bubbles, reason: 'command', commandType: decision.commandType };
    }
    // 私聊的直接请求由程序处理，避免模型漏写标记或误报已送达。
    const msg = decision.msg;
    const stickerRequest = localWechat && msg?.platform === 'wechat' && msg.chatType === 'private'
      && stickers.isOn(this.config)
      && /^(?:请|麻烦)?\s*(?:给我|帮我)?\s*(?:发(?:给我)?|来|甩|丢)\s*(?:一?[个张]|点)?\s*(?:(傲娇|炸毛|开心)(?:的)?\s*)?(?:表情包|表情|动图|贴纸|梗图)(?:吧|呗|嘛|呀|啊|吗)?[\s。！!？?~～]*$/.exec(String(msg.text || '').trim());
    if (stickerRequest) {
      const sticker = this.stickerFor({ msg, stickerCategory: stickerRequest[1] });
      const reply = sticker ? '给你挑了一张' : '这次没能排上表情包，可能没图或上一张还在发送';
      const text = await this.applyBeforeSend(decision, reply, { signal });
      const bubbles = this.finalize(decision, text);
      return { action: 'reply', reply: text, bubbles, reason: 'sticker_request', ...(sticker ? { sticker } : {}) };
    }
    let text = '';
    // 本轮从哪个 usage 水位开始：复读重写 / 半窗 / 降级重试都会再调一次模型，
    // 结束时按水位累加，只记最后一次会把前几次的钱漏掉。
    const usageMark = Number(this.llm && this.llm.usageSeq) || 0;
    try {
      if (decision.canned) {
        text = decision.canned;
      } else if (decision.mock) {
        text = decision.text;
      } else {
        text = await this.completeChat(decision, { signal });
        // 模型有时候只会把别人说过的话复读一遍，或者重复自己上一句，这种重写一次
        const heardList = this.recentHeard(decision);
        const ownList = this.recentOwn(decision);
        decision.heardList = heardList;
        decision.ownList = ownList;
        const repeatsSomeone = heardList.some((h) => isEcho(text, h));
        const repeatsSelf = ownList.some((h) => isEcho(text, h));
        if (repeatsSomeone || repeatsSelf) {
          const why = repeatsSelf ? '在重复你自己刚才说过的话' : '在复读别人的话';
          this.logger && this.logger.warn('回复' + why + '，重写一次：' + textMeta(text));
          try {
            const retry = await this.completeChat(decision, {
              system: decision.system + '\n\n【重写要求】你刚才的回答' + why + '，不合格。现在重写：换一个说法，给出新的信息或明确态度；不能出现对方原句，也不能重复你上面说过的话。',
              turns: decision.turns,
              signal,
              accept: value => Boolean(value && !heardList.some(h => isEcho(value, h)) && !ownList.some(h => isEcho(value, h))),
             });
            // 只有重写合格才采用（M18）：以前不合格时 `else text = retry || text` 照样把
            // 还在复读的 retry 发出去，这道校验形同虚设；不合格就保留原文，finalize 里
            // 还有第二道 echo 兜底。
            if (retry) text = retry;
          } catch { /* 重写失败就沿用原文，后面还有兜底 */ }
        }
      }
    } catch (err) {
      if (signal?.aborted) return { action: 'ignore', reason: 'cancelled' };
      // （errText 以前叫 rawMsg，把 handle 的入参 rawMsg 遮蔽了（L12），改个名）
      const errText = String((err && err.message) || '');
      const blocked = err?.code === 'refusal' || (/敏感|不安全|安全|内容/.test(errText) && /400/.test(errText));
      // 带上模型和结构证据：光一句「生成回复失败」分不清是额度、超长、审核还是空响应
      this.logger && this.logger.error(
        `生成回复失败 [${(this.llm && this.llm.provider) || '?'}|${(this.llm && this.llm.model) || '?'}]：${describeError(err)}`
      );
      let retried = null;
      // 上下文超长：砍掉一半 turns 只重试一次，保留当前消息；不要退化成只发当前一句。
      if (isContextLengthError(err) && this.shrinkTurnsForContext(decision)) {
        try {
          retried = await this.completeChat(decision, { signal });
          this.logger && this.logger.warn('上下文超长，半窗重试成功');
        } catch (err2) {
          this.logger && this.logger.error('半窗重试仍失败：' + describeError(err2));
        }
      }
      // 钥匙失效 / 额度用完（429）/ 模型名不可用（404）→ 切到存过 Key 的备用服务商再试一次。
      // 千问的 qwen-turbo 免费额度经常先耗尽，用户会以为「Key 不能用」，这里直接兜住。
      const canFallback =
        /401|invalid|api key|Unauthorized|密钥|令牌/i.test(errText) ||
        /\b429\b|rate.?limit|exceeded your current request limit/i.test(errText) ||
        (/\b404\b/.test(errText) && /model/i.test(errText));
      if (!retried && canFallback && !blocked && !this.llm.supportsWebSearch?.() && typeof this.llm.switchFallback === 'function') {
        const switched = this.llm.switchFallback();
        if (switched) {
          try {
            retried = await this.completeChat(decision, { signal });
            this.logger && this.logger.warn(`已切到备用服务商 ${switched.label} 并重试成功`);
          } catch (err2) {
            this.logger && this.logger.error('备用服务商也失败了：' + describeError(err2));
          }
        }
      }
      if (!retried && blocked && err?.code !== 'refusal' && !this.llm.supportsWebSearch?.()) {
        try {
          const sys = sanitizeForModel(decision.system || '');
          const cur = sanitizeForModel((decision.msg && (decision.msg.cleanText || decision.msg.text)) || '');
          retried = await this.completeChat(decision, { system: sys, turns: cur ? [{ role: 'user', content: cur }] : [], signal });
          this.logger && this.logger.warn('内容审核拦截，已丢掉历史用精简上下文重试成功');
        } catch (err2) {
          this.logger && this.logger.error('精简重试仍失败：' + describeError(err2));
        }
      }
      if (signal?.aborted) return { action: 'ignore', reason: 'cancelled' };
      if (retried) {
        text = retried;
      } else {
        return this.finishFailure(decision, err);
      }
    }
    if (signal?.aborted) return { action: 'ignore', reason: 'cancelled' };
    text = String(text == null ? '' : text).trim();
    this.recordUsage(decision, this.usageSince(usageMark));
    const finished = await this.finishReply(decision, text, { signal });
    if (finished.cancelled) return { action: 'ignore', reason: 'cancelled' };
    if (finished.error) return finished;
    // 这一轮只有拍一拍、没有可发正文：直接交给网关执行，不要退化成空回复。
    // 有正文时照常回话，pat/patId 由下面的 payload 一起带出去。
    if (finished.pat && !finished.bubbles.length) {
      return { action: 'pat', pat: true, ...(finished.patId ? { patId: finished.patId } : {}),
        bubbles: [], reason: finished.reason || 'pat' };
    }
    if (!finished.bubbles.length) return { action: 'ignore', reason: 'empty_reply' };
    const bubbles = finished.bubbles;
    // 群里回复开头带 @名字时，交给桥接做真 @。
    const finalText = finished.text;
    const atMatch = finalText.match(/^@\s*([^\s，,：:！!？?。]+)/);
    const mention = atMatch ? atMatch[1] : '';
    return {
      action: 'reply',
      reply: finalText,
      bubbles,
      mention: decision.msg && decision.msg.chatType === 'group' ? mention : '',
      reason: decision.reason,
      mock: decision.mock,
      ...(decision.pat ? { pat: true } : {}),
      ...(decision.pat && decision.patId ? { patId: decision.patId } : {}),
      ...(decision.separateText ? { separateText: true } : {}),
      // 表情包分类由模型写在正文里的标记决定，这里带出去给网关排队
      ...(decision.stickerCategory ? { stickerCategory: decision.stickerCategory } : {}),
      // 这一轮是否命中“提醒带一张”；网关用它决定 ensureSend 要不要补图
      ...(decision.msg && decision.msg.stickerDemand ? { stickerDemand: true } : {}),
    };
  }

  /**
   * 一轮结束：把这一轮所有模型调用的 usage 换算成「本轮用量」写到 bot.lastUsage，并打一条 INFO。
   * 复读重写 / 上下文半窗 / 降级重试都会再调一次模型，这里拿的是总和，不是最后一次。
   * 估算走 calibration 按 provider|model 学到的 scale；演示模式、固定话术、接口没回 usage 时不动。
   */
  recordUsage(...args) { return usage.recordUsage.call(this, ...args); }

  describeUsage(...args) { return usage.describeUsage.call(this, ...args); }

  _newUsage(...args) { return usage._newUsage.call(this, ...args); }

  _addUsage(...args) { return usage._addUsage.call(this, ...args); }

  usageSince(...args) { return usage.usageSince.call(this, ...args); }
  /** 切换 API Key 后调用 */
  reload() {
    if (this.llm && this.llm.reload) this.llm.reload();
  }

  stats() {
    return {
      ...this.store.summary(),
      mock: this.llm.isMock,
      model: this.llm.model,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}

module.exports = { Bot, isContextLengthError, momentsIntent, PAT_COMMAND_RE };

