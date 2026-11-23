'use strict';

/**
 * 数据目录排他锁：内核启动与离线记忆迁移共用同一份所有权协议。
 *
 * 为什么不用「先读锁文件再开库」：
 *   读检查与打开数据目录之间有窗口，服务先起、迁移后开始（或反过来）都能钻过去。
 *   这里要求真正的持有者先原子拿到 data/.data.lock，再碰 memory/；
 *   服务一直持有到 store/plugins/HTTP 实际 teardown 完成，迁移一直持有到
 *   formatVersion 写完并释放。谁先拿到谁做事，另一方明确 busy。
 *
 * 崩溃恢复的边界：
 *   - 锁文件先用 owner 临时文件 + hardlink 原子创建，正常文件系统上不存在
 *     「空锁 / 半截 JSON」窗口；owner 里有 pid / startedAt / purpose / host。
 *   - 只有 pid 确认已死（ESRCH）才自动恢复；pid 存活、EPERM、host 不一致、
 *     元数据损坏一律 fail-closed，不靠时间猜，避免 PID 复用或同步迁移卡住时
 *     把别人正在用的锁删掉。
 *   - 恢复陈旧锁前先拿 .data.lock.recover 守卫，并在守卫内重读 token；
 *     这样两个恢复者不会把「刚被另一个进程创建的新锁」改走。
 *
 * 这不是安全沙箱，只是数据目录的单写者协议；锁文件本身不含聊天内容。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCK_NAME = '.data.lock';
const RECOVER_NAME = '.data.lock.recover';
const MAX_ATTEMPTS = 4;

class DataLockError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'DataLockError';
    this.code = code;
    this.detail = detail;
  }
}

function lockFile(dataDir) {
  return path.join(dataDir, LOCK_NAME);
}

function recoverFile(dataDir) {
  return path.join(dataDir, RECOVER_NAME);
}

function tempName(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

function newOwner(purpose) {
  return {
    version: 1,
    token: crypto.randomBytes(12).toString('hex'),
    pid: process.pid,
    // 只用于诊断/人工判断；恢复只看 pid 是否还活着，绝不用时间推断。
    startedAt: Date.now() - Math.round(process.uptime() * 1000),
    host: os.hostname(),
    purpose: String(purpose || 'unknown'),
  };
}

function parseOwner(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || value.version !== 1) return null;
  if (!Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.token !== 'string' || value.token.length < 8) return null;
  if (typeof value.host !== 'string' || !value.host) return null;
  if (!Number.isFinite(value.startedAt)) return null;
  if (typeof value.purpose !== 'string') return null;
  return value;
}

function readAt(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return { state: 'absent', path: file };
    return { state: 'unknown', path: file, reason: err.code || 'read_failed' };
  }
  const owner = parseOwner(raw);
  if (!owner) return { state: 'unknown', path: file, reason: 'invalid_metadata' };
  return { state: 'owner', path: file, owner };
}

function pidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    // ESRCH 才证明进程不存在；EPERM 等只能说明“可能活着但没权限看”，不能删锁。
    return err && err.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

/**
 * 把完整 owner 内容原子地放到锁路径。
 * link 失败 EEXIST 表示已有锁；其余错误先尝试 O_EXCL 退化路径。
 * 返回 true 表示成功；EEXIST 以普通 Error 抛出，由 acquire 处理。
 */
function createWithOwner(file, owner) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = tempName(file);
  try {
    fs.writeFileSync(temp, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      fs.linkSync(temp, file);
      return;
    } catch (err) {
      if (err.code === 'EEXIST') throw err;
      // 任意非 EEXIST 的 link 错误（FAT/网络盘不支持硬链接、权限策略等）才退化。
      // 退化路径先 O_EXCL 建最终锁再写内容/fsync；若在 open 后、write 前崩溃会留下
      // 零字节或半截锁，inspect 会判 unknown 并 fail-closed，只能人工确认后删除，
      // 绝不把它当空闲锁自动覆盖。
      let fd;
      try {
        fd = fs.openSync(file, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(owner), 'utf8');
        fs.fsyncSync(fd);
      } catch (fallbackErr) {
        if (fd !== undefined) { try { fs.unlinkSync(file); } catch { /* 只删自己刚建的 */ } }
        throw fallbackErr;
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      }
    }
  } finally {
    try { fs.unlinkSync(temp); } catch { /* temp 可能还没建出来 */ }
  }
}

