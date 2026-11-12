'use strict';

/**
 * 日志脱敏工具。
 *
 * 为什么单独一层：日志会被打包发给别人，正文、昵称、wxid、群号、手机号都不该原样落盘。
 * 调用点用 tagId/tagName/textMeta 只记「结构证据」，logger 再用 scrubSensitive 兜底，
 * 防止以后新加的日志又把敏感串写回去。
 */
const crypto = require('node:crypto');

function shortHash(value, len = 8) {
  // 摘要的是 id/昵称等敏感值，短哈希只用于对 trace，但算法仍要用 SHA-256。
  return crypto.createHash('sha256')
    .update(String(value == null ? '' : value))
    .digest('hex')
    .slice(0, len);
}

/** 会话/账号 id 只留短哈希，仍能和 trace 对上 */
function tagId(value) {
  const text = String(value == null ? '' : value);
  return text ? '#' + shortHash(text) : '-';
}

/** 昵称、群名同理；附带字数，排查时还能判断是不是空名字 */
function tagName(value) {
  const text = String(value == null ? '' : value);
  return text ? `#${shortHash(text)}(${Array.from(text).length}字)` : '-';
}

/** 正文只留长度 */
function textMeta(value) {
  return 'len=' + Array.from(String(value == null ? '' : value)).length;
}

/** 链接只留主机名，查询串和路径可能带 token/邀请码 */
function urlHost(value) {
  try {
    return new URL(String(value)).host || '-';
  } catch {
    return '-';
  }
}

const SCRUB_RULES = [
  [/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/g, '$1***'],
  [/\b(?:sk|oc_sk|ak|ghp|xox[baprs]|brz)[-_][A-Za-z0-9_-]{8,}/g, '***'],
  [/([?&](?:token|key|secret|signature|password|api_key)=)[^&\s]+/gi, '$1***'],
  [/\bwxid_[A-Za-z0-9_-]+/g, 'wxid_***'],
  [/\b\d{9,}@chatroom\b/g, '***@chatroom'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '1**********'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***'],
  [/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, '$1***'],
];

/** 最后一道闸：日志行里出现已知敏感格式时直接打码 */
function scrubSensitive(text) {
  let out = String(text == null ? '' : text);
  for (const [re, replacement] of SCRUB_RULES) out = out.replace(re, replacement);
  return out;
}

module.exports = { shortHash, tagId, tagName, textMeta, urlHost, scrubSensitive };
