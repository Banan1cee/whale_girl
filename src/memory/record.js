'use strict';

/**
 * 记忆 v2 的唯一记录模型。
 *
 * 为什么要有这一层：现在同一个事实能用四种形态存在（卡里的 preference、
 * note、event、summary 段），每种形态各有一套读写和上限。结果是「这条记忆
 * 在哪」没有唯一答案，改一处要动四处。
 *
 * 这里把「记忆」收敛成一种东西：一条 Record。层（S/M/L）不是目录，而是
 * 记录上的一个字段，所以任何一条记忆在哪一层永远只有一个答案。
 *
 * 三个动作对应三种生命周期：
 *   promote  S → M（episode 关闭）、M → L（被反复提到 / 高置信 / 用户说记住）
 *   demote   L 或 M 满了，降级成 archived —— 不再常驻，但仍可被检索
 *   prune    只有档案（原文）会真的删除，其余「遗忘」都是降级
 *
 * 纯函数，不碰磁盘：读写由 chatStore / store 负责，规则都在这里，方便单测。
 */

const { shortId, chatHash } = require('./hash');

const DAY_MS = 86400000;

const TIERS = Object.freeze(['S', 'M', 'L']);
const KINDS = Object.freeze([
  'message', 'digest', 'event', 'relation', 'fact', 'trait', 'preference', 'thread',
]);
const STATES = Object.freeze(['active', 'archived', 'deleted']);
/** scope 前缀；`chat:<hash>` 的 hash 是 sha1 前 16 位，和目录名同一口径 */
const SCOPE_CHAT_RE = /^chat:([0-9a-f]{16})$/;
const SCOPE_SUBJECT_RE = /^subject:([^\s:]+)$/;
const SCOPE_SHARED_RE = /^shared:([^\s:]+)$/;

/**
 * kind → 默认层。消息是短期，摘要/事件是中期，事实/关系/未完成话题是长期。
 * 调用方显式给了 tier 就用给的，但默认值必须是这一份，不能各模块自己算。
 */
const TIER_BY_KIND = Object.freeze({
  message: 'S',
  digest: 'M',
  event: 'M',
  fact: 'L',
  trait: 'L',
  preference: 'L',
  relation: 'L',
  thread: 'L',
});

/** 提升到长期的门槛。改这里就等于改「她多久能记住你」，只能在一处改。 */
const PROMOTE = Object.freeze({
  hits: 2,
  confidence: 0.8,
  importance: 0.8,
});

