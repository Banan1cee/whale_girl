'use strict';

/**
 * 公告契约测试。
 *
 * 公告是「改远端 JSON 就生效」的功能，没有后端、没有发版闸门，所以规则一旦漂移，用户侧
 * 就是直接可见的错：弹窗太多、链接跳出白名单、撤不掉的旧公告、旧版本误读新字段。
 * 这里三件事一起守：
 *   1. website/content/announcements.json 本身符合 JSON 规格（字段 / 枚举 / 长度 / 白名单）；
 *   2. launcher/AnnouncementFeed.cs 里的本地钳制与白名单还在（源码门禁，和仓库既有先例一致）；
 *   3. docs/公告与通知.md 还在，并且和本测试、CHANGELOG 的关键字对得上。
 *
 * 只读文件、不联网：改坏 JSON 或删掉关键常量，测试立刻红。
 * 公告的完整端到端行为（弹窗时机、已读、铃铛）由启动器 C# 回归负责，这里只守静态契约。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const FEED = 'website/content/announcements.json';
const DOC = 'docs/公告与通知.md';
const SOURCE = 'launcher/AnnouncementFeed.cs';

const ACTIONS = ['none', 'open_url', 'check_update'];
const LEVELS = ['info', 'warn', 'critical'];
// 与 AnnouncementFeed.AllowedUrlHosts 一致：公告里唯一有副作用的动作是打开链接。
const URL_HOSTS = ['github.com', 'raw.githubusercontent.com', 'bot.zyyc.cc', 'afdian.com'];
// 拉取源的主机名（GitHub 直连 / 镜像 / CDN / 自家官网 / 发布页资产）。
const SOURCE_HOSTS = ['raw.githubusercontent.com', 'gh-proxy.com', 'cdn.jsdelivr.net', 'bot.zyyc.cc', 'github.com'];

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[vV]?\d+(?:\.\d+){1,3}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isInt = (value) => typeof value === 'number' && Number.isInteger(value);
const isPositiveInt = (value) => isInt(value) && value > 0;

function isIso(value) {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function hostAllowed(host) {
  const normalized = String(host || '').toLowerCase();
  return URL_HOSTS.some((allowed) => normalized === allowed || normalized.endsWith('.' + allowed));
}

/** 返回 '' 表示合格，否则返回原因（与 AnnouncementFeed.IsAllowedUrl 的判定一致）。 */
function urlError(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return '不是合法 URL';
  }
  if (url.protocol !== 'https:') return '必须是 https';
  if (url.username || url.password) return '不能带 userinfo';
  if (url.port !== '' && url.port !== '443') return '端口必须是 443';
  if (!hostAllowed(url.hostname)) return `host 不在白名单（${url.hostname}）`;
  return '';
}

// 客户端展示前会清洗控制字符 / 双向文本标记；title 压成单行，body 保留换行。
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, '').replace(/[\r\n\t]/g, ' ').trim();
}

function cleanBody(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, '').trim();
}

/**
 * 按规格校验一份公告 feed，返回错误列表（空数组 = 合格）。
 * 只看格式，不看发布策略；所有长度都按客户端清洗后的长度算。
 */
