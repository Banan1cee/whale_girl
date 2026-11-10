'use strict';

const { configuredWhitelist, sendDenial } = require('../core/wechatSendPolicy');
const { sameWxid } = require('../core/master');
const time = require('../infra/time');

// 读布尔开关：兼容老配置里的字符串 "false"（Boolean("false") 会被当成开）
const { toBool } = require('../infra/features');

/**
 * 主动搭话（care）：没事的时候她自己来找你说句话，问问「在干啥 / 累不累」。
 *
 * 桥接定时问服务端「该不该发」，服务端说该发就生成内容。
 * 区别是这里由启动器设置控制**时间窗**和**频率**，而且用纯函数算，方便测试。
 *
 * 设计要点：
 *   - 时间窗用 `'09:00-12:00'` 这种字符串，跨零点（22:00-02:00）也认；
 *   - 频率带「稳定抖动」：同一个 lastSentTs 算出来的间隔是固定的，
 *     否则每次轮询都换一个随机值，会造成抖动到临界点时反复横跳；
 *   - 判断逻辑全在这里，服务端只负责调用，桥接只负责定时轮询和发送。
 */

const DEFAULT_WINDOW = '09:00-23:00';

// 时间解析统一在 infra/time：这里只保留同名入口，老调用方/测试不用改。
const parseClock = time.parseClock;
const parseWindow = time.parseWindow;
const parseWindows = time.parseWindows;
const inWindows = time.inWindows;
const formatMinutes = time.formatClock;

/** 配置 → 规范化的 care 设置（缺省值都在这里，别散落各处） */
function normalizeCare(config) {
  const c = (config && config.care) || {};
  const every = Number(c.everyMinutes);
  const jitter = Number(c.jitterMinutes);
  const maxPerDay = Number(c.maxPerDay);
  const quiet = Number(c.quietAfterMinutes);
  return {
    enabled: toBool(c.enabled, true),
    windows: parseWindows(c.windows),
    everyMinutes: Number.isFinite(every) && every > 0 ? every : 90,
    jitterMinutes: Number.isFinite(jitter) && jitter >= 0 ? jitter : 25,
    maxPerDay: Number.isFinite(maxPerDay) && maxPerDay >= 0 ? maxPerDay : 6,
    quietAfterMinutes: Number.isFinite(quiet) && quiet >= 0 ? quiet : 20,
  };
}

/**
 * 稳定的抖动：同一个 lastSentTs 永远算出同一个偏移。
 * 用简单的 32 位混合，不用真随机，避免轮询时反复横跳。
 */
