'use strict';

/**
 * 记忆 v2 的门面（对外仍是 Store，调用方不用大改）。
 *
 * 数据落在 data/memory/chats/<chatHash>/；每个 chat 物理隔离。
 * 这层负责把「消息 / 人物卡 / episode / 压缩 / 检索」串起来，
 * 并把旧 API（messages/profile/addNote/setSummary/state/events）映射到新结构。
 */
const fs = require('node:fs');
const path = require('node:path');
const { ChatStore } = require('./chatStore');
const personCard = require('./personCard');
const episode = require('./episode');
const compression = require('./compression');
const retrieval = require('./retrieval');
const search = require('./search');
const scope = require('./scope');
const sharedStore = require('./sharedStore');
const record = require('./record');
const recordStore = require('./recordStore');
const format = require('./format');
const extractor = require('./extractor');
const formatVersion = require('./formatVersion');
const budgetPlan = require('./budgetPlan');
const relations = require('./relations');
const { LIMITS, DAY_MS } = require('./constants');
const { estimateTokens, estimateBudgetTokens } = require('./tokens');
const { describeError } = require('../infra/errors');
const { readJson, readJournal } = require('../infra/jsonFile');

/* ------------------------------ 旧文件读取（兼容工具） ------------------------------ */

/** 旧版 store.json + journal 的合并读取；v2 不再写这个文件，只给迁移/工具用 */
function readStoreFile(file) {
  const snap = readJson(file) || {};
  const base = {
    version: snap.version || 1,
    savedAt: snap.savedAt || null,
    stats: Object.assign({ messages: 0, replies: 0 }, snap.stats || {}),
    digest: Array.isArray(snap.digest) ? snap.digest.slice(-800) : [],
    sessions: snap.sessions && typeof snap.sessions === 'object' ? { ...snap.sessions } : {},
  };
  for (const entry of readJournal(file)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.full) base.sessions = entry.sessions && typeof entry.sessions === 'object' ? { ...entry.sessions } : {};
    else if (entry.sessions && typeof entry.sessions === 'object') Object.assign(base.sessions, entry.sessions);
    if (Array.isArray(entry.removed)) for (const key of entry.removed) delete base.sessions[key];
  }
  return base;
}

/* ------------------------------ 工具 ------------------------------ */

