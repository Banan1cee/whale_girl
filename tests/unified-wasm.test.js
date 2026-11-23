'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { compileRestricted, executeRestricted } = require('../src/services/unifiedWasm');

const integerTool = Buffer.from('0061736d010000000105016000017f030201000707010372756e00000a06010400412a0b', 'hex');

test('restricted Wasm process receives the 64-page budget and a limited environment', t => {
  const runtimePath = require.resolve('../src/services/unifiedPluginRuntime');
  const saved = require.cache[runtimePath];
  const child = new EventEmitter();
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  delete require.cache[runtimePath];
  t.after(() => {
    if (saved) require.cache[runtimePath] = saved;
    else delete require.cache[runtimePath];
  });
  const { UnifiedPluginRuntime } = require(runtimePath);
  const runtime = new UnifiedPluginRuntime({ dataDir: 'unused' });
  child.connected = true;
  child.send = () => {};
  runtime.spawn({ flow: { id: 'integer', level: 1, pluginData: 'unused', source: integerTool.toString('base64') } });

  assert.equal(spawn.mock.callCount(), 1);
  const [executable, args, options] = spawn.mock.calls[0].arguments;
  assert.equal(executable, process.execPath);
  const workerIndex = args.findIndex(arg => path.basename(arg) === 'unifiedWasmWorker.js');
  assert.ok(workerIndex > 0, 'must launch the actual restricted worker entry');
  const flags = args.slice(0, workerIndex);
  assert.deepEqual(flags.filter(flag => flag.startsWith('--wasm-max-mem-pages=')), ['--wasm-max-mem-pages=64']);
  assert.deepEqual(flags.filter(flag => flag.startsWith('--wasm-max-table-size=')), ['--wasm-max-table-size=8192']);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  assert.equal(options.env.NODE_PATH, undefined);
});

test('restricted executor runs a valid small integer tool', () => {
  const module = compileRestricted(integerTool, 1);
  assert.equal(executeRestricted(module, 1, 'tool.run@1', null, {}), 42);
});
