'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MessagePlugins, execute } = require('../src/services/messagePlugins');

function fixture(t, executePlugin, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-message-plugin-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, 'plugins');
  fs.mkdirSync(root);
  const flow = { id: 'test-flow', api: 3, hooks: ['chat.pre_reply', 'chat.prompt', 'chat.reply'], permissions: [], wasm: '' };
  fs.writeFileSync(path.join(root, 'test-flow.flow.json'), JSON.stringify(flow));
  const hash = crypto.createHash('sha256').update(JSON.stringify(flow)).digest('hex');
  const grant = path.join(root, 'test-flow.flow-grant.json');
  fs.writeFileSync(grant, JSON.stringify({ enabled: true, hash, settings: {} }));
  return { plugins: new MessagePlugins({ dataDir, executePlugin, ...options }), root, grant };
}

test('plugin state survives runtime restart and is isolated per conversation', async t => {
  const seen = [];
  const executePlugin = async (_, input) => {
    seen.push(input.state.count || 0);
    return { action: 'wake', state: { count: (input.state.count || 0) + 1 } };
  };
  const { plugins, root } = fixture(t, executePlugin);
  await plugins.run('chat.pre_reply', { key: 'one' });
  await plugins.run('chat.pre_reply', { key: 'two' });
  const restarted = new MessagePlugins({ dataDir: path.dirname(root), executePlugin });
  await restarted.run('chat.pre_reply', { key: 'one' });
  assert.deepEqual(seen, [0, 0, 1]);
});

test('ungranted history and model prompt are withheld; invalid output commits no state', async t => {
  const { plugins, root } = fixture(t, async (_, input) => {
    assert.equal(input.history, undefined);
    assert.equal(input.system, undefined);
    return { system: 'unauthorized', state: { changed: true } };
  });
  const result = await plugins.run('chat.prompt', { key: 'one', system: 'original', history: ['private'] });
  assert.equal(result.system, 'original');
  assert.equal(fs.readdirSync(root).some(f => f.endsWith('.state.json')), false);
});

test('disable during execution discards action and state', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let finish;
  const { plugins, root, grant } = fixture(t, async () => {
    entered();
    await new Promise(resolve => { finish = resolve; });
    return { action: 'wake', state: { changed: true } };
  });
  const pending = plugins.run('chat.pre_reply', { key: 'one' });
  await started;
  fs.unlinkSync(grant);
  finish();
  assert.equal((await pending).action, 'pass');
  assert.equal(fs.readdirSync(root).some(f => f.endsWith('.state.json')), false);
});

test('control and bidi characters in plugin text are rejected without committing', async t => {
  const { plugins, root } = fixture(t, async () => ({ text: '正常\u0000伪造\u202E', state: { changed: true } }));
  const result = await plugins.run('chat.reply', { key: 'one', text: '原文' });
  assert.equal(result.text, '原文');
  assert.equal(fs.readdirSync(root).some(f => f.endsWith('.state.json')), false);
});

test('plugins cannot use the host to mention everyone', async t => {
  const { plugins } = fixture(t, async () => ({ text: '@所有人 快来' }));
  const result = await plugins.run('chat.reply', { key: 'one', text: '原文' });
  assert.equal(result.text, '原文');
});

test('concurrent sessions share the global execution cap', async t => {
  let active = 0;
  let peak = 0;
  const { plugins } = fixture(t, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 40));
    active -= 1;
    return {};
  }, { maxConcurrent: 2 });
  await Promise.all(['a', 'b', 'c', 'd'].map(key => plugins.run('chat.pre_reply', { key })));
  assert.equal(peak, 2);
});

test('real Wasm runner terminates a looping module', async () => {
  const module = '0061736d010000000105016000017f030201000707010372756e00000a0b01090003400c000b41000b';
  const before = Date.now();
  await assert.rejects(execute(Buffer.from(module, 'hex').toString('base64'), {}, 150), /timeout/);
  assert.ok(Date.now() - before < 1500);
});

