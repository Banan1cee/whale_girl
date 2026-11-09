'use strict';

/**
 * 接话窗口（follow-up）：移植自 dafeiyu-wechat-ai 的追问逻辑。
 *
 * 原来的群聊规则只有一条「被 @ 一次 → 6 分钟内谁接话都回」，窗口纯按时间算，
 * 于是她会在别人的对话里反复插嘴：别人刚聊起来，她凭时间窗跳出来接一句。
 * 这里给窗口加两个硬约束（对应对方的 FOLLOW_UP_TURNS / FOLLOW_UP_BLOCK_ON_OTHER）：
 *
 *   1. 一次窗口最多接 N 句，说完就收；
 *   2. 窗口只对「她最后回的那个人」有效，别人一插话立刻收口，
 *      想继续聊请重新 @ / 叫名字。
 *
 * 另外先分「在跟她说话」还是「在跟别人说话」：叫别人名字、@ 别人、
 * 纯捧场（哈哈 / 好的 / 收到）都不算接话 —— 对应对方的 followup_decision。
 *
 * 纯逻辑：只读写传入的 state，不发请求、不落盘，方便单测。
 */

/** 纯捧场/敷衍，不值得为它再开一轮 */
const ACKS = new Set([
  '好', '好的', '好滴', '好吧', '嗯', '嗯嗯', '哦', '行', '可以', '收到',
  '谢谢', '谢了', '哈哈', '哈哈哈', '哈', '666', '牛', '厉害', 'ok',
]);

/** 明确的「还在跟我说」信号 */
const FALLBACK_HINTS = [
  '为啥', '为什么', '怎么', '咋', '啥意思', '什么意思', '然后', '还有',
  '继续', '不对', '不是', '所以', '帮我', '再来', '换个', '说说', '解释',
  '行不行', '可以吗', '能不能', '是不是', '对不对', '什么', '啥', '哪',
  '多少', '如何', '看看', '看下', '给我', '发我', '人呢', '在吗',
  '刚才', '刚刚', '你说', '你刚', '觉得', '认为', '咋办', '怎么办',
];

/** 太弱的词：单独出现不代表在跟她说话（"真的" "哈哈" 经常是旁人的感慨） */
const WEAK_HINTS = new Set([
  '你', '您', '吗', '真的', '累', '困', '饿', '开心', '难过', '笑死',
  '好耶', '无语', '服了', '确实', '哈哈',
]);

/** 群聊里的泛称：没带具体指代时，大概率是在跟「大家」说话，不是跟她 */
const GROUP_WORDS = ['你们', '大家', '各位', '兄弟们', '姐妹们'];
const GROUP_CUES = /(刚才|刚刚|你说|你刚|怎么|为什么|这个|那个)/;
const QUESTION_MARK = /[?？吗呢吧]/;
const ASK_VERBS = /(帮|说|看|发|来|觉得|认为)/;
const CONNECTIVE = /^(然后|还有|所以|可是|但是|不过|对了|不是)/;

