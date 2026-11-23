'use strict';

/**
 * 记忆升级用的本地归档（ZIP，只用 Node 内置 zlib/crypto，不引入依赖）。
 *
 * 设计约束：
 *   - 归档只写 data/ 内；条目名必须是相对路径，拒绝绝对路径、`..`、盘符和反斜杠。
 *   - 创建后立即回读校验：条目数/大小/SHA-256/CRC 全部一致才算成功；损坏或截断
 *     一律失败，调用方负责保留旧输入和 formatVersion。
 *   - 真正的完成时间写在外置 receipt（归档全部校验通过之后），retention 只认
 *     “文件名 + 内部 manifest + receipt 哈希”三者一致的归档，绝不按文件 mtime
 *     猜归属。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ARCHIVE_FORMAT = 'whale-memory-backup/1';
const RECEIPT_FORMAT = 'whale-memory-backup-receipt/1';
const OWNER = 'whale-girl/memory-upgrade';
const ARCHIVE_RE = /^memory-pre-v3-\d{8}-\d{6}Z\.zip$/;
const MANIFEST_NAME = '_backup-manifest.json';
const MAX_ENTRIES = 20000;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function dosTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeEntryName(name) {
  const value = String(name || '');
  if (!value || value.length > 512) return false;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  return true;
}

function stampUtc(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch { /* ignore */ }
    throw err;
  }
}

function lstatSafe(file) {
  try { return fs.lstatSync(file); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new ArchiveError('data_unreadable', '无法读取 ' + file + '：' + (err.code || err.message));
  }
}

function listFiles(dataDir, memoryDir, sources) {
  const files = [];
  let total = 0;
  const add = (abs, rel) => {
    if (!safeEntryName(rel)) throw new ArchiveError('backup_failed', '归档条目名不安全：' + rel);
    const st = lstatSafe(abs);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new ArchiveError('data_unreadable', '归档输入不是普通文件（可能是链接/重解析点）：' + rel);
    }
    if (!st.isFile()) throw new ArchiveError('data_unreadable', '归档输入不是普通文件：' + rel);
    if (st.size > MAX_ENTRY_BYTES) throw new ArchiveError('backup_failed', '单个文件过大：' + rel);
    total += st.size;
    if (total > MAX_TOTAL_BYTES) throw new ArchiveError('backup_failed', '归档总量超过上限');
    if (files.length >= MAX_ENTRIES) throw new ArchiveError('backup_failed', '归档条目过多');
    files.push({ name: rel.replace(/\\/g, '/'), data: fs.readFileSync(abs) });
  };
  const walk = (dir, relBase) => {
    const st = lstatSafe(dir);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new ArchiveError('data_unreadable', '记忆目录不是普通目录（可能是链接/重解析点）：' + dir);
    }
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = relBase ? relBase + '/' + name : name;
      const child = lstatSafe(abs);
      if (!child) continue;
      if (child.isSymbolicLink()) throw new ArchiveError('data_unreadable', '归档输入包含链接：' + rel);
      if (child.isDirectory()) walk(abs, rel);
      else add(abs, rel);
    }
  };
  const memStat = lstatSafe(memoryDir);
  if (memStat) {
    if (memStat.isSymbolicLink() || !memStat.isDirectory()) {
      throw new ArchiveError('data_unreadable', '记忆目录不可读或不是普通目录');
    }
    walk(memoryDir, 'memory');
  }
  for (const name of sources) {
    const abs = path.join(dataDir, name);
    const st = lstatSafe(abs);
    if (!st) continue;
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new ArchiveError('data_unreadable', '旧版输入不是普通文件：' + name);
    }
    add(abs, name);
  }
  return files;
}

function buildZip(entries, when) {
  const { time, date } = dosTime(when);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0x0800, 8);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt16LE(time, 12);
    centralEntry.writeUInt16LE(date, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(data.length, 24);
    centralEntry.writeUInt16LE(name.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(0, 38);
    centralEntry.writeUInt32LE(offset, 42);
    parts.push(local, name, compressed);
    central.push(centralEntry, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralOffset = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new ArchiveError('archive_invalid', '归档不是有效的 ZIP');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ArchiveError('archive_invalid', '归档缺少 EOCD（可能被截断）');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new ArchiveError('archive_invalid', '归档条目过多');
  if (centralOffset + centralSize > buffer.length || centralOffset + centralSize > eocd) {
    throw new ArchiveError('archive_invalid', '归档中央目录越界（可能被截断）');
  }
  const entries = [];
  let p = centralOffset;
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) {
      throw new ArchiveError('archive_invalid', '归档中央目录损坏');
    }
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > buffer.length) throw new ArchiveError('archive_invalid', '归档条目名越界');
    const name = buffer.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (!safeEntryName(name) || seen.has(name)) throw new ArchiveError('archive_invalid', '归档条目名不安全或重复：' + name);
    seen.add(name);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ArchiveError('archive_invalid', '归档本地头损坏');
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buffer.length) throw new ArchiveError('archive_invalid', '归档数据被截断：' + name);
    const localName = buffer.slice(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8');
    if (localName !== name) throw new ArchiveError('archive_invalid', '归档本地头名称不一致');
    if (method !== 8) throw new ArchiveError('archive_invalid', '归档压缩方法不支持');
    let data;
    try { data = zlib.inflateRawSync(buffer.slice(dataStart, dataStart + compSize)); }
    catch { throw new ArchiveError('archive_invalid', '归档解压失败：' + name); }
    if (data.length !== size || crc32(data) !== crc) throw new ArchiveError('archive_invalid', '归档校验失败：' + name);
    entries.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== centralOffset + centralSize) throw new ArchiveError('archive_invalid', '归档中央目录长度不一致');
  return entries;
}

