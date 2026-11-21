'use strict';

/**
 * 订单落盘层：relay 唯一的写状态入口。上层只调这里，不关心文件怎么摆。
 *
 * 为什么这样设计（见 relay/CONTRACT.md 第 3、4 节）：
 * - order.json 是订单的唯一事实来源，index.json 只是给人/CLI 用的缓存，随坏可重建；
 *   所以读路径永远先认 order.json，索引只在需要「按 chat 找单」时当候选表。
 * - 所有 JSON 写入都是「先写同目录临时文件再 rename」。rename 在同分区是原子的，
 *   断电/进程被杀最多留下一个没人认领的 .tmp，绝不会让 index.json 变成半截 JSON。
 * - 锁分两层：进程内用 Promise 队列（同订单串行），跨进程用 <订单目录>/.lock 文件
 *   （pid + 启动时间 + nonce）。锁文件放订单目录里，删订单时一起消失，也不污染 layout。
 * - 订单 ID 是唯一进入文件路径的外部标识，格式强校验 + 根内断言，避免 ../ 之类的路径穿越。
 * - 状态根目录由调用方传入（createOrders({root})），模块不读 config.json，测试可完全隔离。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ORDER_STATUSES = ['intake', 'working', 'delivered'];
// 「未关闭」= 还会继续推进的订单；delivered 视为已归档，再收到消息要开新单
const OPEN_STATUSES = ['intake', 'working'];
const ORDER_ID_RE = /^ord-\d{8}-[0-9a-f]{4,12}$/;
// 追加写的硬上限：一条 JSONL 行 / 一段 markdown 必须能被人和 GUI 流畅读取，
// 也避免 model 偶发的超长输出把日志文件撑爆。
const MAX_ENTRY_BYTES = 4096;
// 锁文件里的 pid 已经死了、或者超过这个时长都没释放，就认为持有者已经崩了，可以抢占
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_WAIT_MS = 2 * 60 * 1000;
const TEMPLATE_PLACEHOLDER = '<!-- 待补充 -->';
// updateOrder 收到未知字段只 warn 一次，避免每轮刷屏（字段名是代码常量，不含客户数据）
const warnedFields = new Set();

// ---------- 路径与校验 ----------

function resolveRoot(root) {
  const raw = root || process.env.RELAY_STATE || path.join(__dirname, '..', 'state');
  return path.resolve(String(raw));
}

/**
 * 订单 ID 是唯一会拼进路径的外部输入，这里必须钉死格式。
 * 订单号由本模块生成，形如 ord-20261121-1a2b3c。
 */
function assertOrderId(orderId) {
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) {
    throw new TypeError('非法 orderId：' + String(orderId).slice(0, 80) + '（期望 ord-YYYYMMDD-6位hex）');
  }
  return orderId;
}

// 纵深防御：即使以后放宽 ID 规则，也不允许拼出的路径跑到状态根外面去
function assertInside(parent, target) {
  const rel = path.relative(parent, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return target;
  throw new Error('路径越界：' + target + ' 不在 ' + parent + ' 之下');
}

function pathsAt(root, orderId) {
  const id = assertOrderId(orderId);
  const ordersDir = path.join(root, 'orders');
  const dir = assertInside(ordersDir, path.join(ordersDir, id));
  return {
    root,
    dir,
    orderJson: path.join(dir, 'order.json'),
    orderMd: path.join(dir, 'order.md'),
    threadMd: path.join(dir, 'thread.md'),
    events: path.join(dir, 'events.jsonl'),
    workerJsonl: path.join(dir, 'worker.jsonl'),
    workspace: path.join(dir, 'workspace'),
    deliverables: path.join(dir, 'deliverables'),
    lock: path.join(dir, '.lock'),
    index: path.join(ordersDir, 'index.json'),
  };
}

// ---------- 原子写 ----------

function nowIso() {
  return new Date().toISOString();
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Windows 上 rename 目标可能被杀软/GUI 短暂占住，重试几次比直接失败好
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 写临时文件再 rename。临时文件名带 pid + nonce：两个进程同时写同一个目标时
 * 各写各的临时文件，谁敢最后 rename 谁生效，不会互相写花对方的字节。
 */
function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  fs.writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 5 || !RENAME_RETRY_CODES.has(err.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* 临时文件清理失败不影响主流程，rename 失败才是要抛的错 */
        }
        throw err;
      }
      sleepSync(20 * (attempt + 1));
    }
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

