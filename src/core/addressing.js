'use strict';

/**
 * 「这条消息是不是在跟她说」的唯一判定入口。
 *
 * 以前 atMe / clean.atMe / addressedToBot / replyToBot / namedHerIn 分散在
 * trigger、chat、canned 里各算一遍，同一条消息在不同分支可能得到不同结论。
 * 这里只做纯函数，不读写 state，方便单测。
 */

/** 她当前可能被叫到的名字：人设名 + 别名 + 桥接上报的账号昵称/备注等。 */
function herNames(bot, msg) {
  const persona = (bot && bot.config && bot.config.persona) || {};
  const extra = msg && Array.isArray(msg.selfNames) ? msg.selfNames : [];
  return [...new Set([persona.name, ...(persona.aliases || []), ...extra]
    .map((x) => String(x || '').trim()).filter(Boolean))];
}

/** 正文里是否出现她的名字/外号（含「你机器人」这类明确指代）。 */
function namedHerIn(text, names = []) {
  const s = String(text || '');
  const list = Array.isArray(names) && names.length ? names : ['鲸鲸', '小鲸', '肥鱼'];
  if (list.some((name) => name && s.includes(name))) return true;
  return /(这个|那个|你|破|臭|傻|烂|死)\s*机器人/.test(s);
}

/** 显式 @ 或回复她；名字命中属于「叫到名字」，由调用方单独处理。 */
function isAddressed(atMe, msg) {
  return Boolean(atMe || (msg && msg.replyToBot));
}

/** 把桥接传来的提及名单过滤掉她自己和广播词，避免把自己当第三人。 */
function filterSelfMentions(list, names = []) {
  const self = new Set(
    (Array.isArray(names) ? names : [])
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw || '').trim();
    const key = name.toLowerCase();
    if (!name || self.has(key) || seen.has(key)) continue;
    if (key === '所有人' || key === '全体成员') continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** 这条消息是不是明显在跟别人说（@ 了别人 / 第三人称 / 提了别的成员）。 */
function talkingToOthers({ msg, text, guardOn = true, names = [] }) {
  if (!guardOn) return false;
  const others = filterSelfMentions(msg && msg.mentionedNames, names);
  if (others.length) return true;
  const s = String(text || '');
  return /(他|她|楼上|楼下|那谁|某人|刚才那个)/.test(s) && !/你|你们/.test(s);
}

module.exports = { herNames, namedHerIn, isAddressed, filterSelfMentions, talkingToOthers };
