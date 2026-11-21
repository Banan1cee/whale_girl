'use strict';
// SDK 运行时这块没法在单测里起真进程，但两件最容易出错的事可以钉死：
// 启动参数里有没有挂上 steer 插件，以及 steer 的本地 TCP 客户端行为对不对。

const assert = require('assert');
const net = require('net');
const path = require('path');
const { resolveRuntime, steerVia, DEFAULT_STEER_PATCH } = require('../lib/sdk');

let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('运行时启动参数里带上了 steer 插件 patch', () => {
  const resolved = resolveRuntime({ electronPath: 'D:/DeepSeek Harness/DeepSeek Harness.exe', steerPatch: DEFAULT_STEER_PATCH });
  assert.strictEqual(resolved.source, 'config.electron');
  assert.ok(resolved.args.includes('--profile'), '要指定 profile');
  assert.ok(resolved.args.includes('--patch'), '要挂 steer 插件 patch：' + resolved.args.join(' '));
  assert.ok(resolved.args.includes(DEFAULT_STEER_PATCH));
});

test('steer 客户端：送到就返回 delivered', async () => {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      const req = JSON.parse(chunk.trim());
      assert.strictEqual(req.op, 'steer');
      assert.strictEqual(req.token, 'tk');
      assert.ok(req.text.includes('标题改成蓝色'));
      socket.write(JSON.stringify({ id: req.id, ok: true, delivered: true }) + '\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const res = await steerVia(port, 'tk', 'session-x', '标题改成蓝色');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.delivered, true);
  await new Promise((r) => server.close(r));
});

test('steer 客户端：没有 agent 时如实返回未送达', async () => {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', () => socket.write(JSON.stringify({ ok: false, delivered: false, reason: 'no-agent' }) + '\n'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await steerVia(server.address().port, '', 'session-x', 'hi');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.delivered, false);
  assert.strictEqual(res.reason, 'no-agent');
  await new Promise((r) => server.close(r));
});

test('steer 客户端：端口没人听也要返回失败，不能抛', async () => {
  const res = await steerVia(9, '', 'session-x', 'hi', 1500);
  assert.strictEqual(res.ok, false);
  assert.ok(res.error);
});

(async () => {
  for (const t of tests) {
    try { await t.fn(); console.log('PASS ' + t.name); }
    catch (err) { failed += 1; console.log('FAIL ' + t.name + ' :: ' + err.message); }
  }
  process.exitCode = failed ? 1 : 0;
  console.log(failed ? ('FAILED ' + failed) : 'ALL PASS');
})();
