#!/usr/bin/env node
'use strict';

/**
 * 记忆目录一次性迁移工具（离线执行，不被 src/ 里任何代码 require）。
 *
 * 为什么是脚本而不是「启动时顺手升一下」：
 *   运行时兼容旧格式意味着旧分支永远删不掉 —— 上一版 src/memory/migrate.js
 *   24KB、48 处 legacy 引用，就是那么长出来的。现在迁移只在这里发生：
 *   先备份、再转换、校验通过、最后才动原目录。
 *
 * 用法：
 *   node scripts/migrate-memory.js                 # 只看报告（dry-run）
 *   node scripts/migrate-memory.js --apply         # 真的迁
 *   node scripts/migrate-memory.js --from-store    # 顺便导入 4.0 的 store.json / memory.json
 *   node scripts/migrate-memory.js --data D:\data  # 指定数据目录（默认 <仓库>/data）
 *   node scripts/migrate-memory.js --auto-upgrade --json --data D:\data  # 安装态自动流（归档+转换+清理）
 *
 * 做了什么（v2 → v3）：
 *   1. 全量备份到 data/backups/memory-pre-v3-<时间>/（人工模式）；
 *      自动模式改为 data/backups/memory-pre-v3-<UTC>.zip，回读校验通过才算备份完成；
 *   2. 删掉 data/memory/legacy/（只读副本，运行时不再读它）；
 *   3. 把人物卡/事件/摘要投影成 records：
 *        timeline.jsonl ← 事件 / 摘要 / 关系（中期）
 *        subjects/<uid>.json ← 事实 / 性格 / 话题（长期）
 *   4. 校验（chat 数、原文条数、记录条数），通过后写 formatVersion=3；
 *   5. 任一步失败都不改 formatVersion —— 下次还能重跑。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChatStore, writeJsonAtomic } = require('../src/memory/chatStore');
const convert = require('../src/memory/convert');
const recordStore = require('../src/memory/recordStore');
const { FORMAT_VERSION, readFormatVersion } = require('../src/memory/formatVersion');
const { migrateIfNeeded, LEGACY_SOURCES } = require('./migrate/import-4.0');
const dataLock = require('../src/memory/dataLock');
const archive = require('./migrate/archive');
const maintenance = require('./migrate/upgrade-maintenance');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { apply: false, fromStore: false, dataDir: path.join(ROOT, 'data') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--auto-upgrade') out.autoUpgrade = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--from-store') out.fromStore = true;
    else if (arg === '--data') {
      const dir = argv[++i];
      if (!dir || dir.startsWith('--')) throw new Error('--data 需要指定数据目录');
      out.dataDir = path.resolve(dir);
    }
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error('不认识的参数：' + arg);
  }
  if (out.apply && out.dryRun) throw new Error('--apply 和 --dry-run 不能同时使用');
  if (out.autoUpgrade && out.dryRun) throw new Error('--auto-upgrade 不能和 --dry-run 同时使用');
  if (out.autoUpgrade) { out.apply = true; out.fromStore = true; }
  delete out.dryRun;
  return out;
}

function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return total;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 统计现状：chat 数、原文条数、卡数 */
function survey(memoryDir) {
  const chatRoot = path.join(memoryDir, 'chats');
  let chats = 0;
  let messages = 0;
  let people = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(chatRoot, { withFileTypes: true }); } catch { dirs = []; }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    chats += 1;
    const dir = path.join(chatRoot, entry.name);
    messages += countLines(path.join(dir, 'messages.jsonl'));
    const peopleDir = path.join(dir, 'people');
    try {
      people += fs.readdirSync(peopleDir).filter((n) => n.endsWith('.json')).length;
    } catch { /* 没有卡 */ }
  }
  return {
    chats,
    messages,
    people,
    hasLegacyDir: fs.existsSync(path.join(memoryDir, 'legacy')),
    bytes: dirSize(memoryDir),
  };
}