function validateFeed(feed) {
  const errors = [];
  const bad = (message) => errors.push(message);

  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    bad('顶层必须是 JSON 对象');
    return errors;
  }
  if (feed.schema !== 1) bad(`schema 必须是 1（实际 ${JSON.stringify(feed.schema)}）`);
  if (!isPositiveInt(feed.manifest_version)) bad('manifest_version 必须是正整数');
  if (!isIso(feed.updated_at)) bad('updated_at 必须是可解析的 ISO8601 字符串');
  if (typeof feed.kill !== 'boolean') bad('kill 必须是布尔');

  const config = feed.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    bad('config 必须是对象');
  } else {
    if (config.popups_enabled !== undefined && typeof config.popups_enabled !== 'boolean') {
      bad('config.popups_enabled 必须是布尔');
    }
    if (config.max_popups_per_launch !== undefined
      && (!isInt(config.max_popups_per_launch) || config.max_popups_per_launch < 0 || config.max_popups_per_launch > 20)) {
      bad('config.max_popups_per_launch 必须是 0～20 的整数（客户端本地钳制上限）');
    }
    if (config.popup_delay_ms !== undefined
      && (!isInt(config.popup_delay_ms) || config.popup_delay_ms < 0 || config.popup_delay_ms > 10000)) {
      bad('config.popup_delay_ms 必须是 0～10000 的整数（客户端本地钳制）');
    }
  }

  if (!Array.isArray(feed.announcements)) {
    bad('announcements 必须是数组');
    return errors;
  }

  const ids = new Set();
  feed.announcements.forEach((item, index) => {
    const where = `announcements[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      bad(`${where} 必须是对象`);
      return;
    }

    if (typeof item.id !== 'string' || !ID_RE.test(item.id)) {
      bad(`${where}.id 不符合 ${ID_RE}（实际 ${JSON.stringify(item.id)}）`);
    } else if (ids.has(item.id)) {
      bad(`${where}.id 与其他条目重复：${item.id}`);
    } else {
      ids.add(item.id);
    }

    const title = cleanTitle(item.title);
    if (title.length === 0) bad(`${where}.title 必填`);
    else if (title.length > 60) bad(`${where}.title 清洗后 ${title.length} 字符，超过 60`);

    const body = cleanBody(item.body);
    if (body.length === 0) bad(`${where}.body 必填`);
    else if (body.length > 400) bad(`${where}.body 清洗后 ${body.length} 字符，超过 400`);

    if (item.level !== undefined && !LEVELS.includes(item.level)) {
      bad(`${where}.level 只能是 ${LEVELS.join(' / ')}（实际 ${JSON.stringify(item.level)}）`);
    }
    if (item.action !== undefined && !ACTIONS.includes(item.action)) {
      bad(`${where}.action 只能是 ${ACTIONS.join(' / ')}（实际 ${JSON.stringify(item.action)}）`);
    }
    if (item.action === 'open_url') {
      if (typeof item.url !== 'string') {
        bad(`${where}.url 在 action=open_url 时必填`);
      } else {
        const reason = urlError(item.url);
        if (reason) bad(`${where}.url ${reason}`);
      }
    }
    if (item.published_at !== undefined && !isIso(item.published_at)) {
      bad(`${where}.published_at 必须是可解析的 ISO8601 字符串`);
    }
    for (const field of ['min_version', 'max_version']) {
      if (item[field] !== undefined && (typeof item[field] !== 'string' || !VERSION_RE.test(item[field]))) {
        bad(`${where}.${field} 必须是 2～4 段数字版本号（可带 v 前缀）`);
      }
    }
    if (item.epoch !== undefined && !(isInt(item.epoch) && item.epoch > 0)) {
      bad(`${where}.epoch 必须是 >0 的整数`);
    }
    if (item.priority !== undefined && !isInt(item.priority)) {
      bad(`${where}.priority 必须是整数`);
    }
  });

  return errors;
}

function baseFeed(overrides = {}) {
  return {
    schema: 1,
    manifest_version: 1,
    updated_at: '2026-11-24T00:00:00Z',
    kill: false,
    config: { popups_enabled: true, max_popups_per_launch: 3, popup_delay_ms: 1200 },
    announcements: [],
    ...overrides,
  };
}

function baseAnnouncement(overrides = {}) {
  return { id: 'notice-1', title: '标题', body: '正文', ...overrides };
}

test('website/content/announcements.json 符合公告 JSON 规格', () => {
  const file = path.join(root, FEED);
  assert.ok(fs.existsSync(file), `${FEED} 不存在：公告数据文件必须随仓库提交`);

  let feed;
  assert.doesNotThrow(() => { feed = JSON.parse(read(FEED)); }, `${FEED} 不是合法 JSON`);
  const errors = validateFeed(feed);
  assert.deepEqual(errors, [], `公告 feed 不符合规格：\n  ${errors.join('\n  ')}`);

  // 就算以后清空公告，这两个值也必须存在且可解析——客户端靠它们仲裁新旧份。
  assert.ok(feed.manifest_version >= 1);
  assert.equal(typeof feed.kill, 'boolean');
});

test('validateFeed 本身有效：合法示例通过，越界/越权示例被拒', () => {
  // 默认值兜底：只写必填字段的条目也合法（level/action/priority 等都有默认值）。
  assert.deepEqual(
    validateFeed(baseFeed({
      config: {},
      announcements: [baseAnnouncement({
        action: 'open_url',
        url: 'https://github.com/Banan1cee/whale_girl/releases',
        published_at: '2026-11-24T10:00:00Z',
        min_version: 'v4.2',
        max_version: '4.3.0.1',
        epoch: 1,
        priority: 10,
      })],
    })),
    [],
    '一份合法的最小 feed 不该被校验器拒绝'
  );

  const cases = [
    ['schema 不是 1', baseFeed({ schema: 2 }), /schema/],
    ['manifest_version 不是正整数', baseFeed({ manifest_version: 0 }), /manifest_version/],
    ['updated_at 不可解析', baseFeed({ updated_at: '昨天' }), /updated_at/],
    ['kill 不是布尔', baseFeed({ kill: 'true' }), /kill/],
    ['config 不是对象', baseFeed({ config: [] }), /config/],
    ['弹窗上限超过本地钳制', baseFeed({ config: { max_popups_per_launch: 21 } }), /max_popups_per_launch/],
    ['延迟超过本地钳制', baseFeed({ config: { popup_delay_ms: 10001 } }), /popup_delay_ms/],
    ['announcements 不是数组', baseFeed({ announcements: {} }), /announcements/],
    ['id 大写/带空格', baseFeed({ announcements: [baseAnnouncement({ id: 'Notice 1' })] }), /\.id/],
    ['id 重复', baseFeed({ announcements: [baseAnnouncement(), baseAnnouncement({ title: '另一条' })] }), /重复/],
    ['level 不在枚举里', baseFeed({ announcements: [baseAnnouncement({ level: 'danger' })] }), /\.level/],
    ['action 不在枚举里', baseFeed({ announcements: [baseAnnouncement({ action: 'open-url' })] }), /\.action/],
    ['open_url 用 http', baseFeed({ announcements: [baseAnnouncement({ action: 'open_url', url: 'http://github.com/x' })] }), /https/],
    ['open_url 跳到非白名单', baseFeed({ announcements: [baseAnnouncement({ action: 'open_url', url: 'https://evil.example/x' })] }), /白名单/],
    // 拼出来而不是写整串：完整 URL 里的 "域名@域名" 形态会被隐私扫描误认成邮箱。
    ['open_url 带 userinfo 伪造 host', baseFeed({
      announcements: [baseAnnouncement({ action: 'open_url', url: 'https://github.com' + '@' + 'evil.example/x' })],
    }), /白名单|userinfo/],
    ['版本号只有一段', baseFeed({ announcements: [baseAnnouncement({ min_version: '4' })] }), /min_version/],
    ['priority 不是整数', baseFeed({ announcements: [baseAnnouncement({ priority: 1.5 })] }), /priority/],
    ['title 超长', baseFeed({ announcements: [baseAnnouncement({ title: '字'.repeat(61) })] }), /title/],
    ['body 超长', baseFeed({ announcements: [baseAnnouncement({ body: '字'.repeat(401) })] }), /body/],
    ['published_at 不可解析', baseFeed({ announcements: [baseAnnouncement({ published_at: '待定' })] }), /published_at/],
  ];
  for (const [label, feed, expected] of cases) {
    const errors = validateFeed(feed);
    assert.ok(errors.length > 0, `校验器漏掉了「${label}」`);
    assert.ok(errors.some((message) => expected.test(message)),
      `「${label}」的报错文不对题：${errors.join('；')}`);
  }
});

test('AnnouncementFeed.cs：本地钳制 20、动作枚举、允许域名、四个拉取源都还在', () => {
  const file = path.join(root, SOURCE);
  assert.ok(fs.existsSync(file), `${SOURCE} 不存在：公告功能源码必须和测试一起提交`);
  const source = read(SOURCE);

  // 远端写的条数和延迟不能突破本地上限；这是「公告永不烦人」的底线。
  assert.match(source, /MaxPopupsLimit\s*=\s*20/, '缺少本地钳制上限 MaxPopupsLimit = 20');
  assert.match(source, /MaxDelayMs\s*=\s*10000/, '缺少延迟本地上限 MaxDelayMs = 10000');
  assert.match(source, /Clamp\([\s\S]{0,180}MaxPopupsLimit\)/s, '远端弹窗条数没有经过本地钳制');
  assert.match(source, /MaxReadEntries\s*=\s*500/, '已读 id 没有 500 条上限');

  for (const action of ACTIONS) {
    assert.ok(source.includes(`"${action}"`), `AnnouncementFeed.cs 缺少动作 ${action}`);
  }
  for (const host of URL_HOSTS) {
    assert.ok(source.includes(host), `AnnouncementFeed.cs 缺少允许打开的域名 ${host}`);
  }
  for (const host of SOURCE_HOSTS) {
    assert.ok(source.includes(host), `AnnouncementFeed.cs 缺少公告源 ${host}`);
  }

  // 排序规则与状态文件：priority 降序、published_at 降序；状态文件落在 LocalAppData。
  assert.ok(source.includes('OrderByDescending'), '公告没有排序（按 priority / published_at 倒序）');
  assert.ok(source.includes('Priority'));
  assert.ok(source.includes('PublishedAt'));
  assert.ok(source.includes('announcements-state.json'), '状态文件名变了');
  assert.ok(source.includes('WhaleGirl'), '状态目录不是 %LocalAppData%\\WhaleGirl');
  assert.ok(source.includes('"kill"'), '没有解析 kill 撤下开关');
  assert.ok(source.includes('manifest_version'), '没有解析 manifest_version 做多源仲裁');
});

test('docs/公告与通知.md：存在且覆盖字段、展示规则、状态文件与边界', () => {
  const file = path.join(root, DOC);
  assert.ok(fs.existsSync(file), `${DOC} 不存在：公告规则必须有独立文档`);
  const doc = read(DOC);

  const needles = [
    'manifest_version', 'kill', 'max_popups_per_launch', 'popup_delay_ms', 'popups_enabled',
    'announcements-state.json', '跳过本批', 'force_versions', 'kill_below',
    '没有签名验签', '旧版本', '不会影响启动', '4.2.0',
  ];
  for (const needle of needles) {
    assert.ok(doc.includes(needle), `${DOC} 缺少关键串「${needle}」`);
  }
  for (const host of URL_HOSTS) {
    assert.ok(doc.includes(host), `${DOC} 没有写清允许域名 ${host}`);
  }

  // 文档里的完整示例必须是合法 feed，且至少有一条公告——文档和规格不能各说一套。
  const blocks = [...doc.matchAll(/```json\s*\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.ok(blocks.length > 0, `${DOC} 没有 JSON 示例`);
  const example = blocks
    .map((text) => { try { return JSON.parse(text); } catch { return null; } })
    .find((value) => value && value.schema === 1 && Array.isArray(value.announcements));
  assert.ok(example, `${DOC} 里找不到完整的 feed 示例 JSON`);
  const errors = validateFeed(example);
  assert.deepEqual(errors, [], `文档示例 JSON 不符合规格：\n  ${errors.join('\n  ')}`);
  assert.ok(example.announcements.length >= 1, '文档示例至少要包含一条公告');
});

