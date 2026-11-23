'use strict';

/**
 * 功能能力模块的共享小工具。
 *
 * 这些能力既是插件 SDK（host.call），也是宿主内部（路由、Bot、桥接）唯一的
 * 功能调用入口；因此字段清洗必须放在这一层，不能依赖调用方守规矩。
 */

const error = code => Object.assign(new Error(code), { code });

/** 截断而不是抛错：插件/桥接传来的超长文本不应让整个能力失败。 */
const text = (value, max) => String(value ?? '').slice(0, max);

const list = (value, max) => (Array.isArray(value) ? value : []).slice(0, max);

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

function sessionKey(config, chatId, chatType) {
  return `${chatType === 'group' ? 'g' : 'u'}:${chatId}`;
}

function messageProjection(row) {
  return { role: row.role === 'assistant' ? 'assistant' : 'user', text: text(row.text, 16000), ts: Number(row.ts) || 0 };
}

module.exports = { error, text, list, oneOf, sessionKey, messageProjection };