function norm(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/** 她最后一句是不是问句（问句意味着对方在回答她，短句也算接话） */
function botAskedQuestion(lastText) {
  const t = norm(lastText).replace(/[ \t\r\n。.！!…~～]+$/, '');
  return Boolean(t) && /[？?]$/.test(t);
}

/**
 * 这句话是不是在叫别人。
 * @param {string} text
 * @param {{botNames?: string[], otherNames?: string[]}} opts
 */
function isOtherAddressed(text, { botNames = [], otherNames = [] } = {}) {
  const t = norm(text);
  if (!t) return false;
  if (t.startsWith('@')) {
    const rest = t.slice(1).trim();
    const mine = botNames.some((n) => n && rest.startsWith(norm(n)));
    return !mine; // @ 的不是她
  }
  for (const raw of otherNames) {
    const name = norm(raw);
    if (!name) continue;
    if (t.startsWith('@' + name)) return true;
    if (t.startsWith(name)) {
      const rest = t.slice(name.length);
      if (!rest) return true;
      if (' \t\r\n，,：:、。.!！?？~～-—'.includes(rest[0])) return true;
      // 两个字以上的名字出现在句首，基本就是在喊人（"老王你今天…"）
      if (name.length >= 2) return true;
    }
  }
  return false;
}

/** 这句话里有没有「继续跟我说」的线索 */
function hasFollowupCue(text, { hints = [] } = {}) {
  const t = norm(text);
  if (!t) return false;
  // 「你们 / 大家」+ 没有具体指代 → 在跟群里说话，不接
  if (GROUP_WORDS.some((w) => t.includes(w)) && !GROUP_CUES.test(t)) return false;
  const all = new Set(FALLBACK_HINTS);
  for (const raw of hints) {
    const h = norm(raw);
    if (h && !WEAK_HINTS.has(h)) all.add(h);
  }
  for (const h of all) if (t.includes(h)) return true;
  if (/你|您/.test(t)) {
    if (QUESTION_MARK.test(t)) return true;
    if (ASK_VERBS.test(t)) return true;
  }
  return CONNECTIVE.test(t);
}

/**
 * 判断这一句该不该接。
 * @returns {'AI'|'OTHER'|''} AI = 在跟她说；OTHER = 在跟别人说；'' = 拿不准/不接
 */
function decide({ text, state, config = {}, botNames = [], otherNames = [], isGroup = true } = {}) {
  const t = norm(text);
  if (!t) return '';
  if (t.length > 300) return ''; // 一段小作文多半不是接话，别硬接
  if (/^https?:\/\//i.test(t)) return '';
  if (ACKS.has(t.toLowerCase())) return '';
  if (!isGroup) return 'AI'; // 私聊没有「跟别人说话」这回事
  if (isOtherAddressed(t, { botNames, otherNames })) return 'OTHER';
  const st = state || {};
  if (st.followInterrupted) return '';
  if (botAskedQuestion(st.lastBotText) && t.length <= 80) return 'AI';
  const hints = Array.isArray(config.group && config.group.assistantHints)
    ? config.group.assistantHints
    : [];
  return hasFollowupCue(t, { hints }) ? 'AI' : '';
}

/** 窗口还开着吗（她的最后一句在 assistantSeconds 内） */
function windowOpen(state, { nowMs, seconds = 180 } = {}) {
  const st = state || {};
  const last = Number(st.lastBotAt) || 0;
  if (!last) return false;
  const span = Math.max(10, Number(seconds) || 180) * 1000;
  return nowMs - last <= span;
}

/** 她还剩几句接话额度 */
function remainingTurns(state) {
  return Math.max(0, Number((state || {}).followLeft) || 0);
}

/** 她刚说完一句：重开窗口，重置额度（对应对方的 note_bot_reply） */
function noteBotReply(state, { senderId = '', text = '', nowMs = 0, turns = 3 } = {}) {
  const st = state || {};
  st.lastBotAt = Number(nowMs) || 0;
  st.lastBotSenderId = String(senderId || '');
  st.lastBotText = String(text || '').slice(0, 300);
  st.followLeft = Math.max(0, Number(turns) || 0);
  st.followInterrupted = false;
  return st;
}

/** 被明确叫到（@ / 叫名字）也算重开窗口，只是不写 lastBotText */
function noteExplicitTrigger(state, { turns = 3 } = {}) {
  const st = state || {};
  st.followLeft = Math.max(0, Number(turns) || 0);
  st.followInterrupted = false;
  return st;
}

/** 收口：额度清零，并标记「这一段已经断了」，免得同一条消息又把窗口续上 */
function interrupt(state, reason = '') {
  const st = state || {};
  const had = Number(st.followLeft) > 0 || !st.followInterrupted;
  st.followLeft = 0;
  st.followInterrupted = true;
  return had ? reason : '';
}

/** 重置（换话题 / 静音等场景） */
function reset(state) {
  const st = state || {};
  st.followLeft = 0;
  st.followInterrupted = true;
  st.lastBotAt = 0;
  st.lastBotText = '';
  st.lastBotSenderId = '';
  return st;
}

module.exports = {
  ACKS,
  FALLBACK_HINTS,
  WEAK_HINTS,
  norm,
  botAskedQuestion,
  isOtherAddressed,
  hasFollowupCue,
  decide,
  windowOpen,
  remainingTurns,
  noteBotReply,
  noteExplicitTrigger,
  interrupt,
  reset,
};