function parseManifest(entries) {
  const entry = entries.find((item) => item.name === MANIFEST_NAME);
  if (!entry) throw new ArchiveError('archive_invalid', '归档缺少内部 manifest');
  let manifest;
  try { manifest = JSON.parse(entry.data.toString('utf8')); }
  catch { throw new ArchiveError('archive_invalid', '归档 manifest 不是 JSON'); }
  if (!manifest || manifest.format !== ARCHIVE_FORMAT || !Array.isArray(manifest.files)) {
    throw new ArchiveError('archive_invalid', '归档 manifest 格式不识别');
  }
  if (!Number.isFinite(manifest.chats) || !Number.isFinite(manifest.messages)) {
    throw new ArchiveError('archive_invalid', '归档 manifest 统计缺失');
  }
  const files = entries.filter((item) => item.name !== MANIFEST_NAME).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length !== manifest.files.length) throw new ArchiveError('archive_invalid', '归档条目数与 manifest 不一致');
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const record = manifest.files[i];
    if (!record || record.name !== file.name || record.size !== file.data.length || record.sha256 !== sha256(file.data)) {
      throw new ArchiveError('archive_invalid', '归档条目与 manifest 不一致：' + file.name);
    }
  }
  return manifest;
}

function verifyArchive(file, { readAll = true } = {}) {
  const st = lstatSafe(file);
  if (!st) throw new ArchiveError('archive_missing', '归档不存在：' + file);
  if (st.isSymbolicLink() || !st.isFile()) throw new ArchiveError('archive_invalid', '归档不是普通文件');
  if (st.size > MAX_TOTAL_BYTES + 64 * 1024 * 1024) throw new ArchiveError('archive_invalid', '归档过大');
  const buffer = fs.readFileSync(file);
  const entries = readZip(buffer);
  const manifest = parseManifest(entries);
  const digest = sha256(buffer);
  return { manifest, digest, entries: readAll ? entries.map((item) => ({ name: item.name, size: item.data.length })) : null };
}

function receiptFile(archivePath) {
  return archivePath + '.receipt.json';
}

function createArchive({ dataDir, memoryDir, sources, outPath, now = Date.now() }) {
  const dataRoot = path.resolve(dataDir);
  const backupsRoot = path.join(dataRoot, 'backups');
  const target = path.resolve(outPath);
  // 归档只允许落在 data/backups 下；合成/故障场景也不能把备份写到数据目录之外。
  if (target !== backupsRoot && !target.startsWith(backupsRoot + path.sep)) {
    throw new ArchiveError('backup_failed', '归档路径越界，拒绝写入');
  }
  const files = listFiles(dataDir, memoryDir, sources);
  const archiveId = crypto.randomUUID();
  const startedAt = new Date(now).toISOString();
  const manifest = {
    format: ARCHIVE_FORMAT,
    owner: OWNER,
    archiveId,
    startedAt,
    createdAt: startedAt,
    chats: countChats(memoryDir),
    messages: countMessages(memoryDir),
    legacySources: sources.slice().sort(),
    files: files.map((file) => ({ name: file.name, size: file.data.length, sha256: sha256(file.data) })),
  };
  const zipBuffer = buildZip([...files, { name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest), 'utf8') }], new Date(now));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const temp = outPath + '.' + process.pid + '.tmp';
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, zipBuffer);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, outPath);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch { /* ignore */ }
    throw new ArchiveError('backup_failed', '写入归档失败：' + (err && err.message || err));
  }
  let verified;
  try {
    verified = verifyArchive(outPath);
  } catch (err) {
    try { fs.unlinkSync(outPath); } catch { /* ignore */ }
    throw err instanceof ArchiveError ? err : new ArchiveError('backup_verify_failed', '归档回读校验失败：' + (err && err.message || err));
  }
  const receipt = {
    format: RECEIPT_FORMAT,
    owner: OWNER,
    archiveId,
    archive: path.basename(outPath),
    archiveSha256: verified.digest,
    startedAt,
    completedAt: new Date().toISOString(), // 归档已回读校验通过，这才是“实际完成 UTC”
    files: verified.manifest.files.length,
    bytes: zipBuffer.length,
    chats: verified.manifest.chats,
    messages: verified.manifest.messages,
  };
  writeJsonAtomic(receiptFile(outPath), receipt);
  return { path: outPath, receiptPath: receiptFile(outPath), receipt, manifest: verified.manifest, sha256: verified.digest };
}

