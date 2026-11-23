'use strict';

/**
 * 共享记忆池：唯一一处「跨会话可读」的物理存储。
 *
 * 为什么是独立文件而不是全局索引加过滤：
 *   - 全局索引里躺着私聊内容，任何一条调试/导出/备份路径都会把它带出去；
 *   - 独立文件让「泄漏」退化成「文件不存在」，而不是「漏了一个 if」。
 *
 * 只收已经晋升过的事实（scope 为 shared:<uid>），不收原文、不收摘要、不收事件全文。
 * 目录：data/memory/shared/<personHash>.json
 */

const fs = require('node:fs');
const path = require('node:path');
const record = require('./record');
const scope = require('./scope');
const { personHash } = require('./hash');

const SHARED_DIR = 'shared';

function sharedPath(memoryDir, uid) {
  const safe = String(uid || '').trim();
  if (!safe) throw new TypeError('shared uid 不能为空');
  return path.join(memoryDir, SHARED_DIR, `${personHash(safe)}.json`);
}

function read(memoryDir, uid) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(sharedPath(memoryDir, uid), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.records) ? raw.records : []);
  return list.map((item) => record.normalizeRecord(item)).filter(Boolean);
}

function write(memoryDir, uid, records) {
  const list = (Array.isArray(records) ? records : []).map((item) => record.normalizeRecord(item)).filter(Boolean);
  const file = sharedPath(memoryDir, uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, uid: String(uid), records: list }, null, 2));
  fs.renameSync(tmp, file);
  return list.length;
}

/**
 * 晋升一条事实到共享池。
 *
 * 三道闸：canPromote 策略 → 脱敏改写 → 幂等合并（同 id 覆盖，不重复堆）。
 * 已存在同一个 id 时返回 replaced:true，调用方可以据此判断是不是重复操作。
 *
 * @param {string} memoryDir
 * @param {object} source 源记录（来自 chat 卡）
 * @param {{approvedBy?:string, audience?:string, now?:number}} [opts]
 * @returns {{ok:boolean, reason?:string, record?:object, replaced?:boolean}}
 */
function promote(memoryDir, source, { approvedBy = 'explicit', audience = 'all', now = Date.now() } = {}) {
  const verdict = scope.canPromote(source);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const uid = String(source.subject || '').trim();
  if (!uid) return { ok: false, reason: 'no_subject' };
  const text = scope.redact(source.text);
  const item = record.makeRecord({
    // 保留源 id：重复晋升只更新，不会长出一堆同义记录
    id: source.id,
    kind: source.kind === 'preference' ? 'fact' : source.kind,
    text,
    ts: Number(source.ts) || now,
    tier: 'L',
    // scope 用 shared:<uid>：跨会话可读，但 subject 必须存在
    scope: `shared:${uid}`,
    subject: uid,
    source: source.source,
    confidence: source.confidence,
    importance: source.importance,
    audience,
    state: 'active',
    meta: {
      ...(source.meta || {}),
      promotedFrom: {
        chatId: String((source.source && source.source.chatId) || ''),
        recordId: source.id,
      },
      approvedBy,
      promotedAt: now,
    },
  });
  if (!item) return { ok: false, reason: 'invalid_record' };
  const list = read(memoryDir, uid);
  const idx = list.findIndex((x) => x.id === item.id);
  const replaced = idx >= 0;
  if (replaced) list[idx] = item; else list.push(item);
  // 单人的公开事实也要有上限：共享池不是「什么都往里倒」的地方
  const capped = record.capRecords(list, { cap: 30, tier: 'L', now }).records;
  write(memoryDir, uid, capped);
  return { ok: true, record: item, replaced };
}

/** 撤销：删掉副本即可，源记录不动 */
function revoke(memoryDir, uid, id) {
  const list = read(memoryDir, uid);
  const next = list.filter((x) => x.id !== String(id));
  if (next.length === list.length) return { ok: false, reason: 'not_found' };
  write(memoryDir, uid, next);
  return { ok: true, removed: list.length - next.length };
}

/**
 * 取若干人的公开事实（已按 audience 过滤）。
 * @param {string} memoryDir
 * @param {Iterable<string>} uids
 * @param {object} audience record.visibleTo 的 audience
 */
function forSubjects(memoryDir, uids, audience) {
  const out = [];
  const seen = new Set();
  for (const uid of uids || []) {
    const key = String(uid || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    for (const item of read(memoryDir, key)) {
      if (record.visibleTo(item, audience)) out.push(item);
    }
  }
  return out;
}

module.exports = {
  SHARED_DIR,
  sharedPath,
  read,
  write,
  promote,
  revoke,
  forSubjects,
};
