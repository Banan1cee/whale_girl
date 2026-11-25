'use strict';

/**
 * 公告发布工具（维护者本地用，只改 website/content/announcements.json）。
 *
 * 一条命令做完：追加公告 / 删除公告 / 一键撤下 / 调弹窗节奏，
 * 自动递增 manifest_version、刷新 updated_at，写盘前按客户端同一套规则校验，
 * 写完再跑一遍 tests/announcements.test.js，任何一步不过就回滚原文件。
 *
 * 这个脚本只由 node 调用，不参与启动器编译，也不会被编进 WhaleLauncher.exe。
 * 用法：node scripts/announce.js --help
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FEED = path.join(ROOT, 'website', 'content', 'announcements.json');
const GATE_TEST = path.join(ROOT, 'tests', 'announcements.test.js');
const REPO = 'Banan1cee/whale_girl';

const ACTIONS = ['none', 'open_url', 'check_update'];
const LEVELS = ['info', 'warn', 'critical'];
const URL_HOSTS = ['github.com', 'raw.githubusercontent.com', 'bot.zyyc.cc', 'afdian.com'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[vV]?\d+(?:\.\d+){1,3}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_POPUPS = 20;
const MAX_DELAY = 10000;
const MAX_TITLE = 60;
const MAX_BODY = 400;
// 本地测试缓存用的序号：远高于正常发布序号，保证启动器优先读这份缓存。
const SEED_VERSION = 1000000;

// ── 校验：和客户端 / tests/announcements.test.js 同一套规则 ──────────────

const isInt = (value) => typeof value === 'number' && Number.isInteger(value);
const isPositiveInt = (value) => isInt(value) && value > 0;
const isIso = (value) => typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));

function hostAllowed(host) {
  const normalized = String(host || '').toLowerCase();
  return URL_HOSTS.some((allowed) => normalized === allowed || normalized.endsWith('.' + allowed));
}

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

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const cleanTitle = (value) => (typeof value === 'string'
  ? value.replace(CONTROL, '').replace(/[\r\n\t]/g, ' ').trim() : '');
const cleanBody = (value) => (typeof value === 'string' ? value.replace(CONTROL, '').trim() : '');

/** 返回错误列表；空数组表示合格。 */
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
      && (!isInt(config.max_popups_per_launch) || config.max_popups_per_launch < 0
        || config.max_popups_per_launch > MAX_POPUPS)) {
      bad(`config.max_popups_per_launch 必须是 0～${MAX_POPUPS} 的整数（客户端本地钳制上限）`);
    }
    if (config.popup_delay_ms !== undefined
      && (!isInt(config.popup_delay_ms) || config.popup_delay_ms < 0 || config.popup_delay_ms > MAX_DELAY)) {
      bad(`config.popup_delay_ms 必须是 0～${MAX_DELAY} 的整数（客户端本地钳制）`);
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
    else if (title.length > MAX_TITLE) bad(`${where}.title 清洗后 ${title.length} 字符，超过 ${MAX_TITLE}`);

    const body = cleanBody(item.body);
    if (body.length === 0) bad(`${where}.body 必填`);
    else if (body.length > MAX_BODY) bad(`${where}.body 清洗后 ${body.length} 字符，超过 ${MAX_BODY}`);

    if (item.level !== undefined && !LEVELS.includes(item.level)) {
      bad(`${where}.level 只能是 ${LEVELS.join(' / ')}（实际 ${JSON.stringify(item.level)}）`);
    }
    if (item.action !== undefined && !ACTIONS.includes(item.action)) {
      bad(`${where}.action 只能是 ${ACTIONS.join(' / ')}（实际 ${JSON.stringify(item.action)}）`);
    }
    if (item.action === 'open_url') {
      if (typeof item.url !== 'string') bad(`${where}.url 在 action=open_url 时必填`);
      else {
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

// ── 文件读写 ───────────────────────────────────────────────────────────

function skeleton() {
  return {
    schema: 1,
    manifest_version: 0,
    updated_at: new Date().toISOString(),
    kill: false,
    config: { popups_enabled: true, max_popups_per_launch: 3, popup_delay_ms: 1200 },
    announcements: [],
  };
}

function loadFeed(file) {
  if (!fs.existsSync(file)) return skeleton();
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return skeleton();
  const feed = JSON.parse(text);
  if (!feed.config) feed.config = skeleton().config;
  if (!Array.isArray(feed.announcements)) feed.announcements = [];
  return feed;
}

function writeFeed(file, feed) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(feed, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

function statePath() {
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new Error('拿不到 LOCALAPPDATA，无法定位启动器状态文件');
  return path.join(base, 'WhaleGirl', 'announcements-state.json');
}

// ── 具体动作 ───────────────────────────────────────────────────────────

function bump(feed) {
  feed.schema = 1;
  feed.manifest_version = (Number(feed.manifest_version) || 0) + 1;
  feed.updated_at = new Date().toISOString();
  if (typeof feed.kill !== 'boolean') feed.kill = false;
  return feed;
}

function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
}

function addAnnouncement(feed, options) {
  const title = options.title;
  const body = options.body;
  const entry = {
    id: options.id || `notice-${dateStamp()}-${Math.random().toString(36).slice(2, 6)}`,
    title,
    body,
    level: options.level || 'info',
    action: options.action || 'none',
    priority: options.priority === undefined ? 10 : options.priority,
    published_at: options.publishedAt || new Date().toISOString(),
  };
  if (options.url) entry.url = options.url;
  if (options.minVersion) entry.min_version = options.minVersion;
  if (options.maxVersion) entry.max_version = options.maxVersion;
  if (options.epoch !== undefined) entry.epoch = options.epoch;

  feed.announcements.push(entry);
  return entry;
}

function applyConfig(feed, options, warn) {
  const config = feed.config || (feed.config = skeleton().config);
  if (options.maxPopups !== undefined) {
    if (!isInt(options.maxPopups) || options.maxPopups < 0) throw new Error('--max-popups 必须是非负整数');
    if (options.maxPopups > MAX_POPUPS) {
      warn(`--max-popups ${options.maxPopups} 超过客户端上限，已按 ${MAX_POPUPS} 写入`);
    }
    config.max_popups_per_launch = Math.min(options.maxPopups, MAX_POPUPS);
  }
  if (options.delay !== undefined) {
    if (!isInt(options.delay) || options.delay < 0) throw new Error('--delay 必须是非负整数');
    if (options.delay > MAX_DELAY) warn(`--delay ${options.delay} 超过客户端上限，已按 ${MAX_DELAY} 写入`);
    config.popup_delay_ms = Math.min(options.delay, MAX_DELAY);
  }
  if (options.popups !== undefined) {
    if (!['on', 'off'].includes(options.popups)) throw new Error('--popups 只能是 on 或 off');
    config.popups_enabled = options.popups === 'on';
  }
}

// ── 参数 ───────────────────────────────────────────────────────────────

const FLAGS = new Set(['list', 'kill', 'unkill', 'dry-run', 'push', 'help', 'clear-local', 'keep-read', 'no-test']);
const VALUES = new Set(['id', 'level', 'action', 'url', 'priority', 'min-version', 'max-version', 'epoch',
  'published-at', 'body-file', 'file', 'max-popups', 'delay', 'popups', 'remove', 'seed-local']);

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      options.positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equal = body.indexOf('=');
    const name = equal >= 0 ? body.slice(0, equal) : body;
    const inline = equal >= 0 ? body.slice(equal + 1) : undefined;

    if (FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    if (!VALUES.has(name)) throw new Error(`未知参数 --${name}`);
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        // --seed-local 可以不带值（默认读当前 feed 文件），其它参数必须给值。
        if (name === 'seed-local') {
          options[name] = '';
          continue;
        }
        throw new Error(`--${name} 缺少值`);
      }
      value = next;
      i += 1;
    }
    options[name] = value;
  }
  return options;
}

function toInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`--${name} 必须是整数`);
  return number;
}

function usage() {
  return `公告发布工具（只改 website/content/announcements.json，不参与启动器编译）

用法：
  node scripts/announce.js "标题" "正文" [选项]        追加一条公告并递增序号
  node scripts/announce.js --list                     列出当前公告
  node scripts/announce.js --remove <id>              删除一条公告
  node scripts/announce.js --kill | --unkill          一键撤下 / 恢复全部
  node scripts/announce.js --seed-local [示例文件]     把公告写进本机缓存，供启动器本地预览
  node scripts/announce.js --clear-local              清掉本地预览缓存和已读

内容选项：
  --id <id>            小写字母/数字/._-，默认自动生成
  --level <info|warn|critical>
  --action <none|open_url|check_update>
  --url <https://...>  action=open_url 时必填（只允许官方域名）
  --priority <整数>     默认 10，越大越先弹
  --min-version / --max-version <版本号>   按客户端版本过滤
  --epoch <整数>        只给同一代次的客户端看
  --published-at <ISO>  默认现在
  --body-file <路径>    正文从文件读（长文本用）

节奏选项（写进 config，客户端仍会本地钳制）：
  --max-popups <0-20>   一次启动最多弹几条，默认沿用文件里的值
  --delay <0-10000>     弹窗前延迟毫秒
  --popups <on|off>     弹窗总开关（关掉仍保留铃铛历史）

其他：
  --file <路径>         默认 website/content/announcements.json
  --dry-run             只打印结果，不写盘
  --no-test             写完不跑 tests/announcements.test.js
  --push               提交并推送当前分支，打印 PR 链接（不会直接推 main）

示例：
  node scripts/announce.js "域名已更新" "官网正式域名为 bot.zyyc.cc" --level warn
  node scripts/announce.js --list
  node scripts/announce.js --seed-local examples/announcements-sample.json
`;
}