function readReceipt(archivePath) {
  try { return JSON.parse(fs.readFileSync(receiptFile(archivePath), 'utf8')); }
  catch { return null; }
}

function archiveName(now) {
  return `memory-pre-v3-${stampUtc(now)}.zip`;
}

/** 只认：文件名 → 内部 manifest → 外置 receipt → 归档哈希，四者一致；否则不归我们管。 */
function inspectOwnedArchive(file) {
  const name = path.basename(file);
  if (!ARCHIVE_RE.test(name)) return { owned: false, reason: 'unrecognized_name' };
  const st = lstatSafe(file);
  if (!st) return { owned: false, reason: 'missing' };
  if (st.isSymbolicLink() || !st.isFile()) return { owned: false, reason: 'not_regular_file' };
  const receipt = readReceipt(file);
  if (!receipt || receipt.format !== RECEIPT_FORMAT || receipt.archive !== name) return { owned: false, reason: 'receipt_missing' };
  if (typeof receipt.completedAt !== 'string' || !Number.isFinite(Date.parse(receipt.completedAt))) {
    return { owned: false, reason: 'receipt_time_invalid' };
  }
  let verified;
  try { verified = verifyArchive(file); }
  catch { return { owned: false, reason: 'archive_invalid' }; }
  if (!verified.manifest || verified.manifest.archiveId !== receipt.archiveId) return { owned: false, reason: 'archive_id_mismatch' };
  if (receipt.archiveSha256 !== verified.digest) return { owned: false, reason: 'digest_mismatch' };
  if (receipt.files !== verified.manifest.files.length) return { owned: false, reason: 'count_mismatch' };
  return { owned: true, receipt, verified };
}

function runRetention({ dataDir, now = Date.now(), maxAgeDays = 30, protect = new Set() }) {
  const backups = path.join(dataDir, 'backups');
  const result = { removed: [], kept: 0, skipped: [] };
  let dirStat;
  try { dirStat = fs.lstatSync(backups); }
  catch (err) {
    if (err.code === 'ENOENT') return result;
    throw new ArchiveError('data_unreadable', '无法读取备份目录：' + (err.code || err.message));
  }
  // 备份父目录必须是真实目录；链接/重解析点/普通文件一律不做破坏性操作。
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new ArchiveError('data_unreadable', '备份目录不是普通目录，已跳过过期清理');
  }
  let names;
  try { names = fs.readdirSync(backups); }
  catch (err) { throw new ArchiveError('data_unreadable', '无法读取备份目录：' + (err.code || err.message)); }
  for (const name of names.sort()) {
    if (protect.has(name)) { result.kept += 1; continue; }
    if (!ARCHIVE_RE.test(name)) { result.skipped.push(name); continue; }
    const file = path.join(backups, name);
    const st = lstatSafe(file);
    if (!st) { result.skipped.push(name); continue; }
    if (st.isSymbolicLink() || !st.isFile()) { result.skipped.push(name); continue; } // 目录/重解析点一律不碰
    const owned = inspectOwnedArchive(file);
    if (!owned.owned) { result.skipped.push(name); continue; }
    const completed = Date.parse(owned.receipt.completedAt);
    if (now - completed <= maxAgeDays * 24 * 60 * 60 * 1000) { result.kept += 1; continue; }
    try {
      fs.unlinkSync(file);
      try { fs.unlinkSync(receiptFile(file)); } catch { /* receipt 留着也不影响主归档已删 */ }
      result.removed.push(name);
    } catch { result.skipped.push(name); }
  }
  return result;
}

function extractArchive({ file, targetDir, force = false }) {
  const verified = verifyArchive(file);
  const root = path.resolve(targetDir);
  const extracted = [];
  for (const entry of verified.entries) {
    const target = path.resolve(root, entry.name);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new ArchiveError('archive_invalid', '归档条目越界：' + entry.name);
    }
    const st = lstatSafe(target);
    if (st && !force) throw new ArchiveError('restore_target_exists', '恢复目标已存在：' + entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data, { flag: force ? 'w' : 'wx' });
    extracted.push(entry.name);
  }
  return { manifest: verified.manifest, extracted };
}

function countMessages(memoryDir) {
  const chats = path.join(memoryDir, 'chats');
  let total = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(chats, { withFileTypes: true }); } catch { return 0; }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = fs.readFileSync(path.join(chats, entry.name, 'messages.jsonl'), 'utf8');
      total += raw.split(/\r?\n/).filter((line) => line.trim()).length;
    } catch { /* 没文件算 0 */ }
  }
  return total;
}

function countChats(memoryDir) {
  try {
    return fs.readdirSync(path.join(memoryDir, 'chats'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch { return 0; }
}

module.exports = {
  ARCHIVE_FORMAT,
  RECEIPT_FORMAT,
  ARCHIVE_RE,
  MANIFEST_NAME,
  ArchiveError,
  createArchive,
  verifyArchive,
  extractArchive,
  inspectOwnedArchive,
  runRetention,
  readReceipt,
  receiptFile,
  archiveName,
  countChats,
  countMessages,
  safeEntryName,
};