function backup(memoryDir, dataDir, sources, logger) {
  const backups = path.join(dataDir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const target = fs.mkdtempSync(path.join(backups, `memory-pre-v3-${stamp()}-`));
  if (fs.existsSync(memoryDir)) fs.cpSync(memoryDir, target, { recursive: true });
  if (sources.length) {
    const sourceBackup = path.join(target, 'legacy-sources');
    fs.mkdirSync(sourceBackup);
    for (const name of sources) {
      for (const file of [name, `${name}.journal`]) {
        const source = path.join(dataDir, file);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(sourceBackup, file));
      }
    }
  }
  if (logger) logger.info('已备份到 ' + target);
  return target;
}

/** 把旧结构投影成 records；返回写了多少条 */
function backfillRecords(memoryDir, chatStore, logger) {
  let timeline = 0;
  let subjects = 0;
  for (const chat of chatStore.chats.values()) {
    const records = convert.fromChat(chat);
    const mid = records.filter((r) => r.tier === 'M');
    const long = records.filter((r) => r.tier === 'L');
    if (mid.length) {
      timeline += recordStore.appendTimeline(chat.dir, mid);
    }
    // 长期事实按人归并；同一份 subjects 只写一次
    const bySubject = new Map();
    for (const item of long) {
      if (!item.subject) continue;
      if (!bySubject.has(item.subject)) bySubject.set(item.subject, []);
      bySubject.get(item.subject).push(item);
    }
    for (const [uid, list] of bySubject) {
      // 合并已有（重复执行时不会把旧的覆盖掉）
      const existing = recordStore.readSubjects(memoryDir, uid);
      const merged = new Map(existing.map((r) => [r.id, r]));
      for (const item of list) merged.set(item.id, item);
      subjects += recordStore.writeSubjects(memoryDir, uid, [...merged.values()]);
    }
    if (logger) {
      logger.info(`  ${String(chat.chatId).slice(0, 6)}… 中期 ${mid.length} 条、长期 ${long.length} 条`);
    }
  }
  return { timeline, subjects };
}

