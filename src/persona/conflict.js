'use strict';

/**
 * 自定义提示词与结构化设置的冲突提醒。
 *
 * 只做高置信的文本比对，不做语义判断。提醒只说「第几行、哪句话、跟哪个设置冲突」，
 * 不解释原因；只提醒、不改写、不拦截保存。字数、权限、发送方式仍由代码强制执行。
 */

const STOP_NAME = new Set(['什么', '我', '你', '他', '她', '名字', '谁', '啥', '这个', '那个']);
const FIELD_LABEL = { personality: '性格', appearance: '外观', background: '背景经历' };

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function limit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/** 行号按用户看到的文本算；定位不到就返回 0，界面显示「提示词」。 */
function lineOf(text, index) {
  if (index < 0) return 0;
  return text.slice(0, index).split('\n').length;
}

function where(line, phrase) {
  const at = line > 0 ? `第 ${line} 行` : '提示词';
  return phrase ? `${at}「${phrase}」` : at;
}

function short(value, max = 20) {
  const text = clean(value);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function firstMatch(prompt, patterns) {
  for (const re of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(prompt))) {
      const value = clean(match[1]).replace(/[「」“”"'‘’]/g, '');
      if (value && !STOP_NAME.has(value)) return { value, index: match.index, raw: match[0] };
    }
  }
  return null;
}

function nameConflict(prompt, name) {
  if (!name) return null;
  const hit = firstMatch(prompt, [
    /(?:你的?名字|本名|真名)(?:是|叫|为|：|:)\s*[「“"'‘]?([^\s，。,.!?！？；;：:「」“”"'‘’]{1,16})/g,
    /你(?:就)?叫\s*[「“"'‘]?([^\s，。,.!?！？；;：:「」“”"'‘’]{1,16})/g,
  ]);
  if (!hit || hit.value === name || hit.value.includes(name) || name.includes(hit.value)) return null;
  return {
    code: 'name',
    line: lineOf(prompt, hit.index),
    message: `${where(lineOf(prompt, hit.index), short(hit.raw))} 与「名字」设置（${name}）冲突`,
  };
}

function ownerConflict(prompt, ownerName) {
  if (!ownerName) return null;
  const hit = firstMatch(prompt, [
    /(?:叫我|称呼我(?:为|作)?|喊我)\s*[「“"'‘]?([^\s，。,.!?！？；;：:「」“”"'‘’]{1,16})/g,
  ]);
  if (!hit || hit.value === ownerName || hit.value.includes(ownerName)) return null;
  return {
    code: 'owner',
    line: lineOf(prompt, hit.index),
    message: `${where(lineOf(prompt, hit.index), short(hit.raw))} 与「称呼」设置（${ownerName}）冲突`,
  };
}

function lengthConflict(prompt, privateMax, groupMax) {
  if (!privateMax && !groupMax) return null;
  const max = Math.max(privateMax || 0, groupMax || 0);
  const re = /((?:至少|不少于)\s*\d{1,5}\s*字|\d{1,5}\s*字(?:以上|起))/g;
  let match;
  while ((match = re.exec(prompt))) {
    const raw = match[1].trim();
    const want = Number(raw.replace(/\D/g, ''));
    if (!want || want < 20 || want <= max) continue;
    const line = lineOf(prompt, match.index);
    return {
      code: 'length',
      line,
      message: `${where(line, short(raw))} 与「字数上限」设置（私聊 ${privateMax} 字 / 群聊 ${groupMax} 字）冲突`,
    };
  }
  return null;
}

const SCOPE_RULES = [
  { label: '工具权限', re: /(?:操作|控制|移动)[^。\n]{0,6}(?:电脑|鼠标|键盘|桌面)/ },
  { label: '发送方式', re: /(?:直接|立刻|马上)[^。\n]{0,4}(?:帮我|替我|给你)?(?:发|回)(?:送)?[^。\n]{0,4}(?:微信|消息|图片|语音)/ },
  { label: '朋友圈功能', re: /(?:发布|点赞|评论|查看|读取)[^。\n]{0,6}朋友圈/ },
  { label: '设置修改权限', re: /(?:修改|更改|调整)[^。\n]{0,6}(?:系统|电脑|我的设置|配置)/ },
  { label: '主人认证', re: /(?:所有人|任何人|谁)[^。\n]{0,6}(?:都是|是你的)[^。\n]{0,3}主人|自称主人/ },
];

function scopeConflict(prompt) {
  for (const rule of SCOPE_RULES) {
    const match = prompt.match(rule.re);
    if (!match) continue;
    const line = lineOf(prompt, prompt.indexOf(match[0]));
    return {
      code: 'scope',
      line,
      message: `${where(line, short(match[0]))} 与「${rule.label}」设置冲突`,
    };
  }
  return null;
}

function grams(text) {
  const plain = text.replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < plain.length - 1; i++) out.add(plain.slice(i, i + 2));
  return out;
}

function duplicateConflict(prompt, persona) {
  const promptGrams = grams(prompt);
  if (promptGrams.size < 15) return null;
  for (const key of ['personality', 'appearance', 'background']) {
    const field = clean(persona[key]);
    if (field.length < 20) continue;
    const fieldGrams = grams(field);
    if (fieldGrams.size < 10) continue;
    let hit = 0;
    for (const gram of fieldGrams) if (promptGrams.has(gram)) hit++;
    const ratio = hit / fieldGrams.size;
    if (ratio < 0.6) continue;
    const line = lineOf(prompt, prompt.indexOf(field.slice(0, 8)));
    return {
      code: 'duplicate',
      line,
      message: `${where(line)} 与「${FIELD_LABEL[key]}」字段重复（约 ${Math.round(ratio * 100)}%）`,
    };
  }
  return null;
}

/**
 * @param {object} source 当前（或即将保存的）人设与聊天上限
 * @returns {Array<{code:string,line:number,message:string}>} 最多 4 条，按影响排序
 */
function checkCustomPrompt(source = {}) {
  const prompt = clean(source.customPrompt);
  if (!prompt) return [];
  const persona = {
    name: clean(source.name),
    personality: source.personality,
    appearance: source.appearance,
    background: source.background,
  };
  const privateMax = limit(source.privateMaxChars, 0);
  const groupMax = limit(source.groupMaxChars, 0);
  const warnings = [
    nameConflict(prompt, persona.name),
    ownerConflict(prompt, clean(source.ownerName)),
    lengthConflict(prompt, privateMax, groupMax),
    scopeConflict(prompt),
    duplicateConflict(prompt, persona),
  ].filter(Boolean);
  return warnings.sort((a, b) => a.line - b.line).slice(0, 4);
}

module.exports = { checkCustomPrompt };
