'use strict';

/**
 * 从已有聊天总结「使用者怎么说话」：只留统计和中文总结，不留原文。
 *
 * 设计约束（隐私优先）：
 *  - 落盘的画像文件只含句长/比例/高频短语/语气词这类统计，没有整句原文。
 *  - 日志只打条数、长度、耗时，绝不打印消息正文。
 *  - 读画像时按白名单重建对象：用户手改文件也塞不进任意 prompt 字段。
 *
 * 这一层是纯逻辑 + 文件 IO，不依赖 pipeline / memory / services / adapters，
 * 这样单元测试不需要起运行时。
 */
const fs = require('node:fs');
const path = require('node:path');

const MODES = ['adapt', 'mimic'];
const PROFILE_VERSION = 1;
const PROFILE_FILE = 'style-profile.json';
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_LLM_SAMPLES = 30;
const MAX_LLM_SAMPLE_CHARS = 120;

// 中文里最常见的语气词；统计「怎么说话」用，不做分词。
const PARTICLES = '啊呀吧嘛呢哦噢哈嘿诶唉嗯啦咯嘞呗';
const PARTICLE_SET = new Set(Array.from(PARTICLES));

// 2~4 字 n-gram 里最常见的「没有风格信息」的片段。
const STOP_PHRASES = new Set([
  '这个', '那个', '什么', '怎么', '这么', '那么', '就是', '不是', '没有', '可以',
  '我们', '你们', '他们', '她们', '自己', '现在', '今天', '明天', '昨天', '时候',
  '感觉', '觉得', '应该', '还是', '已经', '因为', '所以', '但是', '然后', '如果',
  '知道', '东西', '这样', '那样', '其实', '真的', '有点', '一下', '一个', '一些',
  '很多', '喜欢', '可能', '需要', '不要', '不会', '不能', '都是', '还有', '也是',
  '关系', '没事', '好的', '好吧', '嗯嗯', '哈哈', '哈哈哈', '呵呵', '嘿嘿', '在吗',
  '在呢', '你好', '谢谢', '为什么', '什么样', '什么样', '是不是', '有没有', '能不能',
  '会不会', '要不要', '对不对', '好不好', '行不行', '怎么办', '怎么样', '就是说',
]);

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const SEGMENT_RE = /[\p{L}\p{N}]+/gu;
const TRAILING_NOISE_RE = /[\s\p{P}\p{S}]+$/gu;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMode(value) {
  const mode = String(value == null ? '' : value).trim().toLowerCase();
  return MODES.includes(mode) ? mode : 'adapt';
}

function clipText(value, max) {
  const text = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function toNonNegativeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function toRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, n);
}

function dataDirOf(config) {
  const fromPaths = config && config.paths && config.paths.dataDir;
  if (fromPaths) return String(fromPaths);
  const root = (config && config.root) || path.resolve(__dirname, '..', '..');
  return path.join(String(root), 'data');
}

function profilePath(config) {
  return path.join(dataDirOf(config), PROFILE_FILE);
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/* ------------------------------------------------------------------ */
/* owner 过滤                                                          */
/* ------------------------------------------------------------------ */

function toLowerSet(value) {
  const out = new Set();
  if (value instanceof Set) {
    for (const item of value) {
      const s = String(item == null ? '' : item).trim().toLowerCase();
      if (s) out.add(s);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      const s = String(item == null ? '' : item).trim().toLowerCase();
      if (s) out.add(s);
    }
  } else if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s) out.add(s);
  }
  return out;
}

/** owner 支持字符串或 {wxids, names}；空配置视为「没指定」。 */
function normalizeOwner(owner) {
  if (owner == null) return null;
  if (typeof owner === 'string') {
    const value = owner.trim().toLowerCase();
    if (!value) return null;
    return { wxids: new Set([value]), names: new Set([value]) };
  }
  if (!isPlainObject(owner)) return null;
  const wxids = toLowerSet(owner.wxids);
  const names = toLowerSet(owner.names);
  if (!wxids.size && !names.size) return null;
  return { wxids, names };
}

