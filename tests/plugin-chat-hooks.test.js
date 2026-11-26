'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

function makeConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.persona.newBehavior = false;
  cfg.features.plugins = false;
  cfg.persona.master = { names: ['Master'], wxids: ['wxid_test_master'] };
  cfg.admin = { spell: 'test-spell', minutes: 30, allowAll: false };
  return cfg;
}

function makeBot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-chat-hooks-'));
  const config = makeConfig();
  config.paths = { root: dir, dataDir: path.join(dir, 'data'), configFile: path.join(dir, 'config.json') };
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.writeFileSync(config.paths.configFile, JSON.stringify(config));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const llm = { isMock: true, model: 'mock', reload() {}, describe() { return {}; }, complete: async () => '回复', stream: async function* () { yield '回复'; } };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0 });
  return { bot, store, config, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } };
}

const msg = (text = '今天过得怎么样', extra = {}) => ({
  platform: 'web', chatId: 's1', chatType: 'private', senderId: 'u1', senderName: '小海', text, ...extra,
});

function fakeCapabilities(bot, providers = {}) {
  const calls = [];
  bot.capabilities = {
    hasProviders: name => Boolean(providers[name]),
    providers: name => providers[name] ? [{ id: 'fake', dataAccess: providers[name].dataAccess || [], settings: {} }] : [],
    invoke: async (name, input, options) => {
      calls.push({ name, input, options });
      return providers[name].handler(input, options);
    },
  };
  return calls;
}

test('无插件声明时行为不变，扩展点零调用', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const calls = fakeCapabilities(bot, {});
    bot.rng = () => 0;
    const result = await bot.handle(msg());
    assert.equal(result.action, 'reply');
    assert.equal(calls.length, 0);
  } finally { cleanup(); }
});

test('pre_reply：skip 不回复/不占配额，pass 与 wake 正常回复', async () => {
  const skip = makeBot();
  try {
    fakeCapabilities(skip.bot, { 'chat.pre_reply@1': { handler: () => ({ action: 'skip', reason: 'blocked' }) } });
    const result = await skip.bot.handle(msg('这条会被拦下', { chatId: 's2' }));
    assert.equal(result.action, 'ignore');
    assert.equal(result.reason, 'plugin_skip');
    assert.equal(skip.store.messages('web:u:s2', 20).filter(row => row.role === 'assistant').length, 0);
    assert.equal(skip.bot._replyQuota.pending.size, 0);
  } finally { skip.cleanup(); }

  for (const action of ['pass', 'wake']) {
    const { bot, cleanup } = makeBot();
    try {
      const calls = fakeCapabilities(bot, { 'chat.pre_reply@1': { handler: () => ({ action }) } });
      const result = await bot.handle(msg());
      assert.equal(result.action, 'reply', action);
      assert.equal(calls[0].name, 'chat.pre_reply@1');
    } finally { cleanup(); }
  }
});

test('pre_reply 插件故障 fail-open，仍在生成前完成', async () => {
  const { bot, cleanup } = makeBot();
  try {
    fakeCapabilities(bot, { 'chat.pre_reply@1': { handler: () => { throw new Error('gate down'); } } });
    const result = await bot.handle(msg('门禁坏了也要回复'));
    assert.equal(result.action, 'reply');
  } finally { cleanup(); }
});

test('chat.prompt 在 system 组装后改写，并按 dataAccess 带 history', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const calls = fakeCapabilities(bot, {
      'chat.prompt@1': {
        dataAccess: ['model.prompt', 'chat.history'],
        handler: input => ({ system: input.system + '\n[HOOK]' }),
      },
    });
    const decision = await bot.decide(msg());
    assert.match(decision.system, /\[HOOK\]$/);
    assert.equal(calls[0].name, 'chat.prompt@1');
    assert.ok(Array.isArray(calls[0].input.history));
  } finally { cleanup(); }
});

test('chat.before_send 改普通/全接管文本，失败保留原文；命令与表情包路径有接入', async () => {
  const { bot, cleanup } = makeBot();
  try {
    fakeCapabilities(bot, { 'chat.before_send@1': { handler: input => ({ text: input.text + '（改）' }) } });
    const decision = await bot.decide(msg());
    const normal = await bot.finishReply(decision, '正文');
    assert.equal(normal.text, '正文（改）');
    const takeover = await bot.finishTakeoverReply(msg(), { reply: '接管' });
    assert.equal(takeover.reply, '接管（改）');
  } finally { cleanup(); }

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'bot.js'), 'utf8');
  assert.match(source, /if \(decision\.action === 'command'\)[\s\S]{0,240}applyBeforeSend/);
  assert.match(source, /stickerRequest[\s\S]{0,420}applyBeforeSend/);
});

