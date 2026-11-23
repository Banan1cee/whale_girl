'use strict';

/**
 * 可见性策略层：决定「什么能公开」「公开给谁」「怎么改写」。
 *
 * record.js 里的 visibleTo 只回答「这条记录能不能出现在这个会话」，属于执行层；
 * 这里回答的是策略问题，两件事分开放，改规则不用动检索：
 *   1. 默认可见级由来源决定：私聊产生 = private（只回原私聊），群产生 = 本群可见；
 *   2. 只有明确晋升过的事实才会进共享池，且必须过黑名单；
 *   3. 晋升时做脱敏改写，原文里带手机号/地址/金额的直接拒绝；
 *   4. 提示词末尾那句声明的文案，按本次实际注入的内容动态生成。
 *
 * 黑名单是「宁可少说」的一侧：误拒只是她少提一句，误放是隐私泄漏。
 */

/** 明确拒绝晋升的内容类型：钱、病、住址、证件、感情状态 */
const SENSITIVE_RE = /(手机号?|电话|微信|身份证|护照|银行卡|密码|住址|家庭地址|门牌|小区|楼栋|单元|住在|(?:路|街|道)\s*\d+|\d+\s*号|工资|年薪|存款|欠款|贷款|信用卡|病情|确诊|住院|抑郁|焦虑症|怀孕|分手|离婚|彩礼)/;
/** 硬拒绝：看起来像证件/号码的数字串 */
const DIGITS_RE = /(1[3-9]\d{9}|\d{17}[\dXx]|\b\d{16,19}\b)/;
/** 只有这几类可以公开：称呼偏好、口味、兴趣、职业这种「别人问了也无所谓」的 */
const PROMOTABLE_KINDS = new Set(['preference', 'fact', 'trait', 'event']);
/** 最低置信度：一次情绪、一句玩笑不晋升 */
const MIN_CONFIDENCE = 0.6;

/**
 * 能不能从私聊/群聊晋升到共享池。
 * @param {object} record
 * @returns {{ok:boolean, reason:string}}
 */
function canPromote(record) {
  if (!record || !record.text) return { ok: false, reason: 'empty' };
  if (!PROMOTABLE_KINDS.has(record.kind)) return { ok: false, reason: 'kind' };
  if (record.state && record.state !== 'active') return { ok: false, reason: 'inactive' };
  if (DIGITS_RE.test(record.text) || SENSITIVE_RE.test(record.text)) return { ok: false, reason: 'sensitive' };
  if (Number(record.confidence) < MIN_CONFIDENCE) return { ok: false, reason: 'low_confidence' };
  return { ok: true };
}

/**
 * 脱敏：晋升时把「我」改成「TA」，并遮掉可能残留的号码。
 * 只做确定性的替换；需要真正改写成第三人称叙述时由调用方（模型）负责。
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
  return String(text || '')
    .replace(/^我/, 'TA')
    .replace(/我的/g, 'TA的')
    .replace(/我(?!们)/g, 'TA')
    .replace(DIGITS_RE, '[已隐去]')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 私聊产生的事实默认只在原私聊可见；群里的默认只在本群可见 */
function defaultAudience({ isGroup = false } = {}) {
  return isGroup ? 'all' : 'private';
}

/**
 * 本轮的 audience 描述，交给 record.visibleTo 用。
 * @param {{chatHash:string, isGroup:boolean, uid:string, roster?:Iterable<string>}} ctx
 */
function buildAudience({ chatHash = '', isGroup = false, uid = '', roster = [] } = {}) {
  return {
    chatHash: String(chatHash),
    isGroup: isGroup === true,
    uid: String(uid || ''),
    roster: roster instanceof Set ? roster : new Set(Array.isArray(roster) ? roster.map(String) : []),
  };
}

/**
 * 提示词末尾的可见性声明。
 *
 * 以前是写死的一句「这些只来自当前这个聊天」；现在有共享池了，
 * 必须告诉模型哪些能用、哪些只是它自己知道，否则它会顺嘴把私聊内容当谈资。
 */
function scopeNotice({ hasShared = false, hasPrivate = false } = {}) {
  if (hasShared && hasPrivate) {
    return '（标了「公开」的可以说；没标的只来自当前这个聊天，别提别的聊天里的事，被问到就说“这个我不清楚”。）';
  }
  if (hasShared) {
    return '（标了「公开」的可以说；其它事一律说“这个我不清楚”。）';
  }
  return '（这些只来自当前这个聊天；别提别的聊天里的事，被问到就说“这个我不清楚”。）';
}

module.exports = {
  SENSITIVE_RE,
  DIGITS_RE,
  PROMOTABLE_KINDS,
  MIN_CONFIDENCE,
  canPromote,
  redact,
  defaultAudience,
  buildAudience,
  scopeNotice,
};