// ---------- 追加写 ----------

function readByteAt(file, pos) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, pos);
    return buf[0];
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 崩溃可能让最后一行没有换行符。追加前补一个，否则新内容会和半截旧行粘成一行，
 * 之后所有 JSONL 解析都会从这一行开始错位。
 */
function ensureTrailingNewline(file) {
  const stat = statOrNull(file);
  if (!stat || stat.size === 0) return;
  if (readByteAt(file, stat.size - 1) !== 0x0a) fs.appendFileSync(file, '\n', 'utf8');
}

function appendLine(file, line) {
  ensureTrailingNewline(file);
  fs.appendFileSync(file, line + '\n', 'utf8');
}

// 段与段之间空一行，thread.md 在 GUI/编辑器里才看得出轮次边界
function ensureBlockSeparator(file) {
  const stat = statOrNull(file);
  if (!stat || stat.size === 0) return;
  const last = readByteAt(file, stat.size - 1);
  if (last === 0x0a) {
    if (stat.size >= 2 && readByteAt(file, stat.size - 2) === 0x0a) return;
    fs.appendFileSync(file, '\n', 'utf8');
    return;
  }
  fs.appendFileSync(file, '\n\n', 'utf8');
}

// ---------- 文本截断（保证单条 < MAX_ENTRY_BYTES 且不切坏多字节字符） ----------

function cutUtf8(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (used + size > maxBytes - 3) break; // 留 3 字节给省略号
    out += ch;
    used += size;
  }
  return out + '…';
}

function splitUtf8(text, limit) {
  const chunks = [];
  let cur = '';
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (used + size > limit && cur) {
      chunks.push(cur);
      cur = '';
      used = 0;
    }
    cur += ch;
    used += size;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function collectStringRefs(value, refs, depth) {
  if (!value || typeof value !== 'object' || depth > 3) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] === 'string') refs.push({ holder: value, key: i });
      else collectStringRefs(value[i], refs, depth + 1);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') refs.push({ holder: value, key });
    else collectStringRefs(value[key], refs, depth + 1);
  }
}

/**
 * 把一条事件压进 < 4KB 的 JSONL 行。
 * 为什么不是直接截断序列化结果：那会写出半截 JSON，后续整份 files 都解析不了。
 * 这里逐个砍最长的字符串字段并打 truncated 标记，宁可丢内容也要保住「一行一个合法 JSON」。
 */
function fitJsonLine(value, limit = MAX_ENTRY_BYTES) {
  let line = JSON.stringify(value);
  if (line === undefined) return 'null';
  if (Buffer.byteLength(line) <= limit) return line;

  const copy = JSON.parse(line);
  if (copy && typeof copy === 'object' && !Array.isArray(copy)) copy.truncated = true;
  const refs = [];
  collectStringRefs(copy, refs);
  for (let guard = 0; guard < 64 && Buffer.byteLength(line) > limit; guard++) {
    let shrunk = false;
    for (const ref of refs) {
      const cur = ref.holder[ref.key];
      const bytes = Buffer.byteLength(cur);
      if (bytes > 16) {
        ref.holder[ref.key] = cutUtf8(cur, Math.floor(bytes / 2));
        shrunk = true;
      }
    }
    if (!shrunk) break;
    line = JSON.stringify(copy);
  }
  if (Buffer.byteLength(line) <= limit) return line;
  // 兜底：字段本身太多（不是字符串长），换成最小可解析行，审计时能看出丢了什么类型
  const type = copy && typeof copy.type === 'string' ? copy.type.slice(0, 64) : 'unknown';
  return JSON.stringify({ at: nowIso(), type, truncated: true, dropped: true });
}

// ---------- 订单对象 ----------

function formatLocalDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return '' + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
}

function newOrderId(ordersDir) {
  // 用本地日期：老板看订单号时按墙上时间理解，不是 UTC
  const day = formatLocalDate(new Date());
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = 'ord-' + day + '-' + crypto.randomBytes(3).toString('hex');
    if (!fs.existsSync(path.join(ordersDir, id))) return id;
  }
  throw new Error('订单号生成失败：连续 8 次撞号，检查系统时间或状态目录');
}