function ownerFromConfig(config) {
  const master = (config && config.persona && config.persona.master) || {};
  const wxids = toLowerSet(master.wxids);
  if (wxids.size) return { wxids };
  const names = toLowerSet(master.names);
  if (names.size) return { names };
  return null;
}

function matchesOwner(message, owner) {
  if (!owner) return true;
  const uid = String(message.uid == null ? '' : message.uid).trim().toLowerCase();
  if (uid && owner.wxids.has(uid)) return true;
  const name = String(message.name == null ? '' : message.name).trim().toLowerCase();
  if (name && owner.names.has(name)) return true;
  return false;
}

/**
 * 收集可分析的样本。role 必须是 user；owner 不传 = 全部 user 消息，
 * 由调用方负责把「只按私聊猜主人」这条规则用 chatType 预过滤。
 */
function collectSamples(messages, owner) {
  const normalized = normalizeOwner(owner);
  const assumedOwner = !normalized;
  const samples = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const message of list) {
    if (!message || message.role !== 'user') continue;
    const text = String(message.text == null ? '' : message.text).trim();
    if (!text) continue;
    if (normalized && !matchesOwner(message, normalized)) continue;
    samples.push({
      text,
      chatKey: message.chatKey == null ? '' : String(message.chatKey),
      ts: Number(message.ts) || 0,
    });
  }
  return { samples, assumedOwner };
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

