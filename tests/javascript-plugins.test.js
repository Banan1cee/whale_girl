'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { JavaScriptPlugins, PluginRuntime } = require('../src/services/javascriptPlugins');

function fixture(t, source, hooks = ['tool.run'], options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-native-plugin-'));
  const plugins = path.join(root, 'data', 'plugins');
  fs.mkdirSync(plugins, { recursive: true });
  const flow = { id: 'native-test', api: 4, kind: 'message', hooks, permissions: ['system.full'],
    javascript: source, executionTimeoutMs: 5000, intervalSeconds: 1 };
  // Raw UTF-8 bytes, including formatting/emoji, are the consent fingerprint.
  const bytes = Buffer.from(JSON.stringify(flow, null, 2));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const grantFile = path.join(plugins, 'native-test.flow-grant.json');
  fs.writeFileSync(path.join(plugins, 'native-test.flow.json'), bytes);
  fs.writeFileSync(path.join(plugins, 'native-test.enabled'), '');
  const grant = { enabled: true, fullAccess: true, hash, settings: { greeting: '你好😀' } };
  fs.writeFileSync(grantFile, JSON.stringify(grant));
  const logs = [];
  const manager = new JavaScriptPlugins({ dataDir: path.join(root, 'data'),
    logger: { warn: line => logs.push(line) }, ...options });
  t.after(async () => { await manager.stop(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, plugins, flow, hash, grant, grantFile, manager, logs };
}

test('JavaScript 插件异步搜索超过 Wasm 300ms 预算仍能完成，保留结构化来源和中文', async t => {
  const f = fixture(t, `const whale = require('whale');
    module.exports.run = async ctx => {
      const result = await whale.search(ctx.input, { freshness: 'yesterday' });
      return { greeting: ctx.settings.greeting, url: result.items[0].url, publishedAt: result.items[0].publishedAt };
    };`, ['tool.run'], { hostCall: async (method, args) => {
    assert.equal(method, 'search'); assert.equal(args.query, '昨天湖人比赛'); assert.equal(args.freshness, 'yesterday');
    await new Promise(resolve => setTimeout(resolve, 350));
    return { items: [{ title: '测试赛报', url: 'https://example.com/report', publishedAt: null }] };
  } });
  assert.equal(f.manager.installed().length, 1);
  assert.deepEqual(await f.manager.runTool('native-test', '昨天湖人比赛'), {
    greeting: '你好😀', url: 'https://example.com/report', publishedAt: null,
  });
});

test('安装本身、缺少完整授权或停用标记都不执行 JavaScript', async t => {
  const f = fixture(t, `require('node:fs').writeFileSync('executed.txt', 'bad'); module.exports.run = () => 'ok';`);
  f.grant.fullAccess = false;
  fs.writeFileSync(f.grantFile, JSON.stringify(f.grant));
  assert.equal(f.manager.installed().length, 0);
  await assert.rejects(f.manager.runTool('native-test', ''), /plugin_not_enabled/);
  f.grant.fullAccess = true;
  fs.writeFileSync(f.grantFile, JSON.stringify(f.grant));
  fs.unlinkSync(path.join(f.plugins, 'native-test.enabled'));
  await assert.rejects(f.manager.runTool('native-test', ''), /plugin_not_enabled/);
  assert.equal(f.manager.workers.size, 0);
  assert.equal(fs.existsSync(path.join(f.plugins, 'native-test.data', 'executed.txt')), false);
});

test('实验总开关关闭会阻止执行并停止已经启动的工作进程，保留设置和状态', async t => {
  let enabled = true;
  const f = fixture(t, 'module.exports.run = ctx => ({state:{counter:7},value:ctx.settings.greeting});', ['tool.run'], { enabled: () => enabled });
  await f.manager.runTool('native-test', {});
  enabled = false;
  await f.manager.reconcile();
  assert.equal(f.manager.workers.size, 0);
  await assert.rejects(f.manager.runTool('native-test', {}), /plugin_not_enabled/);
  assert.ok(fs.existsSync(f.grantFile));
  assert.ok(fs.readdirSync(f.plugins).some(name => name.endsWith('.state.json')));
});

test('更新源码必须重新授权，启用新版本会替换旧进程而保留会话状态', async t => {
  const f = fixture(t, 'module.exports.run = ctx => ({state:{counter:(ctx.state.counter||0)+1},version:1});');
  await f.manager.runTool('native-test', {});
  const previous = f.manager.workers.get('native-test');
  const file = path.join(f.plugins, 'native-test.flow.json');
  const next = Buffer.from(JSON.stringify({ ...f.flow,
    javascript: 'module.exports.run = ctx => ({state:{counter:ctx.state.counter+1},version:2});' }));
  fs.unlinkSync(f.grantFile); fs.writeFileSync(file, next);
  await f.manager.reconcile();
  assert.equal(previous.stopped, true);
  await assert.rejects(f.manager.runTool('native-test', {}), /plugin_not_enabled/);
  fs.writeFileSync(f.grantFile, JSON.stringify({ ...f.grant, hash: crypto.createHash('sha256').update(next).digest('hex') }));
  const out = await f.manager.runTool('native-test', {});
  assert.equal(out.version, 2); assert.equal(out.state.counter, 2);
  assert.notEqual(f.manager.workers.get('native-test'), previous);
});

test('JS 进程常驻且可使用 Node 内置模块，插件状态仍按会话隔离', async t => {
  const f = fixture(t, `const fs = require('node:fs'); const path = require('node:path'); let calls = 0;
    module.exports.hooks = { 'chat.reply': ctx => {
      const n = (ctx.state.n || 0) + 1;
      fs.writeFileSync(path.join(ctx.whale.paths.pluginData, 'own-data.txt'), String(++calls));
      return { text: ctx.text + ':' + calls + ':' + n, state: { n } };
    }};`, ['chat.reply']);
  assert.equal((await f.manager.run('chat.reply', { key: 'one', text: 'a' })).text, 'a:1:1');
  assert.equal((await f.manager.run('chat.reply', { key: 'one', text: 'b' })).text, 'b:2:2');
  assert.equal((await f.manager.run('chat.reply', { key: 'two', text: 'c' })).text, 'c:3:1');
  assert.equal(f.manager.workers.size, 1);
  assert.equal(fs.readFileSync(path.join(f.plugins, 'native-test.data', 'own-data.txt'), 'utf8'), '3');
});

test('等待宿主调用期间撤销授权，丢弃结果并终止旧进程', async t => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const reply = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, `module.exports.hooks = { 'chat.generate': async ctx => {
    await ctx.whale.search('test'); return { text: 'must not replace', state: { leaked: true } };
  }};`, ['chat.generate'], { hostCall: async () => { entered(); return reply; } });
  const task = f.manager.run('chat.generate', { key: 'one', text: 'original' });
  await started;
  fs.unlinkSync(f.grantFile);
  finish({ items: [] });
  assert.equal((await task).text, 'original');
  await f.manager.reconcile();
  assert.equal(f.manager.workers.size, 0);
  assert.equal(fs.readdirSync(f.plugins).some(name => name.endsWith('.state.json')), false);
});

