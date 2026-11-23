'use strict';

const registry = require('./pluginProtocolRegistry.json');
const decoder = new TextDecoder('utf-8', { fatal: true });
const imports = ['input_size', 'input_byte', 'output_byte'];

function compileRestricted(bytes, level) {
  const module = new WebAssembly.Module(bytes);
  for (const item of WebAssembly.Module.imports(module)) {
    if (item.module !== 'whale_plugin' || item.kind !== 'function' || !imports.includes(item.name)
      || level === 1 && item.name === 'output_byte') throw Error('unsupported_wasm_import');
  }
  if (!WebAssembly.Module.exports(module).some(item => item.name === 'run' && item.kind === 'function')) {
    throw Error('missing_wasm_run');
  }
  return module;
}

function executeRestricted(module, level, capability, input, settings) {
  const tool = capability === 'tool.run@1';
  const payload = Buffer.from(tool ? (typeof input === 'string' ? input : JSON.stringify(input)) : JSON.stringify({ input, settings }));
  const limit = registry.limits.maxInvocationBytes;
  if (payload.length > limit) throw Error('input_limit');
  const output = Buffer.alloc(limit);
  let length = 0;
  let running = false;
  const instance = new WebAssembly.Instance(module, { whale_plugin: {
    input_size: () => payload.length,
    input_byte: index => payload[index] ?? -1,
    output_byte: value => {
      if (!running || length >= limit || value < 0 || value > 255) throw Error('invalid_wasm_output');
      output[length++] = value;
    },
  } });
  running = true;
  const result = instance.exports.run();
  if (!Number.isInteger(result) || result < -2147483648 || result > 2147483647) throw Error('invalid_wasm_result');
  if (level === 1) return result;
  if (result !== 0) throw Error('wasm_error');
  const text = decoder.decode(output.subarray(0, length));
  return tool ? text : JSON.parse(text);
}

module.exports = { compileRestricted, executeRestricted };
