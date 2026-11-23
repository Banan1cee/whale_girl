'use strict';

/**
 * data 目录排他锁的进程内/跨进程/Widows lifecycle 用例。
 * 只操作临时目录和合成 pid；不碰真实 data。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dataLock = require('../src/memory/dataLock');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-data-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function owner(pid, overrides = {}) {
  return {
    version: 1,
    token: 'fixture-token-' + pid,
    pid,
    startedAt: Date.now() - 1000,
    host: os.hostname(),
    purpose: 'migration',
    ...overrides,
  };
}

function writeLock(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.data.lock'), typeof value === 'string' ? value : JSON.stringify(value));
}

function waitDead(pid, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      try { process.kill(pid, 0); }
      catch (err) {
        if (err.code === 'ESRCH') { clearInterval(timer); resolve(); return; }
      }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('pid did not exit')); }
    }, 20);
  });
}

test('acquire/inspect/release：同一目录第二个持有者明确 busy', (t) => {
  const dir = tempDir(t);
  const first = dataLock.acquire({ dataDir: dir, purpose: 'server' });
  assert.equal(dataLock.inspect(dir).state, 'busy');
  assert.throws(() => dataLock.acquire({ dataDir: dir, purpose: 'migration' }), (err) => {
    assert.equal(err.code, 'data_lock_busy');
    return true;
  });
  first.releaseSync();
  assert.equal(dataLock.inspect(dir).state, 'idle');
  const second = dataLock.acquire({ dataDir: dir, purpose: 'migration' });
  second.releaseSync();
  assert.equal(dataLock.inspect(dir).state, 'idle');
});

test('pid 确认已死才自动恢复陈旧锁', async (t) => {
  const dir = tempDir(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* 已退出 */ } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeLock(dir, owner(child.pid));
  child.kill();
  await waitDead(child.pid);
  const lock = dataLock.acquire({ dataDir: dir, purpose: 'server' });
  assert.equal(dataLock.inspect(dir).state, 'busy');
  lock.releaseSync();
});

test('pid 存活但不保证属于原持有者时 fail-closed（不按时间删锁）', (t) => {
  const dir = tempDir(t);
  // 用当前测试进程的 pid 扮演“存活的陌生持有者”；不依赖 heartbeat 时间。
  writeLock(dir, owner(process.pid, { purpose: 'migration' }));
  assert.throws(() => dataLock.acquire({ dataDir: dir, purpose: 'server' }), (err) => {
    assert.equal(err.code, 'data_lock_busy');
    return true;
  });
  // 锁没有被删掉；恢复只能由 pid 死亡后的持有者走守卫流程。
  assert.equal(dataLock.inspect(dir).state, 'busy');
});

test('元数据损坏时 fail-closed，不把不可判定锁当已完成', (t) => {
  const dir = tempDir(t);
  writeLock(dir, '{not-json');
  assert.throws(() => dataLock.acquire({ dataDir: dir, purpose: 'server' }), (err) => {
    assert.equal(err.code, 'data_lock_unknown');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(dir, '.data.lock'), 'utf8'), '{not-json');
});

