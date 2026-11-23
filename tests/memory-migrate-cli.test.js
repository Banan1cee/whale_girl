'use strict';

/**
 * 一次性迁移脚本（scripts/migrate-memory.js）。
 *
 * 这个脚本是「删掉运行时旧格式兼容」的前提：数据必须先被搬过去，运行时才敢只认 v3。
 * 重点：
 *   1. dry-run 不动盘；
 *   2. --apply 产出 records，且 chat 数/原文条数不变；
 *   3. 版本号最后才写（中途失败可重跑）；
 *   4. 重复执行是 no-op。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/memory/store');
const episode = require('../src/memory/episode');
const recordStore = require('../src/memory/recordStore');
const { FORMAT_VERSION } = require('../src/memory/formatVersion');
const migrate = require('../scripts/migrate-memory');
const { readFormatVersion } = require('../src/memory/formatVersion');
const archive = require('../scripts/migrate/archive');
const maintenance = require('../scripts/migrate/upgrade-maintenance');
const dataLock = require('../src/memory/dataLock');
const { spawnSync } = require('node:child_process');

function quiet() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  return () => { console.log = originalLog; console.warn = originalWarn; };
}

async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mig-'));
  const memoryDir = path.join(dataDir, 'memory');
  const store = new Store({ file: path.join(dataDir, 'store.json'), dir: memoryDir, logger: null });
  const key = 'wechat:g:1';
  const now = Date.now();
  store.appendMessage(key, { role: 'user', uid: 'u1', name: '小海', text: '我不吃香菜，我喜欢猫', ts: now - 5000 });
  store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '猫好呀', ts: now - 4000 });
  store.appendMessage(key, { role: 'user', uid: 'u1', name: '小海', text: '我今天面试完了，紧张死了', ts: now - 3000 });
  const chat = store.chatStore.ensureChat(key);
  await episode.closeEpisode({ chat, chatStore: store.chatStore, llm: null, now, reason: 'manual' });
  store.close();
  // 4.3 的新库一建就是 v3；这里把标记拿掉，模拟「从旧版本升上来的目录」
  const manifestFile = path.join(memoryDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  delete manifest.formatVersion;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  const before = {
    chats: fs.readdirSync(path.join(memoryDir, 'chats')).length,
    messages: fs.readFileSync(path.join(chat.dir, 'messages.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).length,
    version: readFormatVersion(memoryDir).version,
  };
  return { dataDir, memoryDir, chat, before };
}

test('dry-run：只出报告，不改盘', async () => {
  const { dataDir, memoryDir, before } = await fixture();
  assert.equal(before.version, 0, '夹具应该是未标记的旧格式');
  const manifestFile = path.join(memoryDir, 'manifest.json');
  const snapshot = fs.readFileSync(manifestFile, 'utf8');
  const restore = quiet();
  try {
    const code = migrate.main(['--data', dataDir]);
    assert.equal(code, 0);
  } finally {
    restore();
  }
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), snapshot, 'dry-run 不能改 manifest');
  assert.equal(readFormatVersion(memoryDir).version, 0);
});

test('--apply：产出 records、校验通过、版本号最后写', async () => {
  const { dataDir, memoryDir, chat, before } = await fixture();
  const restore = quiet();
  try {
    assert.equal(migrate.main(['--apply', '--data', dataDir]), 0);
  } finally {
    restore();
  }
  assert.equal(readFormatVersion(memoryDir).version, FORMAT_VERSION);

  // 原文没被动
  const afterMessages = fs.readFileSync(path.join(chat.dir, 'messages.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).length;
  assert.equal(afterMessages, before.messages);

  // 中期记录：事件或摘要至少有一条
  const timeline = recordStore.readTimeline(chat.dir);
  assert.ok(timeline.length >= 1, '应当投影出中期记录');
  assert.ok(timeline.every((r) => r.tier === 'M'));

  // 长期事实：小海的卡里应当有「不吃香菜 / 喜欢猫」这类自述
  const subjects = recordStore.readSubjects(memoryDir, 'u1');
  assert.ok(subjects.length >= 1, '应当投影出长期事实');
  assert.ok(subjects.every((r) => r.tier === 'L'));
  assert.ok(subjects.every((r) => r.scope === `chat:${chat.hash}`));

  // 备份存在
  const backups = fs.readdirSync(path.join(dataDir, 'backups'));
  assert.ok(backups.some((name) => name.startsWith('memory-pre-v3-')));
});

test('重复执行：已是当前版本就 no-op，不重复写', async () => {
  const { dataDir, memoryDir, chat } = await fixture();
  let restore = quiet();
  try { migrate.main(['--apply', '--data', dataDir]); } finally { restore(); }
  const before = recordStore.readTimeline(chat.dir).length;
  restore = quiet();
  try {
    assert.equal(migrate.main(['--apply', '--data', dataDir]), 0);
  } finally {
    restore();
  }
  assert.equal(recordStore.readTimeline(chat.dir).length, before, '不能重复追加');
  assert.equal(readFormatVersion(memoryDir).version, FORMAT_VERSION);
});

test('没有记忆目录：直接成功退出（全新安装不报错）', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mig-empty-'));
  const restore = quiet();
  try {
    assert.equal(migrate.main(['--data', dataDir]), 0);
  } finally {
    restore();
  }
});

test('--from-store：只有旧存档也能保留对象摘要、覆盖范围和原文，重复执行不重复导入', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mig-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memoryDir = path.join(dir, 'memory');
  const file = path.join(dir, 'store.json');
  const id = 'wechat:u:fixture';
  const messages = [
    { role: 'user', text: '我喜欢画画', ts: 1 },
    { role: 'assistant', text: '你画什么？', ts: 2 },
  ];
  fs.writeFileSync(file, JSON.stringify({ sessions: {
    [id]: { messages, summary: { text: '较早的摘要', uptoSeq: 1 } },
    'wechat:u:other': { messages, summary: { text: '无效摘要', uptoSeq: 0 } },
  } }));
  const original = fs.readFileSync(file, 'utf8');
  const restore = quiet();
  t.after(restore);
  const args = ['--from-store', '--data', dir];
  assert.equal(migrate.main(['--dry-run', ...args]), 0);
  assert.equal(fs.existsSync(memoryDir), false);
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
  assert.equal(migrate.main(['--apply', ...args]), 0);
  assert.equal(readFormatVersion(memoryDir).version, FORMAT_VERSION);
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'backups', backups[0], 'legacy-sources', 'store.json'), 'utf8'), original);
  assert.equal(migrate.main(['--apply', ...args]), 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), backups);
  const reopened = new Store({ file, dir: memoryDir });
  try {
    const chat = reopened.chatStore.chats.get(id);
    assert.equal(chat.summary.text, '较早的摘要');
    assert.equal(chat.summary.coveredThroughSeq, 1);
    assert.deepEqual(chat.summary.segments.map(x => [x.fromSeq, x.toSeq]), [[1, 1]]);
    assert.deepEqual(chat.messages.map(x => x.text), messages.map(x => x.text));
    assert.equal(reopened.chatStore.chats.get('wechat:u:other').summary.text, '');
  } finally {
    reopened.close();
  }
});

test('--from-store：导入异常时未完成格式闸，修复输入后可重跑', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mig-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memoryDir = path.join(dir, 'memory');
  fs.mkdirSync(memoryDir);
  const file = path.join(dir, 'store.json');
  const id = 'wechat:u:fixture';
  const valid = { messages: [{ role: 'user', text: '保留一条原文', ts: 1 }] };
  fs.writeFileSync(file, JSON.stringify({ sessions: { [id]: valid, 'wechat:u:bad': null } }));
  const restore = quiet();
  t.after(restore);
  const args = ['--apply', '--from-store', '--data', dir];
  assert.throws(() => migrate.main(args), /旧记忆导入有 1 个会话失败/);
  assert.equal(readFormatVersion(memoryDir).version, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  fs.writeFileSync(file, JSON.stringify({ sessions: { [id]: valid } }));
  assert.equal(migrate.main(args), 0);
  assert.equal(readFormatVersion(memoryDir).version, FORMAT_VERSION);
  const reopened = new Store({ file, dir: memoryDir });
  try {
    assert.deepEqual(reopened.chatStore.chats.get(id).messages.map(x => x.text), ['保留一条原文']);
  } finally {
    reopened.close();
  }
});

test('启动器 JSON 模式预览和应用包含旧存档与 legacy 副本的记忆', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mig-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memory = path.join(dir, 'memory');
  const legacy = path.join(memory, 'legacy');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'fixture.txt'), 'synthetic backup');
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ sessions: {
    'wechat:u:fixture': { messages: [{ role: 'user', text: '合成原文', ts: 1 }] },
  } }));
  const run = (...flags) => {
    const lines = [];
    t.mock.method(console, 'log', line => lines.push(line));
    try { assert.equal(migrate.main(['--json', '--from-store', '--data', dir, ...flags]), 0); }
    finally { console.log.mock.restore(); }
    assert.equal(lines.length, 1);
    return JSON.parse(lines[0]);
  };
  assert.deepEqual(run(), { ok: true, status: 'pending', version: 0, targetVersion: FORMAT_VERSION,
    chats: 0, messages: 0, legacySources: 1 });
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
  const applied = run('--apply');
  assert.equal(applied.status, 'done');
  assert.equal(applied.chats, 1);
  assert.equal(applied.messages, 1);
  assert.equal(fs.existsSync(legacy), false);
  const [backup] = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(fs.readFileSync(path.join(dir, 'backups', backup, 'legacy', 'fixture.txt'), 'utf8'), 'synthetic backup');
  assert.deepEqual(run('--apply'), { ok: true, status: 'idle' });
});

test('活锁时 apply 返回 busy 且不碰盘', async (t) => {
  const { dataDir, memoryDir, before } = await fixture();
  const dataLock = require('../src/memory/dataLock');
  const manifest = path.join(memoryDir, 'manifest.json');
  const snapshot = fs.readFileSync(manifest, 'utf8');
  const lock = dataLock.acquire({ dataDir, purpose: 'server' });
  t.after(() => lock.releaseSync());
  const lines = [];
  const restore = t.mock.method(console, 'log', (line) => lines.push(String(line)));
  try {
    assert.equal(migrate.main(['--json', '--apply', '--data', dataDir]), 2);
  } finally {
    console.log.mock.restore();
  }
  assert.equal(JSON.parse(lines[0]).status, 'busy');
  assert.equal(fs.readFileSync(manifest, 'utf8'), snapshot);
  assert.equal(readFormatVersion(memoryDir).version, before.version);
});

test('死 pid 的陈旧锁自动恢复，再正常迁移', async (t) => {
  const { dataDir, memoryDir } = await fixture();
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  const deadPid = child.pid;
  if (process.platform === 'win32') {
    try { process.kill(deadPid, 0); t.skip('pid 被系统复用，跳过陈旧锁用例'); return; }
    catch (err) { assert.equal(err.code, 'ESRCH'); }
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.data.lock'), JSON.stringify({
    version: 1, token: 'dead-token-fixture', pid: deadPid, startedAt: 1,
    host: os.hostname(), purpose: 'migration',
  }));
  const restore = quiet();
  try { assert.equal(migrate.main(['--apply', '--data', dataDir]), 0); }
  finally { restore(); }
  assert.equal(readFormatVersion(memoryDir).version, FORMAT_VERSION);
  assert.equal(fs.existsSync(path.join(dataDir, '.data.lock')), false);
});

test('死恢复守卫时 apply 返回 guard_stale，手动清理后可恢复', async (t) => {
  const { dataDir, memoryDir } = await fixture();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.data.lock'), JSON.stringify({
    version: 1, token: 'stale-main-fixture', pid: 2147483647, startedAt: 1,
    host: os.hostname(), purpose: 'migration',
  }));
  fs.writeFileSync(path.join(dataDir, '.data.lock.recover'), JSON.stringify({
    version: 1, token: 'stale-guard-fixture', pid: 2147483647, startedAt: 1,
    host: os.hostname(), purpose: 'recovery',
  }));
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(String(line)));
  try {
    assert.equal(migrate.main(['--json', '--apply', '--data', dataDir]), 2);
  } finally {
    console.log.mock.restore();
  }
  const result = JSON.parse(lines[0]);
  assert.equal(result.status, 'busy');
  assert.equal(result.error, 'data_lock_guard_stale');
  assert.match(result.message, /\.data\.lock\.recover/);
  assert.equal(fs.existsSync(path.join(dataDir, '.data.lock.recover')), true);
  fs.unlinkSync(path.join(dataDir, '.data.lock.recover'));
  const restore = quiet();
  try { assert.equal(migrate.main(['--apply', '--data', dataDir]), 0); }
  finally { restore(); }
  assert.equal(readFormatVersion(memoryDir).version, FORMAT_VERSION);
});

test('锁元数据损坏时 fail-closed，不迁移也不删锁', async (t) => {
  const { dataDir, memoryDir } = await fixture();
  const manifest = path.join(memoryDir, 'manifest.json');
  const snapshot = fs.readFileSync(manifest, 'utf8');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.data.lock'), '{broken-lock');
  const lines = [];
  const restore = t.mock.method(console, 'log', (line) => lines.push(String(line)));
  try {
    assert.equal(migrate.main(['--json', '--apply', '--data', dataDir]), 2);
  } finally {
    console.log.mock.restore();
  }
  assert.equal(JSON.parse(lines[0]).status, 'busy');
  assert.equal(fs.readFileSync(manifest, 'utf8'), snapshot);
  assert.equal(fs.readFileSync(path.join(dataDir, '.data.lock'), 'utf8'), '{broken-lock');
});

test('迁移失败后释放锁，修好输入可重跑', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mig-lockfail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.json');
  const id = 'wechat:u:fixture';
  const valid = { messages: [{ role: 'user', text: '保留一条原文', ts: 1 }] };
  fs.writeFileSync(file, JSON.stringify({ sessions: { [id]: valid, 'wechat:u:bad': null } }));
  const restore = quiet();
  t.after(restore);
  const args = ['--apply', '--from-store', '--data', dir];
  assert.throws(() => migrate.main(args), /旧记忆导入有 1 个会话失败/);
  assert.equal(fs.existsSync(path.join(dir, '.data.lock')), false, '失败后必须释放锁');
  fs.writeFileSync(file, JSON.stringify({ sessions: { [id]: valid } }));
  assert.equal(migrate.main(args), 0);
  assert.equal(fs.existsSync(path.join(dir, '.data.lock')), false);
});

test('parseArgs：不认识的参数直接报错，不静默忽略', () => {
  assert.throws(() => migrate.parseArgs(['--nope']), /不认识的参数/);
  const args = migrate.parseArgs(['--apply', '--data', 'D:\\tmp']);
  assert.equal(args.apply, true);
  assert.equal(path.basename(args.dataDir), 'tmp');
});

/* ── 安装态自动升级（task-15）──────────────────────────────────────── */

