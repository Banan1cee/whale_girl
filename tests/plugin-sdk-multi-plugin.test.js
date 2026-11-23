'use strict';

/**
 * 多插件同接口的端到端验收。
 *
 * 宿主能力不是「提供者」：没有唯一所有者，任意多个插件可以同时声明并调用同一个
 * 能力。这里用真实 server + 真实插件进程证明四件事：
 *   1. 两个插件声明并调用同一能力，都能拿到结果；
 *   2. 撤销其中一个的授权后，它的调用报 grant_revoked，另一个不受影响；
 *   3. 一个插件 handler 抛错不影响另一个插件调用同一能力；
 *   4. 未声明 / 已声明但宿主未开放的能力分别报 host_capability_not_declared / disabled。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer } = require('../server');
const { DEFAULT_CONFIG } = require('../src/infra/config');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 写一套真插件目录（plugin.json + plugin.js + grant.json）。
 * approvedCalls 默认等于清单 calls；保留 message.submit@1 这类
 * 「清单可写、授权不批」的组合用来验证 enabled:false 的拒绝路径。
 */
function install(root, id, source, calls, approvedCalls = calls) {
  const directory = path.join(root, 'data', 'plugins', id);
  fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
  const manifest = Buffer.from(JSON.stringify({
    format: 'whale-plugin/1', level: 4, id, name: id, author: '测试', version: '1.0.0',
    minAppVersion: '4.3.0', description: 'SDK', entry: 'plugin.js', runtime: 'node-full',
    provides: { 'tool.run@1': { mode: 'tool', scope: 'manual' } }, calls,
  }));
  const entry = Buffer.from(source);
  fs.writeFileSync(path.join(directory, 'plugin.json'), manifest);
  fs.writeFileSync(path.join(directory, 'plugin.js'), entry);
  fs.writeFileSync(path.join(directory, 'grant.json'), JSON.stringify({
    enabled: true, level: 4, fullAccess: true, nodeFullConfirmed: true, chatConfirmed: false,
    approvedDataAccess: [], epoch: crypto.randomUUID(),
    packageHash: sha(manifest), manifestHash: sha(manifest), entryHash: sha(entry),
    approvedProviders: ['tool.run@1'], approvedCalls, settings: {},
  }));
  return directory;
}

function revoke(root, id) {
  const file = path.join(root, 'data', 'plugins', id, 'grant.json');
  const grant = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...grant, enabled: false }));
}

async function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-multi-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.features.plugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const server = await startServer({ root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  return { root, server };
}

const run = (server, id) => fetch(server.url + '/api/plugins/run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, capability: 'tool.run@1', input: {} }),
});

const CALLER = `exports.providers = { 'tool.run@1': async (input, { host }) => {
  const reminders = await host.call('reminders.list@1', { limit: 5 });
  const contacts = await host.call('contacts.search@1', { q: '', type: 'all' });
  return {
    reminders: Array.isArray(reminders.reminders),
    contacts: Array.isArray(contacts.items),
    total: Number.isInteger(contacts.total),
  };
} };`;

test('两个插件声明并调用同一能力，都能拿到结果且互不影响', async t => {
  const { root, server } = await boot(t);
  const calls = ['reminders.list@1', 'contacts.search@1'];
  install(root, 'alpha', CALLER, calls);
  install(root, 'beta', CALLER, calls);
  // 并发跑：两个插件没有唯一所有者，不该互相排队或抢占。
  const [a, b] = await Promise.all([run(server, 'alpha'), run(server, 'beta')]);
  const [left, right] = await Promise.all([a.json(), b.json()]);
  assert.equal(a.status, 200, JSON.stringify(left));
  assert.equal(b.status, 200, JSON.stringify(right));
  for (const body of [left, right]) {
    assert.deepEqual(body.result, { reminders: true, contacts: true, total: true });
  }
});