function medianOf(sorted) {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentileOf(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function endingOf(text) {
  const trimmed = String(text).replace(TRAILING_NOISE_RE, '');
  const chars = Array.from(trimmed);
  if (!chars.length) return '';
  const last = chars[chars.length - 1];
  return LETTER_OR_NUMBER_RE.test(last) ? last : '';
}

function countParticles(texts) {
  const counts = new Map();
  for (const text of texts) {
    for (const char of Array.from(text)) {
      if (!PARTICLE_SET.has(char)) continue;
      counts.set(char, (counts.get(char) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || PARTICLES.indexOf(a[0]) - PARTICLES.indexOf(b[0]))
    .slice(0, 8)
    .map(([text, count]) => ({ text, count }));
}

function countEndings(texts) {
  const counts = new Map();
  for (const text of texts) {
    const char = endingOf(text);
    if (!char) continue;
    counts.set(char, (counts.get(char) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 5)
    .map(([char, count]) => ({ char, count }));
}

/**
 * 2~4 字 n-gram，只保留真实重复出现的片段。
 * 不输出整句：候选必须短于原消息，且原消息本身不进候选。
 */
function countTopPhrases(texts) {
  const whole = new Set(texts.map((text) => text.trim()).filter(Boolean));
  const counts = new Map();
  for (const text of texts) {
    const segments = String(text).match(SEGMENT_RE) || [];
    for (const segment of segments) {
      const chars = Array.from(segment);
      for (let size = 2; size <= 4; size += 1) {
        for (let i = 0; i + size <= chars.length; i += 1) {
          const phrase = chars.slice(i, i + size).join('');
          if (STOP_PHRASES.has(phrase)) continue;
          if (/^\d+$/.test(phrase)) continue;
          if (whole.has(phrase)) continue;
          counts.set(phrase, (counts.get(phrase) || 0) + 1);
        }
      }
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8)
    .map(([text, count]) => ({ text, count }));
}

function buildStats(samples) {
  const texts = samples.map((sample) => sample.text);
  const lengths = texts.map((text) => Array.from(text).length).sort((a, b) => a - b);
  const count = texts.length;
  const sum = lengths.reduce((acc, n) => acc + n, 0);
  const short = lengths.filter((n) => n <= 12).length;
  const questions = texts.filter((text) => /[?？]/.test(text)).length;
  const exclaims = texts.filter((text) => /[!！]/.test(text)).length;
  const ellipsis = texts.filter((text) => /…|\.{3,}/.test(text)).length;
  const emoji = texts.filter((text) => EMOJI_RE.test(text)).length;
  return {
    avgChars: count ? Math.round(sum / count) : 0,
    medianChars: medianOf(lengths),
    p90Chars: percentileOf(lengths, 0.9),
    shortRatio: count ? short / count : 0,
    questionRatio: count ? questions / count : 0,
    exclaimRatio: count ? exclaims / count : 0,
    ellipsisRatio: count ? ellipsis / count : 0,
    emojiRatio: count ? emoji / count : 0,
    topPhrases: countTopPhrases(texts),
    particles: countParticles(texts),
    endings: countEndings(texts),
  };
}

function percent(ratio) {
  return Math.round(Number(ratio || 0) * 100);
}

function listText(items, key, max) {
  return items.slice(0, max).map((item) => item[key]).join('、');
}

function buildAdaptSummary(stats) {
  const adapt = [];
  adapt.push(`平均每句约 ${stats.avgChars} 字，${percent(stats.shortRatio)}% 的消息不超过 12 字`);
  adapt.push(stats.particles.length
    ? `常用语气词：${listText(stats.particles, 'text', 5)}`
    : '语气词用得不多，句子偏直白');
  adapt.push(`提问占比约 ${percent(stats.questionRatio)}%，${percent(stats.questionRatio) >= 25 ? '常主动发问' : '多为陈述'}`);
  adapt.push(stats.topPhrases.length
    ? `常聊到：${listText(stats.topPhrases, 'text', 5)}`
    : '话题比较分散，没有反复出现的口头短语');
  adapt.push(`约 ${percent(stats.emojiRatio)}% 的消息带表情符号，${percent(stats.exclaimRatio)}% 带感叹号`);
  adapt.push(stats.endings.length
    ? `句尾常用「${listText(stats.endings, 'char', 4)}」`
    : '句尾没有特别固定的字');
  return adapt;
}

function buildMimicSummary(stats) {
  const mimic = [];
  mimic.push(`模仿句长和节奏：平均约 ${stats.avgChars} 字，短句占 ${percent(stats.shortRatio)}%`);
  mimic.push(stats.particles.length
    ? `保留口头禅：${listText(stats.particles, 'text', 5)}`
    : '语气词不明显，别硬加语气词');
  mimic.push(`提问习惯：约 ${percent(stats.questionRatio)}% 的消息在提问`);
  mimic.push(stats.topPhrases.length
    ? `可以自然带出这些话题：${listText(stats.topPhrases, 'text', 4)}`
    : '不预设话题，跟着对方当下说的内容走');
  mimic.push(stats.endings.length
    ? `句尾习惯用「${listText(stats.endings, 'char', 4)}」`
    : '句尾保持自然，不套固定口癖');
  mimic.push('模仿句长和节奏、保留口头禅，但不冒充身份、不复制错别字，也不搬运隐私或攻击性表达');
  return mimic;
}

function buildProfile(collected, { source = 'messages' } = {}) {
  const stats = buildStats(collected.samples);
  const chatKeys = new Set();
  let hasUnkeyed = false;
  for (const sample of collected.samples) {
    if (sample.chatKey) chatKeys.add(sample.chatKey);
    else hasUnkeyed = true;
  }
  return {
    version: PROFILE_VERSION,
    generatedAt: new Date().toISOString(),
    source: String(source || 'messages').slice(0, 40),
    sampleCount: collected.samples.length,
    chatCount: chatKeys.size + (hasUnkeyed ? 1 : 0),
    assumedOwner: Boolean(collected.assumedOwner),
    stats,
    summary: {
      adapt: buildAdaptSummary(stats),
      mimic: buildMimicSummary(stats),
      topics: stats.topPhrases.slice(0, 5).map((item) => item.text),
    },
  };
}

/** 只做分析，不读盘。没有样本时抛错，避免生成一份空画像。 */
function analyzeMessages(messages, { owner, source = 'messages' } = {}) {
  const collected = collectSamples(messages, owner);
  if (!collected.samples.length) throw badRequest('没有可分析的聊天记录');
  return buildProfile(collected, { source });
}

/* ------------------------------------------------------------------ */
/* 可选 LLM 总结                                                       */
/* ------------------------------------------------------------------ */

function pickLlmSamples(samples) {
  if (samples.length <= MAX_LLM_SAMPLES) return samples;
  const step = samples.length / MAX_LLM_SAMPLES;
  const out = [];
  for (let i = 0; i < MAX_LLM_SAMPLES; i += 1) out.push(samples[Math.floor(i * step)]);
  return out;
}

function sanitizeSummaryList(value, maxItems) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = clipText(item, 160);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseJsonObject(raw) {
  const text = String(raw == null ? '' : raw);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 只有用户显式开启 useLlm 才会走这里。失败不抛：本地统计已经够用，
 * 模型只是锦上添花。发给模型的只有统计 + 最多 30 条截断样本，不含姓名/uid。
 */
async function enhanceWithLlm(profile, samples, llm) {
  if (!llm || typeof llm.complete !== 'function') return false;
  try {
    const payload = {
      stats: profile.stats,
      sampleCount: profile.sampleCount,
      chatCount: profile.chatCount,
      samples: pickLlmSamples(samples).map((sample) => Array.from(sample.text).slice(0, MAX_LLM_SAMPLE_CHARS).join('')),
    };
    const raw = await llm.complete({
      system: '你是中文聊天风格分析师。只输出 JSON：{"adapt":[],"mimic":[],"topics":[]}。'
        + '每条是简短中文结论；不要复述原文、姓名、账号或隐私，不要建议冒充身份；只输出 JSON。',
      turns: [{ role: 'user', content: '统计与抽样（只用于总结风格）：\n' + JSON.stringify(payload) }],
      maxTokens: 1200,
      purpose: 'background',
    });
    const parsed = parseJsonObject(raw);
    if (!parsed) return false;
    const adapt = sanitizeSummaryList(parsed.adapt, 6);
    const mimic = sanitizeSummaryList(parsed.mimic, 6);
    const topics = sanitizeSummaryList(parsed.topics, 8);
    if (!adapt.length && !mimic.length && !topics.length) return false;
    if (adapt.length) profile.summary.adapt = adapt;
    if (mimic.length) profile.summary.mimic = mimic;
    if (topics.length) profile.summary.topics = topics;
    return true;
  } catch {
    // 网络/额度/解析失败都不影响确定性画像。
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 读记忆 v2                                                           */
/* ------------------------------------------------------------------ */

function readJsonQuiet(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 扫描 data/memory/chats；没有 manifest 会话清单，目录就是清单。 */
function analyzeMemory(config, { owner, useLlm = false, llm = null } = {}) {
  const chatsDir = path.join(dataDirOf(config), 'memory', 'chats');
  let entries = [];
  try {
    entries = fs.readdirSync(chatsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    entries = [];
  }

  const messages = [];
  for (const entry of entries) {
    const dir = path.join(chatsDir, entry.name);
    const meta = readJsonQuiet(path.join(dir, 'meta.json'));
    if (!meta || !meta.chatId) continue;
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8');
    } catch {
      continue;
    }
    const chatType = meta.chatType === 'group' ? 'group' : 'private';
    const chatKey = String(meta.chatId);
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        continue; // 崩溃时最后一行可能是半截，跳过就行
      }
      if (!message || !message.role || message.text == null) continue;
      messages.push({
        role: message.role,
        text: message.text,
        name: message.name,
        uid: message.uid,
        ts: message.ts,
        chatType,
        chatKey,
      });
    }
  }

  const resolvedOwner = owner === undefined || owner === null || owner === ''
    ? ownerFromConfig(config)
    : owner;
  const collectedOwner = normalizeOwner(resolvedOwner);
  // 没有主人名单时只能猜：私聊里 role=user 的一定是对方（机器人自己的消息是 assistant）。
  // 群聊没法区分谁是谁，所以不纳入「猜」的样本。
  const candidates = collectedOwner
    ? messages
    : messages.filter((message) => message.role === 'user' && message.chatType === 'private');
  const collected = collectSamples(candidates, collectedOwner);
  if (!collected.samples.length) throw badRequest('没有可分析的聊天记录');

  const profile = buildProfile(collected, { source: 'memory' });
  if (useLlm) {
    return enhanceWithLlm(profile, collected.samples, llm).then(() => profile);
  }
  return profile;
}

/* ------------------------------------------------------------------ */
/* 读微信导出 JSON                                                     */
/* ------------------------------------------------------------------ */

function normalizeTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** wechatauto export_history 的 JSON → 统一消息结构。 */
function analyzeExport(config, file, { owner, useLlm = false, llm = null } = {}) {
  const filePath = String(file == null ? '' : file).trim();
  if (!filePath) throw badRequest('请指定微信导出文件');
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw badRequest('找不到微信导出文件');
  }
  if (!stat.isFile()) throw badRequest('导出路径不是文件');
  if (stat.size > MAX_EXPORT_BYTES) throw badRequest('导出文件超过 64MB，请先拆分后再分析');

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw badRequest('导出文件不是有效的 JSON');
  }
  if (!isPlainObject(payload)) throw badRequest('导出文件结构不对');

  const chatTypeOf = new Map();
  for (const chat of Array.isArray(payload.chats) ? payload.chats : []) {
    if (!chat || !chat.username) continue;
    const username = String(chat.username);
    chatTypeOf.set(username, /@chatroom$/i.test(username) ? 'group' : 'private');
  }

  const messages = [];
  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    if (!message || typeof message !== 'object') continue;
    const content = typeof message.content === 'string'
      ? message.content
      : (typeof message.text === 'string' ? message.text : '');
    if (!content.trim()) continue;
    // 图片/文件/引用这类非文本消息的 content 是 XML 载荷，统计进去只会污染句长。
    if (/^\s*</.test(content)) continue;
    const chatKey = String(message.chat || message.username || '');
    messages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: content,
      name: message.sender_name == null ? '' : message.sender_name,
      uid: message.sender_id == null ? '' : message.sender_id,
      ts: normalizeTimestamp(message.create_time),
      chatType: chatTypeOf.get(chatKey) || 'private',
      chatKey,
    });
  }
  if (!messages.length) throw badRequest('没有可分析的聊天记录');

  const hasExplicitOwner = !(owner === undefined || owner === null || owner === '');
  const resolvedOwner = hasExplicitOwner
    ? owner
    : { wxids: [payload.wxid].filter(Boolean), names: [payload.nick_name].filter(Boolean) };
  const collected = collectSamples(messages, resolvedOwner);
  if (!collected.samples.length) throw badRequest('没有可分析的聊天记录');

  const profile = buildProfile(collected, { source: 'export' });
  if (useLlm) {
    return enhanceWithLlm(profile, collected.samples, llm).then(() => profile);
  }
  return profile;
}

/* ------------------------------------------------------------------ */
/* 白名单校验 / 落盘                                                    */
/* ------------------------------------------------------------------ */

function sanitizeCountList(value, { key, maxItems, maxChars }) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const text = clipText(item[key], maxChars);
    const count = toNonNegativeInt(item.count);
    if (!text || !count) continue;
    out.push({ [key]: text, count });
    if (out.length >= maxItems) break;
  }
  return out;
}

function sanitizeStats(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    avgChars: toNonNegativeInt(raw.avgChars),
    medianChars: toNonNegativeInt(raw.medianChars),
    p90Chars: toNonNegativeInt(raw.p90Chars),
    shortRatio: toRatio(raw.shortRatio),
    questionRatio: toRatio(raw.questionRatio),
    exclaimRatio: toRatio(raw.exclaimRatio),
    ellipsisRatio: toRatio(raw.ellipsisRatio),
    emojiRatio: toRatio(raw.emojiRatio),
    topPhrases: sanitizeCountList(raw.topPhrases, { key: 'text', maxItems: 8, maxChars: 20 }),
    particles: sanitizeCountList(raw.particles, { key: 'text', maxItems: 8, maxChars: 4 }),
    endings: sanitizeCountList(raw.endings, { key: 'char', maxItems: 5, maxChars: 4 }),
  };
}

function sanitizeSummary(raw) {
  if (!isPlainObject(raw)) return null;
  const pick = (value, maxItems) => (Array.isArray(value) ? value : [])
    .map((item) => (typeof item === 'string' ? clipText(item, 200) : ''))
    .filter(Boolean)
    .slice(0, maxItems);
  return {
    adapt: pick(raw.adapt, 6),
    mimic: pick(raw.mimic, 6),
    topics: pick(raw.topics, 8),
  };
}

/**
 * 按白名单重建画像对象。读文件时用它，手改文件也塞不进额外 prompt 字段；
 * 返回 null 表示这份画像不可用，调用方应当当成「没有画像」。
 */
function validateProfile(raw) {
  if (!isPlainObject(raw)) return null;
  if (Number(raw.version) !== PROFILE_VERSION) return null;
  const stats = sanitizeStats(raw.stats);
  const summary = sanitizeSummary(raw.summary);
  if (!stats || !summary) return null;
  const generatedAt = typeof raw.generatedAt === 'string' && raw.generatedAt.trim()
    ? clipText(raw.generatedAt, 40)
    : new Date().toISOString();
  return {
    version: PROFILE_VERSION,
    generatedAt,
    source: clipText(raw.source || 'messages', 40) || 'messages',
    sampleCount: toNonNegativeInt(raw.sampleCount),
    chatCount: toNonNegativeInt(raw.chatCount),
    assumedOwner: raw.assumedOwner === true,
    stats,
    summary,
  };
}

const flushProfile = validateProfile;

function load(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath(config), 'utf8').replace(/^\uFEFF/, ''));
    return validateProfile(raw);
  } catch {
    return null; // 文件不存在 / JSON 坏了 / 结构不对：都当没有画像
  }
}

