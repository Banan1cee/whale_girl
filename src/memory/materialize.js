'use strict';

/**
 * 记录 → 人物卡形状的物化视图。
 *
 * 记录（record）是唯一事实源；但「一个人的卡」这个形状仍被很多地方需要：
 * 提示词渲染（format.buildMemoryBlock）、启动器的档案面板、关系块、
 * 「记住/忘掉」这类命令。与其让它们都改成按记录写一遍查询，不如在这里
 * 把记录投影回卡 —— 只读，不落盘。
 *
 * 为什么不是「卡是源、记录是缓存」：反向投影要在每次写卡后做 diff，
 * 两者一旦不一致就没人知道以谁为准。现在是单向：记录 → 卡。
 */

function scoreOf(record) {
  const conf = Number(record.confidence) || 0.5;
  const hits = 1 + Math.min(5, Number(record.hits) || 0) * 0.1;
  return conf * hits;
}

/**
 * @param {Array<object>} records 这个 chat 的记录（subjects + timeline 合并）
 * @param {{uid:string, chatId?:string, name?:string, nickname?:string}} who
 * @returns {object} 与 personCard.normalizeCard 同形状的对象（供只读消费）
 */
function cardFromRecords(records, { uid = '', chatId = '', name = '', nickname = '' } = {}) {
  const id = String(uid);
  const mine = (Array.isArray(records) ? records : []).filter(
    (r) => r && r.subject === id && r.state === 'active'
  );
  const byScore = (a, b) => scoreOf(b) - scoreOf(a);

  const traits = mine.filter((r) => r.kind === 'trait').sort(byScore).map((r) => ({
    id: r.id,
    text: r.text,
    confidence: r.confidence,
    evidence: (r.meta && r.meta.evidence) || [],
    mentions: r.hits,
    createdAt: r.ts,
    updatedAt: r.ts,
  }));

  const preferences = mine.filter((r) => r.kind === 'preference' || r.kind === 'fact')
    .sort(byScore)
    .map((r) => ({
      id: r.id,
      text: r.text,
      key: (r.meta && r.meta.key) || '',
      kind: (r.meta && r.meta.tag) || 'fact',
      confidence: r.confidence,
      source: (r.source && r.source.messageIds && r.source.messageIds[0]) || '',
      mentions: r.hits,
      explicit: Boolean(r.meta && r.meta.explicit),
      legacy: Boolean(r.meta && r.meta.legacy),
      createdAt: r.ts,
      lastMentionedAt: (r.meta && r.meta.lastMentionedAt) || r.ts,
      updatedAt: r.ts,
    }));

  const threads = mine.filter((r) => r.kind === 'thread').sort((a, b) => {
    const am = (a.meta && a.meta.lastMentionedAt) || a.ts;
    const bm = (b.meta && b.meta.lastMentionedAt) || b.ts;
    return bm - am;
  }).map((r) => ({
    id: r.id,
    text: r.text,
    status: (r.meta && r.meta.status) || (r.open ? 'open' : 'closed'),
    createdAt: r.ts,
    lastMentionedAt: (r.meta && r.meta.lastMentionedAt) || r.ts,
  }));

  // 事件按时间倒序；format/retrieval 会自己再排一次
  const events = mine.filter((r) => r.kind === 'event').sort((a, b) => b.ts - a.ts).map((r) => ({
    id: r.id,
    date: (r.meta && r.meta.date) || '',
    title: (r.meta && r.meta.title) || r.text.slice(0, 20),
    summary: (r.meta && r.meta.summary) || r.text,
    keywords: (r.meta && r.meta.keywords) || [],
    participants: (r.meta && r.meta.participants) || [],
    importance: r.importance,
    confidence: r.confidence,
    valence: (r.meta && r.meta.valence) || 0,
    resolved: Boolean(r.meta && r.meta.resolved),
    threadId: (r.meta && r.meta.threadId) || '',
    pinned: Boolean(r.pinned),
    source: r.source,
    createdAt: r.ts,
  }));

  return {
    chatId: String(chatId || ''),
    uid: id,
    name: String(name || ''),
    nickname: String(nickname || ''),
    traits,
    preferences,
    threads,
    events,
    updatedAt: Date.now(),
  };
}

module.exports = { cardFromRecords };