test('撤销一个插件的授权后它报 grant_revoked，另一个插件仍正常', async t => {
  const { root, server } = await boot(t);
  const calls = ['reminders.list@1'];
  // 插件自己等宿主写一个标记再调用：这样可以确定「授权已撤」发生在调用之前，
  // 而不是靠 sleep 抢时序。cwd 是插件自己的数据目录（data/plugins/<id>/data）。
  const waiting = `const fs = require('node:fs');
exports.providers = { 'tool.run@1': async (input, { host }) => {
  fs.writeFileSync('started.txt', '1');
  const deadline = Date.now() + 20000;
  while (!fs.existsSync('go.txt')) {
    if (Date.now() > deadline) return { code: 'timeout' };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const reminders = await host.call('reminders.list@1', {});
  return { ok: true, count: reminders.reminders.length };
} };`;
  const steady = `exports.providers = { 'tool.run@1': async (input, { host }) => {
  const reminders = await host.call('reminders.list@1', {});
  return { ok: true, count: reminders.reminders.length };
} };`;
  const revokeDir = install(root, 'revokeme', waiting, calls);
  install(root, 'steady', steady, calls);

  const pending = run(server, 'revokeme');
  const startedFile = path.join(revokeDir, 'data', 'started.txt');
  const limit = Date.now() + 20000;
  while (!fs.existsSync(startedFile)) {
    assert.ok(Date.now() < limit, '插件进程没有起来（started.txt 未出现）');
    await sleep(25);
  }
  revoke(root, 'revokeme');
  fs.writeFileSync(path.join(revokeDir, 'data', 'go.txt'), '1');

  const revoked = await pending;
  const revokedBody = await revoked.json();
  assert.equal(revoked.status, 400, JSON.stringify(revokedBody));
  assert.equal(revokedBody.error, 'grant_revoked');

  // 另一个插件授权没动，照常调用同一能力。
  const other = await run(server, 'steady');
  const otherBody = await other.json();
  assert.equal(other.status, 200, JSON.stringify(otherBody));
  assert.equal(otherBody.result.ok, true);
  assert.equal(otherBody.result.count, 0);

  // 授权撤回后，撤销的那个插件已经不在已安装列表里：手动运行被路由挡掉。
  assert.equal((await run(server, 'revokeme')).status, 404);
});

test('一个插件 handler 抛错不影响另一个插件调用同一能力', async t => {
  const { root, server } = await boot(t);
  const calls = ['contacts.search@1'];
  install(root, 'boom', `exports.providers = { 'tool.run@1': async (input, { host }) => {
  await host.call('contacts.search@1', {});
  throw new Error('插件自己炸了');
} };`, calls);
  install(root, 'steady', `exports.providers = { 'tool.run@1': async (input, { host }) => {
  const contacts = await host.call('contacts.search@1', {});
  return { items: Array.isArray(contacts.items) };
} };`, calls);

  const [bad, good] = await Promise.all([run(server, 'boom'), run(server, 'steady')]);
  const badBody = await bad.json();
  const goodBody = await good.json();
  assert.equal(bad.status, 400, JSON.stringify(badBody));
  assert.equal(badBody.error, 'plugin_error');
  assert.equal(good.status, 200, JSON.stringify(goodBody));
  assert.deepEqual(goodBody.result, { items: true });
});

test('未声明与宿主未开放的能力分别被拒绝，且不影响已声明能力', async t => {
  const { root, server } = await boot(t);
  install(root, 'undeclared', `exports.providers = { 'tool.run@1': async (input, { host }) => {
  const out = {};
  try { await host.call('memory.recall@1', { chatId: 'c', query: 'x' }); out.declared = 'ok'; }
  catch (error) { out.declared = error.code; }
  const reminders = await host.call('reminders.list@1', {});
  out.reminders = Array.isArray(reminders.reminders);
  return out;
} };`, ['reminders.list@1']);

  const undeclared = await run(server, 'undeclared');
  const undeclaredBody = await undeclared.json();
  assert.equal(undeclared.status, 200, JSON.stringify(undeclaredBody));
  assert.equal(undeclaredBody.result.declared, 'host_capability_not_declared');
  assert.equal(undeclaredBody.result.reminders, true);

  // message.submit@1 是保留能力（注册表 enabled:false）：清单里可以写，
  // 授权里批不下来，真调用时分发层直接报 disabled。
  install(root, 'reserved', `exports.providers = { 'tool.run@1': async (input, { host }) => {
  try { await host.call('message.submit@1', { chatId: 'c', text: 'x' }); return { code: 'ok' }; }
  catch (error) { return { code: error.code }; }
} };`, ['reminders.list@1', 'message.submit@1'], ['reminders.list@1']);

  const reserved = await run(server, 'reserved');
  const reservedBody = await reserved.json();
  assert.equal(reserved.status, 200, JSON.stringify(reservedBody));
  assert.equal(reservedBody.result.code, 'host_capability_disabled');
});
