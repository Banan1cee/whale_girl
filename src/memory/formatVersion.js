'use strict';

/**
 * 数据目录布局版本闸门。
 *
 * 规矩只有一条：运行时只认当前格式，不认识的版本直接拒绝启动，不做隐式升级。
 * 隐式升级（构造时顺手 migrate）看起来友好，实际是「旧格式永远活着」——
 * src/memory/migrate.js 那 24KB 就是这么留下来的。
 *
 * 迁移是一次性的离线脚本（scripts/migrate-memory.js），不被 src 里任何文件 require。
 * 判断标准：删掉它，npm test 还能全绿。
 */

const fs = require('node:fs');
const path = require('node:path');
const { LIMITS } = require('./constants');

const FORMAT_VERSION = Number(LIMITS.formatVersion) || 3;
const MANIFEST = 'manifest.json';

function manifestPath(dir) {
  return path.join(dir, MANIFEST);
}

/**
 * 读 manifest.formatVersion；文件不存在/坏掉/没有这个字段都算 0（旧格式或全新库）。
 *
 * 注意不能读 manifest.version：那个是 ChatStore 的目录布局版本（固定 2），
 * 两个版本号混用会让闸门永远判错。
 */
function readFormatVersion(dir) {
  try {
    const obj = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
    const version = Number(obj && obj.formatVersion);
    return { version: Number.isFinite(version) ? version : 0, manifest: obj || null };
  } catch {
    return { version: 0, manifest: null };
  }
}

/** 目录里除了 legacy 副本之外还有没有东西（决定「空库直接初始化」还是「拒绝启动」） */
function hasData(dir) {
  try {
    return fs.readdirSync(dir).some((name) => name !== 'legacy');
  } catch {
    return false;
  }
}

/**
 * 启动检查。
 * @param {{dir:string, expected?:number}} opts
 * @returns {{ok:boolean, version:number, expected:number, reason:string, error?:Error}}
 */
function check({ dir, expected = FORMAT_VERSION } = {}) {
  const { version } = readFormatVersion(dir);
  const target = Number(expected) || FORMAT_VERSION;
  if (version === target) {
    return { ok: true, version, expected: target, reason: 'current' };
  }
  if (!version && !hasData(dir)) {
    // 全新安装：让 chatStore 自己初始化成当前版本
    return { ok: true, version: 0, expected: target, reason: 'new' };
  }
  const error = new Error(
    `记忆目录格式是 v${version || '未知'}，当前版本需要 v${target}。` +
    `请先运行：node scripts/migrate-memory.js --apply（先 --dry-run 看报告）`
  );
  error.code = 'MEMORY_FORMAT_VERSION';
  error.version = version;
  error.expected = target;
  return { ok: false, version, expected: target, reason: 'outdated', error };
}

module.exports = {
  FORMAT_VERSION,
  readFormatVersion,
  hasData,
  check,
};