function emptyOrder(orderId, chatId, nickname) {
  const at = nowIso();
  return {
    orderId,
    chatId,
    nickname,
    status: 'intake',
    title: '',
    deskSessionId: null,
    workerSessionId: null,
    pendingQuestions: [],
    pendingReport: '',
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * 读盘后补齐字段。保留未知字段：index 之外可能有 CLI 手写的备注，
 * updateOrder 整单回写时不该把它们抹掉。
 */
function normalizeOrder(raw) {
  const order = Object.assign({}, raw);
  order.orderId = String(order.orderId || '');
  order.chatId = String(order.chatId ?? '');
  order.nickname = String(order.nickname ?? '');
  if (!ORDER_STATUSES.includes(order.status)) {
    throw new Error('order.json 状态非法：orderId=' + order.orderId + ' status=' + String(order.status));
  }
  order.title = String(order.title ?? '');
  order.deskSessionId = order.deskSessionId ?? null;
  order.workerSessionId = order.workerSessionId ?? null;
  order.pendingQuestions = Array.isArray(order.pendingQuestions) ? order.pendingQuestions : [];
  order.pendingReport = String(order.pendingReport ?? '');
  order.createdAt = String(order.createdAt ?? '');
  order.updatedAt = String(order.updatedAt ?? order.createdAt);
  return order;
}

function indexEntry(order) {
  return {
    status: order.status,
    chatId: order.chatId,
    nickname: order.nickname,
    title: order.title,
    deskSessionId: order.deskSessionId,
    workerSessionId: order.workerSessionId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function isOpenStatus(status) {
  return OPEN_STATUSES.includes(status);
}

// ---------- order.md ----------

function orderMdTemplate(order) {
  const lines = [
    '# 订单 ' + order.orderId,
    '',
    '- 客户：' + (order.nickname || '（未命名）'),
    '- 创建：' + order.createdAt,
    '',
    '## 【需求】',
    '',
    TEMPLATE_PLACEHOLDER,
    '',
    '## 【验收】',
    '',
    TEMPLATE_PLACEHOLDER,
    '',
    '## 【口径】',
    '',
    TEMPLATE_PLACEHOLDER,
    '',
  ];
  return lines.join('\n');
}

function isSectionHeading(line) {
  return /^\s*(?:#{1,6}\s*)?【[^】]+】\s*$/.test(line);
}

function findRequirementRange(lines) {
  const start = lines.findIndex((line) => /^\s*(?:#{1,6}\s*)?【需求】\s*$/.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // 只在新小节标题处收尾；代码块里的 # 注释可能误判，但 order.md 不写代码块
    if (/^#{1,6}\s/.test(lines[i]) || isSectionHeading(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function normalizeEntries(entries) {
  const raw = Array.isArray(entries) ? entries : [entries];
  const out = [];
  for (const item of raw) {
    if (item == null) continue;
    for (const line of String(item).split('\n')) {
      const text = line.trim();
      if (text) out.push(text);
    }
  }
  return out;
}

function toBullet(text) {
  // 调用方可能已经带了列表符号/标题，别套两层
  if (/^([-*]|\d+[.)])\s/.test(text) || /^#{1,6}\s/.test(text)) return text;
  return '- ' + text;
}

// ---------- 索引（缓存） ----------

function buildIndexAt(root) {
  const ordersDir = path.join(root, 'orders');
  const index = {};
  let entries = [];
  try {
    entries = fs.readdirSync(ordersDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!ORDER_ID_RE.test(entry.name)) continue; // 只认本模块生成的目录，手写目录不碰
    let order = null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ordersDir, entry.name, 'order.json'), 'utf8'));
      order = normalizeOrder(raw);
      if (order.orderId !== entry.name) order.orderId = entry.name;
    } catch {
      // 重建索引是修复手段，单个坏文件不能让它整体失败；坏文件留给人工处理
      order = null;
    }
    if (order) index[order.orderId] = indexEntry(order);
  }
  fs.mkdirSync(ordersDir, { recursive: true });
  writeJsonAtomic(path.join(ordersDir, 'index.json'), index);
  return index;
}

function loadIndexAt(root) {
  const ordersDir = path.join(root, 'orders');
  const indexFile = path.join(ordersDir, 'index.json');
  const dirStat = statOrNull(ordersDir);
  if (!dirStat) return {};
  const indexStat = statOrNull(indexFile);
  if (!indexStat) return buildIndexAt(root);
  // 订单目录的新增/删除会更新 orders/ 的 mtime；比 index.json 新就说明缓存已经落后
  // （例如上次写完 order.json 就被杀在写索引之前），先重建再读。
  if (dirStat.mtimeMs > indexStat.mtimeMs) return buildIndexAt(root);
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* 落到重建 */
  }
  return buildIndexAt(root);
}

function syncIndexEntryAt(root, order) {
  const index = loadIndexAt(root);
  index[order.orderId] = indexEntry(order);
  writeJsonAtomic(path.join(root, 'orders', 'index.json'), index);
  return index;
}

// ---------- 锁 ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 没这个进程；EPERM = 进程在但不是我们的，也算活着
    return err.code !== 'ESRCH';
  }
}

function parseLock(text) {
  try {
    const lock = JSON.parse(text);
    if (!lock || typeof lock !== 'object') return null;
    return lock;
  } catch {
    return null;
  }
}

function isLockStale(lock) {
  if (!lock) return true; // 半截/非法锁文件等于没人持有
  const startedMs = Date.parse(lock.startedAt);
  if (!Number.isFinite(startedMs)) return true;
  if (Date.now() - startedMs > LOCK_STALE_MS) return true;
  // 跨机器没法查 pid（hostname 不同），只能靠时长判断
  if (lock.host === os.hostname()) return !isProcessAlive(Number(lock.pid));
  return false;
}

async function acquireFileLock(lockPath, timeoutMs) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: nowIso(),
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const body = JSON.stringify(token);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // wx = 独占创建，锁文件不可能有两个赢家
      fs.writeFileSync(lockPath, body, { encoding: 'utf8', flag: 'wx' });
      return token;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const holder = parseLock(readIfExists(lockPath) || '');
    if (isLockStale(holder)) {
      // 抢占：删掉再重试 wx。两个进程同时抢只有一个能创建成功，另一个继续排队。
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // Windows 上可能被占用；睡一下再来，别在这里死循环
          if (Date.now() >= deadline) throw new Error('等待订单锁超时：' + lockPath);
          await sleep(10 + Math.floor(Math.random() * 20));
        }
      }
      continue;
    }
    if (Date.now() >= deadline) {
      const heldBy = holder ? 'pid=' + holder.pid + ' startedAt=' + holder.startedAt : '未知';
      throw new Error('等待订单锁超时：' + lockPath + '（持有者 ' + heldBy + '）');
    }
    // 排队等待，不抛错：锁通常只持有几毫秒
    await sleep(15 + Math.floor(Math.random() * 20));
  }
}

