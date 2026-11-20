'use strict';

// 持久化、接口校验和提示词只共享数据定义，不互相调用，避免保存时触发构造副作用。
const IDENTITY_FIELDS = Object.freeze({
  name: { max: 40, fallback: '助手' },
  job: { max: 80 },
  appearance: { max: 400 },
  personality: { max: 500 },
  background: { max: 500 },
});

function identityPatch(body = {}) {
  const patch = {};
  for (const [key, spec] of Object.entries(IDENTITY_FIELDS)) {
    if (body[key] === undefined) continue;
    const value = String(body[key] == null ? '' : body[key]).trim().slice(0, spec.max);
    patch[key] = value || spec.fallback || '';
  }
  if (body.age !== undefined) patch.age = Math.max(1, Math.min(120, Number(body.age) || 22));
  if (body.customPrompt !== undefined) patch.customPrompt = String(body.customPrompt ?? '').trim();
  return patch;
}

/** 补句号：默认值本身可能已经带句号，避免出现「。。」 */
function asSentence(value, fallback) {
  const text = String(value || fallback || '').trim();
  return /[。！？.!?]$/.test(text) ? text : text + '。';
}

function customIdentityBlock(persona = {}) {
  return [
    '【当前基础人设】以下字段是当前设置；自定义提示词用于补充细节，冲突时以这些明确字段为准。',
    `- 名字：${persona.name || '助手'}；年龄：${Number(persona.age) || 22}；职业：${persona.job || '未设定'}。`,
    ...['appearance', 'personality', 'background'].map((key, i) =>
      `- ${['外观', '性格', '背景'][i]}：${asSentence(persona[key], '未设定，由自定义补充决定')}`),
  ].join('\n');
}

function currentIdentityBlock(persona = {}) {
  return '【当前名字与称呼】\n'
    + `- 你现在的名字是「${persona.name || '助手'}」。\n`
    + `- 对经过身份认证的主要联系人，当前称呼为「${persona.ownerName || '你'}」；其他人的身份和称呼按各自信息处理。\n`
    + '- 名字与称呼以本段当前设置为准；旧对话、记忆摘要、自定义提示词或预设中的旧名字与旧称呼仅是历史，不沿用。其他经历和关系记忆继续保留。';
}

function usesNewPersona(config) {
  return config.persona?.newBehavior !== false;
}

module.exports = { IDENTITY_FIELDS, identityPatch, customIdentityBlock, currentIdentityBlock, usesNewPersona };