// ── 主流程 ─────────────────────────────────────────────────────────────

function main(argv = process.argv.slice(2), io = console) {
  const log = (message) => io.log(message);
  const warn = (message) => io.warn(`提示：${message}`);

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.error(error.message);
    return 1;
  }

  if (options.help) {
    log(usage());
    return 0;
  }

  const file = path.resolve(options.file || DEFAULT_FEED);
  const dryRun = Boolean(options['dry-run']);

  try {
    if (options['clear-local']) {
      const target = statePath();
      fs.rmSync(target, { force: true });
      log(`已清空本地公告缓存：${target}`);
      return 0;
    }

    if (options['seed-local'] !== undefined) {
      const sourceFile = path.resolve(options['seed-local'] || file);      const seed = loadFeed(sourceFile);
      const errors = validateFeed(seed);
      if (errors.length) {
        io.error(`示例公告文件不符合规格，未写入：\n  ${errors.join('\n  ')}`);
        return 1;
      }
      const cache = JSON.parse(JSON.stringify(seed));
      cache.manifest_version = Math.max(Number(cache.manifest_version) || 1, SEED_VERSION);
      cache.updated_at = new Date().toISOString();
      const target = statePath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const payload = { read: {}, cache, cached_at: new Date().toISOString() };
      if (options['keep-read'] && fs.existsSync(target)) {
        try {
          const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
          if (previous.read && typeof previous.read === 'object') payload.read = previous.read;
        } catch { /* 旧文件损坏就当没有 */ }
      }
      fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      log(`已写入本地预览缓存：${target}`);
      log(`共 ${cache.announcements.length} 条公告，序号 ${cache.manifest_version}。`);
      log('启动 WhaleLauncher.exe（会弹 UAC）即可看到弹窗和铃铛；测试完记得 --clear-local。');
      return 0;
    }

    const feed = loadFeed(file);

    if (options.list) {
      if (!feed.announcements.length) {
        log('当前没有公告。');
        return 0;
      }
      for (const item of feed.announcements) {
        log(`${item.id}  [${item.level || 'info'}] priority=${item.priority ?? 0}  ${item.title}`);
        if (item.action && item.action !== 'none') log(`    action=${item.action}${item.url ? ' ' + item.url : ''}`);
      }
      log(`共 ${feed.announcements.length} 条，manifest_version=${feed.manifest_version}，kill=${feed.kill}`);
      return 0;
    }

    if (options.remove) {
      const before = feed.announcements.length;
      feed.announcements = feed.announcements.filter((item) => item.id !== options.remove);
      if (feed.announcements.length === before) {
        io.error(`没有找到 id=${options.remove} 的公告`);
        return 1;
      }
      bump(feed);
      return finish(file, feed, options, io, `已删除 ${options.remove}`);
    }

    if (options.kill || options.unkill) {
      feed.kill = Boolean(options.kill);
      bump(feed);
      return finish(file, feed, options, io, options.kill ? '已撤下全部公告（kill=true）' : '已恢复公告（kill=false）');
    }

    const title = options.positional[0];
    let body = options.positional[1];
    if (options['body-file']) body = fs.readFileSync(path.resolve(options['body-file']), 'utf8').trim();
    if (!title || !body) {
      io.error('缺少标题或正文。用法：node scripts/announce.js "标题" "正文" [选项]');
      return 1;
    }

    applyConfig(feed, {
      maxPopups: options['max-popups'] === undefined ? undefined : toInt(options['max-popups'], 'max-popups'),
      delay: options.delay === undefined ? undefined : toInt(options.delay, 'delay'),
      popups: options.popups,
    }, warn);

    const entry = addAnnouncement(feed, {
      id: options.id,
      title,
      body,
      level: options.level,
      action: options.action,
      url: options.url,
      priority: options.priority === undefined ? undefined : toInt(options.priority, 'priority'),
      minVersion: options['min-version'],
      maxVersion: options['max-version'],
      epoch: options.epoch === undefined ? undefined : toInt(options.epoch, 'epoch'),
      publishedAt: options['published-at'],
    });

    bump(feed);
    return finish(file, feed, options, io, `已追加公告 ${entry.id}`);
  } catch (error) {
    io.error(`失败：${error.message}`);
    return 1;
  }
}

