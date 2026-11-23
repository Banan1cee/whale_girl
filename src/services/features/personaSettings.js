'use strict';

/**
 * 人设与设置能力。写操作会落盘并经 hot-reload 生效，所以必须逐个插件授权。
 *
 * 写入口统一走 services 里已有的 applyPersonaPatch / applySettings：
 * 校验、限长、落盘、热更新都只有一份实现，路由和插件不会各写一套。
 */

const { error, text } = require('./helpers');
const { applyPersonaPatch } = require('../persona');
const { applySettings } = require('../settings');

// 密钥只允许从启动器/本机设置页写入：插件拿到的是「改设置」授权，不是「换主人的 Key」。
// model 也一样：切模型会换服务商和计费主体，属于设置页的明确操作，不该由人设写入顺带触发。
const SECRET_FIELDS = ['apiKey', 'visionApiKey'];
const PERSONA_PLUGIN_BLOCKED = ['model'];

function bodyOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('invalid_host_capability_input');
  return input;
}

function withoutSecrets(body) {
  const out = { ...body };
  for (const key of SECRET_FIELDS) delete out[key];
  return out;
}

function create(runtime) {
  return {
    'persona.read@1': () => {
      const persona = runtime.config.persona || {};
      return { name: text(persona.name, 80), ownerName: text(persona.ownerName, 80),
        tone: text(persona.tone, 200), style: text(persona.style, 200) };
    },

    // 返回 applyPersonaPatch 的原样结果：{ok,persona,tokenCheck,warnings,llm} 或 {ok:false,error}。
    // 路由按 ok 决定 200/400，所以这里不能把失败包装成异常。
    'persona.write@1': async (input, plugin) => {
      const body = bodyOf(input);
      if (!plugin) return applyPersonaPatch(runtime, body);
      const safe = { ...body };
      for (const key of PERSONA_PLUGIN_BLOCKED) delete safe[key];
      return applyPersonaPatch(runtime, safe);
    },

    'settings.write@1': async (input, plugin) => {
      const body = bodyOf(input);
      return applySettings(runtime, plugin ? withoutSecrets(body) : body);
    },
  };
}

module.exports = { create, SECRET_FIELDS };