function runLocked(argv, opts = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法：node scripts/migrate-memory.js [--dry-run | --apply | --auto-upgrade] [--from-store] [--data <dir>]');
    return 0;
  }
  const memoryDir = path.join(args.dataDir, 'memory');
  const manifestFile = path.join(memoryDir, 'manifest.json');
  const sources = args.fromStore
    ? LEGACY_SOURCES.filter((name) => fs.existsSync(path.join(args.dataDir, name)))
    : [];
  const logger = args.json ? { info() {}, warn() {} } : {
    info: (msg) => console.log('[migrate] ' + msg),
    warn: (msg) => console.warn('[migrate] ' + msg),
  };
  const say = msg => { if (!args.json) console.log(msg); };
  const report = (status, stats = {}) => {
    if (args.json) console.log(JSON.stringify({ ok: true, status, ...stats }));
    return 0;
  };

  say('数据目录：' + memoryDir);
  if (!fs.existsSync(memoryDir) && !sources.length) {
    say('没有记忆目录，没什么可迁的（全新安装会直接初始化成 v' + FORMAT_VERSION + '）。');
    return report('idle');
  }
  const { version } = readFormatVersion(memoryDir);
  const before = survey(memoryDir);
  say(`当前版本：${version || '未标记'}，目标版本：${FORMAT_VERSION}`);
  say(`现状：chat ${before.chats} 个、原文 ${before.messages} 条、人物卡 ${before.people} 张、` +
    `${(before.bytes / 1024 / 1024).toFixed(1)} MB` + (before.hasLegacyDir ? '，有 legacy/ 只读副本' : ''));

  if (version === FORMAT_VERSION && !(opts.allowCurrentVersion && sources.length)) {
    say('已经是当前版本，无需迁移。');
    return report('idle');
  }
  if (!args.apply) {
    say('\n这是 dry-run，什么都没改。确认后加 --apply 执行。');
    say('将会：备份整个目录 → 删 legacy/ → 投影 records → 写 formatVersion=' + FORMAT_VERSION);
    return report('pending', { version, targetVersion: FORMAT_VERSION, chats: before.chats,
      messages: before.messages, legacySources: sources.length });
  }

  // 1) 备份：先备份，后动任何东西。自动模式已在外层创建并校验 ZIP，这里跳过目录备份。
  const backupDir = opts.skipBackup
    ? (opts.backupLabel || '（压缩归档）')
    : backup(memoryDir, args.dataDir, sources, logger);

  // 2) 空库也先写未升级标记，否则 ChatStore 会按全新安装直接写当前版本。
  if (!fs.existsSync(manifestFile)) {
    fs.mkdirSync(memoryDir, { recursive: true });
    writeJsonAtomic(manifestFile, { formatVersion: 0 });
  }
  const chatStore = new ChatStore({ dir: memoryDir, logger });
  const expected = { ...before };
  try {
    if (sources.length) {
      const result = migrateIfNeeded({ memoryDir, chatStore, logger, strict: true });
      if (result.report) {
        expected.chats += result.report.imported;
        expected.messages += result.report.messages;
      }
      if (result.migrated) logger.info('已导入 4.0 旧记忆');
      else logger.info('没有找到可导入的 4.0 旧文件，跳过');
    }

    // 3) 删 legacy/ 只读副本（备份里有一份）。自动模式留到提交后由 cleanup 校验再删。
    const legacyDir = path.join(memoryDir, 'legacy');
    if (!opts.skipLegacyDelete && fs.existsSync(legacyDir)) {
      fs.rmSync(legacyDir, { recursive: true, force: true });
      logger.info('已删除 legacy/ 只读副本（备份里保留）');
    }

    // 4) 投影 records
    const written = backfillRecords(memoryDir, chatStore, logger);
    chatStore.close();
    return finish({ written, before: expected, backupDir, memoryDir, manifestFile, say, report });
  } catch (err) {
    try { chatStore.close(); } catch { /* 已经关了 */ }
    throw err;
  }
}

/** 校验 + 写版本号 + 打印报告：拆出来是为了让上面的 try 只负责资源释放 */
function finish({ written, before, backupDir, memoryDir, manifestFile, say, report }) {
  // 5) 校验：chat 数、原文条数不能变
  const after = survey(memoryDir);
  if (after.chats !== before.chats) {
    throw new Error(`校验失败：chat 数 ${before.chats} → ${after.chats}，已中止（备份在 ${backupDir}）`);
  }
  if (after.messages !== before.messages) {
    throw new Error(`校验失败：原文 ${before.messages} → ${after.messages} 条，已中止（备份在 ${backupDir}）`);
  }

  // 6) 最后才写版本号：中途失败还能重跑
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.formatVersion = FORMAT_VERSION;
  manifest.migratedAt = Date.now();
  writeJsonAtomic(manifestFile, manifest);

  say('\n迁移完成：');
  say(`  chat ${after.chats} 个、原文 ${after.messages} 条（校验一致）`);
  say(`  中期记录 ${written.timeline} 条、长期事实 ${written.subjects} 条`);
  say(`  备份：${backupDir}`);
  say('  确认没问题后可以删掉备份；出问题用它整目录还原。');
  return report('done', { chats: after.chats, messages: after.messages, timeline: written.timeline,
    subjects: written.subjects });
}

class AutoFailure extends Error {
  constructor(code, message, { exit = 1, status = 'failed' } = {}) {
    super(message);
    this.name = 'AutoFailure';
    this.code = code;
    this.exit = exit;
    this.status = status;
  }
}

