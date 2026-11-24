'use strict';

/**
 * Episode：一段连续话题，从开始到关闭。
 *
 * 关闭条件（任一）：空闲 30 分钟 / 话题切换 / 累计 6,000 token / 持续 3 小时。
 * 关闭时：生成摘要 → 给每个发言人写 L2 事件 → 抽 fact / trait / thread → 清空 L3。
 * 幂等：同一个 episodeId 只写一次 L2（meta.closedEpisodes 去重 + 事件 id 去重 + 写入前检查）。
 */
const { LIMITS, DAY_MS } = require('./constants');
const record = require('./record');
const recordStore = require('./recordStore');
const extractor = require('./extractor');
const compression = require('./compression');
const retrieval = require('./retrieval');
const relations = require('./relations');
const { describeError } = require('../infra/errors');
const { tagId } = require('../infra/privacy');

function memoryDirOf(chatStore) { return chatStore.dir; }

const TOPIC_SHIFT_RE = /(换个话题|换话题|不说这个|不聊这个|聊点别的|说点别的|跳过这个话题|别聊了|算了不聊)/;

function dateString(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function episodeDate(messages, ep, fallbackTs) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const raw = messages[i] && messages[i].ts;
    if (raw === null || raw === undefined || raw === '') continue;
    const ts = Number(raw);
    if (Number.isFinite(ts) && Number.isFinite(new Date(ts).getTime())) return dateString(ts);
  }
  const rawLastMessageAt = ep && ep.lastMessageAt;
  const lastMessageAt = Number(rawLastMessageAt);
  if (rawLastMessageAt !== null && rawLastMessageAt !== undefined && rawLastMessageAt !== ''
    && Number.isFinite(lastMessageAt) && Number.isFinite(new Date(lastMessageAt).getTime())) {
    return dateString(lastMessageAt);
  }
  return dateString(fallbackTs);
}

function episodeStart(chat, { now = Date.now(), seq = chat.meta.nextSeq } = {}) {
  chat.meta.episodeSeq = (Number(chat.meta.episodeSeq) || 0) + 1;
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const id = `ep_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${String(chat.meta.episodeSeq).padStart(2, '0')}`;
  chat.meta.episode = {
    id,
    startedAt: now,
    lastMessageAt: now,
    tokens: 0,
    userMessages: 0,
    messageSeqFrom: seq,
    messageSeqTo: seq - 1,
    activeTopic: '',
    participants: [],
  };
  return chat.meta.episode;
}

function ensureEpisode(chat, { now = Date.now() } = {}) {
  if (!chat.meta.episode) episodeStart(chat, { now });
  return chat.meta.episode;
}

/** 每条消息进来后更新 episode 计数 */
function touchEpisode(chat, message, { now = Date.now() } = {}) {
  const ep = ensureEpisode(chat, { now });
  ep.lastMessageAt = now;
  ep.tokens += Number(message && message.tokens) || 0;
  ep.messageSeqTo = Math.max(ep.messageSeqTo, Number(message && message.seq) || 0);
  if (message && message.role === 'user') {
    ep.userMessages += 1;
    if (message.uid) {
      const uid = String(message.uid);
      if (!ep.participants.includes(uid)) ep.participants.push(uid);
    }
    if (!ep.activeTopic && message.text) ep.activeTopic = String(message.text).replace(/\s+/g, ' ').slice(0, 20);
  }
  return ep;
}

/** 关闭条件；返回原因或 null */
function shouldClose(chat, { text = '', now = Date.now() } = {}) {
  const ep = chat.meta.episode;
  if (!ep) return null;
  if (now - ep.lastMessageAt >= LIMITS.episodeIdleMinutes * 60000) return 'idle';
  if (now - ep.startedAt >= LIMITS.episodeMaxHours * 3600000) return 'max_hours';
  if (ep.tokens >= LIMITS.episodeMaxTokens) return 'tokens';
  if (ep.userMessages >= LIMITS.topicShiftMinMessages) {
    if (TOPIC_SHIFT_RE.test(String(text || ''))) return 'topic_shift';
    const recent = chat.messages
      .filter((m) => m.role === 'user' && m.seq <= ep.messageSeqTo && m.text)
      .slice(-6)
      .map((m) => m.text);
    if (text && recent.length >= 5 && retrieval.topicOverlap(text, recent) < LIMITS.topicShiftOverlap) {
      return 'topic_shift';
    }
  }
  return null;
}

