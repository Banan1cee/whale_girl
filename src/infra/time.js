'use strict';

/**
 * 全局时间口径。
 *
 * 以前日记、主动搭话、提醒、朋友圈、聊天时间戳各写一套：
 *   - 有的只认 HH:mm，有的认 9:00 / 24:00 / ～ / 到；
 *   - 有的用 `new Date()` 直接读系统本地时间，有的把 env.timezone 只用在提示词里。
 * 结果就是“设置里填的是这个时间，实际却按另一个时区/另一套格式跑”。
 *
 * 这里只做纯函数：解析、格式化、时区换算、按天切分。
 * 不读写配置、不碰 IO；调用方把 config 里的 env.timezone 传进来即可。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SYSTEM_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
})();

const FORMAT_CACHE = new Map();

function isValidTimeZone(value) {
  const tz = String(value == null ? '' : value).trim();
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** config.env.timezone 是唯一时区来源；留空 = 系统时区。非法值按系统时区跑。 */
function resolveTimeZone(config) {
  const raw = String((config && config.env && config.env.timezone) || '').trim();
  return raw && isValidTimeZone(raw) ? raw : '';
}

function systemTimeZone() {
  return SYSTEM_TZ;
}

function zoneName(config) {
  return resolveTimeZone(config) || SYSTEM_TZ;
}

function formatter(tz) {
  const key = tz || '__system__';
  const hit = FORMAT_CACHE.get(key);
  if (hit) return hit;
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  };
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', tz ? { ...options, timeZone: tz } : options);
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', options);
  }
  FORMAT_CACHE.set(key, fmt);
  return fmt;
}

/** 某一时刻在指定时区里的年月日时分秒。 */
function parts(ms, tz = '') {
  const n = Number(ms);
  const date = new Date(Number.isFinite(n) ? n : Date.now());
  const raw = {};
  for (const part of formatter(tz).formatToParts(date)) {
    if (part.type !== 'literal') raw[part.type] = part.value;
  }
  return {
    year: Number(raw.year),
    month: Number(raw.month),
    day: Number(raw.day),
    hour: Number(raw.hour) % 24,
    minute: Number(raw.minute),
    second: Number(raw.second),
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 年月日部分 → `YYYY-MM-DD`；不经过 Date，避免 DST 缺时刻影响「哪一天」。 */
function dayKeyOf(value) {
  const p = value || {};
  return `${Number(p.year)}-${pad2(Number(p.month))}-${pad2(Number(p.day))}`;
}

function dayKey(ms, tz = '') {
  return dayKeyOf(parts(ms, tz));
}

function minutesOfDay(ms, tz = '') {
  const p = parts(ms, tz);
  return p.hour * 60 + p.minute;
}

function hourOfDay(ms, tz = '') {
  return parts(ms, tz).hour;
}

function formatClock(minutes) {
  const n = Math.max(0, Math.min(1440, Math.round(Number(minutes) || 0)));
  return `${pad2(Math.floor(n / 60))}:${pad2(n % 60)}`;
}

function formatDateTime(ms, tz = '', { seconds = false } = {}) {
  const p = parts(ms, tz);
  const base = `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
  return seconds ? `${base}:${pad2(p.second)}` : base;
}

function formatStamp(ms, tz = '') {
  const p = parts(ms, tz);
  return `${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * 解析时刻：`9:00` / `09:00` / `09：00` 都认。
 * allow24 只给时间段结束点用（24:00 = 当天结束）。
 */
function parseClock(text, { allow24 = false } = {}) {
  const raw = String(text == null ? '' : text)
    .trim()
    .replace(/：/g, ':')
    .replace(/\s+/g, '');
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour === 24 && minute === 0 && allow24) return 1440;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function normalizeClock(text) {
  const minutes = parseClock(text);
  return minutes === null ? null : formatClock(minutes);
}

/** `09:00-12:00` / `09:00~12:00` / `09:00到12:00` → 分钟区间。 */
function parseWindow(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/[~～—–－到至]/g, '-')
    .replace(/\s+/g, '');
  const m = cleaned.match(/^(.+?)-(.+)$/);
  if (!m) return null;
  const start = parseClock(m[1]);
  const end = parseClock(m[2], { allow24: true });
  if (start === null || end === null) return null;
  return { start, end, raw };
}

function formatWindow(w) {
  if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end)) return '';
  return `${formatClock(w.start)}-${formatClock(w.end)}`;
}

function splitList(list) {
  if (Array.isArray(list)) return list;
  if (list === null || list === undefined || list === '') return [];
  return String(list).split(/[\n,;，；]+/);
}

/** 解析时间段列表；写错的项会被跳过（调用方要严格校验时用 invalidWindows）。 */
function parseWindows(list) {
  const out = [];
  for (const item of splitList(list)) {
    const w = parseWindow(item);
    if (w) out.push(w);
  }
  return out;
}

function invalidWindows(list) {
  const bad = [];
  for (const item of splitList(list)) {
    const text = String(item == null ? '' : item).trim();
    if (!text) continue;
    if (!parseWindow(text)) bad.push(text);
  }
  return bad;
}

function normalizeWindows(list) {
  return parseWindows(list).map(formatWindow);
}

function windowsText(list) {
  return normalizeWindows(list).join('\n');
}

/** 一个时间点（0～1439）在不在这些时间段里；支持跨零点。 */
function inWindows(minutesOfDayValue, windows) {
  const list = windows && windows.length ? windows : parseWindows(['09:00-23:00']);
  const now = ((Math.round(minutesOfDayValue) % 1440) + 1440) % 1440;
  for (const w of list) {
    if (w.start === w.end) continue;
    if (w.start < w.end) {
      if (now >= w.start && now < w.end) return true;
    } else if (now >= w.start || now < w.end) {
      return true;
    }
  }
  return false;
}

/** 把年月日时分秒换算成 epoch 毫秒（指定时区；空串 = 系统时区）。 */
function toEpoch(value, tz = '') {
  const p = value || {};
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const hour = Number(p.hour) || 0;
  const minute = Number(p.minute) || 0;
  const second = Number(p.second) || 0;
  if (!tz) return new Date(year, month - 1, day, hour, minute, second, 0).getTime();
  const target = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  let at = target;
  // 迭代求该时区在目标时刻的偏移；每次都用 target 反推，避免在已收敛的值上继续减偏移。
  for (let i = 0; i < 4; i += 1) {
    const cur = parts(at, tz);
    const asUtc = Date.UTC(cur.year, cur.month - 1, cur.day, cur.hour, cur.minute, cur.second);
    const offset = asUtc - at;
    const next = target - offset;
    if (next === at) break;
    at = next;
  }
  return at;
}

function addDays(value, days) {
  const p = value || {};
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + Number(days || 0)));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: Number(p.hour) || 0,
    minute: Number(p.minute) || 0,
    second: Number(p.second) || 0,
  };
}