test('已有恢复守卫时第二个恢复者不 rename 主锁', (t) => {
  const dir = tempDir(t);
  const dead = owner(2147483647);
  writeLock(dir, dead);
  // 模拟另一个恢复者已拿守卫；第二个进程必须 fail-closed，而不是把主锁改名。
  writeLock(dir, dead);
  fs.writeFileSync(path.join(dir, '.data.lock.recover'), JSON.stringify(owner(process.pid, { purpose: 'recovery' })));
  assert.throws(() => dataLock.acquire({ dataDir: dir, purpose: 'server' }), (err) => {
    assert.equal(err.code, 'data_lock_recovering');
    return true;
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.data.lock'), 'utf8')).token, dead.token);
});

test('死守卫 fail-closed：不删除主锁/守卫，手动删除后才恢复', (t) => {
  const dir = tempDir(t);
  const dead = owner(2147483647);
  writeLock(dir, dead);
  fs.writeFileSync(path.join(dir, '.data.lock.recover'), JSON.stringify(owner(2147483647, { purpose: 'recovery' })));
  const beforeLock = fs.readFileSync(path.join(dir, '.data.lock'), 'utf8');
  const beforeGuard = fs.readFileSync(path.join(dir, '.data.lock.recover'), 'utf8');
  assert.throws(() => dataLock.acquire({ dataDir: dir, purpose: 'server' }), (err) => {
    assert.equal(err.code, 'data_lock_guard_stale');
    assert.match(err.message, /\.data\.lock\.recover/);
    assert.match(err.message, /\.data\.lock/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(dir, '.data.lock'), 'utf8'), beforeLock);
  assert.equal(fs.readFileSync(path.join(dir, '.data.lock.recover'), 'utf8'), beforeGuard);
  fs.unlinkSync(path.join(dir, '.data.lock.recover'));
  const recovered = dataLock.acquire({ dataDir: dir, purpose: 'server' });
  recovered.releaseSync();
});

test('活守卫是 recovering；坏守卫是 guard_unknown；健康主锁优先', (t) => {
  const dir = tempDir(t);
  writeLock(dir, owner(2147483647));
  fs.writeFileSync(path.join(dir, '.data.lock.recover'), JSON.stringify(owner(process.pid, { purpose: 'recovery' })));
  assert.throws(() => dataLock.acquire({ dataDir: dir, purpose: 'server' }), (err) => {
    assert.equal(err.code, 'data_lock_recovering');
    return true;
  });
  fs.writeFileSync(path.join(dir, '.data.lock.recover'), '{broken-guard');
  assert.throws(() => dataLock.acquire({ dataDir: dir, purpose: 'server' }), (err) => {
    assert.equal(err.code, 'data_lock_guard_unknown');
    return true;
  });
  // 健康主锁仍是权威：主锁 pid 活着时，坏守卫不改变 busy。
  fs.writeFileSync(path.join(dir, '.data.lock'), JSON.stringify(owner(process.pid, { purpose: 'server' })));
  assert.throws(() => dataLock.acquire({ dataDir: dir, purpose: 'migration' }), (err) => {
    assert.equal(err.code, 'data_lock_busy');
    return true;
  });
});

test('零字节锁是 unknown，绝不自动覆盖', (t) => {
  const dir = tempDir(t);
  writeLock(dir, '');
  assert.throws(() => dataLock.acquire({ dataDir: dir, purpose: 'server' }), (err) => {
    assert.equal(err.code, 'data_lock_unknown');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(dir, '.data.lock'), 'utf8'), '');
});

test('非 hardlink 退化路径仍能正常加锁/释放', (t) => {
  const dir = tempDir(t);
  const unsupported = Object.assign(new Error('hardlink unsupported'), { code: 'EPERM' });
  t.mock.method(fs, 'linkSync', () => { throw unsupported; });
  try {
    const lock = dataLock.acquire({ dataDir: dir, purpose: 'server' });
    assert.equal(dataLock.inspect(dir).state, 'busy');
    lock.releaseSync();
  } finally {
    fs.linkSync.mock.restore();
  }
  assert.equal(dataLock.inspect(dir).state, 'idle');
});

test('持有者进程被杀后，下一次 acquire 安全恢复（Windows lifecycle）', async (t) => {
  const dir = tempDir(t);
  const pidFile = path.join(dir, 'holder.pid');
  const lockModule = JSON.stringify(require.resolve('../src/memory/dataLock'));
  const script = `const fs=require('fs');const lock=require(${lockModule});` +
    `const h=lock.acquire({dataDir:process.argv[1],purpose:'server'});` +
    `fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script, dir, pidFile], { stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch { /* 已退出 */ } });
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(pidFile), 'holder 应已持有锁');
  assert.equal(dataLock.inspect(dir).state, 'busy');
  child.kill();
  await waitDead(child.pid);
  const recovered = dataLock.acquire({ dataDir: dir, purpose: 'server' });
  recovered.releaseSync();
  assert.equal(dataLock.inspect(dir).state, 'idle');
});