function episodeMessages(chat, ep) {
  if (!ep) return [];
  return chat.messages.filter((m) => m.seq >= ep.messageSeqFrom && m.seq <= ep.messageSeqTo && m.text);
}

function speakersOf(messages) {
  const seen = new Map();
  for (const m of messages) {
    if (m.role !== 'user' || !m.uid) continue;
    if (!seen.has(String(m.uid))) seen.set(String(m.uid), m.name || '群友');
  }
  return [...seen.entries()].map(([uid, name]) => ({ uid, name }));
}

function enqueue(chat, task) {
  chat.closeQueue = (chat.closeQueue || Promise.resolve()).then(task, task);
  return chat.closeQueue;
}

/**
 * 关闭一个 episode，写 L2 + thread。可重复调用，第二次直接返回 already_closed。
 * @returns {Promise<{closed:boolean, reason?:string, episodeId?:string, events?:number}>}
 */
async function closeEpisode({ chat, chatStore, llm = null, logger = null, now = Date.now(), reason = 'manual', episode = null }) {
  const ep = episode || chat.meta.episode;
  if (!ep) return { closed: false, reason: 'no_episode' };
  if ((chat.meta.closedEpisodes || []).includes(ep.id)) return { closed: false, reason: 'already_closed', episodeId: ep.id };
  if (chat.closingEpisode === ep.id) return { closed: false, reason: 'closing', episodeId: ep.id };
  chat.closingEpisode = ep.id;
  try {
    const messages = episodeMessages(chat, ep);
    const speakers = speakersOf(messages);
    const date = episodeDate(messages, ep, now);
    const allUids = speakers.map((s) => s.uid);
    const existingFacts = Object.fromEntries(speakers.map((speaker) => {
      const card = chatStore.getCard(chat, speaker.uid);
      return [speaker.uid, card ? (card.preferences || []).filter(item => !item.deleted && !item.superseded).map(({ id, subject, key, text }) => ({ id, subject, key, text })) : []];
    }));
    const extracted = await extractor.extractEpisode({ messages, llm, speakers, existingFacts, logger, now });
    if (chat.deleted) return { closed: false, reason: 'deleted', episodeId: ep.id };
    const summaryText = String(extracted.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400)
      || extractor.extractiveSummary(messages, 200);
    const messageIds = messages.filter((m) => m.role === 'user').map((m) => m.id).slice(-40);
    let writtenEvents = 0;
    let writtenRelations = 0;

    // 关系边（L1）：只接受本段发言人之间的边（extractEpisode 已经按 speakers 过滤）。
    // 写进当前 chat 的 meta.relations，跨群会直接抛 MEMORY_CHAT_MISMATCH。
    chat.meta.relations = chat.meta.relations || [];
    for (const rel of extracted.relations || []) {
      try {
        const edge = relations.upsert(chat.meta.relations, {
          a: rel.a,
          b: rel.b,
          text: rel.text,
          confidence: rel.confidence,
          source: { chatId: chat.chatId, messageIds },
        }, { chatId: chat.chatId, now });
        if (edge) writtenRelations += 1;
      } catch (err) {
        if (logger) logger.warn('关系边写入失败：' + describeError(err));
      }
    }

    // 记录是唯一事实源：这一段的中期内容进 timeline，长期事实进 subjects。
    // 人物卡只留名册（ensurePerson 只写 uid/name），不再承载记忆正文。
    const scope = `chat:${chat.hash}`;
    const source = { chatId: chat.chatId, messageIds };
    for (const speaker of speakers) {
      chatStore.ensurePerson(chat, speaker.uid, speaker.name);
      const personFacts = extracted.facts.filter((f) => !f.uid || f.uid === speaker.uid);
      const personTraits = extracted.traits.filter((t) => !t.uid || t.uid === speaker.uid);
      const personThreads = extracted.threads.filter((t) => !t.uid || t.uid === speaker.uid);
      const personEvents = extracted.events.filter((e) => !e.uid || e.uid === speaker.uid);

      // 长期：事实 / 性格 / 未完成话题 → subjects（同一人一份，合并而不是覆盖）
      const longRecords = [];
      for (const trait of personTraits) {
        longRecords.push(record.makeRecord({
          kind: 'trait',
          text: trait.text,
          ts: now,
          tier: 'L',
          scope,
          subject: speaker.uid,
          source,
          confidence: trait.confidence,
          meta: { evidence: (trait.evidence && trait.evidence.length ? trait.evidence : messageIds).slice(-8) },
        }));
      }
      for (const thread of personThreads) {
        longRecords.push(record.makeRecord({
          kind: 'thread',
          text: thread.text,
          ts: now,
          tier: 'L',
          scope,
          subject: speaker.uid,
          source,
          confidence: 0.7,
          open: true,
          meta: { status: 'open', lastMentionedAt: now },
        }));
      }
      // 事件里带出的未完成话题也进长期记录：和 fact/trait/thread 一次性合并写入，
      // 不要每个事件都读一遍 subjects 再写回去
      for (const ev of personEvents) {
        if (!ev.threadText) continue;
        longRecords.push(record.makeRecord({
          kind: 'thread',
          text: ev.threadText,
          ts: now,
          tier: 'L',
          scope,
          subject: speaker.uid,
          source,
          confidence: 0.7,
          open: true,
          meta: { status: 'open', lastMentionedAt: now },
        }));
      }
      const existing = record.mergeFacts(recordStore.readSubjects(memoryDirOf(chatStore), speaker.uid), personFacts,
        { uid: speaker.uid, scope, source, now });
      const merged = new Map(existing.map((r) => [r.id, r]));
      for (const item of longRecords) {
        if (!item) continue;
        const old = merged.get(item.id);
        merged.set(item.id, old ? { ...old, ...item, hits: old.hits || 0, ts: old.ts, createdAt: old.createdAt } : item);
      }
      // 分 kind 压容量：性格 / 话题 / 偏好各占各的额度
      const capped = record.capByKind([...merged.values()], {
        caps: {
          preference: LIMITS.maxPreferencesPerPerson,
          fact: LIMITS.maxPreferencesPerPerson,
          trait: LIMITS.maxTraitsPerPerson,
          thread: LIMITS.maxThreadsPerPerson,
        },
        now,
      });
      recordStore.writeSubjects(memoryDirOf(chatStore), speaker.uid, capped);

      // 中期：这一段的事件（没有抽到就给一条兜底事件）
      const midRecords = [];
      for (let i = 0; i < personEvents.length; i += 1) {
        const ev = personEvents[i];
        midRecords.push(record.makeRecord({
          kind: 'event',
          tier: 'M',
          text: ev.title && ev.summary ? `${ev.title}：${ev.summary}` : (ev.summary || ev.title || '一段聊天'),
          ts: now,
          scope,
          subject: speaker.uid,
          source,
          confidence: ev.confidence,
          importance: ev.importance,
          meta: {
            date,
            title: ev.title || '',
            summary: ev.summary || '',
            keywords: ev.keywords || [],
            participants: allUids,
            valence: ev.valence || 0,
            resolved: ev.resolved === true,
            episodeId: ep.id,
          },
        }));
        writtenEvents += 1;
      }
      if (!personEvents.length) {
        midRecords.push(record.makeRecord({
          kind: 'event',
          tier: 'M',
          text: (ep.activeTopic || messages.find((m) => m.role === 'user' && m.text) || {}).text?.slice(0, 20) || '一段聊天',
          ts: now,
          scope,
          subject: speaker.uid,
          source,
          confidence: extracted.fallback ? 0.55 : 0.7,
          importance: 0.5,
          meta: {
            date,
            title: (ep.activeTopic || '一段聊天').slice(0, 20),
            summary: summaryText || '这段聊了一会儿。',
            keywords: [],
            participants: allUids,
            episodeId: ep.id,
          },
        }));
        writtenEvents += 1;
      }
      if (midRecords.length) recordStore.appendTimeline(chat.dir, midRecords.filter(Boolean));
    }

    // 这一段自己的摘要也进 timeline（中期），和 summary.json 各自独立：
    // summary.json 管「prompt 窗口压缩到哪了」，digest 记录管「这段发生过什么」。
    chatStore.markRecordsDirty(chat);
    if (summaryText) {
      recordStore.appendTimeline(chat.dir, [record.makeRecord({
        kind: 'digest',
        tier: 'M',
        text: summaryText,
        ts: now,
        scope,
        source,
        confidence: 0.7,
        meta: { fromSeq: ep.messageSeqFrom || 0, toSeq: ep.messageSeqTo || 0, episodeId: ep.id },
      })].filter(Boolean));
    }

    // 幂等标记 + 清空 L3
    chat.meta.closedEpisodes = [...(chat.meta.closedEpisodes || []), ep.id].slice(-LIMITS.closedEpisodeMemory);
    chat.meta.lastClosedEpisodeId = ep.id;
    // 只追加本段摘要，不能 resetSummary：那会把之前 episode 的 segments 一起清空。
    // coverage 由 applySegment 在摘要真正写入后推进，失败时 recent 仍能看到原文。
    // 关闭不等于失忆：这一段的最终摘要留在 summary 里（后续事件段继续合并，上限 900 token），
    // 原文仍在 messages.jsonl；只是不再占 prompt 的 recent 缓冲。
    if (compression.applySegment(chat, {
      text: summaryText,
      fromSeq: ep.messageSeqFrom,
      toSeq: ep.messageSeqTo,
      now,
    })) {
      chat.summary.episodeId = ep.id;
    }
    if (chat.meta.episode && chat.meta.episode.id === ep.id) chat.meta.episode = null;
    chatStore.saveSummary(chat);
    chatStore.saveMeta(chat, { immediate: true });

    if (logger) {
      logger.info(`episode 关闭（${reason}）：事件 ${writtenEvents} 条、关系 ${writtenRelations} 条（chat ${tagId(chat.chatId)}）`);
    }
    return { closed: true, episodeId: ep.id, reason, events: writtenEvents, relations: writtenRelations, summary: summaryText };
  } finally {
    if (chat.closingEpisode === ep.id) delete chat.closingEpisode;
  }
}