test('死循环只终止插件工作进程，宿主可继续运行', async t => {
  const f = fixture(t, `module.exports.run = ctx => { if (ctx.input === 'hang') while (true) {} return 'ready'; };`);
  assert.equal(await f.manager.runTool('native-test', 'warm'), 'ready');
  const flow = { ...f.manager.installed()[0], executionTimeoutMs: 100 };
  const input = f.manager.input(flow, 'tool.run', { key: 'tool', input: 'hang' }).value;
  const start = Date.now();
  await assert.rejects(f.manager.execute(flow, input), /timeout/);
  assert.ok(Date.now() - start < 2000);
  await f.manager.stop();
  assert.equal(f.manager.workers.size, 0);
  assert.equal(f.manager.retiring.size, 0);
});

test('退出或停用时调用本地清理并等待工作进程退出', async t => {
  const f = fixture(t, `const fs = require('node:fs'); const path = require('node:path');
    module.exports.run = () => 'ready';
    module.exports.deactivate = ctx => fs.writeFileSync(path.join(ctx.whale.paths.pluginData, 'stopped.txt'), 'yes');`,
  ['tool.run', 'app.stop']);
  await f.manager.runTool('native-test', '');
  await f.manager.stop();
  assert.equal(fs.readFileSync(path.join(f.plugins, 'native-test.data', 'stopped.txt'), 'utf8'), 'yes');
});

test('插件异常和 console 不把正文、密钥带进宿主日志', async t => {
  const f = fixture(t, `console.log('PRIVATE-PLUGIN-KEY');
    module.exports.hooks = { 'chat.reply': () => { throw Error('PRIVATE-PLUGIN-KEY'); } };`, ['chat.reply']);
  assert.equal((await f.manager.run('chat.reply', { key: 'one', text: 'original' })).text, 'original');
  assert.ok(f.logs.some(line => line.includes('result=fallback')));
  assert.equal(JSON.stringify(f.logs).includes('PRIVATE-PLUGIN-KEY'), false);
});

test('兼容原 Wasm 执行顺序和接话判定，新检索钩子只交给 JS', async t => {
  const f = fixture(t, `module.exports.hooks = { 'chat.prompt': ctx => ({ system: ctx.system + ' JS' }) };`, ['chat.prompt']);
  const seen = [];
  const runtime = new PluginRuntime({ run: async (hook, ctx) => { seen.push(hook); return { action: 'wake', system: ctx.system + ' Wasm' }; } }, f.manager);
  const out = await runtime.run('chat.prompt', { key: 'one', system: 'base' });
  assert.equal(out.action, 'wake'); assert.equal(out.system, 'base Wasm JS');
  await runtime.run('chat.search', { key: 'one' });
  assert.deepEqual(seen, ['chat.prompt']);
});
