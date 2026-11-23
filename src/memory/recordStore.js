'use strict';

/**
 * 记录的文件层：中期时间线（timeline.jsonl）+ 长期主体档案（subjects/<uid>.json）。
 *
 * 为什么分成两个文件：
 *   - timeline 是**只追加**的事件流（摘要 / 事件 / 关系），按 chat 隔离，读的时候
 *     从后往前取最近若干段；
 *   - subjects 是**按人归并**的长期事实，跨会话可用，必须整份重写（要排序、要压容量）。
 * 强塞进一个文件会逼出「读全量再过滤」，一个群几千段就把启动拖死。
 *
 * 这一层只做 I/O 和校验，不决定任何业务规则（提升/降级在 record.js）。
 */

const fs = require('node:fs');
const path = require('node:path');
const record = require('./record');

const TIMELINE_FILE = 'timeline.jsonl';
const SUBJECT_DIR = 'subjects';

function timelinePath(chatDir) {
  return path.join(chatDir, TIMELINE_FILE);
}

function subjectPath(memoryDir, uid) {
  const safe = String(uid || '').trim();
  if (!safe) throw new TypeError('subject uid 不能为空');
  const { personHash } = require('./hash');
  return path.join(memoryDir, SUBJECT_DIR, `${personHash(safe)}.json`);
}

/** 读时间线；坏行跳过（崩溃时最后一行可能只写了一半），不因为一条脏数据丢掉整段历史 */
function readTimeline(chatDir) {
  let text = '';
  try {
    text = fs.readFileSync(timelinePath(chatDir), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = record.normalizeRecord(JSON.parse(trimmed));
      if (item) out.push(item);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 追加记录。返回真正写下去的条数。
 * 每条必须是合法 Record（normalize 后仍存在），空文本直接跳过。
 */
function appendTimeline(chatDir, records) {
  const incoming = (Array.isArray(records) ? records : [records])
    .map((item) => record.normalizeRecord(item))
    .filter(Boolean);
  // 同 id 已存在就跳过：崩溃后重试同一个 episode 不能把同一条事件写两遍
  const existing = new Set(readTimeline(chatDir).map((item) => item.id));
  const list = incoming.filter((item) => !existing.has(item.id));
  if (!list.length) return 0;
  fs.mkdirSync(chatDir, { recursive: true });
  const body = list.map((item) => JSON.stringify(item)).join('\n') + '\n';
  const fd = fs.openSync(timelinePath(chatDir), 'a');
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return list.length;
}

function readSubjects(memoryDir, uid) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(subjectPath(memoryDir, uid), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.records) ? raw.records : []);
  return list.map((item) => record.normalizeRecord(item)).filter(Boolean);
}

/** 原子写：先写 .tmp 再 rename，进程被 kill 也不会留下半份档案 */
function writeSubjects(memoryDir, uid, records) {
  const list = (Array.isArray(records) ? records : [])
    .map((item) => record.normalizeRecord(item))
    .filter(Boolean);
  const file = subjectPath(memoryDir, uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, uid: String(uid), records: list }, null, 2));
  fs.renameSync(tmp, file);
  return list.length;
}

/** 整份重写 timeline（清理 / 合并时用；正常写入仍然只追加） */
function writeTimeline(chatDir, records) {
  const list = (Array.isArray(records) ? records : []).map((item) => record.normalizeRecord(item)).filter(Boolean);
  fs.mkdirSync(chatDir, { recursive: true });
  const file = timelinePath(chatDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, list.map((item) => JSON.stringify(item)).join('\n') + (list.length ? '\n' : ''));
  fs.renameSync(tmp, file);
  return list.length;
}


module.exports = {
  TIMELINE_FILE,
  SUBJECT_DIR,
  timelinePath,
  subjectPath,
  readTimeline,
  appendTimeline,
  writeTimeline,
  readSubjects,
  writeSubjects,
};




