'use strict';

/**
 * 插件数据边界的行为测试（真实 UnifiedCapabilityDispatcher + UnifiedPluginRuntime，
 * 插件是真实启动的 4 级 Node worker 进程；不调用投影/state helper 自证）。
 *
 * 覆盖审查问题：
 * - enhance 链把上一步 output（chat.search 是 previous）交给未授权插件时，system/history
 *   必须按该插件自己的 dataAccess 投影，不能从嵌套字段泄漏；
 * - 未授权增强者读不到上一层 system 时，它返回的 system 不能覆盖前一层（no-op，不是清空）；
 * - complete 的完整 output 校验通过前不能写 state（非法 text/action 不污染会话状态）；
 * - 同插件排队时 state 在 worker 实际启动前读取，不是 invoke() 入队时的过期快照；
 * - state 与安装包版本绑定，同 id 更新后不继承旧 state；跨 platform/chatType 的
 *   同 chatId 不串状态。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const { UnifiedPluginRuntime } = require('../src/services/unifiedPluginRuntime');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-boundary-'));
  const root = path.join(dataDir, 'plugins');
  fs.mkdirSync(root);
  const runtime = new UnifiedPluginRuntime({ dataDir, logger: null });
  t.after(async () => {
    await runtime.stop();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });

  const install = (id, javascript, {
    dataAccess = [], version = '1.0.0', provides = { 'chat.reply@1': { mode: 'enhance', scope: 'all' } },
  } = {}) => {
    const directory = path.join(root, id);
    fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
    const manifest = { format: 'whale-plugin/1', level: 4, id, name: 'Boundary fixture', author: 'Tester',
      version, minAppVersion: '1.0.0', description: 'Boundary fixture plugin', appEpoch: 2,
      runtime: 'node-full', entry: 'plugin.js', provides, calls: [], dataAccess, executionTimeoutMs: 8000 };
    const raw = JSON.stringify(manifest);
    fs.writeFileSync(path.join(directory, 'plugin.json'), raw);
    fs.writeFileSync(path.join(directory, 'plugin.js'), javascript);
    fs.writeFileSync(path.join(directory, 'grant.json'), JSON.stringify({ epoch: randomUUID(),
      packageHash: sha256(raw + javascript), manifestHash: sha256(raw), entryHash: sha256(javascript),
      enabled: true, level: 4, fullAccess: true, nodeFullConfirmed: true, chatConfirmed: true,
      approvedCalls: [], approvedProviders: Object.keys(provides), approvedDataAccess: dataAccess,
      settings: {} }));
    return directory;
  };

  const readJSON = (directory, name) => JSON.parse(fs.readFileSync(path.join(directory, 'data', name), 'utf8'));
  return { runtime, install, readJSON };
}

function dispatcherFor(runtime) {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: runtime, logger: null });
  dispatcher.define('chat.prompt@1', { builtin: async input => ({ system: input.system }) });
  dispatcher.define('chat.reply@1', { builtin: async input => ({ text: input.text }) });
  dispatcher.define('chat.generate@1', { builtin: async () => ({ text: '' }) });
  dispatcher.define('chat.pre_reply@1', { builtin: async () => ({ action: 'pass' }) });
  return dispatcher;
}

const chatMessage = (overrides = {}) => ({
  platform: 'web', chatType: 'private', chatId: 'c1', senderId: 'u1', text: '在吗', ...overrides,
});
const promptInput = (overrides = {}) => ({
  message: chatMessage(), system: 'HOST-SYSTEM', history: [{ role: 'user', text: '前置历史' }], ...overrides,
});
const replyInput = (text, overrides = {}) => ({ message: chatMessage({ text, ...overrides }), text: '' });
const generateInput = text => ({
  message: chatMessage({ text }),
  system: 'HOST-SYSTEM',
  turns: [{ role: 'user', content: 'OLD-USER-MESSAGE' }, { role: 'assistant', content: 'OLD-ASSISTANT-ANSWER' }],
});

async function waitForFile(file, timeoutMs = 5000) {
  const limit = Date.now() + timeoutMs;
  while (Date.now() < limit) {
    if (fs.existsSync(file)) return;
    await delay(10);
  }
  throw new Error('timeout waiting for ' + path.basename(file));
}

test('chat.prompt 增强链：未授权插件读不到、也覆盖不了前一层已授权的 system/history', async t => {
  const { runtime, install, readJSON } = setup(t);
  const grantedDir = install('a-granted', `const fs = require('node:fs');
exports.providers = { 'chat.prompt@1': input => {
  fs.writeFileSync('seen-granted.json', JSON.stringify(input));
  return { system: input.system + '\\n[granted]' };
} };`, { dataAccess: ['model.prompt', 'chat.history'], provides: { 'chat.prompt@1': { mode: 'enhance', scope: 'all' } } });
  const probe = install('b-unauthorized', `const fs = require('node:fs');
exports.providers = { 'chat.prompt@1': input => {
  fs.writeFileSync('seen-unauthorized.json', JSON.stringify(input));
  return { system: 'UNAUTHORIZED-WIPE' };
} };`, { provides: { 'chat.prompt@1': { mode: 'enhance', scope: 'all' } } });

  const dispatcher = dispatcherFor(runtime);
  const result = await dispatcher.invoke('chat.prompt@1', promptInput(), { key: 'k', chatId: 'c1' });

  const granted = readJSON(grantedDir, 'seen-granted.json');
  assert.equal(granted.system, 'HOST-SYSTEM', '已授权插件仍能拿到 system');
  assert.deepEqual(granted.history, [{ role: 'user', text: '前置历史' }]);

  const seen = readJSON(probe, 'seen-unauthorized.json');
  assert.equal('system' in seen, false, '未授权插件不得在顶层拿到 system');
  assert.equal('history' in seen, false, '未授权插件不得在顶层拿到 history');
  assert.equal(seen.output?.system, undefined, '未授权插件不得从上一层 output 里读到 system');
  const raw = JSON.stringify(seen);
  assert.equal(raw.includes('HOST-SYSTEM'), false, '未授权插件输入里不得出现前层 system');
  assert.equal(raw.includes('前置历史'), false, '未授权插件输入里不得出现前层 history');

  assert.equal(result.system, 'HOST-SYSTEM\n[granted]',
    '未授权增强者返回的 system 必须按 no-op 处理，不能清空/覆盖前一层');
});

test('chat.reply：非法 output 的 complete 不写 state，下一次调用读不到它', async t => {
  const { runtime, install, readJSON } = setup(t);
  const plugin = install('poison', `const fs = require('node:fs');
exports.providers = { 'chat.reply@1': input => {
  const label = input.message.text;
  fs.writeFileSync('seen-' + label + '.json', JSON.stringify(input.state === undefined ? null : input.state));
  if (input.message.text === 'bad') return { text: 123, state: { poison: true } };
  return { text: 'ok', state: { safe: true } };
} };`);

  const dispatcher = dispatcherFor(runtime);
  const first = await dispatcher.invoke('chat.reply@1', replyInput('bad'), { key: 'k1', chatId: 'c1' });
  assert.equal(first.text, '', '非法 text 被拒绝后落到 builtin 输出，不能把非法值透传');
  await dispatcher.invoke('chat.reply@1', replyInput('ok'), { key: 'k2', chatId: 'c1' });
  assert.deepEqual(readJSON(plugin, 'seen-ok.json'), {},
    '非法 output 里的 state 不得先落库，被拒绝时必须整体丢弃');
});

test('直接 runtime.invoke（无 dispatcher 校验回调）也不会把非法 output 的 state 落库', async t => {
  const { runtime, install, readJSON } = setup(t);
  const plugin = install('direct-poison', `const fs = require('node:fs');
exports.providers = { 'chat.reply@1': input => {
  const label = input.message.text;
  fs.writeFileSync('seen-' + label + '.json', JSON.stringify(input.state === undefined ? null : input.state));
  if (label === 'bad') return { text: 123, state: { poison: true } };
  return { text: 'ok', state: { safe: true } };
} };`);
  const [flow] = runtime.installed();
  await assert.rejects(runtime.invoke(flow, 'chat.reply@1', replyInput('bad'), { chatId: 'c1' }),
    { code: 'invalid_capability_output' });
  await runtime.invoke(flow, 'chat.reply@1', replyInput('ok'), { chatId: 'c1' });
  assert.deepEqual(readJSON(plugin, 'seen-ok.json'), {},
    'runtime 自己按注册表 outputSchema 校验，不能依赖调用方传 validateOutput');
});

test('chat.pre_reply：非法 action 的 complete 不写 state', async t => {
  const { runtime, install, readJSON } = setup(t);
  const plugin = install('gate-poison', `const fs = require('node:fs');
exports.providers = { 'chat.pre_reply@1': input => {
  fs.writeFileSync('seen-' + (input.message.text === 'bad-action' ? 'bad' : 'ok') + '.json',
    JSON.stringify(input.state === undefined ? null : input.state));
  if (input.message.text === 'bad-action') return { action: 'explode', state: { poison: true } };
  return { action: 'pass' };
} };`, { provides: { 'chat.pre_reply@1': { mode: 'gate', scope: 'all' } } });

  const dispatcher = dispatcherFor(runtime);
  const failed = await dispatcher.invoke('chat.pre_reply@1', { message: chatMessage({ text: 'bad-action' }), localWechat: false },
    { key: 'k1', chatId: 'c1' });
  assert.deepEqual(failed, { action: 'pass' }, '门禁输出非法时 fail-open');
  await dispatcher.invoke('chat.pre_reply@1', { message: chatMessage({ text: 'ok' }), localWechat: false }, { key: 'k2', chatId: 'c1' });
  assert.deepEqual(readJSON(plugin, 'seen-ok.json'), {},
    '非法 action 随同的 state 不得先落库');
});

test('同插件排队：state 在 worker 实际启动前读取，拿到前一次调用刚写入的一版', async t => {
  const { runtime, install, readJSON } = setup(t);
  const plugin = install('queue-state', `const fs = require('node:fs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.providers = { 'chat.reply@1': async input => {
  const label = input.message.text;
  fs.writeFileSync('seen-' + label + '.json', JSON.stringify(input.state === undefined ? null : input.state));
  if (input.message.text === 'first') {
    fs.writeFileSync('running', '1');
    const limit = Date.now() + 5000;
    while (Date.now() < limit && !fs.existsSync('go')) await wait(5);
    return { text: 'first', state: { turn: 1 } };
  }
  return { text: 'second', state: { turn: 2 } };
} };`);

  const dispatcher = dispatcherFor(runtime);
  const first = dispatcher.invoke('chat.reply@1', replyInput('first'), { key: 'k1', chatId: 'c1' });
  await waitForFile(path.join(plugin, 'data', 'running'));
  // 不同 session key，让第二次调用真正排到 runtime 的同插件队列里（而不是被 dispatcher 串行）。
  const second = dispatcher.invoke('chat.reply@1', replyInput('second'), { key: 'k2', chatId: 'c1' });
  await delay(150);
  fs.writeFileSync(path.join(plugin, 'data', 'go'), '1');
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.text, 'first');
  assert.equal(two.text, 'second');
  assert.deepEqual(readJSON(plugin, 'seen-second.json'), { turn: 1 },
    '排队调用必须在实际运行前读取 state，不能沿用 invoke 入队时的空快照');
});

test('state 与安装包版本绑定：同 id 更新后不继承旧版本的 state', async t => {
  const { runtime, install, readJSON } = setup(t);
  const source = version => `const fs = require('node:fs');
exports.providers = { 'chat.reply@1': input => {
  const label = input.message.text;
  fs.writeFileSync('seen-' + label + '.json', JSON.stringify(input.state === undefined ? null : input.state));
  return { text: '${version}', state: { version: '${version}' } };
} };`;
  install('versioned', source('v1'), { version: '1.0.0' });
  const dispatcher = dispatcherFor(runtime);
  await dispatcher.invoke('chat.reply@1', replyInput('first'), { key: 'k1', chatId: 'c1' });

  install('versioned', source('v2'), { version: '1.0.1' });
  assert.equal(runtime.installed().length, 1);
  await dispatcher.invoke('chat.reply@1', replyInput('second'), { key: 'k2', chatId: 'c1' });
  assert.deepEqual(readJSON(path.join(runtime.root, 'versioned'), 'seen-second.json'), {},
    '同一插件 id 换了安装包后，新版本不得读到旧版本写入的 state');
});

test('state 作用域：跨 platform/chatType 的同 chatId 不串状态', async t => {
  const { runtime, install, readJSON } = setup(t);
  const plugin = install('scoped', `const fs = require('node:fs');
exports.providers = { 'chat.reply@1': input => {
  const label = input.message.text;
  fs.writeFileSync('seen-' + label + '.json', JSON.stringify(input.state === undefined ? null : input.state));
  return { text: 'ok', state: { platform: input.message.platform } };
} };`);

  const dispatcher = dispatcherFor(runtime);
  await dispatcher.invoke('chat.reply@1',
    replyInput('a', { platform: 'web', chatType: 'private', chatId: 'same' }), { key: 'k1', chatId: 'same' });
  await dispatcher.invoke('chat.reply@1',
    replyInput('b', { platform: 'wechat', chatType: 'group', chatId: 'same' }), { key: 'k2', chatId: 'same' });
  assert.deepEqual(readJSON(plugin, 'seen-b.json'), {},
    '同 chatId 换 platform/chatType 就是另一个会话，不能继承 state');

  // 反过来：同 platform/chatType/chatId 仍应共享 state（同一会话的连续调用）。
  await dispatcher.invoke('chat.reply@1',
    replyInput('c', { platform: 'web', chatType: 'private', chatId: 'same' }), { key: 'k3', chatId: 'same' });
  assert.deepEqual(readJSON(plugin, 'seen-c.json'), { platform: 'web' });
});

test('chat.generate：没有 chat.history 授权时 turns 清空但字段保留，当前 message 仍可用', async t => {
  const { runtime, install, readJSON } = setup(t);
  const plugin = install('gen-plain', `const fs = require('node:fs');
exports.providers = { 'chat.generate@1': input => {
  fs.writeFileSync('seen-' + input.message.text + '.json', JSON.stringify(input));
  return { text: 'generated' };
} };`, { provides: { 'chat.generate@1': { mode: 'replace', scope: 'all' } } });

  const dispatcher = dispatcherFor(runtime);
  const result = await dispatcher.invoke('chat.generate@1', generateInput('plain'), { key: 'k', chatId: 'c1' });
  assert.equal(result.text, 'generated', '未授权固定生成能力仍必须能运行');
  const seen = readJSON(plugin, 'seen-plain.json');
  assert.deepEqual(seen.turns, [], 'turns 字段保留（schema 必填）但会话内容清空');
  assert.equal(seen.message.text, 'plain', '当前 message 不受 chat.history 授权影响');
  assert.equal(JSON.stringify(seen).includes('OLD-ASSISTANT-ANSWER'), false,
    '未授权插件不得从 turns 读到历史助手内容');
  assert.equal('system' in seen, false, '未声明 model.prompt 仍不给 system');
});

test('chat.generate：声明 chat.history 后拿回完整 turns，system 仍按各自授权独立发放', async t => {
  const { runtime, install, readJSON } = setup(t);
  const plugin = install('gen-history', `const fs = require('node:fs');
exports.providers = { 'chat.generate@1': input => {
  fs.writeFileSync('seen-' + input.message.text + '.json', JSON.stringify(input));
  return { text: 'generated' };
} };`, { dataAccess: ['chat.history'], provides: { 'chat.generate@1': { mode: 'replace', scope: 'all' } } });

  const dispatcher = dispatcherFor(runtime);
  await dispatcher.invoke('chat.generate@1', generateInput('history'), { key: 'k', chatId: 'c1' });
  const seen = readJSON(plugin, 'seen-history.json');
  assert.deepEqual(seen.turns, generateInput('').turns, '声明 chat.history 应拿到完整 turns');
  assert.equal(seen.message.text, 'history');
  assert.equal('system' in seen, false, '只声明 history 不等于声明 model.prompt');
});

test('lastBot/now 属于默认接话上下文：不按 chat.history 裁剪，未授权 chat.prompt 也保留', async t => {
  const { runtime, install, readJSON } = setup(t);
  const plugin = install('followup', `const fs = require('node:fs');
exports.providers = { 'chat.prompt@1': input => {
  fs.writeFileSync('seen.json', JSON.stringify(input));
  return { system: input.output ? input.output.system : 'probe' };
} };`, { provides: { 'chat.prompt@1': { mode: 'enhance', scope: 'all' } } });

  const dispatcher = dispatcherFor(runtime);
  const lastBot = { text: 'BOT-LAST-REPLY', at: 1699999999000, targetId: 'u1' };
  await dispatcher.invoke('chat.prompt@1', { ...promptInput(), now: 1700000000000, lastBot },
    { key: 'k', chatId: 'c1' });
  const seen = readJSON(plugin, 'seen.json');
  assert.equal(seen.now, 1700000000000, 'now 是宿主时钟，不能裁掉');
  assert.deepEqual(seen.lastBot, lastBot, 'lastBot 是旧 Api3 的默认接话上下文，不能被 chat.history 误伤');
  assert.equal('system' in seen, false, '同一条输入里的 system 仍按 model.prompt 授权裁剪');
  assert.equal('history' in seen, false);
});
