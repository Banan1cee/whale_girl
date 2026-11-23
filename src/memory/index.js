'use strict';

/**
 * 记忆模块的唯一对外入口。
 *
 * 现在 pipeline 直接调了 store 的二十来个方法，等于把「记忆怎么存」摊在对话流程里。
 * 这里收成四个动作：ingest（写）/ consolidate（升）/ recall（读）/ forget（降级或删）。
 * pipeline 只 import 这一个文件，不再碰人物卡、事件、摘要这些结构。
 *
 * 迁移是分阶段的（见 docs/记忆系统.md）：
 *   PR1：recall 转发给 store.buildContext，行为与改造前逐字段一致；
 *   PR3：recallArchive 打开时，额外在长期档案上做一次 BM25 召回；
 *   PR5：recall 换成纯 record 三层投影，转发实现删除。
 */

const record = require('./record');
const search = require('./search');
const scope = require('./scope');
const leakGuard = require('./leakGuard');
const formatVersion = require('./formatVersion');
const { MEMORY_SCOPE_NOTICE } = require('./format');
const { estimateBudgetTokens } = require('./tokens');

/** 默认给「相关回忆」多少 token：@5,500 预算下从 recent 里切 700 */
const RECALL_BUDGET = 700;
const RECALL_TOP_K = 3;
/** 公开信息段：只放几条最能用的，不跟相关回忆抢预算 */
const SHARED_BUDGET = 300;
const SHARED_TOP_K = 6;

/** 一条回忆最多占多少字：太长会把同一条里的无关内容一起塞进去 */
const RECALL_ITEM_CHARS = 220;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayStamp(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 把检索结果渲染成分节文本。
 * 带日期：模型分得清「刚才说的」和「上个月说的」；不带日期它会把旧事当新闻。
 * @param {Array<{chunk:object}>} hits
 * @param {{budget?:number}} [opts]
 * @returns {{text:string, tokens:number}}
 */
function renderRecall(hits, { budget = RECALL_BUDGET } = {}) {
  const list = (Array.isArray(hits) ? hits : []).filter((h) => h && h.chunk && h.chunk.text);
  if (!list.length) return { text: '', tokens: 0 };
  const limit = Math.max(60, Number(budget) || RECALL_BUDGET);
  const lines = list.map(({ chunk }) => {
    const flat = String(chunk.text).split('\n').map((s) => s.trim()).filter(Boolean).join(' / ');
    const clipped = flat.length > RECALL_ITEM_CHARS ? `${flat.slice(0, RECALL_ITEM_CHARS)}…` : flat;
    return `[${dayStamp(chunk.ts)}] ${clipped}`;
  });
  const build = () => `【相关回忆】\n${lines.join('\n')}`;
  let text = build();
  // 超预算从最后一条往前丢：命中的前几条相关度最高
  while (lines.length > 1 && estimateBudgetTokens(text) > limit) {
    lines.pop();
    text = build();
  }
  if (estimateBudgetTokens(text) > limit) {
    // 单条就超预算：硬裁，别把 recent 挤没
    const keep = Math.max(80, limit * 4);
    text = text.slice(0, keep) + '…';
  }
  return { text, tokens: estimateBudgetTokens(text) };
}

/**
 * 公开信息段。每条都标 [公开]，并明确写在提示词里「标了公开的才可以说」。
 * 不带日期：公开档案是「她是谁」的一部分，不是某天发生的事。
 */
function renderShared(records, { budget = SHARED_BUDGET } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r && r.text);
  if (!list.length) return { text: '', tokens: 0 };
  const limit = Math.max(40, Number(budget) || SHARED_BUDGET);
  const lines = list.slice(0, SHARED_TOP_K).map((r) => {
    const text = String(r.text).replace(/\s+/g, ' ').trim();
    const clipped = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    return `[公开] ${clipped}`;
  });
  const build = () => `【可以公开的信息】\n${lines.join('\n')}`;
  let text = build();
  while (lines.length > 1 && estimateBudgetTokens(text) > limit) {
    lines.pop();
    text = build();
  }
  return { text, tokens: estimateBudgetTokens(text) };
}

/**
 * 读：一次拿到本轮要用的全部记忆。
 *
 * 返回结构和 store.buildContext 保持一致（pipeline 只读这几个字段），
 * 额外加 schema / parts 两个说明性字段：
 *   parts 是各层的 token 占用，日志和状态面板按它显示，不再各自估算。
 *
 * @param {object} store Store 实例
 * @param {object} options 见 store.buildContext；额外支持
 *   recallArchive：是否在长期档案上召回（features.memoryV2）
 *   recallBudget：召回段 token 预算
 *   sharedPool：是否注入共享池里的公开事实（features.memoryV2）
 *   sharedBudget：公开段 token 预算
 */