/**
 * 在写入新消息前检查是否要换 episode。
 * @returns {{reason:string, promise:Promise|null}|null}
 */
function rotateIfNeeded({ chat, text = '', now = Date.now(), chatStore, llm = null, logger = null }) {
  const ep = chat.meta.episode;
  if (!ep) {
    episodeStart(chat, { now });
    return null;
  }
  const reason = shouldClose(chat, { text, now });
  if (!reason) return null;
  const snapshot = { ...ep };
  // 关闭动作是异步的，但 L3 缓冲要立刻推进水位：否则这一轮会把刚关闭的旧原文
  // 当成「刚发生」又塞回 prompt。最终摘要稍后由后台补进 summary。
  // 不在这里 reset/推进 coverage：异步摘要还没生成。等 closeEpisode 成功
  // applySegment 后再推进，否则进程中断会丢一整段对话。
  const promise = enqueue(chat, () => closeEpisode({ chat, chatStore, llm, logger, now, reason, episode: snapshot }))
    .catch((err) => {
      if (logger) logger.warn('episode 关闭失败（不影响聊天）：' + describeError(err));
      return null;
    });
  episodeStart(chat, { now });
  return { reason, promise };
}

/** 启动/空闲扫描：距上次消息超过 30 分钟就补写 L2 */
function closeIdleEpisodes({ chat, chatStore, llm = null, logger = null, now = Date.now() }) {
  const ep = chat.meta.episode;
  if (!ep) return null;
  if (now - ep.lastMessageAt < LIMITS.episodeIdleMinutes * 60000) return null;
  const snapshot = { ...ep };
  return enqueue(chat, () => closeEpisode({ chat, chatStore, llm, logger, now, reason: 'idle', episode: snapshot }))
    .catch((err) => {
      if (logger) logger.warn('补写 episode 失败：' + describeError(err));
      return null;
    });
}

module.exports = {
  TOPIC_SHIFT_RE,
  episodeStart,
  ensureEpisode,
  touchEpisode,
  shouldClose,
  episodeMessages,
  speakersOf,
  closeEpisode,
  rotateIfNeeded,
  closeIdleEpisodes,
  dateString,
  DAY_MS,
};





