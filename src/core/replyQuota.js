'use strict';

const WINDOW_MS = 60000;

/** 内存和存储是同一批回复的两种投影，取较大值而不是相加。 */
function recentReplyCount(bot, { key, state, nowMs }) {
  const since = nowMs - WINDOW_MS;
  let count = (Array.isArray(state?.replyTimes) ? state.replyTimes : []).filter(t => Number(t) > since).length;
  try {
    const stored = bot.store.messages(key, 200).filter(m => m.role === 'assistant' && Number(m.ts) > since).length;
    count = Math.max(count, stored);
  } catch { /* 存储不可读时仍保留内存与最后回复的兜底。 */ }
  if (!count && Number(state?.lastReplyAt) > since) count = 1;
  return count;
}

class ReplyQuota {
  constructor({ now, getGlobal, setGlobal, globalCap }) {
    this.now = now;
    this.getGlobal = getGlobal;
    this.setGlobal = setGlobal;
    this.globalCap = globalCap;
    this.pending = new Map();
    this.committed = new Map();
  }

  sweep() {
    const now = this.now();
    this.setGlobal(this.getGlobal().filter(t => now - Number(t) < WINDOW_MS));
    for (const [lease, entry] of this.pending) {
      // 只回收无人继续消费的 decide 结果；仍在 await 模型/插件的工作不能过期超发。
      if (!entry.active && now - entry.idleAt >= WINDOW_MS) this.pending.delete(lease);
    }
    for (const [key, values] of this.committed) {
      const recent = values.filter(t => now - t < WINDOW_MS);
      if (recent.length) this.committed.set(key, recent);
      else this.committed.delete(key);
    }
  }

  reserve(key, recent, cap) {
    this.sweep();
    let sameSession = 0;
    for (const entry of this.pending.values()) if (entry.key === key) sameSession++;
    const committed = Math.max(recent, (this.committed.get(key) || []).length);
    if (cap > 0 && committed + sameSession >= cap) return { reason: 'burst_limit' };
    if (this.getGlobal().length + this.pending.size >= this.globalCap) return { reason: 'global_minute_cap' };
    const lease = Object.freeze({});
    this.pending.set(lease, { key, active: true, idleAt: this.now() });
    return { lease };
  }

  activate(lease) {
    this.sweep();
    const entry = this.pending.get(lease);
    if (!entry) return false;
    entry.active = true;
    return true;
  }

  idle(lease) {
    const entry = this.pending.get(lease);
    if (entry) { entry.active = false; entry.idleAt = this.now(); }
  }

  release(lease) {
    return this.pending.delete(lease);
  }

  commit(lease, key) {
    if (lease && !this.pending.delete(lease)) return false;
    this.sweep();
    const at = this.now();
    const global = this.getGlobal();
    global.push(at);
    this.setGlobal(global.length > 600 ? global.slice(-300) : global);
    const values = this.committed.get(key) || [];
    values.push(at);
    this.committed.set(key, values);
    return true;
  }
}

module.exports = { recentReplyCount, ReplyQuota };