function makeOld({ chats = 1, perChat = 1, legacy = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-auto-old-'));
  const memoryDir = path.join(dataDir, 'memory');
  const store = new Store({ file: path.join(dataDir, 'store.json'), dir: memoryDir, logger: null });
  for (let c = 0; c < chats; c += 1) {
    const key = `wechat:g:${c + 1}`;
    for (let m = 0; m < perChat; m += 1) {
      store.appendMessage(key, { role: m % 2 ? 'assistant' : 'user', uid: 'u1', name: '合成', text: 'synthetic ' + m, ts: 1000 + m });
    }
  }
  store.close();
  const manifestFile = path.join(memoryDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  delete manifest.formatVersion;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  if (legacy) {
    fs.mkdirSync(path.join(memoryDir, 'legacy', 'old'), { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'legacy', 'old', 'note.txt'), 'legacy synthetic');
  }
  return { dataDir, memoryDir, manifestFile };
}

function runAuto(dataDir) {
  const out = [];
  const ol = console.log;
  const ow = console.warn;
  console.log = (...parts) => out.push(parts.join(' '));
  console.warn = (...parts) => out.push(parts.join(' '));
  let code;
  try { code = migrate.main(['--auto-upgrade', '--json', '--data', dataDir]); }
  finally { console.log = ol; console.warn = ow; }
  let json = null;
  for (const line of out.slice().reverse()) {
    try { json = JSON.parse(line); break; } catch { /* 找最后一条 JSON */ }
  }
  return { code, json };
}

function backupNames(dataDir) {
  try { return fs.readdirSync(path.join(dataDir, 'backups')).sort(); }
  catch { return []; }
}

test('--auto-upgrade：v2 旧库（7 chats / 469 messages）压缩归档→转换→清理，标准 ZIP 可解压', (t) => {
  const { dataDir, memoryDir } = makeOld({ chats: 7, perChat: 67, legacy: true });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  fs.writeFileSync(path.join(memoryDir, 'keep.txt'), 'unrelated active data');
  const { code, json } = runAuto(dataDir);
  assert.equal(code, 0);
  assert.equal(json.status, 'done');
  assert.equal(json.chats, 7);
  assert.equal(json.messages, 469);
  assert.equal(json.removedSources.length, 0);
  assert.equal(readFormatVersion(memoryDir).version, FORMAT_VERSION);
  assert.equal(fs.existsSync(path.join(memoryDir, 'legacy')), false, '已归档的 legacy 可在提交后删除');
  assert.equal(fs.readFileSync(path.join(memoryDir, 'keep.txt'), 'utf8'), 'unrelated active data', '不相关数据必须保留');
  const names = backupNames(dataDir);
  const zipName = names.find((name) => name.endsWith('.zip'));
  assert.ok(zipName, '必须有压缩归档');
  assert.ok(names.includes(zipName + '.receipt.json'), '必须有完成收据');
  const receipt = maintenance.readReceipt(dataDir);
  assert.equal(receipt.stage, 'done');
  assert.equal(receipt.formatVersion, FORMAT_VERSION);
  assert.ok(Date.parse(receipt.completedAt) > 0);
  // 标准 ZIP 消费端（Windows 自带 bsdtar）能解出完整条目。
  const zip = path.join(dataDir, 'backups', zipName);
  const outDir = path.join(dataDir, 'restore-check');
  fs.mkdirSync(outDir, { recursive: true });
  const unzip = spawnSync('tar', ['-xf', zip, '-C', outDir], { stdio: 'ignore' });
  assert.equal(unzip.status, 0, '标准 ZIP 消费者必须能解压');
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, '_backup-manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'whale-memory-backup/1');
  assert.equal(manifest.chats, 7);
  assert.equal(manifest.messages, 469);
  assert.ok(fs.existsSync(path.join(outDir, 'memory', 'legacy', 'old', 'note.txt')));
  assert.equal(fs.readFileSync(path.join(outDir, 'memory', 'keep.txt'), 'utf8'), 'unrelated active data');
  // 再跑一次：idle，不新建归档、不重置完成时间。
  const again = runAuto(dataDir);
  assert.equal(again.code, 0);
  assert.equal(again.json.status, 'idle');
  assert.deepEqual(backupNames(dataDir), names);
});

test('--auto-upgrade：已是 v3 但仍有旧 store.json 时导入→删旧源→done，可重跑不重导', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-auto-store-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const memoryDir = path.join(dataDir, 'memory');
  const store = new Store({ file: path.join(dataDir, 'old-tmp.json'), dir: memoryDir, logger: null });
  store.appendMessage('wechat:u:local', { role: 'user', uid: 'u1', name: 'A', text: 'local', ts: 1 });
  store.close();
  fs.writeFileSync(path.join(dataDir, 'store.json'), JSON.stringify({ sessions: {
    'wechat:u:old': { messages: [{ role: 'user', text: 'old synthetic', ts: 2 }] },
  } }));
  const { code, json } = runAuto(dataDir);
  assert.equal(code, 0);
  assert.equal(json.status, 'done');
  assert.deepEqual(json.removedSources.sort(), ['store.json']);
  assert.equal(fs.existsSync(path.join(dataDir, 'store.json')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(memoryDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.formatVersion, FORMAT_VERSION);
  assert.ok((manifest.migratedFrom || []).some((item) => String(item.source).includes('store.json')));
  const names = backupNames(dataDir);
  const again = runAuto(dataDir);
  assert.equal(again.code, 0);
  assert.equal(again.json.status, 'idle');
  assert.deepEqual(backupNames(dataDir), names, '重跑不能新建归档或重置完成时间');
});

test('--auto-upgrade：future / invalid / unreadable 一律 fail-closed 且不改任何文件', (t) => {
  for (const kind of ['future', 'invalid', 'unreadable']) {
    const { dataDir, memoryDir, manifestFile } = makeOld();
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
    if (kind === 'future') {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      manifest.formatVersion = FORMAT_VERSION + 1;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    } else if (kind === 'invalid') {
      fs.writeFileSync(manifestFile, JSON.stringify({ formatVersion: 'not-a-number' }));
    } else {
      fs.rmSync(manifestFile, { force: true });
      fs.mkdirSync(manifestFile);
    }
    const before = kind === 'unreadable' ? null : fs.readFileSync(manifestFile, 'utf8');
    const { code, json } = runAuto(dataDir);
    assert.equal(code, 3, kind);
    assert.equal(json.ok, false, kind);
    assert.equal(json.status, kind, kind);
    assert.deepEqual(backupNames(dataDir), [], kind + '：不应创建归档');
    if (before !== null) assert.equal(fs.readFileSync(manifestFile, 'utf8'), before, kind + '：manifest 不能被改');
  }
});

test('--auto-upgrade：已提交但归档损坏时保留旧输入/格式，失败可诊断', (t) => {
  const { dataDir, memoryDir, manifestFile } = makeOld();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const backups = path.join(dataDir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const zipName = 'memory-pre-v3-20200101-000000Z.zip';
  fs.writeFileSync(path.join(backups, zipName), 'not a zip');
  fs.writeFileSync(path.join(backups, zipName + '.receipt.json'), JSON.stringify({
    format: 'whale-memory-backup-receipt/1', owner: 'whale-girl/memory-upgrade',
    archiveId: 'fixture-id', archive: zipName, archiveSha256: '0'.repeat(64),
    startedAt: '2020-01-01T00:00:00.000Z', completedAt: '2020-01-01T00:00:01.000Z',
    files: 1, chats: 1, messages: 1,
  }));
  maintenance.writeReceipt(dataDir, {
    stage: 'converted', archive: zipName, archiveId: 'fixture-id', archiveSha256: '0'.repeat(64),
    startedAt: '2020-01-01T00:00:00.000Z', completedAt: '2020-01-01T00:00:01.000Z',
    formatVersion: FORMAT_VERSION, targetVersion: FORMAT_VERSION, chats: 1, messages: 1, sources: [],
  });
  const manifestBefore = fs.readFileSync(manifestFile, 'utf8');
  const { code, json } = runAuto(dataDir);
  assert.equal(code, 1);
  assert.equal(json.status, 'backup_failed');
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), manifestBefore, '格式标记不能被改');
  assert.equal(fs.readFileSync(path.join(memoryDir, 'chats', fs.readdirSync(path.join(memoryDir, 'chats'))[0], 'messages.jsonl'), 'utf8').length > 0, true);
});

test('--auto-upgrade：清理失败写 cleanup_pending；下次只重试清理，不重导、不重置归档时间', (t) => {
  const { dataDir, memoryDir } = makeOld();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const source = path.join(dataDir, 'store.json');
  fs.writeFileSync(source, JSON.stringify({ sessions: {
    'wechat:u:old': { messages: [{ role: 'user', text: 'old synthetic', ts: 2 }] },
  } }));
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (path.resolve(file) === path.resolve(source)) throw Object.assign(new Error('fixture unlink failure'), { code: 'EPERM' });
    return realUnlink(file);
  };
  let first;
  try { first = runAuto(dataDir); }
  finally { fs.unlinkSync = realUnlink; }
  assert.equal(first.code, 1);
  assert.equal(first.json.status, 'cleanup_pending');
  assert.equal(readFormatVersion(memoryDir).version, FORMAT_VERSION, '转换已提交');
  assert.equal(fs.existsSync(source), true, '清理失败必须保留旧输入');
  const receipt = maintenance.readReceipt(dataDir);
  assert.equal(receipt.stage, 'cleanup_pending');
  const completedAt = receipt.completedAt;
  const names = backupNames(dataDir);
  const second = runAuto(dataDir);
  assert.equal(second.code, 0);
  assert.equal(second.json.status, 'done');
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(backupNames(dataDir), names, '重试清理不能新建归档');
  assert.equal(maintenance.readReceipt(dataDir).completedAt, completedAt, '不能重置归档过期计时');
});

test('retention：只按归档内部归属+receipt 完成时间清理，不碰目录/未识别文件/旧快照', (t) => {
  const { dataDir, memoryDir } = makeOld();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const backups = path.join(dataDir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const oldNow = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const newNow = Date.now() - 29 * 24 * 60 * 60 * 1000;
  const oldZip = path.join(backups, 'memory-pre-v3-20200101-000000Z.zip');
  const newZip = path.join(backups, 'memory-pre-v3-20200102-000000Z.zip');
  const oldCreated = archive.createArchive({ dataDir, memoryDir, sources: [], outPath: oldZip, now: oldNow });
  const newCreated = archive.createArchive({ dataDir, memoryDir, sources: [], outPath: newZip, now: newNow });
  for (const [file, completedAt] of [[oldZip, new Date(oldNow).toISOString()], [newZip, new Date(newNow).toISOString()]]) {
    const receiptFile = file + '.receipt.json';
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    receipt.completedAt = completedAt;
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  }
  assert.ok(oldCreated.receipt.archiveId && newCreated.receipt.archiveId);
  fs.writeFileSync(path.join(backups, 'memory-pre-v3-20200101-000000Z'), 'not a directory');
  fs.writeFileSync(path.join(backups, 'unrelated.json'), '{}');
  fs.mkdirSync(path.join(backups, 'memory-pre-v3-20190101-000000Z'));
  const result = maintenance.runRetention({ dataDir });
  assert.deepEqual(result.removed, ['memory-pre-v3-20200101-000000Z.zip']);
  assert.equal(fs.existsSync(oldZip), false);
  assert.equal(fs.existsSync(oldZip + '.receipt.json'), false);
  assert.equal(fs.existsSync(newZip), true, '未满 30 天保留');
  assert.equal(fs.existsSync(path.join(backups, 'unrelated.json')), true);
  assert.equal(fs.existsSync(path.join(backups, 'memory-pre-v3-20200101-000000Z')), true, '目录不碰');
  assert.equal(fs.existsSync(path.join(backups, 'memory-pre-v3-20190101-000000Z')), true, '旧目录不碰');
});

test('自动转换在导入/记录中途失败时不丢数据、保留格式标记，可复用同一归档重跑', async (t) => {
  const f = await fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const beforeMessages = archive.countMessages(f.memoryDir);
  const realTimeline = recordStore.appendTimeline;
  const realSubjects = recordStore.writeSubjects;
  let tripped = false;
  recordStore.appendTimeline = () => { tripped = true; throw new Error('fixture timeline failure'); };
  recordStore.writeSubjects = () => { tripped = true; throw new Error('fixture subjects failure'); };
  const outside = [];
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...rest) => {
    if (typeof file === 'string' || Buffer.isBuffer(file)) {
      const abs = path.resolve(String(file));
      const root = path.resolve(f.dataDir);
      if (abs !== root && !abs.startsWith(root + path.sep)) outside.push(abs);
    }
    return realWrite(file, ...rest);
  };
  let first;
  try { first = runAuto(f.dataDir); }
  finally { recordStore.appendTimeline = realTimeline; recordStore.writeSubjects = realSubjects; fs.writeFileSync = realWrite; }
  assert.equal(first.code, 1);
  assert.equal(first.json.status, 'failed');
  assert.equal(tripped, true, '必须真正走到记录投影阶段');
  assert.deepEqual(outside, [], '合成失败期间不能写 data 之外的路径');
  assert.notEqual(readFormatVersion(f.memoryDir).version, FORMAT_VERSION, '失败时不能写目标格式标记');
  const names = backupNames(f.dataDir);
  assert.equal(names.filter((name) => name.endsWith('.zip')).length, 1);
  const receiptAfterFail = maintenance.readReceipt(f.dataDir);
  assert.equal(receiptAfterFail.stage, 'archived');
  const second = runAuto(f.dataDir);
  assert.equal(second.code, 0);
  assert.equal(second.json.status, 'done');
  assert.equal(readFormatVersion(f.memoryDir).version, FORMAT_VERSION);
  assert.equal(archive.countMessages(f.memoryDir), beforeMessages, '重跑不能重复导入/丢消息');
  assert.deepEqual(backupNames(f.dataDir), names, '重跑必须复用同一归档');
  assert.equal(maintenance.readReceipt(f.dataDir).completedAt, receiptAfterFail.completedAt, '不能重置归档过期计时');
});

test('cleanup_pending 只剩 memory/legacy 仍进入 pending；只重试清理且不丢新改动', (t) => {
  const { dataDir, memoryDir } = makeOld({ legacy: true });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const legacyDir = path.join(memoryDir, 'legacy');
  const realRm = fs.rmSync;
  let failed = false;
  fs.rmSync = (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(legacyDir)) {
      failed = true;
      throw Object.assign(new Error('fixture rm failure'), { code: 'EPERM' });
    }
    return realRm(file, ...rest);
  };
  let first;
  try { first = runAuto(dataDir); }
  finally { fs.rmSync = realRm; }
  assert.equal(failed, true);
  assert.equal(first.code, 1);
  assert.equal(first.json.status, 'cleanup_pending');
  assert.equal(readFormatVersion(memoryDir).version, FORMAT_VERSION);
  assert.ok(fs.existsSync(path.join(legacyDir, 'old', 'note.txt')));
  const completedAt = maintenance.readReceipt(dataDir).completedAt;
  const names = backupNames(dataDir);
  const status = maintenance.readStatus(dataDir);
  assert.equal(status.status, 'pending', '只剩 legacy 也必须让启动器再跑自动清理');
  assert.equal(status.canAuto, true);
  assert.equal(status.runnerRequired, true);
  // 备份后有人改了 legacy 文件：清理必须保留它，不能静默删掉新改动。
  fs.writeFileSync(path.join(legacyDir, 'old', 'note.txt'), 'changed after backup');
  const changed = runAuto(dataDir);
  assert.equal(changed.code, 1);
  assert.equal(changed.json.status, 'cleanup_pending');
  assert.equal(fs.readFileSync(path.join(legacyDir, 'old', 'note.txt'), 'utf8'), 'changed after backup');
  // 用户处理掉新改动后，只重试清理即可完成，不重导、不重置归档时间。
  fs.unlinkSync(path.join(legacyDir, 'old', 'note.txt'));
  const done = runAuto(dataDir);
  assert.equal(done.code, 0);
  assert.equal(done.json.status, 'done');
  assert.equal(fs.existsSync(legacyDir), false);
  assert.deepEqual(backupNames(dataDir), names);
  assert.equal(maintenance.readReceipt(dataDir).completedAt, completedAt);
});