/** `YYYY-MM-DD HH:mm` / `YYYY-MM-DDTHH:mm` → epoch；解析失败返回 null。 */
function parseDateTime(text, tz = '') {
  const raw = String(text == null ? '' : text).trim();
  const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const value = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6] || 0),
  };
  // 先卡范围：Date 会把 99:00 / 02-31 静默进位成另一个时刻，
  // 模型或用户填错时不能悄悄改成「差不多的时间」。
  if (value.month < 1 || value.month > 12
    || value.day < 1 || value.day > 31
    || value.hour < 0 || value.hour > 23
    || value.minute < 0 || value.minute > 59
    || value.second < 0 || value.second > 59) return null;
  const at = toEpoch(value, tz);
  if (!Number.isFinite(at)) return null;
  // 再反向比对一次：拦住 2 月 30 日、夏令时跳过的 02:30 这类「范围合法但不存在」的时间。
  const back = parts(at, tz);
  if (back.year !== value.year || back.month !== value.month || back.day !== value.day
    || back.hour !== value.hour || back.minute !== value.minute || back.second !== value.second) return null;
  return at;
}

/**
 * 放宽版：先按上面的本地/指定时区格式解析；失败时只接受**带显式时区**的 ISO
 * （`Z` 或 `±HH:mm`），交给 Date.parse 按绝对时间处理。
 * 不带时区的字符串不能走 Date.parse——那会按系统时区猜，和 env.timezone 打架。
 */
function parseDateTimeLoose(text, tz = '') {
  const strict = parseDateTime(text, tz);
  if (strict !== null) return strict;
  const raw = String(text == null ? '' : text).trim();
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) return null;
  // Date.parse 对 02-31 这类日期也会静默进位；带时区的 ISO 同样先卡年月日。
  const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ]/);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    const back = new Date(Date.UTC(year, month - 1, day));
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

/**
 * 把真实时间换成「指定时区的墙上时间」Date（本地 getters 读出来就是该时区）。
 * 只用于展示/文案（今天几号、几点、深夜判断），不要拿它的 getTime() 当真实时间。
 */
function zonedDate(ms, tz = '') {
  const p = parts(ms, tz);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
}

function startOfDay(ms, tz = '') {
  const p = parts(ms, tz);
  return toEpoch({ ...p, hour: 0, minute: 0, second: 0 }, tz);
}

function nextDayStart(ms, tz = '') {
  const p = parts(ms, tz);
  return toEpoch({ ...addDays({ ...p, hour: 0, minute: 0, second: 0 }, 1) }, tz);
}

module.exports = {
  DAY_MS,
  SYSTEM_TZ,
  isValidTimeZone,
  resolveTimeZone,
  systemTimeZone,
  zoneName,
  parts,
  dayKey,
  dayKeyOf,
  minutesOfDay,
  hourOfDay,
  formatClock,
  formatDateTime,
  formatStamp,
  parseClock,
  normalizeClock,
  parseWindow,
  formatWindow,
  parseWindows,
  invalidWindows,
  normalizeWindows,
  windowsText,
  inWindows,
  toEpoch,
  addDays,
  parseDateTime,
  parseDateTimeLoose,
  zonedDate,
  startOfDay,
  nextDayStart,
};