function emitAuto(args, value, human) {
  if (args.json) console.log(JSON.stringify(value));
  else console.log(human || value.message || value.status);
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new AutoFailure('data_unreadable', '无法读取 ' + file + '：' + (err.code || err.message), { exit: 3, status: 'unreadable' });
  }
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 收集并校验 memory/legacy 下当前文件是否都与归档一致；返回相对 data 的条目名。 */
function legacyFilesForCleanup(memoryDir, dataDir, manifestFiles) {
  const legacyDir = path.join(memoryDir, 'legacy');
  const st = lstatOrNull(legacyDir);
  if (!st) return [];
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new AutoFailure('cleanup_pending', 'legacy 不是普通目录，保留不删', { status: 'cleanup_pending' });
  }
  // import-4.0 在导入时会把 data 根的旧源复制到 memory/legacy/；这些副本不在
  // 归档 manifest 的精确路径里，但内容与已归档源一致，属于本次可清理的 owned 输入。
  const sourceNames = new Set(['store.json', 'store.json.journal', 'memory.json']);
  const sourceHashes = new Set([...manifestFiles.values()]
    .filter((record) => sourceNames.has(record.name)).map((record) => record.sha256));
  const found = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const child = lstatOrNull(abs);
      if (!child) continue;
      if (child.isSymbolicLink()) throw new AutoFailure('cleanup_pending', 'legacy 内含链接，保留不删', { status: 'cleanup_pending' });
      if (child.isDirectory()) { walk(abs); continue; }
      if (!child.isFile()) throw new AutoFailure('cleanup_pending', 'legacy 内含非普通文件，保留不删', { status: 'cleanup_pending' });
      const rel = path.relative(dataDir, abs).replace(/\\/g, '/');
      const record = manifestFiles.get(rel);
      const digest = fileSha256(abs);
      if (record) {
        if (digest !== record.sha256) throw new AutoFailure('cleanup_pending', 'legacy 在备份后被改动，保留不删', { status: 'cleanup_pending' });
      } else if (rel === 'memory/legacy/README.txt'
        && fs.readFileSync(abs, 'utf8').startsWith('这些是迁移前的旧记忆文件')) {
        // import-4.0 在导入时生成说明文件；内容未被改过才随 legacy 目录一起清理。
      } else if (!sourceHashes.has(digest)) {
        // 不在归档里、也不等于任何已归档旧源：可能是备份后新增/改动的文件，保留不删。
        throw new AutoFailure('cleanup_pending', 'legacy 在备份后出现未归档文件，保留不删', { status: 'cleanup_pending' });
      }
      found.push(rel);
    }
  };
  walk(legacyDir);
  return found;
}

