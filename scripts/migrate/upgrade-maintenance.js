#!/usr/bin/env node
'use strict';

/**
 * 常驻维护入口（安装目录会保留，不随一次性 runner 删除）：
 *   status    只读判断记忆目录是否可自动升级（不读聊天正文、只输出计数）
 *   retention 只清理本工具创建且内部 manifest/receipt 校验通过的旧归档
 *
 * 不提供通用恢复 CLI：归档是标准 ZIP，用系统解压工具即可恢复；Node 侧只保证
 * 归档可被标准 ZIP 消费端读取（测试用系统解压验证）。
 */

const fs = require('node:fs');
const path = require('node:path');
const archive = require('./archive');
const dataLock = require('../../src/memory/dataLock');
const { FORMAT_VERSION } = require('../../src/memory/formatVersion');

const RECEIPT_NAME = 'memory-upgrade-receipt.json';
const RECEIPT_FORMAT = 'whale-memory-upgrade/1';
const LEGACY_SOURCES = ['store.json', 'store.json.journal', 'memory.json'];
const STAGES = new Set(['archived', 'converted', 'cleanup_pending', 'done']);

function parseArgs(argv) {
  const out = { json: false, dataDir: null, command: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--data') {
      const dir = argv[++i];
      if (!dir || dir.startsWith('--')) throw new Error('--data 需要指定数据目录');
      out.dataDir = path.resolve(dir);
    } else if (arg === '--help' || arg === '-h') out.help = true;
    else if (!out.command && !arg.startsWith('--')) out.command = arg;
    else throw new Error('不认识的参数：' + arg);
  }
  return out;
}

function receiptPath(dataDir) {
  return path.join(dataDir, RECEIPT_NAME);
}

function readReceipt(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(receiptPath(dataDir), 'utf8'));
    if (!value || value.format !== RECEIPT_FORMAT || !STAGES.has(value.stage)) return null;
    return value;
  } catch { return null; }
}

function writeReceipt(dataDir, value) {
  const file = receiptPath(dataDir);
  const temp = file + '.' + process.pid + '.tmp';
  const payload = { format: RECEIPT_FORMAT, ...value, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  return payload;
}

function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new archive.ArchiveError('data_unreadable', '无法读取 ' + file + '：' + (err.code || err.message));
  }
}

function listLegacySources(dataDir) {
  const names = [];
  for (const name of LEGACY_SOURCES) {
    const st = lstat(path.join(dataDir, name));
    if (!st) continue;
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new archive.ArchiveError('data_unreadable', '旧版输入不是普通文件：' + name);
    }
    names.push(name);
  }
  return names;
}