function constantModule(value) {
  const unsigned = n => { const out = []; do { const b = n & 127; n >>>= 7; out.push(b | (n ? 128 : 0)); } while (n); return out; };
  const string = s => [...unsigned(Buffer.byteLength(s)), ...Buffer.from(s)];
  const section = (id, data) => [id, ...unsigned(data.length), ...data];
  const body = [0];
  for (const b of Buffer.from(JSON.stringify(value))) body.push(0x41, (b & 127) | 128, b >>> 7, 0x10, 0);
  body.push(0x41, 0, 0x0b);
  return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [2, 0x60, 1, 0x7f, 0, 0x60, 0, 1, 0x7f]),
    ...section(2, [1, ...string('whale'), ...string('output_byte'), 0, 0]),
    ...section(3, [1, 1]), ...section(7, [1, ...string('run'), 0, 1]),
    ...section(10, [1, ...unsigned(body.length), ...body])]);
}

test('real Wasm output is decoded and validated as JSON', async () => {
  const result = { action: 'wake', state: { left: 2 }, text: '测试' };
  assert.deepEqual(await execute(constantModule(result).toString('base64'), {}, 1500), result);
});

test('normal Bot entry point runs the reply plugin and records transformed text', async t => {
  const { Bot } = require('../src/pipeline/chat');
  const { Store } = require('../src/memory/store');
  const { DEFAULT_CONFIG } = require('../src/infra/config');
  const { plugins, root } = fixture(t, async (_, input) => input.hook === 'chat.reply' ? { text: '来自消息插件' } : {});
  const config = structuredClone(DEFAULT_CONFIG);
  config.paths = { dataDir: path.dirname(root) };
  config.persona.master = { names: [], wxids: [] };
  const store = new Store({ file: path.join(path.dirname(root), 'store.json'), limits: config.memory });
  t.after(() => store.close?.());
  const bot = new Bot({ config, store, llm: { isMock: true }, mockChunkDelayMs: 0 });
  bot.messagePlugins = plugins;
  const message = { platform: 'web', chatType: 'private', chatId: 'test-chat', senderId: 'test-sender', text: '你好' };
  const reply = await bot.handle(message);
  assert.equal(reply.action, 'reply');
  assert.match(reply.reply, /来自消息插件/);
  assert.match(store.messages(bot.sessionKey(message)).at(-1).text, /来自消息插件/);
});

test('installed Wasm can wake an unaddressed group message; disabling restores default trigger', async t => {
  const { Bot } = require('../src/pipeline/chat');
  const { Store } = require('../src/memory/store');
  const { DEFAULT_CONFIG } = require('../src/infra/config');
  const { plugins, root, grant } = fixture(t);
  const flowFile = path.join(root, 'test-flow.flow.json');
  const flow = JSON.parse(fs.readFileSync(flowFile));
  flow.hooks = ['chat.pre_reply'];
  flow.wasm = constantModule({ action: 'wake' }).toString('base64');
  fs.writeFileSync(flowFile, JSON.stringify(flow));
  fs.writeFileSync(grant, JSON.stringify({ enabled: true, hash: crypto.createHash('sha256').update(JSON.stringify(flow)).digest('hex') }));
  const config = structuredClone(DEFAULT_CONFIG);
  config.paths = { dataDir: path.dirname(root) };
  config.group.requireAt = true;
  config.group.freeChat = false;
  config.group.masterAlwaysReply = false;
  config.group.engagedMinutes = 0;
  config.persona.master = { names: [], wxids: [] };
  const store = new Store({ file: path.join(path.dirname(root), 'store.json'), limits: config.memory });
  t.after(() => store.close());
  const bot = new Bot({ config, store, llm: { isMock: true }, mockChunkDelayMs: 0 });
  bot.messagePlugins = plugins;
  const message = { platform: 'web', chatType: 'group', chatId: 'first-chat', senderId: 'test-sender', text: '今天有点热' };
  const first = await bot.handle(message);
  assert.equal(first.action, 'reply', JSON.stringify(first));
  assert.equal(first.reason, 'plugin');
  fs.unlinkSync(grant);
  const second = await bot.handle({ ...message, chatId: 'second-chat' });
  assert.equal(second.action, 'ignore');
});
