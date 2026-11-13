'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PREFIX = '.memory-restore-';
const KIND = 'whale-memory-restore';
const TARGETS = new Set(['memory', 'store.json', 'persona.json', 'settings.json', 'care-state.json', 'share-state.json']);
function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function writeVerified(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (!fs.readFileSync(file).equals(Buffer.from(body))) throw new Error('恢复准备文件校验失败，已取消恢复');
}

function verifyCopy(source, target) {
  const from = fs.lstatSync(source);
  const to = fs.lstatSync(target);
  if (from.isDirectory() && to.isDirectory()) {
    for (const name of fs.readdirSync(source)) verifyCopy(path.join(source, name), path.join(target, name));
  } else if (from.isSymbolicLink() && to.isSymbolicLink()) {
    if (fs.readlinkSync(source) !== fs.readlinkSync(target)) throw new Error('恢复保留链接校验失败，已取消恢复');
  } else if (!(from.isFile() && to.isFile() && fs.readFileSync(source).equals(fs.readFileSync(target)))) {
    throw new Error('恢复保留数据校验失败，已取消恢复');
  }
}

function removeTransaction(transaction) {
  fs.rmSync(transaction, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
}

function rollback(dir, transaction, plan) {
  for (const { name, existed } of [...plan.entries].reverse()) {
    const live = path.join(dir, name);
    const previous = path.join(transaction, 'previous', name);
    const prepared = path.join(transaction, 'prepared', name);
    if (exists(previous)) {
      if (exists(live)) {
        if (exists(prepared)) throw new Error('恢复事务状态冲突，已保留全部副本，请勿手动删除');
        fs.renameSync(live, prepared);
      }
      fs.renameSync(previous, live);
    } else if (!existed && !exists(prepared) && exists(live)) {
      fs.renameSync(live, prepared);
    } else if (existed && !exists(live)) {
      throw new Error('恢复原目录暂不可用，已保留事务副本，请重试恢复');
    }
  }
}

function readPlan(transaction) {
  let plan;
  try { plan = JSON.parse(fs.readFileSync(path.join(transaction, 'plan.json'), 'utf8')); } catch { return null; }
  if (plan?.kind !== KIND || plan.version !== 1 || !Array.isArray(plan.entries) || !plan.entries.length) return null;
  const names = new Set();
  for (const entry of plan.entries) {
    if (!entry || !TARGETS.has(entry.name) || typeof entry.existed !== 'boolean' || names.has(entry.name)) return null;
    names.add(entry.name);
  }
  return plan;
}

/** 提交标记之前一律回滚；提交之后只清理旧副本，不重放恢复。 */
function recoverRestore(dir) {
  if (!exists(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.memory-restore-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
    const transaction = path.join(dir, entry.name);
    const plan = readPlan(transaction);
    const ready = exists(path.join(transaction, 'ready'));
    const committed = exists(path.join(transaction, 'committed'));
    if (!plan) {
      // 初始描述写入前中断不可能改过活跃文件；未知目录仍不擅自删除。
      if (ready || committed) throw new Error('恢复事务描述损坏，已保留数据，请勿删除事务目录');
      continue;
    }
    if (ready && !committed) rollback(dir, transaction, plan);
    // 清理失败必须留在磁盘；下次恢复先重试，不能复用或覆盖旧事务。
    removeTransaction(transaction);
  }
}

/** 整棵记忆和附属文件先准备验证，再按固定清单交换；不改变原磁盘布局。 */
function restoreFiles(dir, memory, files) {
  const names = [...(memory ? ['memory'] : []), ...Object.keys(files)];
  if (names.some(name => !TARGETS.has(name)) || new Set(names).size !== names.length) throw new Error('非法恢复目标');
  const transaction = fs.mkdtempSync(path.join(dir, PREFIX));
  const plan = { kind: KIND, version: 1, entries: names.map(name => ({ name, existed: exists(path.join(dir, name)) })) };
  const ready = path.join(transaction, 'ready');
  const committed = path.join(transaction, 'committed');
  try {
    writeVerified(path.join(transaction, 'plan.json'), JSON.stringify(plan));
    const preparedMemory = path.join(transaction, 'prepared', 'memory');
    if (memory) {
      fs.mkdirSync(preparedMemory, { recursive: true });
      for (const [rel, body] of Object.entries(memory)) writeVerified(path.join(preparedMemory, rel), body);
      // 保留数据最后覆盖，与既有 bundle 恢复顺序一致；复制或读取失败绝不能忽略后继续发布。
      for (const name of ['legacy', 'archive']) {
        const source = path.join(dir, 'memory', name);
        if (!exists(source)) continue;
        const target = path.join(preparedMemory, name);
        fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
        verifyCopy(source, target);
      }
    }
    for (const [name, body] of Object.entries(files)) writeVerified(path.join(transaction, 'prepared', name), body);
    fs.mkdirSync(path.join(transaction, 'previous'));
    writeVerified(ready, 'prepared\n');
    for (const { name, existed } of plan.entries) {
      if (existed) fs.renameSync(path.join(dir, name), path.join(transaction, 'previous', name));
      fs.renameSync(path.join(transaction, 'prepared', name), path.join(dir, name));
    }
    // 原子重命名是唯一提交点，避免写一半的状态文件把失败误报为成功。
    fs.renameSync(ready, committed);
  } catch (error) {
    if (!exists(committed)) {
      try {
        if (exists(ready)) rollback(dir, transaction, plan);
        removeTransaction(transaction);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], '恢复失败且回滚尚未完成，全部副本已保留，请重试恢复');
      }
      throw error;
    }
  }
  // 发布完成后清理失败不撤销成功；事务仍在，下次入口会先清理再允许新恢复。
  try { removeTransaction(transaction); } catch { /* 已提交的原副本留待重试清理 */ }
}

module.exports = { recoverRestore, restoreFiles };
