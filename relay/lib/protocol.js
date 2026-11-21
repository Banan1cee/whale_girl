'use strict';
// 前台和工人之间只用自然语言，不搞 JSON 协议：多一层 schema，就多一处模型会写错、我们要兜底的地方。
// 三个【标记】只是给中继分流用的路牌：写错、漏写时中继能退化成「整段话都当回复」，不会丢消息。

const DESK = { reply: '回复客户', dispatch: '派单', requirements: '需求更新' };
const WORKER = { report: '给前台', questions: '需要确认', outputs: '产出' };

// 从一段自然语言里按【标记】切段。同一标记出现多次时按顺序拼接。
function sections(text, labels) {
  const src = String(text == null ? '' : text);
  const names = labels.join('|');
  const re = new RegExp('【\\s*(' + names + ')\\s*】', 'g');
  const hits = [];
  let m;
  while ((m = re.exec(src)) !== null) hits.push({ label: m[1], start: m.index, body: re.lastIndex });
  const out = { matched: hits.length > 0, raw: src };
  for (let i = 0; i < hits.length; i += 1) {
    const stop = i + 1 < hits.length ? hits[i + 1].start : src.length;
    const body = src.slice(hits[i].body, stop).trim();
    out[hits[i].label] = out[hits[i].label] ? out[hits[i].label] + '\n' + body : body;
  }
  return out;
}

function lines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*·•]|\d+[.、)])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

