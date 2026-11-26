'use strict';

/**
 * 隔离执行器验收：真实 worker 线程，不 mock。
 *
 * 夹具模块写到系统临时目录，每个测试自己清理；这样测试文件本身是唯一新增源文件，
 * 题面要求的“不改其他文件”仍然成立。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runIsolated } = require('../src/services/isolatedRunner');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixtureDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-isolated-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeModule(dir, name, source) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `'use strict';\n${source}\n`);
  return file;
}

test('runs the export in a separate worker and returns its JSON result', async t => {
  const dir = fixtureDir(t);
  const moduleFile = writeModule(dir, 'echo.js', `
module.exports.echo = input => ({
  echo: input,
  inWorker: require('node:worker_threads').isMainThread === false,
  secret: typeof globalThis.__ISOLATED_SECRET__,
});
`);
  global.__ISOLATED_SECRET__ = 'main-thread-only';
  t.after(() => { delete global.__ISOLATED_SECRET__; });

  const result = await runIsolated({
    module: moduleFile,
    exportName: 'echo',
    input: { hello: 'whale', count: 3 },
    timeoutMs: 2000,
  });
  // 结果必须是 JSON 往返后的值；worker 看不到主进程的全局变量。
  assert.deepEqual(result, { echo: { hello: 'whale', count: 3 }, inWorker: true, secret: 'undefined' });
});

test('awaits an async export before returning', async t => {
  const dir = fixtureDir(t);
  const moduleFile = writeModule(dir, 'later.js', `
module.exports.later = async ({ ms, value }) => {
  await new Promise(resolve => setTimeout(resolve, ms));
  return { value };
};
`);

  const started = Date.now();
  const result = await runIsolated({ module: moduleFile, exportName: 'later', input: { ms: 60, value: 'done' }, timeoutMs: 2000 });
  assert.deepEqual(result, { value: 'done' });
  // 至少等满异步体自己的时长，确保不是把 Promise 当普通对象序列化。
  assert.ok(Date.now() - started >= 50);
});

test('times out and terminates a hanging worker', async t => {
  const dir = fixtureDir(t);
  const marker = path.join(dir, 'late.txt');
  const moduleFile = writeModule(dir, 'hang.js', `
const fs = require('node:fs');
module.exports.hang = ({ marker, delayMs }) => {
  setTimeout(() => { try { fs.writeFileSync(marker, 'late'); } catch {} }, delayMs);
  return new Promise(() => {});
};
`);

  await assert.rejects(runIsolated({
    module: moduleFile, exportName: 'hang', input: { marker, delayMs: 300 }, timeoutMs: 40,
  }), { code: 'isolated_timeout' });

  // worker 已 terminate：它排的定时器不应再落地。
  await wait(500);
  assert.equal(fs.existsSync(marker), false, '超时后必须终止 worker，不能让它继续后台执行');

  // 超时只影响这一次调用，随后一次正常调用不受影响。
  const echoFile = writeModule(dir, 'echo.js', "module.exports.echo = () => ({ ok: true });");
  assert.deepEqual(await runIsolated({ module: echoFile, exportName: 'echo', timeoutMs: 2000 }), { ok: true });
});

test('aborting a live call terminates the worker and reports capability_aborted', async t => {
  const dir = fixtureDir(t);
  const marker = path.join(dir, 'cancel-late.txt');
  const moduleFile = writeModule(dir, 'hang.js', `
const fs = require('node:fs');
module.exports.hang = ({ marker, delayMs }) => {
  setTimeout(() => { try { fs.writeFileSync(marker, 'late'); } catch {} }, delayMs);
  return new Promise(() => {});
};
`);

  // 已取消的 signal 不应再启动执行。
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(runIsolated({
    module: moduleFile, exportName: 'hang', input: { marker, delayMs: 300 }, timeoutMs: 2000,
    signal: preAborted.signal,
  }), { code: 'capability_aborted' });
  assert.equal(fs.existsSync(marker), false);

  const controller = new AbortController();
  const pending = runIsolated({
    module: moduleFile, exportName: 'hang', input: { marker, delayMs: 300 }, timeoutMs: 5000,
    signal: controller.signal,
  });
  await wait(30);
  controller.abort();
  await assert.rejects(pending, { code: 'capability_aborted' });

  await wait(500);
  assert.equal(fs.existsSync(marker), false, '取消后必须终止 worker，不能让它继续后台执行');
});

test('reports a missing module as isolated_failed', async t => {
  const dir = fixtureDir(t);
  const missing = path.join(dir, 'does-not-exist.js');

  const error = await runIsolated({ module: missing, exportName: 'run', timeoutMs: 2000 }).then(() => null, err => err);
  assert.equal(error?.code, 'isolated_failed');
  assert.match(error.message, /Cannot find module/);
  assert.ok(error.message.length <= 200, '错误 message 必须截断至 200 字以内');
});

test('reports load, missing export and call failures as isolated_failed', async t => {
  const dir = fixtureDir(t);
  const loadFailure = writeModule(dir, 'load-fail.js', "throw new Error('load exploded');");
  const echo = writeModule(dir, 'echo.js', "module.exports.echo = () => ({ ok: true });");
  const boom = writeModule(dir, 'boom.js', "module.exports.boom = () => { throw new Error('boom-from-worker'); };");
  const long = writeModule(dir, 'long.js', "module.exports.long = () => { throw new Error('x'.repeat(400)); };");

  await assert.rejects(runIsolated({ module: loadFailure, exportName: 'run', timeoutMs: 2000 }),
    { code: 'isolated_failed', message: 'load exploded' });
  await assert.rejects(runIsolated({ module: echo, exportName: 'nope', timeoutMs: 2000 }),
    { code: 'isolated_failed', message: /not a function/ });
  await assert.rejects(runIsolated({ module: boom, exportName: 'boom', timeoutMs: 2000 }),
    { code: 'isolated_failed', message: 'boom-from-worker' });

  const longError = await runIsolated({ module: long, exportName: 'long', timeoutMs: 2000 }).then(() => null, err => err);
  assert.equal(longError?.code, 'isolated_failed');
  assert.equal(longError.message.length, 200);
  assert.ok(longError.message.startsWith('xxx'));
});

test('rejects output larger than 512KiB and accepts smaller results', async t => {
  const dir = fixtureDir(t);
  const moduleFile = writeModule(dir, 'big.js', "module.exports.big = ({ bytes }) => ({ blob: 'x'.repeat(bytes) });");

  const limit = 512 * 1024;
  // 边界必须严格是「> 512KiB」：恰好 512KiB 允许，超 1 字节拒绝。
  const overhead = Buffer.byteLength(JSON.stringify({ blob: '' }), 'utf8');
  const allowed = await runIsolated({
    module: moduleFile, exportName: 'big', input: { bytes: limit - overhead }, timeoutMs: 5000,
  });
  assert.equal(Buffer.byteLength(JSON.stringify(allowed), 'utf8'), limit);

  await assert.rejects(runIsolated({
    module: moduleFile, exportName: 'big', input: { bytes: limit - overhead + 1 }, timeoutMs: 5000,
  }), { code: 'isolated_output_limit' });

  // 512KiB 的字符加上 JSON 包装当然也超限。
  await assert.rejects(runIsolated({
    module: moduleFile, exportName: 'big', input: { bytes: limit }, timeoutMs: 5000,
  }), { code: 'isolated_output_limit' });

  const small = await runIsolated({ module: moduleFile, exportName: 'big', input: { bytes: 128 * 1024 }, timeoutMs: 5000 });
  assert.equal(small.blob.length, 128 * 1024);
});

test('concurrent calls run in independent workers without sharing module state', async t => {
  const dir = fixtureDir(t);
  const counter = writeModule(dir, 'counter.js', `
let calls = 0;
module.exports.next = async () => {
  calls += 1;
  await new Promise(resolve => setTimeout(resolve, 20));
  return { call: calls };
};
`);

  const [a, b] = await Promise.all([
    runIsolated({ module: counter, exportName: 'next', timeoutMs: 5000 }),
    runIsolated({ module: counter, exportName: 'next', timeoutMs: 5000 }),
  ]);
  // 每次调用一个独立 worker，模块级计数器各自从 0 开始。
  assert.deepEqual([a, b], [{ call: 1 }, { call: 1 }]);
});

test('terminates the worker after a successful call', async t => {
  const dir = fixtureDir(t);
  const marker = path.join(dir, 'after-success.txt');
  const moduleFile = writeModule(dir, 'arm.js', `
const fs = require('node:fs');
module.exports.arm = ({ marker, delayMs }) => {
  setTimeout(() => { try { fs.writeFileSync(marker, 'late'); } catch {} }, delayMs);
  return { armed: true };
};
`);

  assert.deepEqual(await runIsolated({
    module: moduleFile, exportName: 'arm', input: { marker, delayMs: 300 }, timeoutMs: 2000,
  }), { armed: true });

  // settled 之后必须 terminate；否则 worker 的定时器会继续跑并写出文件。
  await wait(500);
  assert.equal(fs.existsSync(marker), false, '成功返回后也必须终止 worker');
});
