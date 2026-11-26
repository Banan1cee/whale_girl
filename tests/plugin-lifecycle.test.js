'use strict';

/**
 * app.start@1 / app.stop@1 的真实生命周期装配测试。
 *
 * 装配是真的：startServer（= createRuntime + 路由 + listen + 现有 reconcile 回调）。
 * 只有「worker 进程」这一层换成记录器：4 级 Node 插件照常安装、照常按 grant.json 校验授权，
 * 运行时读到的授权/清单/代次都是真实磁盘状态；spawn 被替成「记录本次调用并立即完成」，
 * 这样不必在测试里跑真正的子进程（沙箱里 spawn 也可能 EPERM）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { startServer } = require('../server');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { UnifiedPluginRuntime } = require('../src/services/unifiedPluginRuntime');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 生命周期调用记录：{ capability, id, epoch, settings }
let spawnLog = [];
const originalSpawn = UnifiedPluginRuntime.prototype.spawn;
UnifiedPluginRuntime.prototype.spawn = function fakeSpawn(job) {
  spawnLog.push({
    capability: job.capability,
    id: job.flow && job.flow.id,
    epoch: job.flow && job.flow.epoch,
    settings: job.flow && job.flow.settings,
  });
  // 只走 runtime 自己的完成路径：不启动子进程，也不跳过任何宿主侧校验。
  this.finish(job, null, {});
};
test.after(() => { UnifiedPluginRuntime.prototype.spawn = originalSpawn; });

const PLUGIN_ID = 'lifecycle-probe';

function manifestBytes(id = PLUGIN_ID) {
  return Buffer.from(JSON.stringify({
    format: 'whale-plugin/1', level: 4, id, name: '生命周期探针', author: '测试', version: '1.0.0',
    minAppVersion: '4.3.0', description: '生命周期测试', entry: 'plugin.js', runtime: 'node-full',
    provides: {
      'app.start@1': { mode: 'observe', scope: 'all' },
      'app.stop@1': { mode: 'observe', scope: 'all' },
    },
    calls: [],
  }));
}

const entryBytes = Buffer.from('exports.providers = {};\n');

/** 重签：写入新的授权代次/settings，包内容不变（模拟启用、改设置、撤权）。 */
function writeGrant(dir, { settings = {}, epoch = crypto.randomUUID(), enabled = true } = {}) {
  fs.writeFileSync(path.join(dir, 'grant.json'), JSON.stringify({
    enabled, level: 4, fullAccess: true, nodeFullConfirmed: true, chatConfirmed: false,
    approvedDataAccess: [], epoch,
    packageHash: sha(manifestBytes()), manifestHash: sha(manifestBytes()),
    entryHash: sha(entryBytes), approvedProviders: ['app.start@1', 'app.stop@1'],
    approvedCalls: [], settings,
  }));
}

/** 合成安装包：plugin.json + plugin.js + grant.json，字段与宿主真实安装一致。 */
function install(root, { id = PLUGIN_ID, settings = {}, epoch = crypto.randomUUID(), enabled = true } = {}) {
  const dir = path.join(root, 'data', 'plugins', id);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), manifestBytes(id));
  fs.writeFileSync(path.join(dir, 'plugin.js'), entryBytes);
  writeGrant(dir, { settings, epoch, enabled });
  return { dir };
}

