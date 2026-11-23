'use strict';

/**
 * 旧结构 → Record 的转换器。
 *
 * 它有两个用途，都不在聊天热路径上：
 *   1. 迁移脚本（scripts/migrate-memory.js）把 4.2 的卡/事件/摘要搬成新格式；
 *   2. 等价性测试：用旧状态造一份记录，断言新模型没有丢信息。
 *
 * 这里只做「翻译」，不判断提升/降级；容量和可见性由 record.js 决定。
 * 保留旧 id：重复迁移必须幂等，不能每次重建都长出一批新记录。
 */

const record = require('./record');
const { chatHash } = require('./hash');

function hashOf(chat) {
  if (chat && chat.hash) return String(chat.hash);
  return chatHash((chat && chat.chatId) || '');
}

function isoToTs(date) {
  const ts = Date.parse(`${date}T00:00:00`);
  return Number.isFinite(ts) ? ts : 0;
}

function scopeOf(chat) {
  return `chat:${hashOf(chat)}`;
}

function sourceOf(chat, ids = []) {
  return { chatId: String((chat && chat.chatId) || ''), messageIds: ids };
}

function stateOf(item) {
  if (!item) return 'deleted';
  if (item.deleted === true) return 'deleted';
  if (item.superseded === true) return 'deleted';
  return 'active';
}

/** 一条偏好 / 自述事实 / 忌讳 */
function fromPreference(chat, card, pref, { now = Date.now() } = {}) {
  return record.makeRecord({
    id: pref.id,
    kind: 'preference',
    text: pref.text,
    ts: Number(pref.createdAt) || Number(pref.lastMentionedAt) || now,
    tier: 'L',
    scope: scopeOf(chat),
    subject: card.uid,
    source: sourceOf(chat, pref.source ? [String(pref.source)] : []),
    confidence: pref.confidence,
    hits: Number(pref.mentions) || 0,
    state: stateOf(pref),
    meta: {
      key: pref.key || '',
      tag: pref.kind || 'fact',
      explicit: pref.explicit === true,
      legacy: pref.legacy === true,
      lastMentionedAt: Number(pref.lastMentionedAt) || 0,
    },
  });
}

/** 性格标签：证据比结论重要，原样带过去 */
function fromTrait(chat, card, trait, { now = Date.now() } = {}) {
  return record.makeRecord({
    id: trait.id,
    kind: 'trait',
    text: trait.text,
    ts: Number(trait.createdAt) || now,
    tier: 'L',
    scope: scopeOf(chat),
    subject: card.uid,
    source: sourceOf(chat, Array.isArray(trait.evidence) ? trait.evidence : []),
    confidence: trait.confidence,
    hits: Number(trait.mentions) || 0,
    state: stateOf(trait),
    meta: { evidence: Array.isArray(trait.evidence) ? trait.evidence.slice(0, 8) : [] },
  });
}

/** 未完成的话题 */
function fromThread(chat, card, thread, { now = Date.now() } = {}) {
  return record.makeRecord({
    id: thread.id,
    kind: 'thread',
    text: thread.text,
    ts: Number(thread.createdAt) || now,
    tier: 'L',
    scope: scopeOf(chat),
    subject: card.uid,
    source: sourceOf(chat, []),
    confidence: 0.7,
    open: thread.status !== 'closed',
    state: stateOf(thread),
    meta: {
      status: thread.status || 'open',
      lastMentionedAt: Number(thread.lastMentionedAt) || 0,
      closedAt: Number(thread.closedAt) || 0,
    },
  });
}

/**
 * 事件卡 → 中期记录。text 用「标题：正文」，
 * 因为检索是对 text 打分，只有正文会丢掉标题里的关键词（面试 / 搬家）。
 */