function autoUpgrade(argv) {
  const args = parseArgs(argv);
  if (!args.json) args.json = true; // 自动模式只给启动器/维护用，统一 JSON
  const dataDir = args.dataDir;
  let lock;
  try {
    lock = dataLock.acquire({ dataDir, purpose: 'migration' });
  } catch (err) {
    emitAuto(args, { ok: false, status: 'busy', error: err.code || 'data_lock_unavailable', message: err.message });
    return 2;
  }
  try {
    if (args.help) { emitAuto(args, { ok: true, status: 'idle' }); return 0; }
    const status = maintenance.readStatus(dataDir);
    if (status.status === 'future' || status.status === 'invalid' || status.status === 'unreadable') {
      emitAuto(args, {
        ok: false, status: status.status, error: 'data_format_' + status.status,
        version: status.version, targetVersion: FORMAT_VERSION,
        message: status.status === 'future'
          ? '记忆目录是更新版本，不能用当前内核自动转换。'
          : status.status === 'invalid'
            ? '记忆目录格式标记无效，已停止且未改动任何文件。'
            : '记忆目录无法读取，已停止且未改动任何文件。',
      });
      return 3;
    }
    try { maintenance.runRetention({ dataDir, skipLock: true }); } catch { /* 过期清理失败不阻塞启动 */ }
    if (status.status === 'idle') {
      emitAuto(args, {
        ok: true, status: 'idle', version: status.version, targetVersion: FORMAT_VERSION,
        receipt: status.receipt, runnerCleanupEligible: status.runnerCleanupEligible,
      });
      return 0;
    }

    const memoryDir = path.join(dataDir, 'memory');
    const sources = maintenance.listLegacySources(dataDir);
    const prior = maintenance.readReceipt(dataDir);
    let receipt = prior;
    let archiveInfo = null;

    const reusable = prior && ['archived', 'converted', 'cleanup_pending'].includes(prior.stage) && prior.archive;
    if (reusable) {
      const file = path.join(dataDir, 'backups', prior.archive);
      const owned = archive.inspectOwnedArchive(file);
      if (owned.owned) {
        archiveInfo = { path: file, receipt: owned.receipt, sha256: owned.verified.digest, manifest: owned.verified.manifest };
      } else if (prior.stage === 'archived') {
        // 备份阶段崩溃且归档不可用：尚未提交，重新归档是安全的。
        receipt = null;
      } else {
        throw new AutoFailure('backup_failed', '已提交转换但备份归档缺失/损坏，保留旧输入不动', { status: 'backup_failed' });
      }
    }
    if (!archiveInfo) {
      const now = Date.now();
      const file = path.join(dataDir, 'backups', archive.archiveName(now));
      let created;
      try {
        created = archive.createArchive({ dataDir, memoryDir, sources, outPath: file, now });
      } catch (err) {
        const unreadable = err && err.code === 'data_unreadable';
        throw new AutoFailure(unreadable ? 'data_unreadable' : 'backup_failed', err.message || String(err),
          unreadable ? { exit: 3, status: 'unreadable' } : { status: 'backup_failed' });
      }
      archiveInfo = { path: file, receipt: created.receipt, sha256: created.sha256, manifest: created.manifest };
      receipt = maintenance.writeReceipt(dataDir, {
        stage: 'archived',
        archive: path.basename(file),
        archiveId: created.receipt.archiveId,
        archiveSha256: created.sha256,
        startedAt: created.receipt.startedAt,
        completedAt: created.receipt.completedAt,
        formatVersion: status.version,
        targetVersion: FORMAT_VERSION,
        sources,
      });
    }

    const skipConvert = receipt && ['converted', 'cleanup_pending'].includes(receipt.stage)
      && status.version === FORMAT_VERSION;
    let chats;
    let messages;
    if (!skipConvert) {
      const captured = captureRunLocked(['--apply', '--from-store', '--json', '--data', dataDir], {
        skipBackup: true, allowCurrentVersion: true, skipLegacyDelete: true, backupLabel: archiveInfo.path,
      });
      if (captured.error) {
        throw new AutoFailure('migration_failed', captured.error.message || String(captured.error), { status: 'failed' });
      }
      const result = captured.parsed;
      if (captured.code !== 0 || !result || result.ok !== true || (result.status !== 'done' && result.status !== 'idle')) {
        throw new AutoFailure('migration_failed', '转换工具未完成，旧输入与格式标记保持原样', { status: 'failed' });
      }
      const afterVersion = maintenance.readStatus(dataDir).version;
      if (afterVersion !== FORMAT_VERSION) {
        throw new AutoFailure('migration_failed', '转换后版本标记不是目标版本，已停止', { status: 'failed' });
      }
      chats = result.chats;
      messages = result.messages;
      receipt = maintenance.writeReceipt(dataDir, {
        stage: 'converted',
        archive: path.basename(archiveInfo.path),
        archiveId: archiveInfo.receipt.archiveId,
        archiveSha256: archiveInfo.sha256,
        startedAt: archiveInfo.receipt.startedAt,
        completedAt: archiveInfo.receipt.completedAt,
        formatVersion: FORMAT_VERSION,
        targetVersion: FORMAT_VERSION,
        chats, messages, sources,
      });
    }

    // 提交后、删除任何输入前，再次校验归档，并只删“备份时哈希仍然一致”的旧输入。
    const verified = archive.inspectOwnedArchive(archiveInfo.path);
    if (!verified.owned) throw new AutoFailure('backup_failed', '删除旧输入前归档校验失败，已停止', { status: 'backup_failed' });
    const manifestFiles = new Map(verified.verified.manifest.files.map((item) => [item.name, item]));
    const removedSources = [];
    for (const name of sources) {
      const abs = path.join(dataDir, name);
      const st = lstatOrNull(abs);
      if (!st) continue; // 已经不在了
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new AutoFailure('cleanup_pending', '旧版输入不是普通文件，保留不删', { status: 'cleanup_pending' });
      }
      const record = manifestFiles.get(name);
      if (!record) throw new AutoFailure('cleanup_pending', '旧版输入不在本次归档中，保留不删', { status: 'cleanup_pending' });
      if (fileSha256(abs) !== record.sha256) {
        throw new AutoFailure('cleanup_pending', '旧版输入在备份后被改动，保留不删', { status: 'cleanup_pending' });
      }
      try { fs.unlinkSync(abs); }
      catch { throw new AutoFailure('cleanup_pending', '删除旧版输入失败，保留待重试', { status: 'cleanup_pending' }); }
      removedSources.push(name);
    }
    const legacyFiles = legacyFilesForCleanup(memoryDir, dataDir, manifestFiles);
    if (lstatOrNull(path.join(memoryDir, 'legacy'))) {
      try { fs.rmSync(path.join(memoryDir, 'legacy'), { recursive: true, force: true }); }
      catch { throw new AutoFailure('cleanup_pending', '删除 legacy 备份失败，保留待重试', { status: 'cleanup_pending' }); }
    }
    maintenance.writeReceipt(dataDir, {
      stage: 'done',
      archive: path.basename(archiveInfo.path),
      archiveId: archiveInfo.receipt.archiveId,
      archiveSha256: archiveInfo.sha256,
      startedAt: archiveInfo.receipt.startedAt,
      completedAt: archiveInfo.receipt.completedAt,
      formatVersion: FORMAT_VERSION,
      targetVersion: FORMAT_VERSION,
      chats, messages, sources: [], removedSources,
    });
    try { maintenance.runRetention({ dataDir, skipLock: true }); } catch { /* 过期清理失败不改变本次成功 */ }
    emitAuto(args, {
      ok: true, status: 'done', version: FORMAT_VERSION, targetVersion: FORMAT_VERSION,
      chats, messages, backupPath: archiveInfo.path, backupCompletedAt: archiveInfo.receipt.completedAt,
      archiveId: archiveInfo.receipt.archiveId, removedSources, legacySources: 0,
      runnerCleanupEligible: true,
    });
    return 0;
  } catch (err) {
    if (err instanceof AutoFailure) {
      try {
        // 只有“提交后清理失败”才更新收据；转换/备份失败保持原收据（通常是 archived），
        // 下次重跑会复用同一归档，不重导、不重置过期计时。
        if (err.status === 'cleanup_pending') {
          const prior = maintenance.readReceipt(dataDir);
          if (prior) {
            maintenance.writeReceipt(dataDir, {
              archive: prior.archive, archiveId: prior.archiveId, archiveSha256: prior.archiveSha256,
              startedAt: prior.startedAt, completedAt: prior.completedAt,
              formatVersion: prior.formatVersion, targetVersion: prior.targetVersion,
              chats: prior.chats, messages: prior.messages, sources: prior.sources,
              stage: 'cleanup_pending', error: err.code,
            });
          }
        }
      } catch { /* 收据写失败也不改变“已停止”的事实 */ }
      emitAuto(args, { ok: false, status: err.status, error: err.code, message: err.message });
      return err.exit;
    }
    const unreadable = err && err.code === 'data_unreadable';
    emitAuto(args, {
      ok: false, status: unreadable ? 'unreadable' : 'failed',
      error: unreadable ? 'data_unreadable' : (err && err.code) || 'migration_failed',
      message: (err && err.message) || String(err),
    });
    return unreadable ? 3 : 1;
  } finally {
    try { lock.releaseSync(); } catch { /* ignore */ }
  }
}