test('retention 保护进行中的升级归档，并在 data 锁忙时跳过', (t) => {
  const { dataDir, memoryDir } = makeOld();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const backups = path.join(dataDir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const oldNow = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const zip = path.join(backups, 'memory-pre-v3-20200101-000000Z.zip');
  const created = archive.createArchive({ dataDir, memoryDir, sources: [], outPath: zip, now: oldNow });
  const receiptFile = zip + '.receipt.json';
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  receipt.completedAt = new Date(oldNow).toISOString();
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  maintenance.writeReceipt(dataDir, {
    stage: 'cleanup_pending', archive: path.basename(zip), archiveId: created.receipt.archiveId,
    archiveSha256: created.receipt.archiveSha256, startedAt: created.receipt.startedAt,
    completedAt: receipt.completedAt, formatVersion: FORMAT_VERSION, targetVersion: FORMAT_VERSION, sources: [],
  });
  const protectedRun = maintenance.runRetention({ dataDir });
  assert.deepEqual(protectedRun.removed, []);
  assert.equal(fs.existsSync(zip), true, '进行中的升级备份不能被过期清理');
  const lock = dataLock.acquire({ dataDir, purpose: 'server' });
  try {
    const locked = maintenance.runRetention({ dataDir });
    assert.ok(locked.skippedLocked, 'data 锁忙时 retention 必须跳过');
    assert.equal(fs.existsSync(zip), true);
  } finally { lock.releaseSync(); }
  const doneReceipt = maintenance.readReceipt(dataDir);
  maintenance.writeReceipt(dataDir, { ...doneReceipt, stage: 'done' });
  const after = maintenance.runRetention({ dataDir });
  assert.deepEqual(after.removed, [path.basename(zip)]);
  assert.equal(fs.existsSync(zip), false);
});

test('安装载荷包含自动升级脚本闭包', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'installer', 'whale.iss'), 'utf8');
  for (const name of ['migrate-memory.js', 'migrate\\import-4.0.js', 'migrate\\archive.js', 'migrate\\upgrade-maintenance.js']) {
    assert.ok(installer.includes(name), '安装包必须包含 ' + name);
  }
  assert.match(installer, /SaveStringToFile\(ExpandConstant\('\{app\}\\\.whale-installed\.json'\)/);
  assert.ok(installer.includes('{"schemaVersion":1,"installer":"whale-girl"}'), '安装标记 schema 必须与 C# 约定一致');
});

