'use strict';

/**
 * 小助手模式：她回完一句之后，只对「她刚回的那个人」开一小段接话窗口。
 *
 * 这一块是从大肥鱼（dafeiyu-wechat-ai-1.2.0）的追问逻辑搬过来的，和原来那套
 * 「接话后保持参与 N 分钟」（trigger.js 里的 engagedUntil + engagedBy，谁说话都能算）
 * 是两套不同的东西，所以单独成一个模块、单独一个功能开关 features.assistantMode：
 *
 *   - 打开：只有 lastBotSenderId 那个人能顺着接，最多 turns 句；别人一插话、
 *           或者这条明显在叫别人，窗口当场收口。
 *   - 关掉：整块不生效，回到旧行为（engagedUntil 那套 + 老的「3 分钟内带你」兜底）。
 *
 * 纯逻辑：不联网、不读文件、不写库；state 由 chatStore 的 session.state 提供。
 * 判定规则（ACK、问句、叫别人名字、追问线索）在 ./followup 里，这里只管「窗口」。
 */

const features = require('../infra/features');
const followup = require('./followup');

const DEFAULT_TURNS = 3;
const DEFAULT_SECONDS = 180;
const DEFAULT_ENGAGED_MINUTES = 6;

/** 开关是否打开（缺省按 REGISTRY 的 default） */
function isOn(config) {
  return features.isOn(config || {}, 'assistantMode');
}

function intIn(raw, def, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 一轮最多顺接几句（0 = 只回被点到的那一句） */
function turns(config) {
  return intIn(config && config.group ? config.group.assistantTurns : undefined, DEFAULT_TURNS, 0, 20);
}

/** 窗口有效秒数 */
function seconds(config) {
  return intIn(config && config.group ? config.group.assistantSeconds : undefined, DEFAULT_SECONDS, 10, 3600);
}

function engagedMinutes(config) {
  return Math.max(1, Number(config && config.group ? config.group.engagedMinutes : 0) || DEFAULT_ENGAGED_MINUTES);
}

/** 被人 @ / 叫名字 / 点名叫她说话：重新开一轮额度 */
function noteExplicitTrigger(config, state) {
  if (!state) return;
  followup.noteExplicitTrigger(state, { turns: turns(config) });
}

/**
 * 她刚发完一句：记下回的是谁、说了什么、还剩几句，窗口从现在开始算。
 * 只应该对群聊调用（私聊不需要窗口）。
 */
function noteReply({ config, state, senderId, text, nowMs }) {
  if (!state) return;
  followup.noteBotReply(state, {
    senderId,
    text,
    nowMs,
    turns: turns(config),
  });
}

function closeWindow(state) {
  state.engagedUntil = 0;
  state.engagedBy = '';
}

/**
 * 小助手模式的主判定：这条群消息要不要顺着接。
 *
 * @returns {{wake:boolean, reason:string}|null} null = 这一块没接管，继续走后面的判定
 */
function judge({ config, msg, clean, state, nowMs }) {
  if (!isOn(config)) return null;
  if (!followup.windowOpen(state, { nowMs, seconds: seconds(config) })) return null;

  const senderNow = String((msg && msg.senderId) || '');
  const lastTo = String(state.lastBotSenderId || '');
  const open = followup.remainingTurns(state) > 0 && !state.followInterrupted;
  if (!open || !lastTo) return null;

  // 别人插话：立刻收口。旧逻辑这时还会按 engaged 接，于是她老在别人的对话里插嘴。
  if (senderNow && senderNow !== lastTo) {
    followup.interrupt(state, 'other_speaker');
    closeWindow(state);
    return null;
  }
  if (senderNow !== lastTo) return null;

  const persona = (config && config.persona) || {};
  const verdict = followup.decide({
    text: clean && clean.text,
    state,
    config,
    botNames: [persona.name, ...(Array.isArray(persona.aliases) ? persona.aliases : [])].filter(Boolean),
    otherNames: Array.isArray(msg && msg.otherMemberNames) ? msg.otherMemberNames : [],
    isGroup: true,
  });
  if (verdict === 'AI') {
    state.followLeft = Math.max(0, followup.remainingTurns(state) - 1);
    state.engagedUntil = nowMs + engagedMinutes(config) * 60000;
    state.engagedBy = senderNow;
    return { wake: true, reason: 'followup' };
  }
  if (verdict === 'OTHER') {
    followup.interrupt(state, 'addressed_other');
    closeWindow(state);
  }
  return null;
}

module.exports = {
  isOn,
  turns,
  seconds,
  noteExplicitTrigger,
  noteReply,
  judge,
};
