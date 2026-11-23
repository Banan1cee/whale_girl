'use strict';

/**
 * 记忆目录的格式闸（formatVersion.js）。
 *
 * 规矩：运行时只认当前格式，旧版本直接拒绝启动，不做隐式升级。
 * 测试重点：
 *   1. 全新空库能直接初始化，不能被误拦；
 *   2. 旧格式（没有 formatVersion 但有数据）必须拦下来，且错误里带脚本名；
 *   3. 闸门必须在 ChatStore 之前跑 —— 否则 manifest 被重写，标记就丢了；
 *   4. 开关关闭时行为与改造前一致（旧格式照常读）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gate = require('../src/memory/formatVersion');
const { Store } = require('../src/memory/store');
const { FORMAT_VERSION } = require('../src/memory/formatVersion');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whale-fmt-'));
}

function writeManifest(dir, obj) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(obj, null, 2));
}

test('全新空目录：放行，reason=new', () => {
  const dir = tmpDir();
  const result = gate.check({ dir });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'new');
  assert.equal(result.version, 0);
  assert.equal(FORMAT_VERSION, 3);
});

test('当前格式：放行，reason=current', () => {
  const dir = tmpDir();
  writeManifest(dir, { version: 2, formatVersion: FORMAT_VERSION });
  const result = gate.check({ dir });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'current');
  assert.equal(result.version, FORMAT_VERSION);
});

test('旧格式（有数据但没有 formatVersion）：拒绝，并给出迁移命令', () => {
  const dir = tmpDir();
  writeManifest(dir, { version: 2, createdAt: 1 });
  fs.mkdirSync(path.join(dir, 'chats', 'abc'), { recursive: true });
  const result = gate.check({ dir });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outdated');
  assert.equal(result.error.code, 'MEMORY_FORMAT_VERSION');
  assert.match(result.error.message, /scripts[\\/]migrate-memory\.js/);
});

test('manifest 坏掉但有数据：也拒绝（不能当空库）', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{不是 JSON');
  const result = gate.check({ dir });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MEMORY_FORMAT_VERSION');
});

test('开关关闭：旧格式照常启动（改造前行为不变）', () => {
  const dir = tmpDir();
  writeManifest(dir, { version: 2 });
  const store = new Store({ file: path.join(dir, 'store.json'), dir, logger: null });
  assert.ok(store.chatStore);
  store.close();
});

test('开关打开：旧格式抛错，且不留下被改写过的 manifest', () => {
  const dir = tmpDir();
  writeManifest(dir, { version: 2, createdAt: 123 });
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  assert.throws(
    () => new Store({ file: path.join(dir, 'store.json'), dir, logger: null, formatVersionEnforced: true }),
    (err) => err.code === 'MEMORY_FORMAT_VERSION'
  );
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before, '闸门失败不能改写磁盘');
});

test('开关打开 + 已是 v3：能启动，且 manifest 里的 formatVersion 不会被 ChatStore 抹掉', () => {
  const dir = tmpDir();
  writeManifest(dir, { version: 2, formatVersion: FORMAT_VERSION, createdAt: 1 });
  const store = new Store({ file: path.join(dir, 'store.json'), dir, logger: null, formatVersionEnforced: true });
  store.close();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(Number(manifest.formatVersion), FORMAT_VERSION);
});