/** 校验 → 写盘 → 跑门禁；门禁不过就回滚。 */
function finish(file, feed, options, io, success) {
  const errors = validateFeed(feed);
  if (errors.length) {
    io.error(`公告文件不符合规格，未写入：\n  ${errors.join('\n  ')}`);
    return 1;
  }

  if (options['dry-run']) {
    io.log(`${success}（--dry-run，未写盘）`);
    io.log(JSON.stringify(feed, null, 2));
    return 0;
  }

  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  writeFeed(file, feed);

  if (!options['no-test'] && path.resolve(file) === path.resolve(DEFAULT_FEED)) {
    try {
      execFileSync(process.execPath, [GATE_TEST], { cwd: ROOT, stdio: 'pipe' });
    } catch (error) {
      if (original === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, original, 'utf8');
      io.error('测试没通过，已回滚公告文件：');
      io.error(String(error.stdout || '').trim() || error.message);
      return 1;
    }
  }

  io.log(`${success}（manifest_version=${feed.manifest_version}）`);
  io.log(`文件：${file}`);
  io.log(`共 ${feed.announcements.length} 条公告。`);
  if (options.push) return push(file, feed, io);
  io.log('下一步：git add 该文件并合入 main（或加 --push 自动推当前分支、开 PR）后，客户端下次启动生效。');
  return 0;
}

function push(file, feed, io) {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'main') {
    io.error('当前在 main 上：按仓库约定不能直接推 main，请先切分支（git switch -c content/announcements）。');
    return 1;
  }
  git('add', path.relative(ROOT, file));
  git('commit', '-m', `content: 公告 ${feed.announcements.map((item) => item.id).join(', ')}`);
  execFileSync('git', ['push', '-u', 'origin', branch], { cwd: ROOT, stdio: 'inherit' });
  io.log(`已推送分支 ${branch}。开 PR：https://github.com/${REPO}/compare/main...${branch}?expand=1`);
  return 0;
}

module.exports = { main, validateFeed, loadFeed, writeFeed };

if (require.main === module) {
  process.exitCode = main();
}