function fromEvent(chat, card, event, { now = Date.now() } = {}) {
  const date = event.date || '';
  const title = String(event.title || '').trim();
  const summary = String(event.summary || '').trim();
  return record.makeRecord({
    id: event.id,
    kind: 'event',
    text: title && summary ? `${title}：${summary}` : (summary || title),
    ts: isoToTs(date) || Number(event.createdAt) || now,
    tier: 'M',
    scope: scopeOf(chat),
    subject: card.uid,
    source: sourceOf(chat, (event.source && event.source.messageIds) || []),
    confidence: event.confidence,
    importance: event.importance,
    pinned: event.pinned === true,
    state: stateOf(event),
    meta: {
      date,
      title,
      summary,
      keywords: Array.isArray(event.keywords) ? event.keywords.slice(0, 10) : [],
      participants: Array.isArray(event.participants) ? event.participants.slice(0, 20) : [],
      valence: Number(event.valence) || 0,
      resolved: event.resolved === true,
      threadId: event.threadId || '',
    },
  });
}

/** 两张卡之间明确说出口的关系 */
function fromRelation(chat, edge, { now = Date.now() } = {}) {
  if (!edge || !edge.text) return null;
  return record.makeRecord({
    kind: 'relation',
    text: edge.text,
    ts: Number(edge.createdAt) || now,
    tier: 'L',
    scope: scopeOf(chat),
    subject: String(edge.a || ''),
    source: sourceOf(chat, (edge.source && edge.source.messageIds) || []),
    confidence: edge.confidence,
    state: edge.deleted === true ? 'deleted' : 'active',
    meta: {
      a: String(edge.a || ''),
      b: String(edge.b || ''),
      aName: edge.aName || '',
      bName: edge.bName || '',
    },
  });
}

/** 摘要段 → 中期摘要记录（一段一条，滚动合并发生在旧结构里，这里只翻译） */
function fromSummary(chat, { now = Date.now() } = {}) {
  const summary = (chat && chat.summary) || {};
  const segments = Array.isArray(summary.segments) ? summary.segments : [];
  const out = [];
  for (const seg of segments) {
    if (!seg || !String(seg.text || '').trim()) continue;
    const item = record.makeRecord({
      kind: 'digest',
      text: seg.text,
      ts: Number(seg.at) || now,
      tier: 'M',
      scope: scopeOf(chat),
      source: sourceOf(chat, []),
      confidence: 0.7,
      meta: { fromSeq: Number(seg.fromSeq) || 0, toSeq: Number(seg.toSeq) || 0 },
    });
    if (item) out.push(item);
  }
  if (!out.length && String(summary.text || '').trim()) {
    const item = record.makeRecord({
      kind: 'digest',
      text: summary.text,
      ts: Number(summary.updatedAt) || now,
      tier: 'M',
      scope: scopeOf(chat),
      source: sourceOf(chat, []),
      confidence: 0.6,
      meta: { fromSeq: 0, toSeq: Number(summary.coveredThroughSeq) || 0 },
    });
    if (item) out.push(item);
  }
  return out;
}

/**
 * 把一个 chat 的全部旧结构翻成 Record。
 * @param {object} chat ChatStore 的 chat 对象
 * @param {{now?:number}} [opts]
 * @returns {Array<object>}
 */
function fromChat(chat, { now = Date.now() } = {}) {
  const out = [];
  const people = chat && chat.people;
  const cards = people instanceof Map ? [...people.values()] : Object.values(people || {});
  for (const card of cards) {
    if (!card || !card.uid) continue;
    for (const pref of card.preferences || []) {
      const item = fromPreference(chat, card, pref, { now });
      if (item) out.push(item);
    }
    for (const trait of card.traits || []) {
      const item = fromTrait(chat, card, trait, { now });
      if (item) out.push(item);
    }
    for (const thread of card.threads || []) {
      const item = fromThread(chat, card, thread, { now });
      if (item) out.push(item);
    }
    for (const event of card.events || []) {
      const item = fromEvent(chat, card, event, { now });
      if (item) out.push(item);
    }
  }
  for (const edge of (chat && chat.meta && chat.meta.relations) || []) {
    const item = fromRelation(chat, edge, { now });
    if (item) out.push(item);
  }
  out.push(...fromSummary(chat, { now }));
  return out.filter(Boolean);
}

module.exports = {
  fromPreference,
  fromTrait,
  fromThread,
  fromEvent,
  fromRelation,
  fromSummary,
  fromChat,
};