function captureRunLocked(argv, opts) {
  const output = [];
  const ol = console.log;
  const ow = console.warn;
  console.log = (...parts) => output.push(parts.join(' '));
  console.warn = (...parts) => output.push(parts.join(' '));
  let code = 1;
  let error = null;
  try { code = runLocked(argv, opts); }
  catch (err) { error = err; }
  finally { console.log = ol; console.warn = ow; }
  let parsed = null;
  for (let i = output.length - 1; i >= 0; i -= 1) {
    try { parsed = JSON.parse(output[i].trim()); break; } catch { /* 继续找 */ }
  }
  return { code, error, parsed, output };
}

function refuseDataLock(source, args) {
  const state = source && source.state;
  const code = source && source.code ? source.code : 'data_lock_' + (state || 'unknown');
  const owner = source && source.owner;
  const detail = owner ? `（pid=${owner.pid}，${owner.purpose || 'unknown'}）` : '';
  const guardPath = dataLock.recoverFile(args.dataDir);
  const lockPath = dataLock.lockFile(args.dataDir);
  const message = (source && source.message) || (
    state === 'stale'
      ? '上次记忆转换没有正常结束，重新运行转换可安全恢复；预览已暂停。'
      : state === 'busy'
        ? '数据目录正被另一个进程使用' + detail + '，请等它结束后再转换。'
        : state === 'recovering'
          ? '另一个进程正在恢复数据目录锁，请等它结束后再转换。'
          : state === 'guard_stale'
            ? '上次数据目录锁恢复进程异常退出。请先停止鲸鲸内核和所有转换重试，确认没有相关进程后手动删除：'
              + guardPath + '（恢复守卫）；仅当主锁 ' + lockPath + ' 记录的 pid 也已退出时，再删除主锁。程序不会自动删除。'
            : state === 'guard_unknown'
              ? '无法确认恢复守卫的持有者（' + guardPath + '）。请确认没有转换/服务进程后手动删除该文件；程序不会自动删除。'
              : '无法确认数据目录锁的持有者（' + lockPath + '）。请确认没有转换/服务进程后手动删除该文件；程序不会自动删除。');
  if (args && args.json) {
    console.log(JSON.stringify({ ok: false, status: 'busy', error: code, message }));
  } else {
    console.error('[migrate] ' + message);
  }
  return 2;
}