test('retention 在拿到 data 锁之后才读 receipt，避免删掉并发提交的 pending 备份', (t) => {
  const { dataDir, memoryDir } = makeOld();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const backups = path.join(dataDir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const oldNow = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const oldIso = new Date(oldNow).toISOString();
  const oldZip = path.join(backups, 'memory-pre-v3-20200101-000000Z.zip');
  const oldCreated = archive.createArchive({ dataDir, memoryDir, sources: [], outPath: oldZip, now: oldNow });
  const oldReceiptFile = oldZip + '.receipt.json';
  const oldReceipt = JSON.parse(fs.readFileSync(oldReceiptFile, 'utf8'));
  oldReceipt.completedAt = oldIso;
  fs.writeFileSync(oldReceiptFile, JSON.stringify(oldReceipt));
  // 初始是旧 done 收据：protect 为空，旧归档本身应过期。
  maintenance.writeReceipt(dataDir, {
    stage: 'done', archive: path.basename(oldZip), archiveId: oldCreated.receipt.archiveId,
    archiveSha256: oldCreated.receipt.archiveSha256, startedAt: oldCreated.receipt.startedAt,
    completedAt: oldIso, formatVersion: FORMAT_VERSION, targetVersion: FORMAT_VERSION, sources: [],
  });
  const newZipName = 'memory-pre-v3-20200102-000000Z.zip';
  const newZip = path.join(backups, newZipName);
  const realAcquire = dataLock.acquire;
  let injected = false;
  dataLock.acquire = (options) => {
    const held = realAcquire(options);
    if (!injected) {
      injected = true;
      // 模拟“另一个进程在 retention 读 receipt 之后、拿到锁之前完成了新 pending 提交”。
      const created = archive.createArchive({ dataDir, memoryDir, sources: [], outPath: newZip, now: oldNow });
      const receiptFile = newZip + '.receipt.json';
      const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      receipt.completedAt = oldIso;
      fs.writeFileSync(receiptFile, JSON.stringify(receipt));
      maintenance.writeReceipt(dataDir, {
        stage: 'cleanup_pending', archive: newZipName, archiveId: created.receipt.archiveId,
        archiveSha256: created.receipt.archiveSha256, startedAt: created.receipt.startedAt,
        completedAt: oldIso, formatVersion: FORMAT_VERSION, targetVersion: FORMAT_VERSION, sources: [],
      });
    }
    return held;
  };
  let result;
  try { result = maintenance.runRetention({ dataDir }); }
  finally { dataLock.acquire = realAcquire; }
  assert.ok(result.removed.includes(path.basename(oldZip)), '旧 done 归档应过期');
  assert.equal(fs.existsSync(newZip), true, '并发提交的 pending 归档必须被保护');
  assert.equal(fs.existsSync(newZip + '.receipt.json'), true);
});

test('格式已写但完成收据未写时，重跑复用归档、不重复导入/不重置过期计时', async (t) => {
  const f = await fixture();
  t.after(() => fs.rmSync(f.dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const beforeMessages = archive.countMessages(f.memoryDir);
  const realWriteReceipt = maintenance.writeReceipt;
  let tripped = false;
  maintenance.writeReceipt = (dataDir, value) => {
    if (value && value.stage === 'converted') {
      tripped = true;
      throw new Error('fixture receipt failure after format write');
    }
    return realWriteReceipt(dataDir, value);
  };
  let first;
  try { first = runAuto(f.dataDir); }
  finally { maintenance.writeReceipt = realWriteReceipt; }
  assert.equal(tripped, true);
  assert.equal(first.code, 1);
  assert.equal(readFormatVersion(f.memoryDir).version, FORMAT_VERSION, '格式标记已写入');
  const receipt = maintenance.readReceipt(f.dataDir);
  assert.equal(receipt.stage, 'archived');
  const names = backupNames(f.dataDir);
  const completedAt = receipt.completedAt;
  const second = runAuto(f.dataDir);
  assert.equal(second.code, 0);
  assert.equal(second.json.status, 'done');
  assert.equal(archive.countMessages(f.memoryDir), beforeMessages, '重跑不能重复导入');
  assert.deepEqual(backupNames(f.dataDir), names, '复用同一归档');
  assert.equal(maintenance.readReceipt(f.dataDir).completedAt, completedAt, '不能重置归档过期计时');
});
