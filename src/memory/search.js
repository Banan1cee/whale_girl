'use strict';

/**
 * 长期档案的检索（RAG 的 P0：不需要任何 API）。
 *
 * 现状最致命的缺口是「原文从来不参与检索」：messages.jsonl 存着 2000 条，
 * 但读路径只有 recent 窗口和事件卡，掉出窗口又没被抽成事件的话就永久失联。
 *
 * 这里把原文切成块，用字符 bigram + BM25 搜。不引分词库、不引向量库，
 * 零依赖、离线可用；语义召回（embedding）是 P1，接上以后和这里做 RRF 融合。
 *
 * 分块策略：6 条消息一块、重叠 1 条。块太小会切断上下文，太大则一块里
 * 只有一句话相关时，会把整块无关内容一起塞进 prompt。
 */

const { tokens } = require('./retrieval');
const { LIMITS } = require('./constants');

const DEFAULT_SIZE = Number(LIMITS.chunkSize) || 6;
const DEFAULT_OVERLAP = Number(LIMITS.chunkOverlap) || 1;
const K1 = 1.5;
const B = 0.75;

/** 只收有正文的消息；机器人自己的回复也算史料（她说过什么要能想起来） */
function usable(message) {
  return message && message.text && !message.error;
}

/**
 * 把一段消息切成块。
 * @param {Array<object>} messages 按时间升序
 * @param {{size?:number, overlap?:number, chatId?:string}} [opts]
 * @returns {Array<{id:string, seqFrom:number, seqTo:number, ts:number, text:string, chatId:string, messageIds:string[]}>}
 */
function buildChunks(messages, { size = DEFAULT_SIZE, overlap = DEFAULT_OVERLAP, chatId = '' } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter(usable);
  const span = Math.max(1, Number(size) || DEFAULT_SIZE);
  const step = Math.max(1, span - Math.max(0, Math.min(span - 1, Number(overlap) || 0)));
  const out = [];
  for (let start = 0; start < list.length; start += step) {
    const slice = list.slice(start, start + span);
    if (!slice.length) break;
    const lines = slice.map((m) => {
      const who = m.role === 'assistant' ? '鲸鲸' : (m.name || m.uid || '对方');
      return `${who}：${String(m.text).replace(/\s+/g, ' ').trim()}`;
    });
    const text = lines.join('\n');
    if (!text.trim()) continue;
    const seqs = slice.map((m) => Number(m.seq) || 0);
    out.push({
      id: `ck_${seqs[0] || start}_${seqs[seqs.length - 1] || start}`,
      seqFrom: seqs[0] || 0,
      seqTo: seqs[seqs.length - 1] || 0,
      ts: Number(slice[0].ts) || 0,
      text,
      chatId: String(chatId || (slice[0] && slice[0].chatId) || ''),
      messageIds: slice.map((m) => String(m.id || '')).filter(Boolean),
    });
    if (start + span >= list.length) break;
  }
  return out;
}

/**
 * 建索引：每块的词频 + 文档频率。块数量在几百量级，直接放内存。
 * @param {Array<object>} chunks
 */
function buildIndex(chunks) {
  const docs = (Array.isArray(chunks) ? chunks : []).filter((c) => c && c.text);
  const entries = docs.map((chunk) => {
    const terms = tokens(chunk.text);
    const tf = new Map();
    for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
    return { chunk, tf, len: terms.length };
  });
  const df = new Map();
  for (const entry of entries) {
    for (const term of entry.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const avgLen = entries.reduce((n, e) => n + e.len, 0) / Math.max(1, entries.length);
  return { entries, df, avgLen, n: entries.length };
}

/**
 * BM25 打分。
 * @param {object} index buildIndex 的返回
 * @param {string} query
 * @param {{topK?:number, minScore?:number}} [opts]
 */
function search(index, query, { topK = 5, minScore = 0 } = {}) {
  const idx = index || { entries: [], df: new Map(), avgLen: 0, n: 0 };
  const qt = tokens(String(query || ''));
  if (!qt.length || !idx.entries.length) return [];
  const scored = [];
  for (const entry of idx.entries) {
    let score = 0;
    for (const q of qt) {
      const f = entry.tf.get(q);
      if (!f) continue;
      const df = idx.df.get(q) || 0;
      const idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5));
      const norm = f + K1 * (1 - B + B * (entry.len / Math.max(1, idx.avgLen)));
      score += idf * ((f * (K1 + 1)) / norm);
    }
    // score 为 0 表示只是碰巧共用了单字/空白，不算命中；
    // 不挡掉的话任何查询都会返回「一组零分结果」，调用方还得再过滤一遍。
    if (score <= 0 || score < minScore) continue;
    scored.push({ chunk: entry.chunk, score: Number(score.toFixed(4)) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, Number(topK) || 0));
}

/**
 * 去掉已经在 recent 窗口里的块：同一段对话不要在 prompt 里出现两次。
 * @param {Array<{chunk:object}>} hits
 * @param {Iterable<number>} recentSeqs
 */
function filterFresh(hits, recentSeqs) {
  const covered = new Set([...(recentSeqs || [])].map(Number));
  if (!covered.size) return hits || [];
  return (hits || []).filter((hit) => {
    const chunk = hit && hit.chunk;
    if (!chunk) return false;
    // 区间有交集就算重复
    for (let seq = chunk.seqFrom; seq <= chunk.seqTo; seq += 1) {
      if (covered.has(seq)) return false;
    }
    return true;
  });
}

/** 便捷入口：消息 → 索引 → 结果 */
function searchMessages(messages, query, { topK = 3, size, overlap, chatId } = {}) {
  const chunks = buildChunks(messages, { size, overlap, chatId });
  return search(buildIndex(chunks), query, { topK });
}

module.exports = {
  buildChunks,
  buildIndex,
  search,
  filterFresh,
  searchMessages,
};