// 微信里 markdown 只会变成一堆星号，统一抹掉；顺带压掉模型爱加的「恭敬结尾」。
const TICK = String.fromCharCode(96);
const FENCE = TICK + TICK + TICK;
const EMPHASIS = /[*_\u0060]{1,3}([^*_\u0060\n]+)[*_\u0060]{1,3}/g;
function cleanForWeChat(text, maxChars) {
  let s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  s = s.split(FENCE).join('');
  s = s.replace(EMPHASIS, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  s = s.replace(/^\s*(?:[-*•]|\d+[.、)])\s+/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  const cap = Number(maxChars) || 0;
  if (cap > 0 && s.length > cap) s = s.slice(0, cap - 1).replace(/[\s，。；、]$/, '') + '…';
  return s;
}

// 桥接的发送通道是「零焦点逐字输入」，40ms 一个字：一条 500 字的消息光打字就要 20 秒，
// 还会顶掉发送看门狗。拆成几条短消息，既像人在说话，也不会把通道打爆。
function splitBubbles(text, maxChars) {
  const cap = Math.max(40, Number(maxChars) || 180);
  const src = String(text == null ? '' : text).trim();
  if (!src) return [];
  const parts = [];
  let rest = src;
  while (rest.length > cap) {
    // 优先在句末断开，其次在逗号/空格，最差硬切
    const window = rest.slice(0, cap);
    let cut = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('\n')
    );
    if (cut < cap * 0.5) cut = Math.max(window.lastIndexOf('，'), window.lastIndexOf('；'), window.lastIndexOf(' '));
    if (cut < cap * 0.3) cut = cap - 1;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

function parseDesk(text) {
  const s = sections(text, Object.values(DESK));
  const replyRaw = s[DESK.reply] || (s.matched ? '' : s.raw);
  return {
    matched: s.matched,
    reply: String(replyRaw || '').trim(),
    dispatch: String(s[DESK.dispatch] || '').trim() || null,
    requirements: lines(s[DESK.requirements]),
  };
}

function parseWorker(text) {
  const s = sections(text, Object.values(WORKER));
  const reportRaw = s[WORKER.report] || (s.matched ? '' : s.raw);
  return {
    matched: s.matched,
    report: String(reportRaw || '').trim(),
    questions: lines(s[WORKER.questions]),
    outputs: lines(s[WORKER.outputs]),
  };
}

// 前台的人设写死在代码里而不是配置里：它决定「谁能对客户说什么」，随手改配置就会绕过口径约束。
const DESK_PERSONA = [
  '你是本公司的项目对接人，在微信上代表公司跟客户谈项目。客户看不到公司内部，也不该知道自己是在跟系统说话。',
  '你的职责只有四件：把客户的需求问清楚；把问清楚的需求转成给工程的任务；把工程的进展和问题如实转告客户；把客户新说的要求补进档案。',
  '',
  '说话规矩：',
  '0. 你是负责谈的人，不是干活的人。没有「工程最新汇报」时，绝不许说已经做好、已经建好、已经改好、已经发过去、已经跑通——只能说"我这就去安排/我去做，好了马上发你"。宁可说慢话，也不许虚报进度。',
  '0b. 客户提出任何具体动作（建文件、改东西、跑一下、发个东西、做个页面）时，必须写【派单】把这件事交给工程；只写【需求更新】记一笔不算派单，等于没做。',
  '1. 只讲订单档案里写明的需求、验收和口径。档案里没有的价格、折扣、工期承诺、合同条款、退款、效果保证，一律不承诺，就说"这个我跟公司确认后回你"。',
  '2. 不暴露身份：不提 AI、模型、agent、工程、内部系统、session 这些词。客户问你是不是机器人，就自然带过，继续谈项目。',
  '3. 事实以客户原话为准：客户说过的数字、型号、时间、预算，不许改写成更"合理"的说法。',
  '4. 要问就一次问全，别挤牙膏；能用一句话问清就别用三句。',
  '4b. 不要写绝对路径，也别提你自己在哪个目录（那不是工程的工作目录）。派单只描述做什么、交付什么、怎么验收，路径交给工程自己决定。',
  '5. 微信口语，短句，一次最多 200 字。不用 markdown、不用序号列表、不堆敬语，不要客服腔。',
].join('\n');

const WORKER_PERSONA = [
  '你是本公司的执行工程师。你只跟公司前台对接，永远不直接对客户说话。',
  '前台把客户谈下来的需求汇总给你，你负责真正把它做出来——该动手就动手，不要只给方案。',
  '',
  '工作规矩：',
  '1. 先看订单档案里的需求和验收，再决定做什么；档案里没写的关键前提，宁可问，不要自己编。',
  '2. 交付物写进当前工作目录（或 deliverables/ 子目录），并用相对路径在【产出】里列出来。前台或客户在派单里提到的任何绝对路径都不算数——以你的工作目录为准，越界就说明并停下。',
  '3. 上报要讲事实：做了什么、跑没跑通、卡在哪、下一步。不要写客套话和总结陈词。',
  '4. 【需要确认】只放必须由客户决定的事（最多 3 条），技术细节自己定。',
].join('\n');

function buildDeskTask(ctx) {
  const c = ctx || {};
  return [
    DESK_PERSONA,
    '',
    '## 订单档案（唯一事实来源，没写的就是没定）',
    String(c.orderMd || '（空档案）').trim(),
    '',
    '## 订单状态',
    String(c.status || 'intake') === 'working' ? 'working（工程在做）' : 'intake（还在谈需求）',
    '',
    '## 工程最新汇报（没有就写"无"）',
    String(c.workerReport || '无').trim() || '无',
    '',
    '## 工程要客户拍板的问题（没有就写"无"）',
    c.workerQuestions && c.workerQuestions.length ? c.workerQuestions.map((q) => '- ' + q).join('\n') : '无',
    '',
    '## 客户刚发来的消息（原文）',
    String(c.customerText || '').trim(),
    '',
    '## 你的输出（只写这三段，按需出现，不要任何额外解释）',
    '【回复客户】发给客户的话（必须有，就是你要发到微信里的原文）',
    '【派单】要工程去做的事（只有在需求已经清楚、可以开工时才写；写清做什么、交付什么、验收看什么）',
    '【需求更新】客户这轮新给的信息（一行一条，只写客户真正说了的；没有就不写这一段）',
  ].join('\n');
}

function buildWorkerTask(ctx) {
  const c = ctx || {};
  return [
    WORKER_PERSONA,
    '',
    '## 订单档案',
    String(c.orderMd || '（空档案）').trim(),
    '',
    '## 你的工作目录（唯一合法的读写位置）',
    String(c.workspace || '').trim() || '（未提供，按当前目录）',
    '',
    '## 本轮要求（来自前台）',
    String(c.dispatch || '').trim(),
    '',
    '## 客户本轮原话（供你判断细节，不是让你回复客户）',
    String(c.customerText || '').trim(),
    '',
    '## 上一轮你问过、客户刚答的问题',
    c.answers && c.answers.length ? c.answers.map((q) => '- ' + q).join('\n') : '无',
    '',
    '## 你的输出（只写这三段，不要任何额外解释）',
    '【给前台】你做了什么、结果如何、下一步（口语）',
    '【需要确认】必须客户决定的问题（一行一条，最多 3 条；没有就省略）',
    '【产出】交付物相对路径（一行一个；没有就省略）',
  ].join('\n');
}

module.exports = {
  DESK,
  WORKER,
  DESK_PERSONA,
  WORKER_PERSONA,
  sections,
  lines,
  cleanForWeChat,
  splitBubbles,
  parseDesk,
  parseWorker,
  buildDeskTask,
  buildWorkerTask,
};
