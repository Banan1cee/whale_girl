'use strict';

/**
 * 旧 Api 1/2/3 的 Wasm 二进制兼容：
 * - 旧的 `whale` 导入模块名等价于 `whale_plugin`（只限三个字节接口）；
 * - 3 级声明 `compat:"api3"` 后收到旧 Api3 信封，输出按新 provider schema 投影；
 * - 未声明 compat 的插件收到 v2 信封 {capability, input, settings, state}；
 * - 2/3 级工具返回纯文本，不能先按 JSON 解析（daily-digest 依赖）。
 */
const registry = require('./pluginProtocolRegistry.json');
const decoder = new TextDecoder('utf-8', { fatal: true });
const imports = ['input_size', 'input_byte', 'output_byte'];
const MODULE_NAMES = ['whale_plugin', 'whale'];

// api3 兼容支持哪些扩展点由注册表登记（唯一事实源），这里只做一次快照。
// 旧 Api3 宿主本来就派发过同名 chat.received hook，所以这里不是新造名字；
// 已实现该 hook 的旧字节码照常收到调用，未实现的收到未知 hook 自己忽略，
// 返回值一律按 observe 丢弃。名字必须在注册表里登记，否则旧插件会安装成功
// 却在第一次派发时撞 invalid_wasm_compat。
const API3_HOOKS = Object.freeze({ ...(registry.manifest?.compat?.hooks || {}) });

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function compileRestricted(bytes, level) {
  const module = new WebAssembly.Module(bytes);
  for (const item of WebAssembly.Module.imports(module)) {
    if (!MODULE_NAMES.includes(item.module) || item.kind !== 'function' || !imports.includes(item.name)
      || level === 1 && item.name === 'output_byte') throw Error('unsupported_wasm_import');
  }
  if (!WebAssembly.Module.exports(module).some(item => item.name === 'run' && item.kind === 'function')) {
    throw Error('missing_wasm_run');
  }
  return module;
}

/**
 * 旧 Api3 信封：{api:3, hook, message, now, lastBot, state, settings, decision}
 * 并按输入带 text/system/history。state 由宿主按「插件 × 会话」提供（缺省 {}、上限 8 KiB）。
 *
 * lastBot 是旧插件接话判定的命门：`followup-window` 的 reference.js 第 89 行
 * 「没有上一条机器人回复就直接 pass」，旧 Api3 宿主传的是 store 里最后一条
 * assistant 记录。这里只接受宿主收口后的 {text, at, targetId}，绝不把整条
 * 数据库记录透给插件；字段顺序把 at/targetId 放前面，是因为该插件的 Wasm 用
 * 子串查找 `"at":` / `"targetId":"`，正文里恰好出现这些片段时不能抢先命中。
 */
function api3LastBot(value) {
  if (!isObject(value)) return null;
  const at = Number(value.at);
  return {
    at: Number.isFinite(at) && at > 0 ? Math.trunc(at) : 0,
    targetId: String(value.targetId || '').slice(0, 120),
    text: String(value.text || '').slice(0, 4000),
  };
}

function api3Envelope(capability, input, settings, state) {
  const hook = API3_HOOKS[capability];
  if (!hook) return null;
  const source = isObject(input) ? input : {};
  // 时间必须用宿主给的 now：插件自己 Date.now() 会和老 lastBot.at 不同源，180 秒的
  // 窗口判定就没法复现，假时钟测试也过不去。
  const now = Number(source.now);
  const envelope = {
    api: 3,
    hook,
    message: isObject(source.message) ? source.message : null,
    now: Number.isFinite(now) && now > 0 ? Math.trunc(now) : Date.now(),
    lastBot: api3LastBot(source.lastBot),
    state: isObject(state) ? state : {},
    settings: isObject(settings) ? settings : {},
    decision: 'pass',
  };
  if (typeof source.text === 'string') envelope.text = source.text;
  if (typeof source.system === 'string') envelope.system = source.system;
  if (Array.isArray(source.history)) envelope.history = source.history;
  return envelope;
}

function buildWasmPayload(level, capability, input, settings, compat, state) {
  const tool = capability === 'tool.run@1';
  if (compat !== undefined && compat !== null) {
    if (compat !== 'api3' || level !== 3) throw Error('invalid_wasm_compat');
    const envelope = api3Envelope(capability, input, settings, state);
    if (!envelope) throw Error('invalid_wasm_compat');
    return Buffer.from(JSON.stringify(envelope));
  }
  if (tool) return Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  // v2 信封：同一个 Wasm 包可能声明多个 provider，必须告诉它这次是哪个能力。
  return Buffer.from(JSON.stringify({
    capability, input, settings, state: isObject(state) ? state : {},
  }));
}

/** 旧输出 {action,text,system,state?} → 新 provider 的窄 schema；state 原样透传（超限或非对象按不合契约处理）。 */
function compatOutput(capability, output, input) {
  if (!isObject(output)) throw Error('invalid_wasm_output');
  // chat.received@1 是纯观察者：旧 Api3 里没有这个 hook，旧插件可能返回
  // {action} 或原样回显，宿主本来就会丢弃 observe 的返回值，所以这里不需要
  // 也不应该按接话契约校验它的字段（否则安装成功、第一次派发就报非法输出）。
  if (capability === 'chat.received@1') return {};
  if (Object.keys(output).some(key => !['action', 'text', 'system', 'state'].includes(key))) {
    throw Error('invalid_wasm_output');
  }
  const withState = result => {
    if (output.state === undefined) return result;
    if (!isObject(output.state) || Buffer.byteLength(JSON.stringify(output.state)) > 8 * 1024) {
      throw Error('invalid_wasm_output');
    }
    return { ...result, state: output.state };
  };
  if (capability === 'chat.pre_reply@1') {
    const action = output.action === undefined ? 'pass' : output.action;
    if (!['pass', 'skip', 'wake'].includes(action)) throw Error('invalid_wasm_output');
    return withState({ action });
  }
  if (capability === 'chat.prompt@1') {
    const system = typeof output.system === 'string' ? output.system : input?.system;
    if (typeof system !== 'string') throw Error('invalid_wasm_output');
    return withState({ system });
  }
  const text = typeof output.text === 'string' ? output.text : input?.text;
  if (typeof text !== 'string') throw Error('invalid_wasm_output');
  return withState({ text });
}

function executeRestricted(module, level, capability, input, settings, compat, state) {
  const tool = capability === 'tool.run@1';
  const payload = buildWasmPayload(level, capability, input, settings, compat, state);
  const limit = registry.limits.maxInvocationBytes;
  if (payload.length > limit) throw Error('input_limit');
  const output = Buffer.alloc(limit);
  let length = 0;
  let running = false;
  const bridge = {
    input_size: () => payload.length,
    input_byte: index => payload[index] ?? -1,
    output_byte: value => {
      if (!running || length >= limit || value < 0 || value > 255) throw Error('invalid_wasm_output');
      output[length++] = value;
    },
  };
  const instance = new WebAssembly.Instance(module, { whale_plugin: bridge, whale: bridge });
  running = true;
  const result = instance.exports.run();
  if (!Number.isInteger(result) || result < -2147483648 || result > 2147483647) throw Error('invalid_wasm_result');
  if (level === 1) return result;
  if (result !== 0) throw Error('wasm_error');
  const text = decoder.decode(output.subarray(0, length));
  if (tool) return text;
  const value = JSON.parse(text);
  if (compat === 'api3') return compatOutput(capability, value, input);
  return value;
}

module.exports = { compileRestricted, executeRestricted, buildWasmPayload, compatOutput, API3_HOOKS };
