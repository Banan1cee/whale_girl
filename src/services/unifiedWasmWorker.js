'use strict';

const { compileRestricted, executeRestricted } = require('./unifiedWasm');
let moduleInstance;
let level;
let compat;
let invoked = false;
process.on('message', message => {
  if (message?.type === 'init' && level === undefined) {
    level = message.level;
    compat = message.compat;
    try {
      if (![1, 2, 3].includes(level)) throw Error('invalid_wasm_level');
      if (compat !== undefined && compat !== 'api3') throw Error('invalid_wasm_compat');
      moduleInstance = compileRestricted(Buffer.from(message.source, 'base64'), level);
      process.send({ type: 'ready' });
    } catch { process.send({ type: 'boot_failed' }); }
  } else if (message?.type === 'invoke' && moduleInstance && !invoked) {
    invoked = true;
    const { invocation, capability, input, settings, state } = message;
    try {
      const value = executeRestricted(moduleInstance, level, capability, input, settings, compat, state);
      process.send({ type: 'complete', invocation, ok: true, value });
    } catch { process.send({ type: 'complete', invocation, ok: false }); }
  }
});
process.on('disconnect', () => process.exit(0));