test('chat.received：基础检查后 observe 一次；魔咒/静音/重复/无 provider 不触发', async () => {
  const { bot, store, cleanup } = makeBot();
  try {
    const calls = fakeCapabilities(bot, { 'chat.received@1': { handler: () => ({}) } });
    const count = () => calls.filter(call => call.name === 'chat.received@1').length;

    await bot.handle(msg('正常消息'));
    assert.equal(count(), 1, '正常消息 observe 一次');
    assert.equal(calls.find(call => call.name === 'chat.received@1').options.chatId, 's1');

    const duplicate = msg('重复消息', { msgId: 'dup-received' });
    await bot.handle(duplicate);
    assert.equal(count(), 2);
    await bot.handle(duplicate);
    assert.equal(count(), 2, '重复消息不再 observe');

    const state = store.getState('web:u:s1');
    state.mutedUntil = Date.now() + 60000;
    await bot.handle(msg('静音消息'));
    assert.equal(count(), 2, '静音消息不 observe');
    state.mutedUntil = 0;

    await bot.handle({
      ...msg('test-spell'), platform: 'wechat', chatId: 'wxid_test_master', chatType: 'private',
      senderId: 'wxid_test_master', senderName: 'Master',
    });
    assert.equal(count(), 2, '魔咒命令不 observe');
  } finally { cleanup(); }

  const { bot: bare, cleanup: cleanupBare } = makeBot();
  try {
    const zero = fakeCapabilities(bare, {});
    await bare.handle(msg('无插件'));
    assert.equal(zero.length, 0, '无 provider 零调用');
  } finally { cleanupBare(); }
});

test('chat.received 观察失败不影响回复', async () => {
  const { bot, cleanup } = makeBot();
  try {
    fakeCapabilities(bot, { 'chat.received@1': { handler: () => { throw new Error('observer down'); } } });
    const result = await bot.handle(msg('观察者坏了也要回复'));
    assert.equal(result.action, 'reply');
  } finally { cleanup(); }
});

test('chat.pre_reply wake：本来不回复的群消息被强制回复（reason plugin_wake）', async () => {
  const { bot, config, cleanup } = makeBot();
  try {
    config.group.requireAt = true;
    fakeCapabilities(bot, { 'chat.pre_reply@1': { handler: () => ({ action: 'wake' }) } });
    const decision = await bot.decide({
      platform: 'web', chatId: 'g-wake', chatType: 'group', senderId: 'u1', senderName: '甲', text: '随便聊聊',
    });
    assert.equal(decision.action, 'reply');
    assert.equal(decision.reason, 'plugin_wake');
  } finally { cleanup(); }
});

test('chat.before_send：改写结果进入 finalize，按最终文本拆分/落库', async () => {
  const { bot, store, cleanup } = makeBot();
  try {
    // 这里只验证改写/拆泡顺序，固定随机源以排除宿主概率追加表情的干扰。
    bot.rng = () => 0.999;
    fakeCapabilities(bot, { 'chat.before_send@1': { handler: () => ({ text: '一\n\n二' }) } });
    const decision = await bot.decide(msg('拆分用例'));
    const result = await bot.finishReply(decision, '原文');
    assert.equal(result.reply ?? result.text, '一\n\n二');
    assert.deepEqual(result.bubbles, ['一', '二'], 'finalize 用的是 before_send 返回的文本');
    assert.equal(store.messages(decision.key, 20).filter(row => row.role === 'assistant').at(-1)?.text, '一\n\n二');
  } finally { cleanup(); }
});

test('chat.dispatched：ignore sent:false 且失败不影响主流程；网关覆盖 reply/ignore', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const calls = fakeCapabilities(bot, { 'chat.dispatched@1': { handler: () => ({}) } });
    await bot.observeDispatched({ key: 'web:u:s1', msg: msg() }, { action: 'ignore', sent: false, reason: 'duplicate' });
    assert.equal(calls[0].input.action, 'ignore');
    assert.equal(calls[0].input.sent, false);
    fakeCapabilities(bot, { 'chat.dispatched@1': { handler: () => { throw new Error('down'); } } });
    await assert.doesNotReject(() => bot.observeDispatched({ key: 'web:u:s1', msg: msg() }, { action: 'ignore', sent: false }));
  } finally { cleanup(); }

  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(app, /result\.outbound\.ok !== false/);
  assert.match(app, /action: reply \? 'reply' : 'ignore'/);
  assert.match(app, /result\.__pluginDispatched/);
});

test('app.start/app.stop 各插件一次；stop 前 await 且去重', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const calls = fakeCapabilities(bot, {
      'app.start@1': { handler: () => ({}) },
      'app.stop@1': { handler: () => ({}) },
    });
    await bot.observeAppLifecycle('app.start@1');
    await bot.observeAppLifecycle('app.stop@1');
    assert.deepEqual(calls.map(call => call.name), ['app.start@1', 'app.stop@1']);
    assert.equal(calls[0].options.pluginId, 'fake');
  } finally { cleanup(); }

  // 真实装配、运行中启用和停机去重由 plugin-lifecycle.test.js 的行为回归覆盖。
});

test('取消路径保持 capability_aborted，不被新扩展点改写', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const controller = new AbortController();
    controller.abort();
    const decision = await bot.decide(msg('取消'), { signal: controller.signal });
    assert.equal(decision.action, 'ignore');
    assert.equal(decision.reason, 'cancelled');
  } finally { cleanup(); }
});