function recall(store, options = {}) {
  if (!store || typeof store.buildContext !== 'function') {
    throw new TypeError('memory.recall 需要 Store 实例');
  }
  const mem = store.buildContext(options);
  const parts = partsOf(mem);
  const out = { ...mem, schema: 'memory-v2', parts };
  // 提示词末尾那句声明先摘掉，最后按「这次到底注入了什么」重新生成一份。
  // 不摘的话，加了共享池之后它还写着「这些只来自当前这个聊天」，等于骗模型。
  const baseBlock = String(mem.block || '').split(MEMORY_SCOPE_NOTICE).join('').trim();

  if (options.recallArchive && options.key && options.query) {
    try {
      const hits = store.searchArchive(options.key, options.query, { topK: RECALL_TOP_K });
      // 已经在 recent 里的块不要重复出现
      const fresh = search.filterFresh(hits, (mem.recent || []).map((m) => m.seq));
      const section = renderRecall(fresh, { budget: options.recallBudget || RECALL_BUDGET });
      if (section.text) {
        out.block = (baseBlock ? `${baseBlock}\n\n` : '')
          + section.text + '\n\n' + MEMORY_SCOPE_NOTICE;
        out.parts = { ...out.parts, recall: section.tokens };
        out.recall = fresh.map((hit) => hit.chunk);
      }
    } catch (err) {
      // 检索是加分项：索引坏了 / 消息里有脏数据，都不能让整块记忆失败
      out.recallFailed = true;
      out.recallError = String((err && err.message) || err).slice(0, 200);
    }
  }

  if (options.sharedPool && options.key) {
    try {
      const { records } = store.sharedFor(options.key, {
        uid: options.uid,
        isGroup: options.isGroup,
        mentionedNames: options.mentionedNames,
      });
      const section = renderShared(records, { budget: options.sharedBudget || SHARED_BUDGET });
      if (section.text) {
        const current = String(out.block || '').split(MEMORY_SCOPE_NOTICE).join('').trim();
        out.block = (current ? `${current}\n\n` : '') + section.text + '\n\n'
          + scope.scopeNotice({ hasShared: true, hasPrivate: Boolean(current) });
        out.parts = { ...out.parts, shared: section.tokens };
        out.shared = records;
      }
    } catch (err) {
      // 共享池坏了也只少一段「公开信息」，不能因此毁掉整块记忆
      out.sharedFailed = true;
      out.sharedError = String((err && err.message) || err).slice(0, 200);
    }
  }
  return out;
}

/** 各层占了多少 token —— 只做展示/日志，不参与裁剪决策 */
function partsOf(mem) {
  const m = mem || {};
  return {
    working: Number(m.recentTokens) || 0,
    mid: Number(m.summaryTokens) || 0,
    long: Number(m.memoryTokens) || 0,
    recall: 0,
    shared: 0,
    relations: Number(m.relationsTokens) || 0,
  };
}

/**
 * 写：消息落盘 + 短期记账。
 * 同步、不调模型；episode 关闭与模型抽取都在 consolidate 里。
 */
function ingest(store, key, message) {
  if (!store || typeof store.appendMessage !== 'function') {
    throw new TypeError('memory.ingest 需要 Store 实例');
  }
  return store.appendMessage(key, message);
}

/**
 * 升：episode 关闭时把这段转成中期摘要，并按规则提升到长期。
 * 接线在 PR5（切换 PR）；现在显式返回 skipped，免得调用方以为已经写进去了。
 */
function consolidate() {
  return { skipped: true, reason: 'not_implemented' };
}

/** 降级 / 删除：PR5 之后接 record.capRecords + 档案 prune */
function forget() {
  return { skipped: true, reason: 'not_implemented' };
}

/**
 * 晋升一条事实到共享池。显式操作，不在聊天热路径上。
 * 返回 {ok, reason?}：被黑名单拒绝时 reason 会说明原因，方便调用方给用户提示。
 */
function promoteFact(store, key, uid, target, opts) {
  if (!store || typeof store.promoteFact !== 'function') {
    throw new TypeError('memory.promoteFact 需要 Store 实例');
  }
  return store.promoteFact(key, uid, target, opts);
}

/** 撤销公开：只删共享池副本，聊天里的源记录不动 */
function revokeShared(store, uid, id) {
  if (!store || typeof store.revokeShared !== 'function') {
    throw new TypeError('memory.revokeShared 需要 Store 实例');
  }
  return store.revokeShared(uid, id);
}

/**
 * 输出侧兜底：回复发出去之前检查一次。
 * 只在群聊调用；私聊里同一句话不构成「泄漏」。
 */
function guardReply(text, options = {}) {
  return leakGuard.check(text, options);
}

module.exports = {
  FORMAT_VERSION: formatVersion.FORMAT_VERSION,
  RECALL_BUDGET,
  RECALL_TOP_K,
  SHARED_BUDGET,
  record,
  search,
  scope,
  leakGuard,
  formatVersion,
  recall,
  ingest,
  consolidate,
  forget,
  promoteFact,
  revokeShared,
  guardReply,
  partsOf,
  renderRecall,
  renderShared,
};
