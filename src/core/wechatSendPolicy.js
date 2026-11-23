'use strict';

const { nameMatches } = require('./text');

/**
 * 发言范围（这个会话现在能不能发）的唯一业务规则。
 *
 * 这里只回答发送许可，是纯函数：不读 HTTP、不校验桥接 token、不看插件授权、
 * 不判管理员魔咒或主人身份。需要这些身份的入口（桥接许可路由、网关 webhook、
 * 插件 message.send、管理员命令）先在自己的层里过身份检查，再拿同一个目标来问这里；
 * 规则本身不复制到入口里，入口之间也不会各算一套「会话 ID / 群名 / 平台」。
 */

/** 配置里生效的白名单。选择器存 wxid；旧版文字配置仍按分隔符拆开。 */
function configuredWhitelist(config = {}) {
  const raw = config.care?.whitelist;
  const list = Array.isArray(raw) ? raw : (raw ? String(raw).split(/[\n,;，；\s]+/) : []);
  return [...new Set(list.map((value) => String(value || '').trim()).filter(Boolean))];
}

/**
 * 把「标准化消息」或「显式目标」折成判定事实。
 *
 * - 会话 ID：chatId 优先，兼容旧调用传 id
 * - 群：显式 isGroup 或 chatType=group；ID 形态（@chatroom 结尾）由入口自己确认后传进来，
 *   这里不猜，避免非微信平台被 ID 后缀改写语义
 * - 名称：chatTitle/title/name/names 合并去重，只用于兼容旧版按群名禁言
 * - 平台：未传时按 wechat（历史默认值）
 */
function sendFacts(target = {}) {
  const source = target && typeof target === 'object' ? target : {};
  const id = String(source.chatId ?? source.id ?? '').trim();
  const isGroup = source.isGroup === true || String(source.chatType || '').toLowerCase() === 'group';
  const names = [
    source.chatTitle ?? source.title,
    ...(Array.isArray(source.names) ? source.names : [source.names, source.name]),
  ].map((value) => String(value ?? '').trim()).filter(Boolean);
  return {
    id,
    names: [...new Set(names)],
    isGroup,
    platform: source.platform === undefined ? 'wechat' : String(source.platform),
  };
}

/**
 * null 表示可发，否则返回拒绝原因。
 * 选择器存会话 ID，群名只用来兼容旧版文字禁言。
 *
 * @param {object} config 当前配置
 * @param {object} target 标准化消息（chatId/chatType/chatTitle/platform）或显式事实（id/names/isGroup/platform）
 */
function sendDenial(config = {}, target = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const { id, names, isGroup, platform } = sendFacts(target);
  const key = id.toLowerCase();
  const wechat = platform === 'wechat';
  const blocked = cfg.group?.mutedGroups;
  if ((wechat || isGroup) && Array.isArray(blocked) && blocked.some((value) => {
    const entry = String(value || '').trim().toLowerCase();
    return entry === '*' || (key && key === entry) || (isGroup && names.some((name) => nameMatches(name, entry)));
  })) return isGroup ? 'muted_group' : 'muted_chat';
  if (wechat && (!key || key === 'unknown') && (blocked?.length || cfg.wechat?.whitelistOnly === true)) {
    return 'unresolved_chat';
  }
  if (wechat && cfg.wechat?.whitelistOnly === true &&
      !configuredWhitelist(cfg).some((entry) => entry.toLowerCase() === key)) return 'not_whitelisted';
  return null;
}

/** 入口只关心「能不能发」时用这个；和 sendDenial 同源，避免两套返回形状。 */
function sendAllowed(config = {}, target = {}) {
  const reason = sendDenial(config, target);
  return { allowed: !reason, reason };
}

module.exports = { configuredWhitelist, sendFacts, sendDenial, sendAllowed };