/**
 * apply 在备份/读改写之前拿 data 目录独占锁，直到 formatVersion 写完才释放；
 * 预览只读，不持独占锁（避免并行启动被短暂挡住），但读前/读后各查一次锁，
 * 发现转换已经插进来就丢弃本次输出。
 */
function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('用法：node scripts/migrate-memory.js [--dry-run | --apply | --auto-upgrade] [--from-store] [--data <dir>]');
    return 0;
  }
  if (args.autoUpgrade) return autoUpgrade(argv);
  if (args.apply) {
    let lock;
    try { lock = dataLock.acquire({ dataDir: args.dataDir, purpose: 'migration' }); }
    catch (err) {
      if (err.code === 'data_lock_unavailable') {
        const message = '无法写入数据目录锁：' + err.message;
        if (args.json) console.log(JSON.stringify({ ok: false, status: 'busy', error: err.code, message }));
        else console.error('[migrate] ' + message);
        return 2;
      }
      return refuseDataLock(err, args);
    }
    try { return runLocked(argv); }
    finally { lock.releaseSync(); }
  }

  const before = dataLock.inspect(args.dataDir);
  if (before.state !== 'idle') return refuseDataLock(before, args);
  const output = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...parts) => output.push(parts.join(' '));
  console.warn = (...parts) => output.push(parts.join(' '));
  let code;
  try { code = runLocked(argv); }
  finally { console.log = log; console.warn = warn; }
  const after = dataLock.inspect(args.dataDir);
  if (after.state !== 'idle') return refuseDataLock(after, args);
  for (const line of output) log(line);
  return code;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: 'migration_failed' }));
    else console.error('[migrate] 失败：' + ((err && err.message) || err));
    process.exitCode = 1;
  }
}

module.exports = { survey, backfillRecords, parseArgs, main, autoUpgrade };