function tierForKind(kind) {
  return TIER_BY_KIND[kind] || 'M';
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/** 统一 scope 写法：接受字符串或 {kind, hash|uid}，认不出来返回空串 */
function normalizeScope(scope) {
  if (!scope) return '';
  if (typeof scope === 'object') {
    if (scope.kind === 'chat' && scope.hash) return `chat:${scope.hash}`;
    if (scope.kind === 'subject' && scope.uid) return `subject:${scope.uid}`;
    if (scope.kind === 'shared' && scope.uid) return `shared:${scope.uid}`;
    return '';
  }
  const text = String(scope).trim();
  if (SCOPE_CHAT_RE.test(text) || SCOPE_SUBJECT_RE.test(text) || SCOPE_SHARED_RE.test(text)) return text;
  return '';
}

function parseScope(scope) {
  const text = String(scope || '');
  let m = SCOPE_CHAT_RE.exec(text);
  if (m) return { kind: 'chat', hash: m[1] };
  m = SCOPE_SUBJECT_RE.exec(text);
  if (m) return { kind: 'subject', uid: m[1] };
  m = SCOPE_SHARED_RE.exec(text);
  if (m) return { kind: 'shared', uid: m[1] };
  return { kind: 'unknown', hash: '', uid: '' };
}

/** audience 决定「哪种会话能看到」：private / all / group:<hash> */
function normalizeAudience(value) {
  if (!value) return 'all';
  const text = String(value).trim();
  if (text === 'private' || text === 'all') return text;
  if (/^group:[0-9a-f]{16}$/.test(text)) return text;
  return 'all';
}

function normalizeSource(source) {
  if (!source || typeof source !== 'object') return { chatId: '', messageIds: [] };
  const ids = Array.isArray(source.messageIds)
    ? source.messageIds.filter((x) => x != null && String(x).trim()).map(String).slice(0, 40)
    : [];
  return { chatId: String(source.chatId || ''), messageIds: ids };
}

/**
 * kind 自己的结构化细节（事件的日期/关键词、关系的两端、话题状态…）。
 * 不摊到顶层：不同 kind 的字段互不相干，摊平只会让每条记录都长胖。
 * 只接受 JSON 能表达的值，序列化失败就当没有，别让一条脏记录堵住整个写入。
 */
function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  try {
    const text = JSON.stringify(meta);
    if (!text || text.length > 4096) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 幂等 id：同一条消息/同一句事实重复写入必须命中同一个 id */
function recordId({ kind, text, scope = '', ts = 0, source = null } = {}) {
  const src = normalizeSource(source);
  const anchor = src.messageIds[0] || String(Number(ts) || 0);
  return `${kind}_${shortId([kind, cleanText(text), normalizeScope(scope), anchor].join('|'))}`;
}

/**
 * 构造一条记录；text 为空返回 null（空记忆没有价值，也别写盘）。
 * @param {object} input
 * @returns {object|null}
 */
function makeRecord(input = {}) {
  const kind = KINDS.includes(input.kind) ? input.kind : 'fact';
  const text = cleanText(input.text);
  if (!text) return null;
  const ts = Number(input.ts) || Date.now();
  const tier = TIERS.includes(input.tier) ? input.tier : tierForKind(kind);
  const source = normalizeSource(input.source);
  // scope 没给就按来源 chat 推导：一条记忆默认只属于产生它的那个会话
  const scope = normalizeScope(input.scope)
    || (source.chatId ? `chat:${chatHash(source.chatId)}` : 'chat:0000000000000000');
  const subject = String(input.subject || '').trim();
  const confidence = Math.min(1, Math.max(0, Number(input.confidence == null ? 0.7 : input.confidence)));
  const importance = Math.min(1, Math.max(0, Number(input.importance || 0)));
  const hits = Math.max(0, Math.floor(Number(input.hits) || 0));
  const state = STATES.includes(input.state) ? input.state : 'active';
  const record = {
    id: String(input.id || recordId({ kind, text, scope, ts, source })),
    kind,
    text,
    ts,
    tier,
    scope,
    subject,
    source,
    confidence,
    importance,
    hits,
    audience: normalizeAudience(input.audience),
    state,
    pinned: input.pinned === true,
    // 未完成话题（thread）用 open 表示，别的 kind 恒为 false
    open: input.open === true,
    meta: normalizeMeta(input.meta),
    createdAt: Number(input.createdAt) || ts,
    updatedAt: Number(input.updatedAt) || ts,
  };
  if (input.archivedAt) record.archivedAt = Number(input.archivedAt) || ts;
  return record;
}

/** 读盘回来的一律过这一遍：字段缺了补默认，脏数据返回 null 而不是抛 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return makeRecord(raw);
}

/**
 * 跨会话可见性。这是隐私红线的唯一实现，别在别处再写一份。
 *
 * 规则分两步，顺序不能反：
 *   1. scope 决定「哪些会话能拿到」：chat:<hash> 只给它自己；subject/shared 才可能跨会话
 *   2. audience 决定「哪种会话能拿到」：private 只进私聊；group:<hash> 只进那个群
 * 最后，跨会话可见还要求这个人确实在场 —— 否则小明的喜好会出现在他不在的群里。
 *
 * @param {object} record
 * @param {{chatHash?:string, isGroup?:boolean, uid?:string, roster?:Set<string>|string[]}} audience
 * @returns {boolean}
 */
function visibleTo(record, audience = {}) {
  if (!record || record.state !== 'active') return false;
  const a = audience || {};
  const chatHash = String(a.chatHash || '');
  const isGroup = a.isGroup === true;
  const uid = String(a.uid || '');
  const roster = a.roster instanceof Set ? a.roster : new Set(Array.isArray(a.roster) ? a.roster.map(String) : []);
  const scope = parseScope(record.scope);
  const aud = record.audience || 'all';

  if (scope.kind === 'chat' && scope.hash !== chatHash) return false;

  if (aud === 'private') {
    if (isGroup) return false;
    return !record.subject || record.subject === uid;
  }
  if (aud.startsWith('group:')) {
    if (!isGroup || aud.slice('group:'.length) !== chatHash) return false;
  }
  // 本 chat 的 local 记录已经过了 scope 检查，到此即可见
  if (scope.kind === 'chat') return true;
  // 跨会话：主体必须在这个会话里（群看名单，私聊看是不是本人）
  if (!record.subject) return false;
  return isGroup ? roster.has(record.subject) : uid === record.subject;
}

/** 中期 → 长期：只认「被反复用到」或「明确要求记住」，不认一次情绪 */
function shouldPromote(record) {
  if (!record || record.state !== 'active' || record.tier !== 'M') return false;
  if (record.pinned === true) return true;
  if (Number(record.hits) >= PROMOTE.hits) return true;
  if (Number(record.confidence) >= PROMOTE.confidence) return true;
  if (Number(record.importance) >= PROMOTE.importance) return true;
  return false;
}

/**
 * 淘汰分：置信度 × 90 天半衰的新鲜度 × 被用到过（最多加 50%）× 置顶。
 * 和 personCard.evictOverflow 的口径保持一致，避免两处分数打架。
 */
function evictionScore(record, now = Date.now()) {
  if (!record) return 0;
  const conf = Number(record.confidence) || 0.5;
  const ageDays = Math.max(0, (now - (Number(record.ts) || now)) / DAY_MS);
  const freshness = Math.pow(0.5, ageDays / 90);
  const used = 1 + Math.min(5, Number(record.hits) || 0) * 0.1;
  const pin = record.pinned ? 10 : 1;
  return conf * freshness * used * pin;
}

/**
 * 把某一层压到上限。超出的不是删除，是 state='archived'（还能被检索）。
 * 返回新数组，不改入参 —— 调用方可能是内存里的共享对象。
 *
 * @param {Array<object>} records
 * @param {{cap?:number, tier?:string, now?:number}} [opts]
 * @returns {{records:Array<object>, demoted:Array<object>}}
 */
function capRecords(records, { cap, tier, now = Date.now() } = {}) {
  const list = (Array.isArray(records) ? records : []).filter(Boolean);
  const limit = Math.max(0, Number(cap) || 0);
  const targets = list.filter((r) => r.state === 'active' && (!tier || r.tier === tier));
  if (targets.length <= limit) return { records: list.slice(), demoted: [] };
  const ranked = targets.slice().sort((a, b) => evictionScore(b, now) - evictionScore(a, now));
  const overflow = new Set(ranked.slice(limit).map((r) => r.id));
  const next = list.map((r) => (overflow.has(r.id) ? { ...r, state: 'archived', archivedAt: now } : r));
  return { records: next, demoted: next.filter((r) => overflow.has(r.id)) };
}

/**
 * 按 kind 分别压容量。
 *
 * 为什么要分 kind：以前人物卡是「偏好 30 / 性格 12 / 话题 10」三套独立上限，
 * 合成一条 subjects 之后如果只用一个总数，性格和话题会挤占偏好的额度 ——
 * 10 条性格 + 10 条话题就能把 30 条偏好挤掉一半。调用方把各 kind 的上限传进来。
 *
 * @param {Array<object>} records
 * @param {{caps?:object, now?:number}} [opts] caps: { kind: 上限 }
 * @returns {Array<object>} 新数组，超出的那条变成 archived
 */
function capByKind(records, { caps = {}, now = Date.now() } = {}) {
  const map = new Map();
  for (const item of (Array.isArray(records) ? records : []).filter(Boolean)) map.set(item.id, item);
  for (const [kind, cap] of Object.entries(caps || {})) {
    if (!Number.isFinite(Number(cap))) continue;
    const ofKind = [...map.values()].filter((r) => r.kind === kind);
    if (!ofKind.length) continue;
    for (const item of capRecords(ofKind, { cap: Number(cap), now }).records) map.set(item.id, item);
  }
  return [...map.values()];
}

/** 真删除只发生在档案淘汰；这里只做标记，物理删除由 prune 负责 */
function markDeleted(record, now = Date.now()) {
  if (!record) return null;
  return { ...record, state: 'deleted', deletedAt: now };
}

module.exports = {
  TIERS,
  KINDS,
  STATES,
  TIER_BY_KIND,
  PROMOTE,
  tierForKind,
  normalizeScope,
  parseScope,
  normalizeSource,
  recordId,
  makeRecord,
  normalizeRecord,
  visibleTo,
  shouldPromote,
  evictionScore,
  capRecords,
  capByKind,
  markDeleted,
};