async function boot(t, { preinstall } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-lifecycle-'));
  if (preinstall) install(root, preinstall);
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.features.plugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const server = await startServer({
    root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' },
  });
  t.after(async () => {
    try { await server.close(); } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  return { root, server };
}

const lifecycleCalls = name => spawnLog.filter(call => call.capability === name);

async function waitFor(predicate, label, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail('等待超时：' + label);
}

test('启动时已授权的插件收到一次 app.start，之后的 reconcile 不重复', async t => {
  spawnLog = [];
  await boot(t, { preinstall: {} });
  await waitFor(() => lifecycleCalls('app.start@1').length === 1, '启动时收到 app.start');
  const starts = lifecycleCalls('app.start@1');
  assert.equal(starts[0].id, PLUGIN_ID);
  assert.deepEqual(starts[0].settings, {});
  // 再多跑几个 reconcile 周期（500ms 一次），同一授权快照不能再来一次。
  await sleep(1200);
  assert.equal(lifecycleCalls('app.start@1').length, 1);
  assert.equal(lifecycleCalls('app.stop@1').length, 0);
});

test('运行中启用插件：由现有 reconcile 回调补发 app.start，且只发一次', async t => {
  spawnLog = [];
  const { root } = await boot(t);
  // 没有插件时不应有任何生命周期调用；也确认没有额外的定时器在乱发。
  await sleep(700);
  assert.equal(spawnLog.length, 0);
  install(root);
  await waitFor(() => lifecycleCalls('app.start@1').length === 1, '运行中启用后收到 app.start');
  await sleep(1000);
  assert.equal(lifecycleCalls('app.start@1').length, 1);
});

test('重签换代：新授权快照再通知一次，旧快照不会被补执行', async t => {
  spawnLog = [];
  const { root } = await boot(t);
  const installed = install(root, { settings: { mode: 'a' } });
  await waitFor(() => lifecycleCalls('app.start@1').length === 1, '首次 app.start');
  const firstEpoch = lifecycleCalls('app.start@1')[0].epoch;
  assert.deepEqual(lifecycleCalls('app.start@1')[0].settings, { mode: 'a' });

  // 改设置即重签：新 epoch，包内容不变。
  writeGrant(installed.dir, { settings: { mode: 'b' } });
  await waitFor(() => lifecycleCalls('app.start@1').length === 2, '换代后收到新的 app.start');
  const starts = lifecycleCalls('app.start@1');
  assert.notEqual(starts[1].epoch, firstEpoch);
  assert.deepEqual(starts[1].settings, { mode: 'b' });
  // 换代之后旧快照一次都不能再执行。
  await sleep(1000);
  assert.equal(starts.filter(call => call.epoch === firstEpoch).length, 1);
  assert.equal(lifecycleCalls('app.start@1').length, 2);
});

test('正常停机：await 一次 app.stop，重复 stop 不再通知', async t => {
  spawnLog = [];
  const { root, server } = await boot(t);
  install(root);
  await waitFor(() => lifecycleCalls('app.start@1').length === 1, 'app.start 先到');
  await server.close();
  const stops = lifecycleCalls('app.stop@1');
  assert.equal(stops.length, 1);
  // stop 在 close() 返回前就已经 await 完成，且用的是最新授权快照。
  assert.equal(stops[0].id, PLUGIN_ID);
  assert.equal(stops[0].epoch, lifecycleCalls('app.start@1')[0].epoch);
  // 重复 stop（'close' 事件与最后一次 close）不能再发。
  await server.runtime.plugins.stop();
  assert.equal(lifecycleCalls('app.stop@1').length, 1);
});

test('撤权后：不再补 start，也不再对已撤回的旧快照执行 stop', async t => {
  spawnLog = [];
  const { root, server } = await boot(t);
  const installed = install(root);
  await waitFor(() => lifecycleCalls('app.start@1').length === 1, '先收到 app.start');
  // 撤权：只把 grant 置为 disabled，包内容仍在磁盘上。
  writeGrant(installed.dir, { enabled: false });
  await sleep(1200);
  assert.equal(lifecycleCalls('app.start@1').length, 1);
  await server.close();
  assert.equal(lifecycleCalls('app.stop@1').length, 0);
});

test('快速启用后立刻撤销：不补发 start，也不泄漏未处理异常', async t => {
  spawnLog = [];
  const { root, server } = await boot(t);
  const installed = install(root);
  // 在同一个同步片段里撤权，下一次 reconcile 才会看到授权快照，不会先跑一次 start。
  writeGrant(installed.dir, { enabled: false });
  await sleep(1200);
  assert.equal(spawnLog.length, 0);
  await server.close();   // 没有记录到 start 的插件不会收到 stop
  assert.equal(spawnLog.length, 0);
});
