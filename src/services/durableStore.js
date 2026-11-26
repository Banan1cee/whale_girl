'use strict';

/**
 * 持久任务存储：把「已经接下、但还没跑完」的可调度任务落到磁盘，重启后还能看见。
 *
 * 为什么是 JSONL 而不是一个大 JSON：
 *   - 追加一条就是追加一行，不用把整份数组读出来再写回去，进程崩在中途最多坏最后一行；
 *   - 单行损坏可以跳过，不会因为一条坏记录把整份任务表读空（大 JSON 会直接解析失败）。
 *
 * 为什么每次写都做「临时文件 + rename」：
 *   - 截断重写（remove/clear）时如果直接覆盖，写到一半断电就是半截 JSONL，
 *     下一次 load 会把仍然有效的任务全丢掉。rename 在同一分区上是原子的，
 *     要么是旧文件、要么是写完的新文件，不存在中间态。
 *
 * 只存「任务是什么」，不存「任务跑出什么」：结果可能含聊天正文、记忆正文、
 * 插件返回值，落在磁盘上会绕过隐私边界。要回放结果请走各自能力的状态查询。
 */

const fs = require('node:fs');
const path = require('node:path');
const { describeError } = require('../infra/errors');

// 上限按「条」算而不是按字节：任务是有限个待办，不是日志，不需要按体积滚动。
const MAX_ENTRIES = 500;

// 单条字段上限：和注册表里能力输入的长度量级对齐，避免一条畸形记录吃掉整个文件。
const FIELD_LIMITS = { name: 120, key: 200 };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const clip = (value, max) => String(value == null ? '' : value).slice(0, max);

/**
 * 把任意输入收敛成存储形态：只留 name / input / key / at 四个字段。
 * key 缺失或重复时上层用它做 remove 的句柄，所以这里不做去重，只做类型清洗。
 */
function normalizeEntry(entry, now) {
  if (!isObject(entry)) return null;
  const name = clip(entry.name, FIELD_LIMITS.name).trim();
  if (!name) return null;
  const key = clip(entry.key, FIELD_LIMITS.key).trim();
  const at = Number(entry.at);
  const input = isObject(entry.input) ? entry.input : {};
  return { name, input, key, at: Number.isFinite(at) && at > 0 ? at : now() };
}

/**
 * 解析一行 JSONL。坏行返回 null 交给调用方跳过；这里不抛，因为一行坏不该毁掉整份任务表。
 */
function parseLine(line, now) {
  const text = String(line || '').trim();
  if (!text) return null;
  try {
    return normalizeEntry(JSON.parse(text), now);
  } catch {
    return null;
  }
}

function createDurableStore({ file, logger, now = Date.now } = {}) {
  const target = typeof file === 'string' ? file.trim() : '';
  // 没有路径就是「这台机器上不落盘」：所有写操作都不报错地变成 no-op，
  // 避免裁剪装配（测试夹具、只读部署）因为缺目录在启动路径上炸掉。
  const enabled = Boolean(target);
  const clock = typeof now === 'function' ? now : Date.now;

  const warn = message => {
    try { logger?.warn?.(message); } catch { /* 日志坏了不能影响存储可用性 */ }
  };

  /**
   * 读全部条目。文件缺失 = 全新安装，空数组；文件损坏 = 逐行跳过坏行。
   * 两种都不抛：启动路径上的持久化读取失败不该让内核起不来。
   */
  function load() {
    if (!enabled) return [];
    let raw;
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch (err) {
      // ENOENT 是正常状态（第一次运行），不值得告警；其余读失败要留证据。
      if (err && err.code !== 'ENOENT') {
        warn('持久任务存储读取失败，按空任务表继续：' + describeError(err));
      }
      return [];
    }
    // BOM 会让第一行 JSON.parse 直接失败，Windows 记事本另存过就会遇到。
    const lines = String(raw).replace(/^\uFEFF/, '').split(/\r?\n/);
    const out = [];
    let broken = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseLine(line, clock);
      if (entry) out.push(entry);
      else broken += 1;
      // 上限对齐 MAX_ENTRIES：文件被人手工写大时也只交出前 500 条，避免后面 append 的
      // size() 判断失真（读出来就超限，append 会立刻拒绝）。
      if (out.length >= MAX_ENTRIES) break;
    }
    if (broken) {
      warn(`持久任务存储有 ${broken} 行无法解析，已跳过（文件=${path.basename(target)}）`);
    }
    return out;
  }

  /**
   * 原子写整份列表：临时文件 + rename。
   * 临时文件带 pid，避免两个进程同时写时互相截断对方没写完的临时文件。
   */
  function writeAll(entries) {
    if (!enabled) return false;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const body = entries.map(item => JSON.stringify(item)).join('\n');
      // 空列表写成空文件，而不是留下一个空行——空行虽能被跳过，但读起来像坏数据。
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body ? body + '\n' : '', 'utf8');
      fs.renameSync(tmp, target);
      return true;
    } catch (err) {
      warn('持久任务存储写入失败：' + describeError(err));
      return false;
    }
  }

  /**
   * 追加一条任务。返回 {ok:true,size} 或 {ok:false,code}。
   * 用 read-modify-write 而不是纯 appendFile：需要先判断是否已到上限，
   * 而条数只能从文件里读出来（进程内缓存会在多进程下失真）。
   */
  function append(entry) {
    const normalized = normalizeEntry(entry, clock);
    if (!normalized) return { ok: false, code: 'durable_invalid' };
    if (!enabled) return { ok: false, code: 'durable_no_file' };
    const entries = load();
    if (entries.length >= MAX_ENTRIES) return { ok: false, code: 'durable_full' };
    entries.push(normalized);
    if (!writeAll(entries)) return { ok: false, code: 'durable_write_failed' };
    return { ok: true, size: entries.length };
  }

  /** 按 key 删除；key 为空或没命中都返回 {ok:false,code:'durable_missing'}，调用方据此区分。 */
  function remove(key) {
    const wanted = clip(key, FIELD_LIMITS.key).trim();
    if (!wanted) return { ok: false, code: 'durable_missing' };
    if (!enabled) return { ok: false, code: 'durable_no_file' };
    const entries = load();
    const kept = entries.filter(item => item.key !== wanted);
    if (kept.length === entries.length) return { ok: false, code: 'durable_missing' };
    if (!writeAll(kept)) return { ok: false, code: 'durable_write_failed' };
    return { ok: true, size: kept.length };
  }

  /** 清空整份任务表。已经没有文件时也返回 ok（幂等），别让调用方为「本来就没有」报错。 */
  function clear() {
    if (!enabled) return { ok: false, code: 'durable_no_file' };
    if (!writeAll([])) return { ok: false, code: 'durable_write_failed' };
    return { ok: true, size: 0 };
  }

  function size() {
    if (!enabled) return 0;
    // 读失败时 load() 已经返回空数组，这里不会把「读不出来」误报成有任务。
    return load().length;
  }

  return { load, append, remove, clear, size, file: target, max: MAX_ENTRIES };
}

module.exports = { createDurableStore, MAX_ENTRIES };
