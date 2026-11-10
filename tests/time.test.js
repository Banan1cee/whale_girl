'use strict';

/**
 * 统一时间口径回归：
 *   - 同一套解析/格式化：9:00 / 09:00 / 09：00 都能读，落库写回 09:00；
 *   - 时间段：~ ～ — 到 至 都当成连字符，支持跨零点和 24:00；
 *   - 时区：env.timezone 是唯一来源，日记/搭话/提醒/朋友圈/聊天时间戳都按它算。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const time = require('../src/infra/time');
const care = require('../src/services/care');
const reminder = require('../src/core/reminder');
const { loadConfig } = require('../src/infra/config');
const { applyConfigPatch, publicConfig } = require('../src/infra/configPatch');
const { validate } = require('../src/infra/configSchema');

test('时刻解析：9:00 / 09:00 / 全角冒号统一成 HH:mm', () => {
  assert.equal(time.parseClock('9:00'), 540);
  assert.equal(time.parseClock('09:00'), 540);
  assert.equal(time.parseClock('09：00'), 540);
  assert.equal(time.parseClock(' 23:59 '), 1439);
  assert.equal(time.parseClock('24:00'), null);
  assert.equal(time.parseClock('24:00', { allow24: true }), 1440);
  assert.equal(time.parseClock('12:60'), null);
  assert.equal(time.normalizeClock('8:05'), '08:05');
  assert.equal(time.formatClock(1440), '24:00');
});

test('时间段解析：统一分隔符、跨零点、24:00、错误返回 null', () => {
  assert.deepEqual(time.parseWindow('09:00-12:00'), { start: 540, end: 720, raw: '09:00-12:00' });
  assert.equal(time.parseWindow('09:00~12:00').end, 720);
  assert.equal(time.parseWindow('09:00—12:00').end, 720);
  assert.equal(time.parseWindow('09:00到12:00').end, 720);
  assert.equal(time.parseWindow('09:00至12:00').end, 720);
  assert.equal(time.parseWindow('22:00-02:00').end, 120);
  assert.equal(time.parseWindow('09:00-24:00').end, 1440);
  assert.equal(time.parseWindow('abc'), null);
  assert.equal(time.parseWindow('09:70-10:00'), null);
  assert.deepEqual(time.normalizeWindows(['09:00~12:00', '14:00到23:00']), ['09:00-12:00', '14:00-23:00']);
  assert.deepEqual(time.invalidWindows(['09:00-12:00', '写错']), ['写错']);
});

test('时间窗判断：左闭右开、跨零点、空列表退回默认', () => {
  const day = time.parseWindows(['09:00-12:00']);
  assert.equal(time.inWindows(540, day), true);
  assert.equal(time.inWindows(719, day), true);
  assert.equal(time.inWindows(720, day), false);
  assert.equal(time.inWindows(480, day), false);

  const night = time.parseWindows(['22:00-02:00']);
  assert.equal(time.inWindows(23 * 60, night), true);
  assert.equal(time.inWindows(60, night), true);
  assert.equal(time.inWindows(12 * 60, night), false);

  assert.equal(time.inWindows(10 * 60, []), true);
  assert.equal(time.inWindows(3 * 60, []), false);
});

test('时区语义：同一时刻在上海和纽约属于不同日期', () => {
  const at = Date.UTC(2026, 0, 1, 16, 0); // 上海 2026-01-02 00:00；纽约 2026-01-01 11:00
  assert.equal(time.dayKey(at, 'Asia/Shanghai'), '2026-01-02');
  assert.equal(time.dayKey(at, 'America/New_York'), '2026-01-01');
  assert.equal(time.minutesOfDay(at, 'Asia/Shanghai'), 0);
  assert.equal(time.formatDateTime(at, 'Asia/Shanghai'), '2026-01-02 00:00');
  assert.equal(time.hourOfDay(at, 'America/New_York'), 11);
  assert.equal(time.toEpoch({ year: 2026, month: 1, day: 2, hour: 0, minute: 0 }, 'Asia/Shanghai'), at);
  assert.equal(time.parseDateTime('2026-01-02 00:00', 'Asia/Shanghai'), at);
});

test('主动搭话和提醒的自然语言时间都按 env.timezone 算', () => {
  const at = Date.UTC(2026, 0, 1, 2, 0); // 上海 2026-01-01 10:00；纽约 2025-12-31 21:00
  const base = {
    env: { timezone: 'Asia/Shanghai' },
    care: { enabled: true, windows: ['09:00-12:00'], everyMinutes: 90, jitterMinutes: 0, maxPerDay: 6 },
  };
  assert.equal(care.careDue(base, { now: at }).due, true);
  assert.equal(care.careDue({ ...base, env: { timezone: 'America/New_York' } }, { now: at }).reason, 'out_of_window');

  const now = new Date(Date.UTC(2026, 0, 1, 15, 0)); // 上海 2026-01-01 23:00
  const parsed = reminder.parseWhen('明天早上八点提醒我开会', now, 'Asia/Shanghai');
  assert.equal(parsed.at.toISOString(), '2026-01-02T00:00:00.000Z');
  assert.equal(reminder.describeWhen(parsed.at, now, 'Asia/Shanghai'), '明天 08:00');
});

test('时区来源：env.timezone 有效就用，留空/非法退回系统时区', () => {
  assert.equal(time.resolveTimeZone({ env: { timezone: 'Asia/Shanghai' } }), 'Asia/Shanghai');
  assert.equal(time.resolveTimeZone({ env: { timezone: '  ' } }), '');
  assert.equal(time.resolveTimeZone({ env: { timezone: 'Not/AZone' } }), '');
  assert.equal(time.isValidTimeZone('Europe/London'), true);
  assert.equal(time.isValidTimeZone('Not/AZone'), false);
});

test('日期时间解析：越界/不存在的时刻必须拒绝，不能静默进位', () => {
  const sh = 'Asia/Shanghai';
  assert.equal(time.parseDateTime('2026-11-09 08:00', sh), Date.UTC(2026, 10, 9, 0, 0));
  assert.equal(time.parseDateTime('2026-11-09T08:00:00', sh), Date.UTC(2026, 10, 9, 0, 0));
  for (const bad of [
    '2026-01-01 99:00',
    '2026-13-01 10:00',
    '2026-02-31 10:00',
    '2026-01-01 23:59:99',
    '2026-04-31 08:00',
  ]) {
    assert.equal(time.parseDateTime(bad, sh), null, bad + ' 应该被拒绝');
  }
  // 夏令时跳过的 02:30 不存在，也不能被悄悄改成 01:30
  assert.equal(time.parseDateTime('2026-03-08 02:30', 'America/New_York'), null);
  // 不存在的日期反过来也不能把正确日期误杀
  assert.equal(time.parseDateTime('2028-02-29 10:00', sh), Date.UTC(2028, 1, 29, 2, 0));
});

test('放宽解析：只额外接受带显式时区的 ISO，不带时区仍按 env.timezone', () => {
  const sh = 'Asia/Shanghai';
  assert.equal(time.parseDateTimeLoose('2026-11-09 08:00', sh), Date.UTC(2026, 10, 9, 0, 0));
  assert.equal(time.parseDateTimeLoose('2026-11-09T00:00:00.000Z', sh), Date.UTC(2026, 10, 9, 0, 0));
  assert.equal(time.parseDateTimeLoose('2026-11-09T08:00:00+08:00', sh), Date.UTC(2026, 10, 9, 0, 0));
  assert.equal(time.parseDateTimeLoose('2026-02-31T10:00:00Z', sh), null);
  // 不带时区的 ISO 不能交给 Date.parse 按系统时区猜
  assert.equal(time.parseDateTimeLoose('2026-11-09T08:00:00', sh), Date.UTC(2026, 10, 9, 0, 0));
  assert.equal(time.parseDateTimeLoose('明天早上八点', sh), null);
});

test('“明天”按日历加一天，不受夏令时 25 小时影响', () => {
  const now = new Date('2026-11-01T04:30:00Z'); // 纽约 2026-11-01 00:30（回拨日）
  const at = new Date('2026-11-02T05:30:00Z');  // 纽约 2026-11-02 00:30
  assert.equal(reminder.describeWhen(at, now, 'America/New_York'), '明天 00:30');
  assert.equal(time.dayKeyOf(time.addDays(time.parts(now.getTime(), 'America/New_York'), 1)), '2026-11-02');
});

function makeRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-time-'));
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  const runtime = {
    config: loadConfig({ root, env: {} }),
    logger: { info() {}, warn() {}, error() {} },
    llm: { reload() {} },
  };
  return { root, runtime, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }) };
}

test('诊断页的现在/心情/活动按 env.timezone，和提示词看同一个时区', (t) => {
  const { debugState } = require('../src/services/debug');
  const { runtime, cleanup } = makeRuntime();
  t.after(cleanup);
  runtime.config.env.timezone = 'America/New_York';
  runtime.llm = {
    isMock: true, provider: 'deepseek', providerLabel: 'DeepSeek', model: 'deepseek-flash',
    baseUrl: '', apiKey: '', needsKey: false, temperature: 0.9, frequencyPenalty: 0, presencePenalty: 0,
  };
  runtime.gateways = new Map();
  runtime.store = {
    sessions: new Map(),
    summary: () => ({ sessions: 0, messages: 0, notes: 0, totalMessages: 0, totalReplies: 0 }),
  };
  runtime.bot = { lastUsage: null, lastBudget: null };

  // UTC 2026-01-01 15:00 = 纽约 2026-01-01 10:00（周四）
  const out = debugState(runtime, { now: Date.UTC(2026, 0, 1, 15, 0) });
  assert.match(out.nowLabel, /10:00/);
  assert.match(out.nowLabel, /周四/);
  assert.ok(out.mood && out.mood.name);
  assert.ok(out.activity);
});

test('日记的文件名和到点判断按 env.timezone，而不是系统本地时间', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diary-tz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const now = Date.UTC(2026, 0, 1, 15, 0); // 上海 2026-01-01 23:00；纽约 10:00
  const session = {
    platform: 'wechat',
    chatType: 'private',
    chatId: 'wechat:u:wxid_master',
    title: '主人',
    messages: [{ role: 'user', name: '主人', text: '今天聊得挺开心', ts: now - 60000 }],
  };
  const store = { sessions: new Map([['owner', session]]) };
  const llm = { isMock: false, complete: async () => '今天和主人聊得很开心。' };
  const config = {
    paths: { dataDir: dir },
    env: { timezone: 'Asia/Shanghai' },
    diary: { enabled: true, time: '23:00', sendToOwner: false },
    persona: { name: '鲸鲸', ownerName: '主人', master: { names: ['主人'], wxids: ['wxid_master'] } },
  };
  const service = new (require('../src/services/diary').DiaryService)(config, {
    store,
    llm,
    logger: { info() {}, warn() {} },
    now: () => now,
  });
  t.after(() => service.stop());
  await service.tick();
  assert.ok(fs.existsSync(path.join(dir, 'diary', '2026', '01-01.md')));

  // 同一时刻换成纽约时区：才上午 10 点，不到 23:00，不应生成。
  const nyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diary-tz-ny-'));
  t.after(() => fs.rmSync(nyDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const nyService = new (require('../src/services/diary').DiaryService)(
    { ...config, paths: { dataDir: nyDir }, env: { timezone: 'America/New_York' } },
    { store, llm, logger: { info() {}, warn() {} }, now: () => now }
  );
  t.after(() => nyService.stop());
  await nyService.tick();
  assert.equal(fs.existsSync(path.join(nyDir, 'diary')), false);
});

test('配置保存：时间字段统一规范化，非法时间段/时区直接拒绝', (t) => {
  const { runtime, cleanup } = makeRuntime();
  t.after(cleanup);

  applyConfigPatch(runtime, { 'diary.time': '9:00' });
  assert.equal(runtime.config.diary.time, '09:00');

  applyConfigPatch(runtime, { 'care.windows': ['09:00~12:00', '22:00到02:00'] });
  assert.deepEqual(runtime.config.care.windows, ['09:00-12:00', '22:00-02:00']);

  applyConfigPatch(runtime, { 'env.timezone': 'Asia/Shanghai' });
  assert.equal(runtime.config.env.timezone, 'Asia/Shanghai');
  const pub = publicConfig(runtime.config).config;
  assert.equal(pub.env.timezone, 'Asia/Shanghai');
  assert.equal(pub.env.PATH, undefined, '环境变量不能整份吐给启动器');

  assert.throws(() => applyConfigPatch(runtime, { 'care.windows': ['写错'] }), { statusCode: 400 });
  assert.throws(() => applyConfigPatch(runtime, { 'env.timezone': 'Not/AZone' }), { statusCode: 400 });
  assert.deepEqual(validate(runtime.config), []);
});