function guardState(dataDir) {
  const file = recoverFile(dataDir);
  const read = readAt(file);
  if (read.state === 'absent') return { state: 'absent', path: file };
  if (read.state === 'unknown') return { state: 'unknown', path: file, reason: read.reason };
  const owner = read.owner;
  if (String(owner.host).toLowerCase() !== os.hostname().toLowerCase()) {
    return { state: 'unknown', path: file, owner, reason: 'host_mismatch' };
  }
  const pids = pidState(owner.pid);
  if (pids === 'alive') return { state: 'live', path: file, owner };
  if (pids === 'dead') return { state: 'stale', path: file, owner };
  return { state: 'unknown', path: file, owner, reason: 'pid_unreadable' };
}

function guardStaleMessage(dataDir, owner) {
  const started = Number.isFinite(owner && owner.startedAt)
    ? new Date(owner.startedAt).toISOString() : '未知';
  return `上次数据目录锁恢复进程异常退出（pid=${owner && owner.pid}，startedAt=${started}）。`
    + '程序不会自动删除锁文件，以免两个进程同时改记忆。'
    + '请先停止鲸鲸内核和所有 CLI 转换重试，确认没有相关进程后手动删除：'
    + recoverFile(dataDir) + '（恢复守卫）；'
    + '仅当主锁 ' + lockFile(dataDir) + ' 记录的 pid 也已退出时，再删除主锁。';
}

function stateError(dataDir, state) {
  const details = { ...state, lockPath: lockFile(dataDir), guardPath: recoverFile(dataDir) };
  if (state.state === 'busy') {
    return new DataLockError('data_lock_busy',
      `数据目录正被另一个${state.owner.purpose === 'server' ? '服务' : '任务'}占用（pid=${state.owner.pid}）`, details);
  }
  if (state.state === 'recovering') {
    return new DataLockError('data_lock_recovering',
      `另一个进程正在恢复数据目录锁（pid=${state.guard.owner.pid}）。请等它结束；不要删除锁文件。`, details);
  }
  if (state.state === 'guard_stale') {
    return new DataLockError('data_lock_guard_stale', guardStaleMessage(dataDir, state.guard.owner), details);
  }
  if (state.state === 'guard_unknown') {
    return new DataLockError('data_lock_guard_unknown',
      '无法确认数据目录恢复守卫的持有者（' + recoverFile(dataDir) + '）。'
      + '请先停止鲸鲸内核和所有 CLI 转换重试，确认没有相关进程后手动删除该守卫文件；程序不会自动删除。',
      details);
  }
  if (state.state === 'unknown') {
    return new DataLockError('data_lock_unknown',
      '无法确认数据目录锁的持有者（' + lockFile(dataDir) + '）。'
      + '请先停止鲸鲸内核和所有 CLI 转换重试，确认没有相关进程后手动删除该文件；程序不会自动删除。',
      details);
  }
  return null;
}

function inspect(dataDir) {
  const dir = path.resolve(dataDir);
  const read = readAt(lockFile(dir));
  const guard = guardState(dir);
  const base = { path: lockFile(dir), guard };
  if (read.state === 'absent') {
    if (guard.state === 'live') return { ...base, state: 'recovering' };
    if (guard.state === 'stale') return { ...base, state: 'guard_stale' };
    if (guard.state === 'unknown') return { ...base, state: 'guard_unknown' };
    return { ...base, state: 'idle' };
  }
  if (read.state === 'unknown') {
    return { ...base, state: 'unknown', reason: read.reason };
  }
  const owner = read.owner;
  if (String(owner.host).toLowerCase() !== os.hostname().toLowerCase()) {
    return { ...base, state: 'unknown', owner, reason: 'host_mismatch' };
  }
  const pids = pidState(owner.pid);
  // 健康主锁始终优先：主锁持有者活着时，守卫残留不改变“正被服务/任务占用”的事实。
  if (pids === 'alive') return { ...base, state: 'busy', owner };
  if (pids !== 'dead') return { ...base, state: 'unknown', owner, reason: 'pid_unreadable' };
  if (guard.state === 'live') return { ...base, state: 'recovering', owner };
  if (guard.state === 'stale') return { ...base, state: 'guard_stale', owner };
  if (guard.state === 'unknown') return { ...base, state: 'guard_unknown', owner };
  return { ...base, state: 'stale', owner };
}