function stableJitter(lastSentTs, jitterMinutes) {
  if (!jitterMinutes) return 0;
  let x = Math.abs(Math.floor(Number(lastSentTs) || 0)) % 2147483647;
  x = (x ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  const span = jitterMinutes * 2;
  return (x % (span + 1)) - jitterMinutes;
}

/**
 * 现在该不该主动搭话。
 *
 * @param {object} config 整份配置（读 care 段）
 * @param {object} opts
 *   - lastSentTs   上次主动搭话的时间（毫秒），0 = 从没发过
 *   - sentToday    今天已经发了几次
 *   - now          当前时间（毫秒），测试用
 * @returns {{due:boolean, reason:string, ...}}
 */
function careDue(config, { lastSentTs = 0, sentToday = 0, now = Date.now() } = {}) {
  const care = normalizeCare(config);
  if (!care.enabled) return { due: false, reason: 'disabled', care };

  const tz = time.resolveTimeZone(config);
  const minutesOfDay = time.minutesOfDay(now, tz);
  const windows = care.windows.length ? care.windows : parseWindows([DEFAULT_WINDOW]);
  if (!inWindows(minutesOfDay, windows)) {
    return {
      due: false,
      reason: 'out_of_window',
      now: formatMinutes(minutesOfDay),
      windows: windows.map((w) => w.raw),
      sentToday: Number(sentToday),
      maxPerDay: care.maxPerDay,
      gapMinutes: null,
      waitMinutes: null,
    };
  }

  if (care.maxPerDay > 0 && Number(sentToday) >= care.maxPerDay) {
    return {
      due: false,
      reason: 'daily_cap',
      sentToday: Number(sentToday),
      maxPerDay: care.maxPerDay,
      gapMinutes: null,
      waitMinutes: null,
    };
  }

  // 抖动只用来「打散节奏」，不能盖过用户明确设的间隔：
  // 比如 everyMinutes=1、jitterMinutes=25，再不收窄就变成等 22 分钟，等于设置没生效。
  const jitterCap = Math.max(0, Math.floor(care.everyMinutes / 2));
  const jitter = stableJitter(lastSentTs, Math.min(care.jitterMinutes, jitterCap));
  const gapMinutes = Math.max(1, care.everyMinutes + jitter);
  const gapMs = gapMinutes * 60 * 1000;
  const elapsed = lastSentTs ? now - Number(lastSentTs) : Infinity;
  if (lastSentTs && elapsed < gapMs) {
    return {
      due: false,
      reason: 'too_soon',
      waitMinutes: Math.max(1, Math.ceil((gapMs - elapsed) / 60000)),
      gapMinutes,
      sentToday: Number(sentToday),
      maxPerDay: care.maxPerDay,
    };
  }

  return {
    due: true,
    reason: 'ok',
    gapMinutes,
    now: formatMinutes(minutesOfDay),
    sentToday: Number(sentToday),
    maxPerDay: care.maxPerDay,
    waitMinutes: null,
  };
}

/** 演示模式 / 模型挂了时候的兜底台词（她主动开口的那几种） */
const CARE_TEMPLATES = [
  '在干啥呢',
  '忙完了没，累不累',
  '今天累不累啊',
  '在忙吗，我就问一句',
  '干嘛呢，有没有好好吃饭',
  '闲下来没，陪我说句话',
  '在干活吗，别太累了',
  '你这会儿在忙啥',
];

function pickTemplate(rng = Math.random) {
  const i = Math.floor(rng() * CARE_TEMPLATES.length);
  return CARE_TEMPLATES[Math.min(CARE_TEMPLATES.length - 1, Math.max(0, i))];
}

/**
 * 生成「主动搭话」用的提示词。
 * 参考最近聊过什么：别重复、接着话头问，比干巴巴一句「在干啥」自然。
 */
function buildCarePrompt({ persona = {}, recent = [], name = '', hour = null } = {}) {
  const who = String(persona.name || '鲸鲸');
  const master = String(persona.ownerName || '主人');
  const lines = [
    `你叫${who}，现在是你自己主动找人说话（对方没先开口）。`,
    `对方叫「${name || master}」。`,
    '目的很简单：关心一下对方在干嘛、累不累。',
    '',
    '要求：',
    '- 一句话，8~20 个字，像真人随手发的一条微信。',
    '- 可以是「在干啥呢」「忙完了没，累不累」这种感觉，但不要每次都说同一句。',
    '- 可以顺着最近聊的内容接一句，但别翻旧账、别追问隐私。',
    '- 不要自我介绍，不要说「我是 AI / 模型」，不要解释为什么找他。',
    '- 不要用颜文字堆砌，最多一个；不要用「~」。',
    '- 只输出这一句话本身。',
  ];
  if (Number.isFinite(hour)) {
    const part = hour < 6 ? '凌晨' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
    lines.push(`- 现在是${part}，语气跟这个时间搭一点。`);
  }
  const user = recent.length
    ? '最近你们聊的（旧→新，只用来参考语气和话题，别复述）：\n' + recent.slice(-8).join('\n')
    : '你们有一阵没说话了。';
  return { system: lines.join('\n'), user };
}

/** 清理模型输出：先取第一行，再去掉引号 / 波浪号 */
function cleanCareText(raw) {
  let t = String(raw == null ? '' : raw).trim();
  // 先按行切：模型有时会先来一句废话换行，再给正文
  const firstLine = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
  t = firstLine || t;
  // 引号要按「行内」剥，否则第一行尾部的引号会留下来
  t = t.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
  t = t.replace(/[~～]+\s*$/g, '').trim();
  return t.slice(0, 40).trim();
}

function onlyMasterEnabled(config) {
  const care = config?.care || {};
  return typeof care.onlyMaster === 'boolean' ? care.onlyMaster : care.allowOthers !== true;
}

/** 默认找已绑定的主人；关闭「只找主人」时才保留文件传输助手。 */
function defaultWhitelist(config) {
  const out = [];
  const masters = ((config && config.persona && config.persona.master) || {}).wxids || [];
  for (const id of masters) {
    const wxid = String(id || '').trim();
    if (wxid) out.push(wxid);
  }
  if (!onlyMasterEnabled(config)) out.push('filehelper');
  return [...new Set(out)];
}

/**
 * 当前生效的白名单（wxid 列表）。
 * 没配时使用默认名单；只找主人且没有绑定对象时，名单可以为空。
 */
function careWhitelist(config = {}) {
  const list = configuredWhitelist(config);
  return list.length || config.wechat?.whitelistOnly === true ? list : defaultWhitelist(config);
}

/** 按绑定 wxid 或联系人昵称确认主人。 */
function isMasterTarget(config, wxid, contacts = null) {
  const id = String(wxid || '').trim();
  if (!id || id.toLowerCase() === 'filehelper') return false;
  const masters = ((config && config.persona && config.persona.master) || {}).wxids || [];
  // 主人 wxid 可能填的是账号目录名（多 4 位哈希），按归一化后的 id 比。
  if (masters.some((m) => String(m || '').trim() && sameWxid(m, id))) return true;
  // 没填 wxid 时按昵称兜底（以前 wxids 为空 → 一个目标都发不出去）
  const names = ((config && config.persona && config.persona.master) || {}).names || [];
  const hit = contacts && typeof contacts.get === 'function' ? contacts.get(id) : null;
  const label = hit ? (hit.name || hit.label) : '';
  return Boolean(label) && names.some((n) => String(n || '').trim() && String(n).trim() === label);
}

/**
 * 白名单是否被显式配置过（空数组 = 没配，走默认值）。
 * wxid 没填时可用主人昵称从联系人缓存里补。
 */
function hasExplicitWhitelist(config) {
  return configuredWhitelist(config).length > 0;
}

/** 昵称 → wxid（主人名单只填了昵称时的兜底） */
function resolveByName(contacts, names) {
  if (!contacts || !Array.isArray(contacts.items) || !Array.isArray(names)) return [];
  const wanted = names.map((n) => String(n || '').trim()).filter(Boolean);
  if (!wanted.length) return [];
  return contacts.items
    .filter((item) => !item.isGroup && (wanted.includes(item.name) || wanted.includes(item.remark)))
    .map((item) => item.wxid);
}

/**
 * 把白名单解析成「能发给谁」的候选列表。
 *
 * @param {object} config
 * @param {object} opts
 *   - contacts  联系人缓存（ContactsCache），用来把 wxid 变成显示名、判断是不是群
 *   - onlyMaster / allowOthers / allowGroups  覆盖配置（测试用）
 * @returns {Array<{wxid,name,isGroup,kind}>}
 */
function careTargets(config, { contacts = null, onlyMaster, allowOthers, allowGroups } = {}) {
  const cfg = (config && config.care) || {};
  const master = onlyMaster === undefined ? onlyMasterEnabled(config) : Boolean(onlyMaster);
  const others = allowOthers === undefined ? cfg.allowOthers === true : Boolean(allowOthers);
  const groups = allowGroups === undefined ? cfg.allowGroups === true : Boolean(allowGroups);
  let whitelist = careWhitelist(config);
  // 主人只填了昵称、没填 wxid：从联系人缓存里把 wxid 补进默认白名单
  if (!hasExplicitWhitelist(config) && config.wechat?.whitelistOnly !== true && contacts) {
    const names = ((config && config.persona && config.persona.master) || {}).names || [];
    const extra = resolveByName(contacts, names);
    if (extra.length) whitelist = [...new Set([...whitelist, ...extra])];
  }
  const out = [];
  for (const raw of whitelist) {
    const wxid = String(raw).trim();
    const isFile = wxid.toLowerCase() === 'filehelper';
    const isGroup = !isFile && /@chatroom$/i.test(wxid);
    const hit = contacts && typeof contacts.get === 'function' ? contacts.get(wxid) : null;
    const name = isFile ? '文件传输助手' : (hit ? hit.label || hit.name : wxid);
    if (sendDenial(config, { id: wxid, names: [name, hit?.name, hit?.remark], isGroup })) continue;
    const masterHit = !isGroup && isMasterTarget(config, wxid, contacts);
    if (master && !masterHit) continue;
    if (isGroup ? !groups : !isFile && !masterHit && !others) continue;
    out.push({ wxid, name, isGroup, kind: isGroup ? 'group' : (masterHit ? 'master' : 'other') });
  }
  // 排序：真主人 → 文件传输助手 → 别人的私聊 → 群（主人优先，别先发给自己）
  const rank = (t) => (t.wxid === 'filehelper' ? 1 : t.kind === 'master' ? 0 : t.kind === 'other' ? 2 : 3);
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

/**
 * 现在该不该发、发给谁 —— 唯一的判定点（桥接只负责问、发、回执）。
 *
 * @param {object} config
 * @param {object} opts
 *   - contacts    联系人缓存
 *   - lastSentTs  上次主动搭话时间（毫秒）
 *   - sentToday   今天已发次数
 *   - activeWxids 最近正在聊的会话（quietAfterMinutes 内），跳过
 *   - now
 */
function careDecide(config, { contacts = null, lastSentTs = 0, sentToday = 0, activeWxids = [], now = Date.now() } = {}) {
  const base = careDue(config, { lastSentTs, sentToday, now });
  if (!base.due) return { ...base, due: false, target: null };
  const targets = careTargets(config, { contacts });
  if (!targets.length) {
    const cfg = (config && config.care) || {};
    const whitelist = careWhitelist(config);
    return {
      ...base,
      due: false,
      reason: whitelist.length ? 'whitelist_filtered' : 'whitelist_empty',
      target: null,
      whitelist,
      onlyMaster: onlyMasterEnabled(config),
      allowOthers: cfg.allowOthers === true,
      allowGroups: cfg.allowGroups === true,
    };
  }
  const busy = new Set((activeWxids || []).map((x) => String(x)));
  const target = targets.find((t) => !busy.has(t.wxid)) || null;
  if (!target) return { ...base, due: false, reason: 'all_busy', target: null, targets };
  return { ...base, due: true, target, targets };
}

module.exports = {
  parseClock,
  parseWindow,
  parseWindows,
  inWindows,
  normalizeCare,
  stableJitter,
  careDue,
  careWhitelist,
  defaultWhitelist,
  careTargets,
  careDecide,
  isMasterTarget,
  CARE_TEMPLATES,
  pickTemplate,
  buildCarePrompt,
  cleanCareText,
  formatMinutes,
  DEFAULT_WINDOW,
};