function save(config, profile, file = null) {
  const clean = validateProfile(profile);
  if (!clean) throw new Error('风格画像不合法，已拒绝写入');
  const target = file ? path.resolve(String(file)) : profilePath(config);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  return clean;
}

function clear(config) {
  try {
    fs.rmSync(profilePath(config), { force: true });
  } catch {
    // 删不掉也不要让「关闭风格画像」失败；下次保存会覆盖。
  }
  return true;
}

function buildBlock(profile, mode) {
  const clean = validateProfile(profile);
  if (!clean) return '';
  const normalized = normalizeMode(mode);
  const lines = (clean.summary[normalized] || []).length
    ? clean.summary[normalized]
    : clean.summary[normalized === 'mimic' ? 'adapt' : 'mimic'];
  if (!lines || !lines.length) return '';
  const header = normalized === 'mimic' ? '【模仿对方表达】' : '【对方聊天习惯】';
  const tail = '（只作风格参考，不冒充对方身份，不复制隐私/攻击性表达）';
  return [header, ...lines.map((line) => `- ${line}`), tail].join('\n');
}

/** 给 HTTP 用：过一遍白名单，保证不把任何原始消息带出去。 */
function publicProfile(profile, mode = 'adapt') {
  const clean = validateProfile(profile);
  if (!clean) return null;
  const normalized = normalizeMode(mode);
  const lines = (clean.summary[normalized] || clean.summary.adapt || []).slice(0, 12);
  return {
    ...clean,
    mode: normalized,
    // 启动器只读这些扁平字段；summary 仍是对象，别让 UI 去猜结构。
    messageCount: clean.sampleCount,
    lines,
    preview: lines.join('\n'),
  };
}

module.exports = {
  MODES,
  normalizeMode,
  analyzeMessages,
  analyzeMemory,
  analyzeExport,
  buildBlock,
  validateProfile,
  flushProfile,
  profilePath,
  load,
  save,
  clear,
  publicProfile,
};