function readVersionStrict(memoryDir) {
  const manifestFile = path.join(memoryDir, 'manifest.json');
  const st = lstat(manifestFile);
  if (!st) return { version: 0, hasManifest: false };
  if (st.isSymbolicLink() || !st.isFile()) throw new archive.ArchiveError('data_unreadable', 'manifest 不是普通文件');
  let raw;
  try { raw = fs.readFileSync(manifestFile, 'utf8'); }
  catch (err) { throw new archive.ArchiveError('data_unreadable', '无法读取 manifest：' + (err.code || err.message)); }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch { return { state: 'invalid', version: 0, hasManifest: true, manifest: null }; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { state: 'invalid', version: 0, hasManifest: true };
  if (!Object.hasOwn(manifest, 'formatVersion')) return { version: 0, hasManifest: true, manifest };
  const version = manifest.formatVersion;
  if (!Number.isInteger(version) || version < 0) return { state: 'invalid', version: 0, hasManifest: true, manifest };
  if (version > FORMAT_VERSION) return { state: 'future', version, hasManifest: true, manifest };
  return { version, hasManifest: true, manifest };
}

function inspectDir(memoryDir) {
  const st = lstat(memoryDir);
  if (!st) return { exists: false, hasData: false };
  if (st.isSymbolicLink() || !st.isDirectory()) throw new archive.ArchiveError('data_unreadable', '记忆目录不是普通目录');
  let entries;
  try { entries = fs.readdirSync(memoryDir); }
  catch (err) { throw new archive.ArchiveError('data_unreadable', '无法读取记忆目录：' + (err.code || err.message)); }
  return { exists: true, hasData: entries.some((name) => name !== 'legacy') };
}

/** 只读状态；不读取/不输出聊天正文。 */
function readStatus(dataDir) {
  const root = path.resolve(dataDir);
  const memoryDir = path.join(root, 'memory');
  const dir = inspectDir(memoryDir);
  const parsed = readVersionStrict(memoryDir);
  const sources = listLegacySources(root);
  const receipt = readReceipt(root);
  const result = {
    ok: true,
    status: 'idle',
    version: 0,
    targetVersion: FORMAT_VERSION,
    canAuto: false,
    runnerRequired: false,
    legacySources: sources.length,
    chats: 0,
    messages: 0,
    receipt: receipt ? {
      stage: receipt.stage,
      archiveId: receipt.archiveId || null,
      completedAt: receipt.completedAt || null,
      formatVersion: receipt.formatVersion ?? null,
      targetVersion: receipt.targetVersion ?? null,
    } : null,
    runnerCleanupEligible: Boolean(receipt && receipt.stage === 'done'),
  };
  if (parsed.state === 'invalid') { result.status = 'invalid'; return result; }
  if (parsed.state === 'future') { result.status = 'future'; result.version = parsed.version; return result; }
  result.version = parsed.version;
  // 收据还没到 done：说明转换已提交但清理/收据未完成，即使 v3、旧源已删、只剩 legacy，
  // 也必须让启动器再次进入自动流把清理续完。
  const receiptPending = Boolean(receipt && receipt.stage !== 'done');
  const pending = Boolean(
    (parsed.version !== FORMAT_VERSION && (dir.exists ? dir.hasData : false)) ||
    sources.length > 0 ||
    (parsed.version === 0 && parsed.hasManifest && dir.exists && dir.hasData) ||
    receiptPending,
  );
  if (!dir.exists && !sources.length && !receiptPending) { result.status = 'idle'; return result; }
  if (!dir.exists && (sources.length || receiptPending)) {
    result.status = 'pending'; result.canAuto = true; result.runnerRequired = true; return result;
  }
  if (parsed.version === FORMAT_VERSION && !sources.length && !receiptPending) { result.status = 'idle'; return result; }
  if (!pending && !dir.hasData) { result.status = 'idle'; return result; }
  result.status = pending ? 'pending' : 'idle';
  result.canAuto = result.status === 'pending';
  result.runnerRequired = result.status === 'pending';
  result.chats = dir.exists ? archive.countChats(memoryDir) : 0;
  result.messages = dir.exists ? archive.countMessages(memoryDir) : 0;
  return result;
}

function runRetention({ dataDir, now = Date.now(), maxAgeDays = 30, skipLock = false }) {
  const root = path.resolve(dataDir);
  let lock = null;
  if (!skipLock) {
    try { lock = dataLock.acquire({ dataDir: root, purpose: 'maintenance' }); }
    catch (err) {
      // 内核/迁移持锁时不和它们抢：本次跳过过期清理，下次启动再试。
      return { removed: [], kept: 0, skipped: [], skippedLocked: err.code || 'data_lock_busy' };
    }
  }
  try {
    // 必须在持有 data 所有权之后读 receipt：否则延迟进程可能先看到旧 done 收据，
    // 等另一个进程提交新的 pending 收据并释放锁后再删掉它唯一的备份。
    const receipt = readReceipt(root);
    const protect = receipt && receipt.stage !== 'done' && receipt.archive
      ? new Set([path.basename(receipt.archive)]) : new Set();
    return archive.runRetention({ dataDir: root, now, maxAgeDays, protect });
  } finally {
    if (lock) lock.releaseSync();
  }
}

function emit(args, value) {
  if (args.json) console.log(JSON.stringify(value));
  else console.log(value.ok ? `${value.status}${value.removed ? ' removed=' + value.removed.length : ''}` : (value.message || value.status));
}

function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); }
  catch (err) {
    console.error('[maintain] ' + (err.message || err));
    return 1;
  }
  if (args.help) {
    console.log('用法：node scripts/migrate/upgrade-maintenance.js [--json] status|retention --data <dir>');
    return 0;
  }
  if (!args.command || !args.dataDir) {
    console.error('需要 command（status|retention）和 --data <dir>');
    return 1;
  }
  try {
    if (args.command === 'status') {
      emit(args, readStatus(args.dataDir));
      return 0;
    }
    if (args.command === 'retention') {
      const result = runRetention({ dataDir: args.dataDir });
      emit(args, { ok: true, status: 'done', ...result });
      return 0;
    }
    console.error('不认识的命令：' + args.command);
    return 1;
  } catch (err) {
    const code = err && err.code === 'data_unreadable' ? 'data_unreadable' : 'maintenance_failed';
    const payload = { ok: false, status: code === 'data_unreadable' ? 'unreadable' : 'failed', error: code, message: err.message || String(err) };
    if (args.json) console.log(JSON.stringify(payload));
    else console.error('[maintain] ' + payload.message);
    // status 是只读报告：即使目录不可读也用 JSON 报告，退出码保持 0，让启动器按 status 处理。
    return args.command === 'status' ? 0 : 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  RECEIPT_NAME,
  RECEIPT_FORMAT,
  LEGACY_SOURCES,
  readStatus,
  readReceipt,
  writeReceipt,
  listLegacySources,
  runRetention,
  receiptPath,
  main,
};