function trimText(value, max = 2000) {
  const s = String(value == null ? '' : value).replace(/\u0000/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function importanceToConfidence(importance) {
  const n = Number(importance);
  if (!Number.isFinite(n)) return 0.75;
  if (n >= 3) return 0.95;
  if (n <= 1) return 0.7;
  return 0.85;
}

function activePreferenceTexts(card) {
  return personCard.activePreferences(card).map((p) => p.text);
}

class Store {
  constructor({ file, dir, limits = {}, logger = null, now = Date.now, llm = null, formatVersionEnforced = false } = {}) {
    this.file = file || path.resolve(process.cwd(), 'data', 'store.json');
    this.memoryDir = dir || path.join(path.dirname(this.file), 'memory');
    this.logger = logger;
    this.nowFn = typeof now === 'function' ? now : () => now;
    this.llm = llm;
    this.limits = {
      maxSessions: Number(limits.maxSessions) || 200,
      maxMessages: Number(limits.maxMessages) || LIMITS.maxMessagesPerChat,
      maxNotesPerUser: Number(limits.maxNotesPerUser) || LIMITS.maxPreferencesPerPerson,
      // 对话预算由 config.memory.dialogueBudget 传入（app.js 就是这么传的），没传就用默认 5,500。
      // 分片（recent / memory / summary / reserve / relations）全部由 budgetPlan 按比例算出来，
      // 这里只保存用户可调的那一个数。
      dialogueBudget: Number(limits.dialogueBudget) || LIMITS.dialogueBudget,
      relationsEnabled: limits.relationsEnabled === true || limits.relationsEnabled === 'true',
    };
    // 预算分片：唯一事实源，见 src/memory/budgetPlan.js
    this.plan = budgetPlan.planBudget(this.limits.dialogueBudget, { relations: this.limits.relationsEnabled });
    this.sessions = new Map();
    this.digest = [];
    this.stats = { messages: 0, replies: 0 };
    this._background = new Set();
    // 格式闸：只认当前格式，不认识的版本直接拒绝启动。
    // 必须放在 ChatStore 构造之前 —— 它初始化时会重写 manifest，把 formatVersion 抹掉，
    // 之后就再也判断不出「这个目录本来是旧格式」。
    //
    // 旧版这里会在构造时顺手跑一次自动导入。那等于让旧格式永远活着：
    // 每次启动都跑一遍导入、还要留一份 legacy 只读副本。现在导入搬到了
    // scripts/migrate-memory.js（一次性、离线、跑完就删旧文件），
    // src/ 里不再有任何迁移代码。
    if (formatVersionEnforced) {
      const gate = formatVersion.check({ dir: this.memoryDir });
      if (!gate.ok) throw gate.error;
    }
    this.chatStore = new ChatStore({
      dir: this.memoryDir, logger, now: () => this._now(),
      maxMessages: this.limits.maxMessages,
    });
    this._syncSessions();
  }

  _now() {
    const v = this.nowFn();
    return v instanceof Date ? v.getTime() : Number(v) || Date.now();
  }

  _syncSessions() {
    this.sessions.clear();
    for (const chat of this.chatStore.chats.values()) this.sessions.set(chat.chatId, this._view(chat));
  }

  _view(chat) {
    const view = {
      key: chat.chatId,
      platform: chat.platform,
      chatId: chat.chatId,
      chatType: chat.chatType,
      title: chat.title,
      createdAt: chat.createdAt,
      lastActiveAt: chat.lastActiveAt,
    };
    Object.defineProperty(view, 'messages', { enumerable: true, get: () => chat.messages });
    Object.defineProperty(view, 'profiles', {
      enumerable: true,
      get: () => {
        const out = {};
        for (const registry of chat.people.values()) {
          // 记忆正文在记录里，名册只有 uid/name：物化后合并，别让 UI 看到空卡
          const card = this.chatStore.getCard(chat, registry.uid);
          out[registry.uid] = this._profileView({ ...registry, ...(card || {}), uid: registry.uid });
        }
        return out;
      },
    });
    Object.defineProperty(view, 'state', { enumerable: true, get: () => chat.meta.state });
    Object.defineProperty(view, 'seenIds', { enumerable: true, get: () => chat.meta.seenIds });
    Object.defineProperty(view, 'events', { enumerable: true, get: () => chat.meta.events });
    Object.defineProperty(view, 'summary', { enumerable: true, get: () => chat.summary.text || undefined });
    Object.defineProperty(view, 'summaryUpto', { enumerable: true, get: () => chat.summary.coveredThroughSeq });
    return view;
  }

  _profileView(card) {
    return {
      uid: card.uid,
      name: card.name,
      nickname: card.nickname,
      firstSeenAt: card.firstSeenAt,
      lastSeenAt: card.lastSeenAt,
      count: card.count,
      notes: personCard.activePreferences(card).map(personCard.preferenceToNote),
      traitCount: personCard.activeTraits(card).length,
      eventCount: personCard.activeEvents(card).length,
      threadCount: personCard.openThreads(card).length,
    };
  }

  /* ------------------------------ 会话 ------------------------------ */

  ensureSession(key, meta = {}) {
    const chatId = String(key || 'default').slice(0, 240);
    const chat = this.chatStore.ensureChat(chatId, meta);
    if (!this.sessions.has(chatId)) this.sessions.set(chatId, this._view(chat));
    else if (meta.title && !chat.title) chat.title = String(meta.title).slice(0, 60);
    return this.sessions.get(chatId);
  }

  setGeneratedTitle(key, value) {
    const title = String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60);
    if (!title) return;
    const chat = this.chatStore.ensureChat(key);
    if (chat.title || chat.platform !== 'web' || chat.chatType !== 'private') return;
    chat.title = title;
    this.sessions.set(chat.chatId, this._view(chat));
    this.chatStore.saveMeta(chat, { immediate: true });
  }

  getState(key) {
    return this.ensureSession(key).state;
  }

  isDuplicate(key, msgId) {
    if (!msgId) return false;
    return this.ensureSession(key).seenIds.includes(String(msgId));
  }

  markSeen(key, msgId) {
    if (!msgId) return;
    const chat = this.chatStore.ensureChat(key);
    const id = String(msgId);
    if (!chat.meta.seenIds.includes(id)) {
      chat.meta.seenIds.push(id);
      if (chat.meta.seenIds.length > 500) chat.meta.seenIds = chat.meta.seenIds.slice(-500);
      this.chatStore.saveMeta(chat, { immediate: true });
    }
  }

  redactLastMessage(key, replacement = '（已隐藏）') {
    const chat = this.chatStore.ensureChat(key);
    return this.chatStore.redactLast(chat, replacement);
  }

  /* ------------------------------ 消息 ------------------------------ */

  appendMessage(key, message = {}) {
    const chat = this.chatStore.ensureChat(key);
    const at = Number(message.ts) || this._now();
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (role === 'user' && message.text) {
      episode.ensureEpisode(chat, { now: at });
      const rotation = episode.rotateIfNeeded({
        chat,
        text: String(message.text || ''),
        now: at,
        chatStore: this.chatStore,
        llm: this.llm,
        logger: this.logger,
      });
      if (rotation && rotation.promise) this._track(rotation.promise);
    }
    const entry = this.chatStore.appendMessage(chat, {
      ...message,
      role,
      ts: at,
    });
    // 消息和去重 id 一起落盘：崩溃后重启不会把同一条再回一遍
    if (entry.msgId) this.markSeen(key, entry.msgId);
    episode.touchEpisode(chat, entry, { now: at });
    if (role === 'user') {
      this._onUserMessage(chat, entry);
      // 关系边：规则即时（「我和小明是同事」这种），不调模型、不建卡
      this._onRelationMention(chat, entry);
    }
    // 直接关停/断电也不能把 episode 水位、seenIds、stats 丢在 400ms 防抖里：
    // 原文已经 fsync，这里同步写 meta（每轮 1 次，很小的文件）。
    this.chatStore.saveMeta(chat, { immediate: true });
    return entry;
  }

  /** 记录是唯一事实源：事实写进这个人的 subjects，不再写人物卡 */
  _writeFacts(chat, uid, facts, entry) {
    const id = String(uid || '');
    if (!id || !Array.isArray(facts) || !facts.length) return;
    const existing = recordStore.readSubjects(this.memoryDir, id);
    const byId = new Map(existing.map((r) => [r.id, r]));
    for (const fact of facts) {
      const item = record.makeRecord({
        kind: 'preference',
        text: fact.text,
        ts: entry.ts,
        tier: 'L',
        scope: `chat:${chat.hash}`,
        subject: id,
        source: { chatId: chat.chatId, messageIds: [entry.id] },
        confidence: fact.confidence,
        meta: { key: fact.key || '', tag: fact.kind || 'fact', explicit: true },
      });
      if (!item) continue;
      // 同义自述去重：同一个 key（比如 name / city）或同一句话，只更新不新增。
      // 记录 id 含消息 id，所以「同一句话发两遍」会得到两个 id —— 必须在这里按内容合并。
      const textKey = personCard.normalizeText(item.text);
      const dup = [...byId.values()].find((r) => r.state === 'active'
        && ((item.meta.key && r.meta && r.meta.key === item.meta.key)
          || (textKey && personCard.normalizeText(r.text) === textKey)));
      if (dup) {
        byId.set(dup.id, {
          ...dup,
          confidence: Math.max(Number(dup.confidence) || 0, Number(item.confidence) || 0),
          hits: (Number(dup.hits) || 0) + 1,
          meta: { ...(dup.meta || {}), ...(item.meta || {}), lastMentionedAt: entry.ts },
        });
        continue;
      }
      const old = byId.get(item.id);
      byId.set(item.id, old ? { ...old, ...item, hits: old.hits || 0, ts: old.ts } : item);
    }
    const capped = record.capByKind([...byId.values()], {
      caps: { preference: LIMITS.maxPreferencesPerPerson, fact: LIMITS.maxPreferencesPerPerson },
      now: entry.ts,
    });
    recordStore.writeSubjects(this.memoryDir, id, capped);
    this.chatStore.markRecordsDirty(chat);
  }

  /** 中期记录（摘要 / 事件 / 关系）只追加到 timeline */
  _appendTimeline(chat, records) {
    const list = (Array.isArray(records) ? records : []).filter(Boolean);
    if (!list.length) return 0;
    const n = recordStore.appendTimeline(chat.dir, list);
    this.chatStore.markRecordsDirty(chat);
    return n;
  }

  _onUserMessage(chat, entry) {
    if (!entry.uid || !entry.text) return;
    // 人物卡退化成名册：这里只登记「这个 chat 出现过这个人」，记忆内容一律写记录
    this.chatStore.ensurePerson(chat, entry.uid, entry.name);
    try {
      const { facts } = extractor.extractSelfFacts(entry.text, { msgId: entry.id, now: entry.ts });
      if (facts.length) {
        this._writeFacts(chat, entry.uid, facts, entry);
        // 人生事件：即时补一条中期事件
        for (const fact of facts) {
          if (!String(fact.key || '').startsWith('life:')) continue;
          this._appendTimeline(chat, [record.makeRecord({
            kind: 'event',
            tier: 'M',
            text: trimText(entry.text, 150),
            ts: entry.ts,
            scope: `chat:${chat.hash}`,
            subject: entry.uid,
            source: { chatId: chat.chatId, messageIds: [entry.id] },
            confidence: 0.8,
            importance: 0.65,
            meta: {
              date: personCard.dateString(entry.ts),
              title: trimText(entry.text, 20),
              summary: trimText(entry.text, 150),
              keywords: [],
              participants: [entry.uid],
            },
          })]);
        }
      }
    } catch (err) {
      if (err && err.code === 'MEMORY_CHAT_MISMATCH') throw err;
      if (this.logger) this.logger.warn('自述抽取失败（不影响聊天）：' + describeError(err));
    }

    // 连续 20 条 user 消息：轻量候选，只写偏好，不写 L2
    if (chat.meta.stats.userMessagesSinceExtract >= LIMITS.factExtractEveryUserMessages) {
      try {
        const last = chat.messages.filter((m) => m.role === 'user').slice(-LIMITS.factExtractEveryUserMessages);
        const candidates = extractor.lightweightCandidates(last, { now: entry.ts });
        const byUid = new Map();
        for (const c of candidates) {
          if (!c.uid) continue;
          if (!byUid.has(c.uid)) byUid.set(c.uid, []);
          byUid.get(c.uid).push(c);
        }
        for (const [uid, list] of byUid) {
          this.chatStore.ensurePerson(chat, uid, list[0].name);
          this._writeFacts(chat, uid, list, entry);
        }
        chat.meta.stats.userMessagesSinceExtract = 0;
      } catch (err) {
        if (this.logger) this.logger.warn('轻量抽取失败（不影响聊天）：' + describeError(err));
      }
    }

    // 软阈值：后台准备一块摘要，不删消息、不阻塞回复（阈值随预算走）
    if (this.llm && !this.llm.isMock && !chat.softPreparing) {
      const currentSeq = chat.meta.nextSeq;
      if (compression.recentTokens(chat, { currentSeq }) >= this.plan.recentSoft) {
        chat.softPreparing = true;
        const task = compression.prepareSoft(chat, {
          currentSeq,
          llm: this.llm,
          logger: this.logger,
          now: entry.ts,
          softTrigger: this.plan.recentSoft,
          compressChunk: this.plan.compressChunk,
        })
          .catch(() => false)
          .then(() => { chat.softPreparing = false; });
        this._track(Promise.resolve(task));
      }
    }
  }

  /**
   * 规则即时关系边：只处理「说话人自己说出来的」关系（三句式，见 relations.fromMessage）。
   * 目标名在本群最近 200 条里查得到 uid 才建边；查不到只保留 bName，不建卡、不编 uid。
   * 跨群写入照常抛 MEMORY_CHAT_MISMATCH（隔离红线），其余失败只记日志、不影响聊天。
   */
  _onRelationMention(chat, entry) {
    if (!entry || !entry.uid || !entry.text) return;
    try {
      const drafts = relations.fromMessage(entry.text, {
        uid: entry.uid,
        name: entry.name,
        msgId: entry.id,
        now: entry.ts,
      });
      if (!drafts.length) return;
      chat.meta.relations = chat.meta.relations || [];
      let touched = false;
      for (const draft of drafts) {
        const targetUid = relations.resolveName(chat, draft.bName);
        if (!targetUid || String(targetUid) === String(entry.uid)) continue;
        const edge = relations.upsert(chat.meta.relations, {
          a: entry.uid,
          b: targetUid,
          text: draft.text,
          confidence: draft.confidence,
          source: { chatId: chat.chatId, messageIds: draft.source.messageIds },
        }, { chatId: chat.chatId, now: entry.ts });
        if (edge) touched = true;
      }
      // appendMessage 收尾会 immediate 写一次 meta，这里只标脏，不额外落盘
      if (touched) this.chatStore.saveMeta(chat);
    } catch (err) {
      if (err && err.code === 'MEMORY_CHAT_MISMATCH') throw err;
      if (this.logger) this.logger.warn('关系边抽取失败（不影响聊天）：' + describeError(err));
    }
  }

  _track(promise) {
    this._background.add(promise);
    Promise.resolve(promise).catch(() => {}).then(() => this._background.delete(promise));
  }

  messages(key, limit = 24) {
    const chat = this.chatStore.ensureChat(key);
    return chat.messages.slice(-Math.max(0, Number(limit) || 0));
  }

  recentCareMessages(key, limit = 3) {
    const chat = this.chatStore.ensureChat(key);
    const count = Math.max(0, Math.min(10, Number(limit) || 0));
    if (!count) return [];
    return chat.messages
      .filter((message) => message.role === 'assistant'
        && typeof message.msgId === 'string'
        && message.msgId.startsWith('care:')
        && message.text)
      .slice(-count);
  }

  /**
   * 每个 chat 的档案索引（懒建 + 按「消息数 + 最后 seq」失效）。
   *
   * 不缓存的话，开着档案召回时每轮都要重切 400 块再建倒排，实测 ~20ms，
   * 全部花在同一份没变的数据上。消息一追加缓存就自动失效，不需要手动清。
   */
  _archiveIndex(key) {
    const chat = this.chatStore.ensureChat(key);
    if (!chat) return null;
    const last = chat.messages[chat.messages.length - 1] || {};
    const stamp = `${chat.messages.length}:${last.seq || 0}`;
    if (!this._archiveCache) this._archiveCache = new Map();
    const hit = this._archiveCache.get(key);
    if (hit && hit.stamp === stamp) return hit.index;
    const chunks = search.buildChunks(chat.messages, { chatId: chat.chatId });
    const index = search.buildIndex(chunks);
    this._archiveCache.set(key, { stamp, index });
    // 只留最近 16 个会话，别把几千个群的索引都揣在内存里
    if (this._archiveCache.size > 16) {
      const oldest = this._archiveCache.keys().next().value;
      this._archiveCache.delete(oldest);
    }
    return index;
  }

  /**
   * 长期档案检索：在原文分块上跑 BM25（不需要 embedding）。
   *
   * 这是补「掉出 recent 窗口就永久失联」那个缺口的最小实现：读路径以前只看
   * recent / 摘要 / 事件卡，messages.jsonl 里几千条原文根本没人搜。
   * 纯读取，不改任何状态；要不要塞进 prompt 由调用方决定。
   *
   * @param {string} key chatId
   * @param {string} query 当前消息
   * @param {{topK?:number}} [opts]
   * @returns {Array<{chunk:object, score:number}>}
   */
  searchArchive(key, query, { topK = 3 } = {}) {
    if (!query) return [];
    const index = this._archiveIndex(key);
    if (!index) return [];
    return search.search(index, query, { topK });
  }

  /**
   * 这一轮的可见性上下文。
   *
   * 群聊必须带成员名单：跨会话的公开事实只有在当事人「也在场」时才注入，
   * 否则小明的口味会出现在他根本不在的群里 —— 那比泄漏更让人不适。
   * 名单来自本 chat 已建卡的人；宁可少注入，不猜。
   */
  audienceOf(key, { uid = '', isGroup = false } = {}) {
    const chat = this.chatStore.ensureChat(key);
    const roster = new Set();
    if (chat) {
      for (const card of chat.people.values()) {
        if (card && card.uid) roster.add(String(card.uid));
      }
    }
    return scope.buildAudience({
      chatHash: chat ? chat.hash : '',
      isGroup: isGroup === true,
      uid,
      roster,
    });
  }

  /** 把「名字」解析成本群里的 uid：只认本 chat 已有的卡，不跨群查人 */
  _resolveMentionUids(key, names = []) {
    const chat = this.chatStore.ensureChat(key);
    const out = [];
    if (!chat || !Array.isArray(names) || !names.length) return out;
    const wanted = new Set(names.map((n) => String(n || '').trim()).filter(Boolean));
    if (!wanted.size) return out;
    for (const card of chat.people.values()) {
      if (!card) continue;
      const labels = [card.name, card.nickname].filter(Boolean).map(String);
      if (labels.some((label) => wanted.has(label))) out.push(String(card.uid));
    }
    return out;
  }

  /**
   * 本轮可以注入的公开事实：当前说话人 + 被提到的人。
   * 不注入全群所有人的公开卡：50 个人各几条，预算直接爆，而且和当前话题无关。
   */
  sharedFor(key, { uid = '', isGroup = false, mentionedNames = [] } = {}) {
    const audience = this.audienceOf(key, { uid, isGroup });
    const subjects = new Set();
    if (uid) subjects.add(String(uid));
    for (const id of this._resolveMentionUids(key, mentionedNames)) subjects.add(id);
    if (!subjects.size) return { records: [], audience };
    const records = sharedStore.forSubjects(this.memoryDir, subjects, audience);
    return { records, audience };
  }

  /**
   * 晋升一条事实到共享池（显式操作，不在聊天热路径上）。
   *
   * @param {string} key chatId
   * @param {string} uid 事实所属的人
   * @param {{id?:string, text?:string}} target 用 id 或文本定位那条记录
   * @param {{approvedBy?:string, audience?:string}} [opts]
   */
  promoteFact(key, uid, target = {}, { approvedBy = 'explicit', audience = 'all' } = {}) {
    const chat = this.chatStore.ensureChat(key);
    if (!chat || !chat.people.has(String(uid))) return { ok: false, reason: 'no_card' };
    // 记录是唯一事实源：从 subjects/timeline 里找那条要公开的事实
    const records = this.chatStore.recordsOf(chat);
    const id = target.id ? String(target.id) : '';
    const text = target.text ? String(target.text).trim() : '';
    const source = records.find((r) => (
      r.subject === String(uid) && (id ? r.id === id : (text && r.text.includes(text)))
    ));
    if (!source) return { ok: false, reason: 'not_found' };
    return sharedStore.promote(this.memoryDir, source, { approvedBy, audience });
  }

  /** 撤销公开：只删共享池副本，源记录不动 */
  revokeShared(uid, id) {
    return sharedStore.revoke(this.memoryDir, uid, id);
  }

  /**
   * 当前说话人的卡 + 这个 chat 的最近原文 + 摘要 + 相关事件。
   *
   * tokenScale：校准后的「真实 token / 本地估算」倍数。只有调用方确认样本足够
   * （calibration.trimScale 已做 n ≥ 10 与 0.05 量化）时才传非 1 值。
   * 真实 token 比估算多（scale > 1）就按 D/scale 裁剪，别把 prompt 顶爆；
   * 估算偏保守（scale < 1）则多给一点窗口。不能直接改 this.plan，否则不同模型互相污染。
   */
  buildContext({
    key, uid = '', name = '', query = '', now = null, isGroup = false, currentSeq = 0,
    mentionedNames = [], relationsEnabled = undefined, tokenScale = 1,
    historyTurns = 0, groupHistoryTurns = 0,
  } = {}) {
    const chat = this.chatStore.ensureChat(key);
    const at = Number(now) || this._now();
    const factor = Number(tokenScale);
    const relationsOn = relationsEnabled === undefined ? this.limits.relationsEnabled : relationsEnabled === true;
    const plan = Number.isFinite(factor) && factor > 0 && factor !== 1
      ? budgetPlan.planBudget(this.limits.dialogueBudget / factor, { relations: relationsOn })
      : this.plan;
    let card = this.chatStore.getCard(chat, uid);
    if (!card) card = this.chatStore.ensurePerson(chat, uid, name);
    const last = chat.messages[chat.messages.length - 1];
    const protectSeq = Number(currentSeq) || (last && last.role === 'user' ? last.seq : 0);
    const compressed = compression.compressSync(chat, {
      currentSeq: protectSeq,
      now: at,
      hardTrigger: plan.recent,
      recentLow: plan.recentLow,
      compressChunk: plan.compressChunk,
      summaryTokens: plan.summary,
    });
    if (compressed.chunks) {
      this.chatStore.saveSummary(chat);
      this.chatStore.saveMeta(chat);
    }
    // 用户配置的「上下文条数」是真正的条数上限；token 预算仍由 plan.recent 兜底。
    // 以前这里只读 plan.recentCount，配置项只在记忆读取失败的兜底里生效。
    const configuredCount = Number(isGroup ? groupHistoryTurns : historyTurns);
    const recent = compression.recentForPrompt(chat, {
      currentSeq: protectSeq,
      maxTokens: plan.recent,
      maxCount: configuredCount > 0
        ? configuredCount
        : (isGroup ? plan.groupRecentCount : plan.recentCount),
    });
    const recentUser = chat.messages
      .filter((m) => m.role === 'user' && m.seq !== protectSeq && m.text)
      .slice(-2)
      .map((m) => m.text);
    const events = retrieval.selectEvents(card, {
      query,
      recentTexts: recentUser,
      activeTopic: chat.meta.episode ? chat.meta.episode.activeTopic : '',
      now: at,
      uid,
      topK: plan.caps.events,
    });
    const block = format.buildMemoryBlock({
      card,
      events,
      summary: chat.summary.text,
      // 这个块里同时装了「人物卡 + 事件」和「摘要」，所以上限是两者之和；
      // 只给 memory 的话，摘要一长就会把卡的展示空间挤掉。
      budget: plan.memory + plan.summary,
      // 但「单条记忆最多占 25%」要按 memory 这一片算，不能拿 memory+summary 当基数
      memoryBudget: plan.memory,
      caps: plan.caps,
    });
    // 「这条消息提到了谁」：只做内部状态，不进任何界面；名字对不上人就整块不输出。
    const relationCtx = this._buildRelationsBlock(chat, { uid, mentionedNames, relationsEnabled });
    return {
      chatId: chat.chatId,
      card,
      events,
      block,
      relationsBlock: relationCtx.block,
      relationsTokens: relationCtx.tokens,
      relations: relationCtx.edges,
      mentions: relationCtx.mentions,
      summary: chat.summary.text,
      recent: recent.messages,
      recentTokens: recent.tokens,
      summaryTokens: chat.summary.tokens,
      memoryTokens: estimateBudgetTokens(block),
      // 对话预算（不含 system）：system 只由上层测量，不参与这里的挤压
      dialogueBudget: plan.dialogueBudget,
      configuredDialogueBudget: this.plan.dialogueBudget,
      tokenScale: factor > 0 ? factor : 1,
      hardTotalTokens: LIMITS.hardTotalTokens,
      reserveTokens: plan.reserve,
      plan,
      notes: activePreferenceTexts(card),
      compressed,
    };
  }

  /**
   * 关系块：A 提到 B 时，把「A 和 B 的关系 + B 的卡 + B 最近说过的话」拼成 ≤200 token 的一小块。
   * 全部来自本 chat 的系统记录；名字解析不到 uid 就整块跳过（不建卡、不编 uid）。
   * 开关：显式传 relationsEnabled 优先，否则看 Store 构造时的 features.relations。
   */
  _buildRelationsBlock(chat, { uid = '', mentionedNames = [], relationsEnabled = undefined } = {}) {
    const enabled = relationsEnabled === undefined ? this.limits.relationsEnabled === true : relationsEnabled === true;
    const empty = { block: '', tokens: 0, edges: [], mentions: [] };
    if (!enabled) return empty;
    const names = [...new Set((Array.isArray(mentionedNames) ? mentionedNames : [])
      .map((n) => String(n == null ? '' : n).trim())
      .filter(Boolean))].slice(0, 3);
    if (!names.length) return empty;

    const entries = [];
    for (const nm of names) {
      const targetUid = relations.resolveName(chat, nm);
      if (!targetUid || String(targetUid) === String(uid)) continue;
      const edge = relations.find(chat.meta.relations, uid, targetUid);
      const card = this.chatStore.getCard(chat, targetUid);
      const recent = chat.messages
        .filter((m) => m.role === 'user' && String(m.uid) === String(targetUid) && m.text)
        .slice(-2)
        .map((m) => m.text);
      if (!edge && !card && !recent.length) continue;
      const block = relations.renderMentionBlock({ name: nm, edge, card, recent });
      if (!block) continue;
      entries.push({ block, edge, mention: { name: nm, uid: targetUid, hasEdge: Boolean(edge) } });
    }
    if (!entries.length) return empty;

    // 多个名字合并后仍守 200 token：先整块丢掉最后一个人，再在块内裁
    let combined = entries.map((e) => e.block).join('\n\n');
    while (entries.length > 1 && estimateBudgetTokens(combined) > relations.MAX_BLOCK_TOKENS) {
      entries.pop();
      combined = entries.map((e) => e.block).join('\n\n');
    }
    const block = relations.capBlockTokens(combined, relations.MAX_BLOCK_TOKENS);
    return {
      block,
      tokens: estimateBudgetTokens(block),
      edges: entries.map((e) => e.edge).filter(Boolean),
      mentions: entries.map((e) => e.mention),
    };
  }

  checkpoint(key) {
    // 只给已经存在的会话落 checkpoint：系统通知等早退消息没有 session，
    // 不能因为一次 ignore 就在磁盘上建出空会话目录。
    const chat = this.chatStore.chats.get(String(key));
    if (!chat) return false;
    const stats = compression.recentTokens(chat, { currentSeq: 0 });
    return this.chatStore.checkpoint(chat, { recentTokens: stats });
  }

  /** 旧 API：把当前会话 meta 落盘（state 改动后调用） */
  markDirty(key) {
    if (key) {
      const chat = this.chatStore.chats.get(String(key));
      if (chat) this.chatStore.saveMeta(chat, { immediate: true });
      return;
    }
    this.chatStore.flush();
  }

  /* ------------------------------ 人物卡 ------------------------------ */

  profile(key, uid, name) {
    const chat = this.chatStore.ensureChat(key);
    const registry = this.chatStore.ensurePerson(chat, uid, name);
    const card = this.chatStore.getCard(chat, uid) || registry;
    return this._profileView({ ...registry, ...card, uid: registry.uid });
  }

  setNickname(key, uid, nickname) {
    const chat = this.chatStore.ensureChat(key);
    const card = this.chatStore.ensurePerson(chat, uid);
    card.nickname = trimText(nickname, 60);
    this.chatStore.saveCard(chat, card);
    return this._profileView(card);
  }

  displayName(key, uid, fallback = '群友') {
    const chat = this.chatStore.ensureChat(key);
    const card = this.chatStore.getCard(chat, uid);
    if (!card) return fallback;
    return card.nickname || card.name || fallback;
  }

  /**
   * 旧 API：写一条记忆。
   * kind 支持 fact/preference/promise/recent/taboo；promise 同时开一条 thread。
   * 4.3 起写的是记录，不是人物卡。
   */
  addNote(key, uid, note, meta = {}) {
    const chat = this.chatStore.ensureChat(key);
    this.chatStore.ensurePerson(chat, uid, meta.name || '');
    const raw = typeof note === 'string' ? { text: note } : (note || {});
    const textValue = trimText(raw.text, 80);
    if (!textValue) return activePreferenceTexts(this._viewCard(chat, uid));
    const kind = ['fact', 'preference', 'promise', 'recent', 'taboo'].includes(raw.kind) ? raw.kind : (meta.kind || 'fact');
    const lastMsg = chat.messages[chat.messages.length - 1];
    const now = this._now();
    this._saveSubjectRecords(chat, uid, (list) => {
      const item = record.makeRecord({
        kind: 'preference',
        text: textValue,
        ts: now,
        tier: 'L',
        scope: `chat:${chat.hash}`,
        subject: String(uid),
        source: { chatId: chat.chatId, messageIds: [meta.source || (lastMsg && lastMsg.id)].filter(Boolean) },
        confidence: Number.isFinite(Number(meta.confidence)) ? Number(meta.confidence) : importanceToConfidence(raw.importance || meta.importance),
        meta: { tag: kind, explicit: meta.explicit !== false },
      });
      if (!item) return list;
      const map = new Map(list.map((r) => [r.id, r]));
      map.set(item.id, item);
      if (kind === 'promise') {
        const thread = record.makeRecord({
          kind: 'thread',
          text: textValue,
          ts: now,
          tier: 'L',
          scope: `chat:${chat.hash}`,
          subject: String(uid),
          source: item.source,
          confidence: 0.7,
          open: true,
          meta: { status: 'open', lastMentionedAt: now },
        });
        if (thread) map.set(thread.id, thread);
      }
      return [...map.values()];
    });
    return activePreferenceTexts(this._viewCard(chat, uid));
  }

  manualRemember(key, uid, textValue) {
    const chat = this.chatStore.ensureChat(key);
    this.chatStore.ensurePerson(chat, uid);
    const lastMsg = chat.messages[chat.messages.length - 1];
    const now = this._now();
    this._saveSubjectRecords(chat, uid, (list) => {
      const item = record.makeRecord({
        kind: 'preference',
        text: trimText(textValue, 80),
        ts: now,
        tier: 'L',
        scope: `chat:${chat.hash}`,
        subject: String(uid),
        source: { chatId: chat.chatId, messageIds: [lastMsg && lastMsg.id].filter(Boolean) },
        confidence: 1,
        meta: { tag: 'fact', explicit: true },
      });
      if (!item) return list;
      const map = new Map(list.map((r) => [r.id, r]));
      map.set(item.id, item);
      return [...map.values()];
    });
    return activePreferenceTexts(this._viewCard(chat, uid));
  }

  removeNote(key, uid, needle) {
    const chat = this.chatStore.ensureChat(key);
    const target = personCard.normalizeText(needle);
    const scope = `chat:${chat.hash}`;
    let removed = 0;
    this._saveSubjectRecords(chat, uid, (list) => list.map((item) => {
      // 只删这个 chat 的记录：同一个 uid 在别的会话里的同文记忆不能被顺手删掉
      if (!target || item.state !== 'active' || item.scope !== scope) return item;
      const body = personCard.normalizeText(item.text);
      if (!body || (body !== target && !body.includes(target))) return item;
      removed += 1;
      return record.markDeleted(item, this._now());
    }));
    return { removed, notes: activePreferenceTexts(this._viewCard(chat, uid)) };
  }

  touchNotes(key, uid, texts, now = null) {
    const chat = this.chatStore.ensureChat(key);
    const at = Number(now) || this._now();
    const targets = new Set((texts || []).map((t) => personCard.normalizeText(t)).filter(Boolean));
    if (targets.size) {
      this._saveSubjectRecords(chat, uid, (list) => list.map((item) => {
        if (item.state !== 'active') return item;
        const body = personCard.normalizeText(item.text);
        if (!body || !targets.has(body)) return item;
        return {
          ...item,
          hits: (Number(item.hits) || 0) + 1,
          meta: { ...(item.meta || {}), lastMentionedAt: at },
        };
      }));
    }
    return activePreferenceTexts(this._viewCard(chat, uid));
  }

  listNotes(key) {
    const chat = this.chatStore.ensureChat(key);
    const out = [];
    for (const registry of chat.people.values()) {
      const card = this._viewCard(chat, registry.uid);
      const notes = activePreferenceTexts(card);
      if (notes.length) out.push({ uid: registry.uid, name: registry.name || (card && card.name), notes });
      else {
        const threads = personCard.openThreads(card);
        if (threads.length) out.push({ uid: registry.uid, name: registry.name, notes: threads.map((t) => t.text) });
      }
    }
    return out;
  }

  /** 记录读写的小工具：读这个人的 subjects → 交给 mutate → 写回（含容量裁剪） */
  _saveSubjectRecords(chat, uid, mutate) {
    const id = String(uid || '');
    if (!id) return [];
    const before = recordStore.readSubjects(this.memoryDir, id);
    const after = record.capByKind(mutate(before), { caps: this._subjectCaps(), now: this._now() });
    recordStore.writeSubjects(this.memoryDir, id, after);
    this.chatStore.markRecordsDirty(chat);
    return after;
  }

  /** 长期记录的分 kind 上限：各占各的额度，别让性格/话题挤掉偏好 */
  _subjectCaps() {
    return {
      preference: LIMITS.maxPreferencesPerPerson,
      fact: LIMITS.maxPreferencesPerPerson,
      trait: LIMITS.maxTraitsPerPerson,
      thread: LIMITS.maxThreadsPerPerson,
    };
  }

  /** 物化卡：记录优先；没有任何记录时退回名册（未迁移的老数据） */
  _viewCard(chat, uid) {
    return this.chatStore.getCard(chat, uid) || personCard.newCard({ chatId: chat.chatId, uid: String(uid || ''), now: this._now() });
  }

  /* ------------------------------ 摘要 / 兼容 ------------------------------ */

  /** 配置热更新后重算预算分片；否则界面/硬上限用新值、检索窗口用启动时旧值。 */
  replan(config = null) {
    const cfg = config || null;
    if (cfg && cfg.memory && Number(cfg.memory.dialogueBudget) > 0) {
      this.limits.dialogueBudget = Number(cfg.memory.dialogueBudget);
    }
    if (cfg) {
      try {
        const features = require('../infra/features');
        this.limits.relationsEnabled = features.isOn(cfg, 'relations');
      } catch { /* 读不到就保持原值 */ }
    }
    if (cfg && cfg.chat) {
      const wanted = Math.max(
        Number(cfg.memory?.maxMessages) || Number(this.limits.maxMessages) || LIMITS.maxMessagesPerChat,
        Number(cfg.chat.historyTurns || 0) + 2,
        Number(cfg.chat.groupHistoryTurns || 0) + 2,
      );
      this.limits.maxMessages = Math.min(800, wanted);
    }
    if (this.chatStore) this.chatStore.maxMessages = this.limits.maxMessages;
    this.plan = budgetPlan.planBudget(this.limits.dialogueBudget, {
      relations: this.limits.relationsEnabled,
    });
    return this.plan;
  }

  setSummary(key, textValue, meta = {}) {
    const chat = this.chatStore.ensureChat(key);
    const body = trimText(textValue, 1200);
    const lastSeq = (chat.messages[chat.messages.length - 1] || {}).seq || 0;
    const covered = Math.max(0, Math.min(lastSeq, Number(meta.upto) || lastSeq));
    chat.summary.text = body;
    chat.summary.tokens = estimateTokens(body);
    chat.summary.coveredThroughSeq = covered;
    chat.summary.segments = body ? [{ text: body, tokens: chat.summary.tokens, fromSeq: 1, toSeq: covered, at: this._now() }] : [];
    chat.summary.updatedAt = this._now();
    this.chatStore.saveSummary(chat);
    return body;
  }

  setMuted(key, ms) {
    const chat = this.chatStore.ensureChat(key);
    chat.meta.state.mutedUntil = this._now() + Math.max(0, ms);
    this.chatStore.saveMeta(chat, { immediate: true });
    return chat.meta.state.mutedUntil;
  }

  resetSession(key) {
    const chatId = String(key || '');
    if (!this.chatStore.deleteChat(chatId)) return false;
    this.sessions.delete(chatId);
    return true;
  }

  resetAll() {
    this.sessions.clear();
    this.digest = [];
    this.stats = { messages: 0, replies: 0 };
    this.chatStore.resetAll();
  }

  reloadFromDisk() {
    const n = this.chatStore.reload();
    this._syncSessions();
    return n;
  }

  /**
   * 手动导入旧记忆之后用：chatStore 里新加的 chat 直接出现在 sessions 视图里。
   * 不重建 chat 对象（避免打断正在进行的回复），只重建预览映射。
   */
  refreshSessions() {
    this._syncSessions();
    return this.sessions.size;
  }

  summary() {
    let messages = 0;
    let notes = 0;
    let totalMessages = 0;
    let totalReplies = 0;
    for (const chat of this.chatStore.chats.values()) {
      messages += chat.messages.length;
      totalMessages += chat.meta.stats.messages || 0;
      totalReplies += chat.meta.stats.replies || 0;
      // 记忆在记录里，别再从空卡上数：数出来永远是 0
      notes += this.chatStore.recordsOf(chat)
        .filter((r) => r.state === 'active' && (r.kind === 'preference' || r.kind === 'fact')).length;
    }
    this.stats = { messages: totalMessages, replies: totalReplies };
    return {
      sessions: this.chatStore.chats.size,
      messages,
      notes,
      totalMessages,
      totalReplies,
      budget: {
        dialogueBudget: this.plan.dialogueBudget,
        hardTotalTokens: LIMITS.hardTotalTokens,
        memoryTokens: this.plan.memory,
        summaryTokens: this.plan.summary,
        recentMaxTokens: this.plan.recent,
        reserveTokens: this.plan.reserve,
        relationsTokens: this.plan.relations,
      },
    };
  }

  archiveCount() {
    try {
      return fs.readdirSync(path.join(this.memoryDir, 'archive'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length;
    } catch {
      return 0;
    }
  }

  /* ------------------------------ 动作账本 ------------------------------ */

  appendEvent(key, event) {
    if (!key) return null;
    let clamped = null;
    try {
      // 复用动作账本的类型/长度约束；core/events 不依赖 memory，避免循环
      const actionEvents = require('../core/events');
      clamped = actionEvents.clampEvent(event, this._now());
    } catch {
      clamped = event;
    }
    if (!clamped) return null;
    const chat = this.chatStore.ensureChat(key);
    const list = chat.meta.events;
    const last = list[list.length - 1];
    if (last && last.type === clamped.type && last.status === clamped.status && last.detail === clamped.detail
      && Number(clamped.ts) - Number(last.ts) < 5000) return last;
    list.push(clamped);
    if (list.length > 60) list.splice(0, list.length - 60);
    this.chatStore.saveMeta(chat, { immediate: true });
    return clamped;
  }

  events(key, limit = 12) {
    const chat = this.chatStore.ensureChat(key);
    return chat.meta.events.slice(-Math.max(0, Number(limit) || 0));
  }

  updateEvent(key, ts, patch = {}) {
    if (!key || !ts) return null;
    const chat = this.chatStore.ensureChat(key);
    for (let i = chat.meta.events.length - 1; i >= 0; i -= 1) {
      if (Number(chat.meta.events[i].ts) !== Number(ts)) continue;
      let next = { ...chat.meta.events[i], ...patch, ts };
      try {
        const actionEvents = require('../core/events');
        next = actionEvents.clampEvent(next, next.ts) || next;
      } catch { /* ignore */ }
      chat.meta.events[i] = next;
      this.chatStore.saveMeta(chat);
      return next;
    }
    return null;
  }

  /* ------------------------------ episode / 维护 ------------------------------ */

  async closeEpisode(key, { reason = 'manual', now = null, llm = null } = {}) {
    const chat = this.chatStore.ensureChat(key);
    const at = Number(now) || this._now();
    if (!chat.meta.episode) {
      return { closed: false, reason: chat.meta.lastClosedEpisodeId ? 'already_closed' : 'no_episode' };
    }
    const result = await episode.closeEpisode({
      chat,
      chatStore: this.chatStore,
      llm: llm || this.llm,
      logger: this.logger,
      now: at,
      reason,
    });
    this._syncSessions();
    return result;
  }

  /** 启动：30 分钟空闲补写 L2；超预算按需压缩。不阻塞服务启动。 */
  async startupRecovery({ llm = null } = {}) {
    const model = llm || this.llm;
    const tasks = [];
    for (const chat of this.chatStore.chats.values()) {
      const idle = episode.closeIdleEpisodes({
        chat,
        chatStore: this.chatStore,
        llm: model,
        logger: this.logger,
        now: this._now(),
      });
      if (idle) tasks.push(idle.then((r) => (r && r.closed ? 1 : 0)));
    }
    const closed = (await Promise.all(tasks)).reduce((a, b) => a + b, 0);
    for (const chat of this.chatStore.chats.values()) {
      const before = compression.recentTokens(chat, { currentSeq: 0 });
      if (before > this.plan.recent) {
        await compression.compressAsync(chat, {
          currentSeq: 0,
          llm: model,
          logger: this.logger,
          now: this._now(),
          hardTrigger: this.plan.recent,
          recentLow: this.plan.recentLow,
          compressChunk: this.plan.compressChunk,
          summaryTokens: this.plan.summary,
        });
        this.chatStore.saveSummary(chat);
        this.chatStore.saveMeta(chat);
      }
    }
    this._syncSessions();
    return { chats: this.chatStore.chats.size, episodesClosed: closed };
  }

  /** 每天一次：过期、去重、关闭闲置话题、归档（4.3 起清理的是记录，不是人物卡） */
  sweep(now = null) {
    const at = Number(now) || this._now();
    let evicted = 0;
    for (const chat of this.chatStore.chats.values()) {
      // 刚导入的旧记忆先原样留着（pruneRaw 会删「已被摘要覆盖且超过 90 天」的原文，
      // 用户刚导进来就少一段很难解释）；一周后按正常规则清理。
      const freshImport = chat.meta.importedAt && at - chat.meta.importedAt < 7 * DAY_MS;
      if (!freshImport) this.chatStore.pruneRaw(chat, at);
      evicted += this._expireRecords(chat, at);
      this.chatStore.saveMeta(chat);
    }
    const archived = this.chatStore.archiveIdle(at);
    this._syncSessions();
    if (evicted || archived.length) {
      if (this.logger) this.logger.info(`记忆清理：淘汰 ${evicted} 条，归档 ${archived.length} 个聊天`);
    }
    return { archived: archived.length, evicted, purged: 0 };
  }

  /** 记录的时间价值分：重要度 × 30 天半衰 + 置顶 */
  _recordScore(item, now) {
    const importance = Number(item.importance) || 0.3;
    const ageDays = Math.max(0, (now - (Number(item.ts) || now)) / DAY_MS);
    return importance * Math.pow(0.5, ageDays / 30) + (item.pinned ? 1 : 0);
  }

  /** 清理一个 chat 的记录：过期事件、同文事件、每 chat 上限、闲置话题、软删清理 */
  _expireRecords(chat, now) {
    const scope = `chat:${chat.hash}`;
    const cutoff = now - LIMITS.eventRetentionDays * DAY_MS;
    let evicted = 0;

    // 中期 timeline：过期 + 去重 + 上限
    const timeline = recordStore.readTimeline(chat.dir);
    let timelineChanged = false;
    const kept = [];
    for (const item of timeline) {
      if (item.kind === 'event' && item.scope === scope && !item.pinned) {
        const ts = Number(item.ts) || 0;
        if (ts && ts < cutoff) { evicted += 1; timelineChanged = true; continue; }
      }
      kept.push(item);
    }
    const seen = new Set();
    let deduped = [];
    for (const item of kept) {
      if (item.kind === 'event') {
        const key = `${item.subject}|${item.text}`;
        if (seen.has(key)) { evicted += 1; timelineChanged = true; continue; }
        seen.add(key);
      }
      deduped.push(item);
    }
    const events = deduped.filter((r) => r.kind === 'event');
    if (events.length > LIMITS.maxEventsPerChat) {
      const overflow = events.length - LIMITS.maxEventsPerChat;
      const ranked = events.slice().sort((a, b) => this._recordScore(a, now) - this._recordScore(b, now));
      const drop = new Set(ranked.slice(0, overflow).map((r) => r.id));
      deduped = deduped.map((item) => (
        drop.has(item.id) && item.state === 'active'
          ? { ...item, state: 'archived', archivedAt: now }
          : item
      ));
      evicted += overflow;
      timelineChanged = true;
    }
    // 只有真的改了才重写：sweep 每天跑，空写一遍整份 timeline 纯属浪费
    if (timelineChanged) recordStore.writeTimeline(chat.dir, deduped);

    // 长期 subjects：闲置话题关闭、软删记录过期清掉
    for (const registry of chat.people.values()) {
      const all = recordStore.readSubjects(this.memoryDir, registry.uid);
      let changed = false;
      const next = [];
      for (const item of all) {
        if (item.scope === scope && item.kind === 'thread' && item.open) {
          const last = Number(item.meta && item.meta.lastMentionedAt) || Number(item.ts) || now;
          if (now - last > LIMITS.threadIdleCloseDays * DAY_MS) {
            next.push({ ...item, open: false, meta: { ...(item.meta || {}), status: 'closed', closedAt: now } });
            changed = true;
            continue;
          }
        }
        if (item.state === 'deleted' && now - (Number(item.ts) || now) > 30 * DAY_MS) {
          changed = true;
          evicted += 1;
          continue;
        }
        next.push(item);
      }
      if (changed) recordStore.writeSubjects(this.memoryDir, registry.uid, next);
    }
    return evicted;
  }


  /* ------------------------------ 生命周期 ------------------------------ */

  flush() {
    return this.chatStore.flush();
  }

  close() {
    try { this.chatStore.close(); } catch { /* ignore */ }
  }

  /** 等后台任务（测试/退出用） */
  async drain() {
    await Promise.all([...this._background]);
  }
}

module.exports = { Store, readStoreFile, trimText };












