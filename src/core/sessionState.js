'use strict';

/**
 * 会话状态的唯一读写入口：静默 / 禁言 / 接话窗口。
 *
 * 这些字段以前在 trigger、chat、canned 里分别手写，写入时机不同，
 * 于是出现「被静音的消息还续了接话窗口」「退场后一个问号就能解除」。
 * 这里不做策略判断，只保证时间语义和边界一致。
 */

function nowMsOf(value, fallback = Date.now()) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isSilent(state, nowMs) {
  return Number(state && state.silentUntil) > nowMsOf(nowMs);
}

function isMuted(state, nowMs) {
  return Number(state && state.mutedUntil) > nowMsOf(nowMs);
}

function engagedWith(state, senderId, nowMs) {
  return Boolean(
    state
    && Number(state.engagedUntil) > nowMsOf(nowMs)
    && String(state.engagedBy || '') === String(senderId || ''),
  );
}

function touchEngagement(state, senderId, nowMs, minutes) {
  if (!state) return 0;
  const mins = Math.max(1, Number(minutes) || 6);
  state.engagedUntil = nowMsOf(nowMs) + mins * 60000;
  state.engagedBy = String(senderId || '');
  return state.engagedUntil;
}

function clearEngagement(state) {
  if (!state) return;
  state.engagedUntil = 0;
  state.engagedBy = '';
}

function clearSilent(state) {
  if (state) state.silentUntil = 0;
}

module.exports = {
  isSilent,
  isMuted,
  engagedWith,
  touchEngagement,
  clearEngagement,
  clearSilent,
};