function releaseGuard(dataDir, token) {
  const file = recoverFile(dataDir);
  const read = readAt(file);
  if (read.state === 'owner' && read.owner.token === token) {
    try { fs.unlinkSync(file); } catch { /* 已经没了也算释放 */ }
  }
}

/**
 * 只允许在 recovery 守卫内、且重读后 token 仍等于观察值时，把死锁改名为 tombstone。
 * 不做「按 mtime/heartbeat 过期清理」：同步迁移会长时间堵事件循环，时间不能证明死亡。
 */
function recoverStale(dataDir, observed) {
  const guard = newOwner('recovery');
  try {
    createWithOwner(recoverFile(dataDir), guard);
  } catch (err) {
    if (err.code === 'EEXIST') {
      // 守卫被别人抢先创建：用统一状态判断是“正常恢复中”还是“死守卫”。
      // 绝不在这里 unlink/rename 守卫；交给 stateError 给出 fail-closed 诊断。
      const state = inspect(dataDir);
      const conflict = stateError(dataDir, state);
      if (conflict) throw conflict;
      return 'changed';
    }
    throw new DataLockError('data_lock_unavailable',
      '无法创建数据目录锁恢复守卫：' + ((err && err.message) || err && err.code || err),
      { path: recoverFile(dataDir) });
  }
  try {
    const current = readAt(lockFile(dataDir));
    if (current.state !== 'owner'
      || current.owner.token !== observed.token
      || current.owner.pid !== observed.pid) return 'changed';
    // 守卫内再确认一次 pid，避免检查后 pid 被复用成新进程。
    if (pidState(current.owner.pid) !== 'dead') return 'changed';
    const tomb = `${lockFile(dataDir)}.stale-${observed.token}`;
    try { fs.renameSync(lockFile(dataDir), tomb); }
    catch (err) {
      if (err.code === 'ENOENT') return 'changed';
      throw err;
    }
    try { fs.unlinkSync(tomb); } catch { /* 删除失败留给下一轮；主锁已让位 */ }
    return 'recovered';
  } finally {
    releaseGuard(dataDir, guard.token);
  }
}

function makeHandle(dataDir, owner) {
  let released = false;
  const releaseSync = () => {
    if (released) return;
    released = true;
    const read = readAt(lockFile(dataDir));
    // 只删自己 token 的锁：万一锁被别的进程替换，绝不误删。
    if (read.state === 'owner' && read.owner.token === owner.token) {
      try { fs.unlinkSync(lockFile(dataDir)); } catch { /* 已不存在 */ }
    }
  };
  return {
    owner: { ...owner },
    path: lockFile(dataDir),
    releaseSync,
    release: releaseSync,
  };
}

/**
 * 拿 data 目录排他所有权。成功返回 handle；busy/unknown 抛 DataLockError。
 * purpose 只用于提示（server / migration / recovery）。
 */
function acquire({ dataDir, purpose = 'unknown' } = {}) {
  if (!dataDir) throw new DataLockError('data_lock_unavailable', '没有数据目录，无法加锁');
  const dir = path.resolve(dataDir);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // 先看状态再创建：主锁空闲但恢复守卫残留时必须在写锁之前 fail-closed，
    // 不能先抢到主锁再忽略守卫（那会让死守卫被新主锁“盖住”）。
    const state = inspect(dir);
    if (state.state === 'idle') {
      const owner = newOwner(purpose);
      try {
        createWithOwner(lockFile(dir), owner);
        return makeHandle(dir, owner);
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw new DataLockError('data_lock_unavailable',
            '无法写入数据目录锁：' + ((err && err.message) || err && err.code || err),
            { path: lockFile(dir) });
        }
        continue; // 刚刚被别人抢到，重新看状态
      }
    }
    const conflict = stateError(dir, state);
    if (conflict) throw conflict;
    if (state.state === 'stale') {
      recoverStale(dir, state.owner);
      continue;
    }
    // idle 竞态 / 主锁刚消失：重试。
  }
  throw new DataLockError('data_lock_busy', '数据目录锁竞争失败，请稍后重试', { path: lockFile(dir) });
}

module.exports = {
  LOCK_NAME,
  RECOVER_NAME,
  DataLockError,
  lockFile,
  recoverFile,
  inspect,
  acquire,
};
