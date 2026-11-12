'use strict';

/**
 * 群聊历史行的生成/解析工具。
 *
 * 历史行格式是 `[间隔约 N 分钟]\n[MM-DD HH:mm] {json}`。以前压缩摘要用
 * 两个 replace 依次剥前缀，但第一个 `\s*` 会把换行吃掉，第二个永远不匹配，
 * 带间隔的旧消息全部解析失败。这里统一成一个可测试的解析入口。
 */

const GAP_RE = /^\[间隔[^\]]*\]\s*/;
const STAMP_RE = /^\[[^\]]*\]\s*/;

function stripHistoryPrefixes(line) {
  let text = String(line || '');
  text = text.replace(GAP_RE, '');
  text = text.replace(STAMP_RE, '');
  return text;
}

function parseHistoryLine(line) {
  try {
    return JSON.parse(stripHistoryPrefixes(line));
  } catch {
    return null;
  }
}

module.exports = { stripHistoryPrefixes, parseHistoryLine };