test('CHANGELOG 4.2.0：新增公告小节紧跟在更新弹窗摘要之后，摘要仍满足长度限制', () => {
  const changelog = read('docs/CHANGELOG.md');
  const start = changelog.indexOf('## 4.2.0');
  assert.ok(start >= 0, 'docs/CHANGELOG.md 找不到 4.2.0 版本');
  const rest = changelog.slice(start + '## 4.2.0'.length);
  const next = rest.indexOf('\n## ');
  const body = next < 0 ? rest : rest.slice(0, next);

  const summaryAt = body.indexOf('### 更新弹窗摘要');
  const noticeAt = body.indexOf('### 新增 · 公告');
  assert.ok(summaryAt >= 0, '4.2.0 缺少更新弹窗摘要');
  assert.ok(noticeAt > summaryAt, '缺少「### 新增 · 公告」小节，或位置不在更新弹窗摘要之后');
  assert.equal(body.indexOf('### ', summaryAt + 1), noticeAt,
    '「### 新增 · 公告」必须紧跟在更新弹窗摘要之后、其他小节之前');

  const noticeSection = body.slice(noticeAt, body.indexOf('\n### ', noticeAt + 1));
  assert.ok(noticeSection.split(/\r?\n/).filter((line) => line.startsWith('- ')).length >= 2,
    '公告小节至少要有 2 条说明');

  // 更新弹窗摘要：1～5 行、每行 ≤15 个字符（与 scripts/release-notes.js 一致）。
  const { popupSummary } = require('../scripts/release-notes.js');
  const lines = popupSummary(changelog, '4.2.0').split('\n');
  assert.ok(lines.length >= 1 && lines.length <= 5, `更新弹窗摘要必须是 1～5 行，实际 ${lines.length} 行`);
  for (const line of lines) {
    assert.match(line, /^- \S/);
    assert.ok(line.replace(/^- /, '').length <= 15, `摘要行超过 15 字：${line}`);
  }
});
