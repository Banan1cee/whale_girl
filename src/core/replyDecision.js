'use strict';

// 只暂存普通回复路径会写的字段；旁听、去重、提醒和管理员路径不回滚。
const FIELDS = ['silentUntil', 'engagedUntil', 'engagedBy', 'consent', 'discussUntil', 'seriousByUser'];
const MAP_FIELDS = new Set(['consent', 'seriousByUser']);
const copy = value => value === undefined ? undefined : structuredClone(value);

function draftReplyState(state) {
  const draft = { ...state };
  const before = {};
  for (const field of FIELDS) {
    before[field] = copy(state[field]);
    if (Object.hasOwn(state, field)) draft[field] = copy(state[field]);
  }
  return { before, draft };
}

function replyPlan(action, reason, before, draft) {
  const effects = [];
  if (action === 'reply') for (const field of FIELDS) {
    if (JSON.stringify(before[field]) !== JSON.stringify(draft[field])) {
      effects.push(Object.freeze({ field, before: copy(before[field]), value: copy(draft[field]) }));
    }
  }
  return Object.freeze({ action, reason, effects: Object.freeze(effects) });
}

function applyReplyPlan(state, plan) {
  for (const effect of plan.effects) {
    if (MAP_FIELDS.has(effect.field)) {
      const target = state[effect.field] || (state[effect.field] = {});
      const before = effect.before || {};
      const value = effect.value || {};
      for (const key of new Set([...Object.keys(before), ...Object.keys(value)])) {
        if (JSON.stringify(before[key]) === JSON.stringify(value[key])) continue;
        if (Object.hasOwn(value, key)) target[key] = copy(value[key]);
        else if (JSON.stringify(target[key]) === JSON.stringify(before[key])) delete target[key];
      }
    } else state[effect.field] = copy(effect.value);
  }
}

module.exports = { draftReplyState, replyPlan, applyReplyPlan };