function releaseFileLock(lockPath, token) {
  const holder = parseLock(readIfExists(lockPath) || '');
  if (!holder || holder.nonce !== token.nonce) return; // 锁已经被别人抢走，别误删
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// ---------- store ----------

/**
 * @param {{root?: string}} [opts] root 默认取 RELAY_STATE，再退到 relay/state。
 * @returns 绑定了 root 的订单操作集合。
 */
function createOrders(opts = {}) {
  const root = resolveRoot(opts.root);

  // 首次创建就把 orders/ 和 index.json 铺好，第一次 ensureOrder 不用重复判断
  const ordersDir = path.join(root, 'orders');
  fs.mkdirSync(ordersDir, { recursive: true });
  if (!statOrNull(path.join(ordersDir, 'index.json'))) {
    writeJsonAtomic(path.join(ordersDir, 'index.json'), {});
  }

  function paths(orderId) {
    return pathsAt(root, orderId);
  }

  function loadOrder(orderId) {
    const p = paths(orderId);
    const text = readIfExists(p.orderJson);
    if (text == null) return null;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('order.json 解析失败：' + p.orderJson);
    }
    const order = normalizeOrder(raw);
    if (order.orderId !== orderId) order.orderId = orderId;
    return order;
  }

  function mustLoad(orderId) {
    const order = loadOrder(orderId);
    if (!order) throw new Error('订单不存在：' + orderId + '（' + pathsAt(root, orderId).orderJson + '）');
    return order;
  }

  function findOpenOrderByChat(chatId) {
    const wanted = String(chatId);
    const index = loadIndexAt(root);
    // 索引只是候选表：是否复用必须用 order.json 复核，否则索引滞后会拿 delivered 单凑数
    const candidates = [];
    for (const id of Object.keys(index)) {
      if (index[id] && index[id].chatId === wanted && isOpenStatus(index[id].status)) candidates.push(id);
    }
    let best = null;
    for (const id of candidates) {
      let order = null;
      try {
        order = loadOrder(id);
      } catch {
        order = null;
      }
      if (!order || order.chatId !== wanted || !isOpenStatus(order.status)) continue;
      if (!best || String(order.createdAt) > String(best.createdAt)) best = order;
    }
    return best;
  }

  function ensureOrder({ chatId, nickname } = {}) {
    if (typeof chatId !== 'string' || !chatId.trim()) {
      throw new TypeError('ensureOrder 需要非空 chatId');
    }
    const name = nickname == null ? '' : String(nickname).slice(0, 120);
    const existing = findOpenOrderByChat(chatId);
    if (existing) {
      // 昵称会变（改群名/改备注），复用顺手更新；其余字段不动，避免每轮白写盘
      if (name && name !== existing.nickname) {
        return { order: updateOrder(existing.orderId, { nickname: name }), created: false };
      }
      return { order: existing, created: false };
    }

    const orderId = newOrderId(ordersDir);
    const order = emptyOrder(orderId, chatId, name);
    const p = paths(orderId);
    fs.mkdirSync(p.dir, { recursive: true });
    fs.mkdirSync(p.workspace, { recursive: true });
    fs.mkdirSync(p.deliverables, { recursive: true });
    writeJsonAtomic(p.orderJson, order);
    writeFileAtomic(p.orderMd, orderMdTemplate(order));
    syncIndexEntryAt(root, order);
    return { order, created: true };
  }

  function updateOrder(orderId, patch = {}) {
    const current = mustLoad(orderId);
    const next = Object.assign({}, current);
    for (const key of Object.keys(patch || {})) {
      if (key === 'orderId' || key === 'createdAt') continue; // 身份字段不接受改写（调用方整单回传时也不该改）
      if (!Object.prototype.hasOwnProperty.call(current, key) && !isKnownField(key)) {
        if (!warnedFields.has(key)) {
          warnedFields.add(key);
          process.stderr.write('[orders] updateOrder 忽略未知字段：' + key + '\n');
        }
        continue;
      }
      next[key] = patch[key];
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'status') && !ORDER_STATUSES.includes(next.status)) {
      // 状态机是 relay 的骨架，写错状态值属于编码错误，早点炸出来比静默存盘好
      throw new TypeError('非法订单状态：' + String(next.status) + '（可选 ' + ORDER_STATUSES.join(' / ') + '）');
    }
    next.orderId = current.orderId;
    next.createdAt = current.createdAt;
    next.updatedAt = nowIso();
    const normalized = normalizeOrder(next);
    const p = paths(orderId);
    writeJsonAtomic(p.orderJson, normalized);
    syncIndexEntryAt(root, normalized);
    return normalized;
  }

  function appendEvent(orderId, event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('appendEvent 需要事件对象');
    }
    const p = paths(orderId);
    mustLoad(orderId);
    // 显式传入的 at 优先，补记/重放时要保留原始时间
    const payload = Object.assign({ at: nowIso() }, event);
    appendLine(p.events, fitJsonLine(payload));
    return payload;
  }

  function appendWorkerEvents(orderId, events) {
    const p = paths(orderId);
    mustLoad(orderId);
    const list = Array.isArray(events) ? events : events == null ? [] : [events];
    for (const event of list) {
      appendLine(p.workerJsonl, fitJsonLine(event === undefined ? null : event));
    }
    return list.length;
  }

  function appendWorkerEvent(orderId, event) {
    return appendWorkerEvents(orderId, [event]);
  }

  function appendThread(orderId, markdown) {
    const p = paths(orderId);
    mustLoad(orderId);
    const text = String(markdown ?? '').trim();
    if (!text) return { segments: 0, bytes: 0 };
    // 一段 markdown 控制在 4KB 内；超长的汇报切段追加，不丢内容也不违反单条上限
    const chunks = splitUtf8(text, MAX_ENTRY_BYTES);
    ensureBlockSeparator(p.threadMd);
    for (const chunk of chunks) fs.appendFileSync(p.threadMd, chunk, 'utf8');
    fs.appendFileSync(p.threadMd, '\n', 'utf8');
    return { segments: chunks.length, bytes: Buffer.byteLength(text) };
  }

  function readOrderMd(orderId) {
    const p = paths(orderId);
    return readIfExists(p.orderMd) || '';
  }

  function writeOrderMd(orderId, text) {
    mustLoad(orderId);
    const body = String(text ?? '');
    writeFileAtomic(paths(orderId).orderMd, body.endsWith('\n') ? body : body + '\n');
    return body;
  }

  function appendRequirement(orderId, entries) {
    const order = mustLoad(orderId);
    const items = normalizeEntries(entries);
    if (!items.length) return readOrderMd(orderId);
    const p = paths(orderId);
    let text = readIfExists(p.orderMd) || '';
    if (!text.trim()) {
      // order.md 被删了也要能恢复：按骨架重铺，再往【需求】里写
      text = orderMdTemplate(order);
    }
    const lines = text.split('\n');
    const range = findRequirementRange(lines);
    if (!range) {
      throw new Error('order.md 缺少【需求】小节：' + p.orderMd);
    }
    const content = lines.slice(range.start + 1, range.end);
    while (content.length && content[content.length - 1].trim() === '') content.pop();
    // 首次追加时把模板占位注释清掉，否则每条需求后面都挂着「待补充」
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i].trim() === TEMPLATE_PLACEHOLDER) content.splice(i, 1);
    }
    const bullets = items.map(toBullet);
    const out = lines.slice(0, range.start + 1).concat(content);
    if (content.length) out.push('');
    out.push(...bullets);
    const suffix = lines.slice(range.end);
    out.push('');
    if (suffix.length) out.push(...suffix);
    const next = out.join('\n');
    writeFileAtomic(p.orderMd, next.endsWith('\n') ? next : next + '\n');
    return next;
  }

  const inProcessLocks = new Map();

  async function withOrderLock(orderId, fn, lockOpts = {}) {
    if (typeof fn !== 'function') throw new TypeError('withOrderLock 需要函数');
    const p = paths(orderId);
    const key = p.dir;
    const timeoutMs = Number(lockOpts.lockTimeoutMs) > 0 ? Number(lockOpts.lockTimeoutMs) : LOCK_WAIT_MS;
    const previous = inProcessLocks.get(key) || Promise.resolve();
    const tail = previous.then(async () => {
      fs.mkdirSync(p.dir, { recursive: true });
      const token = await acquireFileLock(p.lock, timeoutMs);
      try {
        return await fn();
      } finally {
        releaseFileLock(p.lock, token);
      }
    });
    // 队列尾巴必须永不 reject，否则下一个等待者会直接继承到上一个的失败
    const chained = tail.then(
      () => undefined,
      () => undefined
    );
    inProcessLocks.set(key, chained);
    chained.then(() => {
      if (inProcessLocks.get(key) === chained) inProcessLocks.delete(key);
    });
    return tail;
  }

  return {
    root,
    ensureOrder,
    findOpenOrderByChat,
    loadOrder,
    updateOrder,
    appendEvent,
    appendWorkerEvent,
    appendWorkerEvents,
    appendThread,
    readOrderMd,
    writeOrderMd,
    appendRequirement,
    paths,
    withOrderLock,
  };
}

function isKnownField(key) {
  return [
    'orderId',
    'chatId',
    'nickname',
    'status',
    'title',
    'deskSessionId',
    'workerSessionId',
    'pendingQuestions',
    'pendingReport',
    'createdAt',
    'updatedAt',
  ].includes(key);
}

/**
 * 从磁盘重建 index.json。CLI 修复入口，也是 loadIndex 发现缓存落后时的自动修复路径。
 * 只认 order.json，index.json 里多出来的条目会被丢掉。
 */
function rebuildIndex(rootOrOpts) {
  const root = typeof rootOrOpts === 'string' ? resolveRoot(rootOrOpts) : resolveRoot(rootOrOpts && rootOrOpts.root);
  return buildIndexAt(root);
}

module.exports = { createOrders, rebuildIndex };
