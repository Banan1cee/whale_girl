'use strict';

/**
 * 输出侧兜底：群聊回复发出去之前，再过一遍「不该说」的检查。
 *
 * 必须说清楚它的边界：**这不是隐私保障，是补丁。** 真正的保障是那些内容
 * 根本没进上下文（record.visibleTo + 物理隔离的共享池）。这里挡的是两类
 * 模型才有可能犯的错：
 *
 *   1. 来源泄漏：她把「你私聊跟我说过」这种出处说出来。内容本身可能已经公开，
 *      但出处一旦被点破，就等于告诉群里「她和我有私聊」。
 *   2. 敏感号码：手机号 / 身份证 / 银行卡这类数字串漏进正文。
 *
 * 指纹比对（和调用方给的 secrets 比对）只在调用方给了才做；群聊里通常为空，
 * 因为私聊事实压根不该出现在那个上下文里。
 *
 * 命中后的处理很简单：整条改成一句安全回复。宁可少说一句，也不赌模型转述的分寸。
 */

const SOURCE_LEAK_RE = /(私聊|私下|单独(?:跟我|和你|跟我)|你(?:上次|之前|那天)(?:跟我|和我|私下)?(?:说|提|聊)过|我们(?:私聊|私下)说|你(?:在)?(?:微信)?(?:跟我)?说过的)/;
const SENSITIVE_RE = /(1[3-9]\d{9}|\d{17}[\dXx]|\b\d{16,19}\b)/;

const DEFAULT_THRESHOLD = 0.35;
const SAFE_REPLY = '这个我不清楚呀';

/** 字符 bigram 指纹；和 retrieval/search 同一套口径，不引分词库 */
function fingerprint(text) {
  const s = String(text || '').replace(/[\s\p{P}]+/gu, '');
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

/** 重合度：交集 / 较短一侧，避免长句把短句「稀释」成安全 */
function similarity(a, b) {
  const setB = b instanceof Set ? b : fingerprint(b);
  const setA = a instanceof Set ? a : fingerprint(a);
  if (!setA.size || !setB.size) return 0;
  let hit = 0;
  for (const gram of setA) if (setB.has(gram)) hit += 1;
  return hit / Math.min(setA.size, setB.size);
}

/**
 * @param {string} text 回复正文
 * @param {{secrets?:Array<string|{text:string}>, threshold?:number}} [opts]
 * @returns {{leak:boolean, reason:string, score:number}}
 */
function check(text, { secrets = [], threshold = DEFAULT_THRESHOLD } = {}) {
  const reply = String(text || '');
  if (!reply.trim()) return { leak: false, reason: 'empty', score: 0 };
  if (SOURCE_LEAK_RE.test(reply)) return { leak: true, reason: 'source_leak', score: 1 };
  if (SENSITIVE_RE.test(reply)) return { leak: true, reason: 'sensitive_number', score: 1 };
  const prints = (secrets || [])
    .map((s) => (typeof s === 'string' ? s : (s && s.text)))
    .filter(Boolean)
    .map(fingerprint);
  if (prints.length) {
    const replyPrint = fingerprint(reply);
    for (const print of prints) {
      const score = similarity(replyPrint, print);
      if (score >= threshold) return { leak: true, reason: 'secret_fact', score: Number(score.toFixed(3)) };
    }
  }
  return { leak: false, reason: 'ok', score: 0 };
}

/** 命中后的安全替换 */
function safeReply() {
  return SAFE_REPLY;
}

module.exports = {
  SOURCE_LEAK_RE,
  SENSITIVE_RE,
  SAFE_REPLY,
  DEFAULT_THRESHOLD,
  fingerprint,
  similarity,
  check,
  safeReply,
};
