'use strict';

/**
 * 扩展点独立验收测试（task-100）。
 *
 * 与 tests/plugin-chat-hooks.test.js 的区别：这里不用 union 式假 capabilities，
 * 而是用真实的 UnifiedCapabilityDispatcher + runtime 的 projectDataAccess 投影，
 * 只把「插件运行器」换成记录输入的假 runtime。这样 per-plugin dataAccess 是否真的
 * 按插件发放、gate/enhance/observe 的组合语义是否成立，都由产品代码决定，测试不做假设。
 *
 * 已知审查点：chat.prompt@1 的 system 如果不受 dataAccess 约束（bot.js 无条件放进
 * input、运行时只剥离 chat.reply@1），A 插件声明 model.prompt、B 未声明时，B 会拿到
 * system。第 1 条用例就是钉住这个行为，修好后应转绿。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { projectDataAccess } = require('../src/services/unifiedPluginRuntime');

// 全部 12 个 provider 都登记契约：bot 在 _decide 里会 hasProviders 查它们，
// 未登记会抛 unknown_capability，与扩展点本身无关。
const BUILTINS = {
  'tool.run@1': async () => ({}),
  'chat.handle@1': async () => ({ action: 'ignore', reason: 'no_handle_plugin' }),
  'chat.generate@1': async () => ({ text: '回复' }),
  'chat.reply@1': async input => ({ text: input.text }),
  'chat.search@1': async () => ({ status: 'empty', text: '', items: [] }),
  'task.tick@1': async () => ({}),
  'chat.pre_reply@1': async () => ({ action: 'pass' }),
  'chat.received@1': async () => ({}),
  'chat.prompt@1': async input => ({ system: input.system }),
  'chat.before_send@1': async input => ({ text: input.text }),
  'chat.dispatched@1': async () => ({}),
  'app.start@1': async () => ({}),
  'app.stop@1': async () => ({}),
};

function makeConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.persona.newBehavior = false;
  cfg.features.plugins = false;
  cfg.persona.master = { names: ['Master'], wxids: ['wxid_test_master'] };
  cfg.admin = { spell: 'test-spell', minutes: 30, allowAll: false };
  return cfg;
}

function makeBot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-hooks-verify-'));
  const config = makeConfig();
  config.paths = { root: dir, dataDir: path.join(dir, 'data'), configFile: path.join(dir, 'config.json') };
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.writeFileSync(config.paths.configFile, JSON.stringify(config));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const llm = {
    isMock: true, model: 'mock', reload() {}, describe() { return {}; },
    complete: async () => '回复',
    stream: async function* () { yield '回复'; },
  };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0 });
  return {
    bot,
    store,
    config,
    cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); },
  };
}

const msg = (text = '今天过得怎么样', extra = {}) => ({
  platform: 'web', chatId: 's1', chatType: 'private', senderId: 'u1', senderName: '小海', text, ...extra,
});

const provider = (id, capability, descriptor = { mode: 'enhance', scope: 'all' }, dataAccess = []) => ({
  id,
  provides: { [capability]: descriptor },
  dataAccess,
  settings: {},
});

/**
 * 真实 dispatcher + 假插件运行器：假运行器只在「worker 边界」上替换，
 * 仍然调用产品代码的 projectDataAccess 做 per-plugin 投影，再记录实际收到的输入。
 */
function installCapabilities(bot, plugins, behaviors) {
  const calls = [];
  const runtime = {
    installed: () => plugins,
    invoke: async (plugin, name, input, options) => {
      const projected = projectDataAccess(name, structuredClone(input), plugin.dataAccess || []);
      calls.push({ pluginId: plugin.id, name, input: projected, options: options || {} });
      const behavior = behaviors[plugin.id + '|' + name];
      if (!behavior) throw Object.assign(new Error('no_behavior:' + plugin.id + '|' + name), { code: 'plugin_error' });
      return behavior(projected, options || {});
    },
  };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: runtime, logger: null });
  for (const [name, builtin] of Object.entries(BUILTINS)) dispatcher.define(name, { builtin });
  bot.capabilities = dispatcher;
  return { dispatcher, calls, runtime };
}

const callsNamed = (calls, name) => calls.filter(call => call.name === name);

test('chat.prompt@1：system/history 按插件自己的 dataAccess 发放', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const plugins = [
      provider('a-granted', 'chat.prompt@1', undefined, ['model.prompt', 'chat.history']),
      provider('b-not-granted', 'chat.prompt@1'),
    ];
    const { calls } = installCapabilities(bot, plugins, {
      'a-granted|chat.prompt@1': input => ({ system: input.system + '\n[A]' }),
      // 未声明 dataAccess 的插件只能看到上一层的 output，不能看到原始 system/history
      'b-not-granted|chat.prompt@1': input => ({ system: input.output?.system || 'b-only' }),
    });

    const decision = await bot.decide(msg());
    const promptCalls = callsNamed(calls, 'chat.prompt@1');
    assert.equal(promptCalls.length, 2);
    assert.deepEqual(promptCalls.map(call => call.pluginId), ['a-granted', 'b-not-granted']);

    const [granted, notGranted] = promptCalls;
    assert.equal(typeof granted.input.system, 'string', '声明 model.prompt 的插件必须拿到 system');
    assert.ok(Array.isArray(granted.input.history), '声明 chat.history 的插件必须拿到 history');

    assert.equal(notGranted.input.system, undefined, '未声明 dataAccess 的插件不得拿到 system');
    assert.equal(notGranted.input.history, undefined, '未声明 dataAccess 的插件不得拿到 history');

    // 增强链：后一个插件基于前一层 output 返回，宿主最终采用它
    assert.match(decision.system, /\[A\]$/);
  } finally {
    cleanup();
  }
});

test('chat.prompt@1：没人声明聊天数据时不构造 history', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const { calls } = installCapabilities(bot, [provider('plain', 'chat.prompt@1')], {
      'plain|chat.prompt@1': input => ({ system: 'plain' }),
    });
    await bot.decide(msg());
    const [call] = callsNamed(calls, 'chat.prompt@1');
    assert.ok(call);
    assert.equal(call.input.system, undefined);
    assert.equal(call.input.history, undefined);
  } finally {
    cleanup();
  }
});

test('chat.pre_reply@1：skip 不回复不占配额；pass/wake 继续；故障 fail-open', async () => {
  for (const action of ['skip', 'pass', 'wake']) {
    const { bot, store, cleanup } = makeBot();
    try {
      const { calls } = installCapabilities(bot, [provider('gate', 'chat.pre_reply@1', { mode: 'gate', scope: 'all' })], {
        'gate|chat.pre_reply@1': () => (action === 'skip' ? { action, reason: 'blocked' } : { action }),
      });
      const result = await bot.handle(msg('门禁用例 ' + action, { chatId: 'gate-' + action }));
      assert.equal(callsNamed(calls, 'chat.pre_reply@1').length, 1, action + ' 应只问一次门禁');
      if (action === 'skip') {
        assert.equal(result.action, 'ignore');
        assert.equal(result.reason, 'plugin_skip');
        assert.equal(store.messages('web:u:gate-skip', 20).filter(row => row.role === 'assistant').length, 0,
          'skip 不产生助手回复');
        assert.equal(bot._replyQuota.pending.size, 0, 'skip 不占配额');
      } else {
        assert.equal(result.action, 'reply', action + ' 应继续正常回复');
      }
    } finally {
      cleanup();
    }
  }

  // gate 插件抛错：dispatcher fail-open 按 pass，正常回复不受影响
  const { bot, cleanup } = makeBot();
  try {
    installCapabilities(bot, [provider('broken', 'chat.pre_reply@1', { mode: 'gate', scope: 'all' })], {
      'broken|chat.pre_reply@1': () => { throw new Error('gate down'); },
    });
    const result = await bot.handle(msg('门禁坏了也要回复', { chatId: 'gate-broken' }));
    assert.equal(result.action, 'reply');
  } finally {
    cleanup();
  }
});

test('chat.before_send@1：普通回复与全接管都改写；失败保留原文', async () => {
  const normal = makeBot();
  try {
    const { calls } = installCapabilities(normal.bot, [provider('bs', 'chat.before_send@1')], {
      'bs|chat.before_send@1': input => ({ text: input.text + '（改）' }),
    });
    const decision = await normal.bot.decide(msg());
    const reply = await normal.bot.finishReply(decision, '正文');
    assert.equal(reply.text, '正文（改）');
    const takeover = await normal.bot.finishTakeoverReply(msg(), { reply: '接管' });
    assert.equal(takeover.reply, '接管（改）');
    const beforeSend = callsNamed(calls, 'chat.before_send@1');
    assert.equal(beforeSend.length, 2, '普通与接管两条路径都要经过 before_send');
    assert.deepEqual(beforeSend.map(call => call.input.text), ['正文', '接管']);
  } finally {
    normal.cleanup();
  }

  const failing = makeBot();
  try {
    installCapabilities(failing.bot, [provider('bs-fail', 'chat.before_send@1')], {
      'bs-fail|chat.before_send@1': () => { throw new Error('rewrite down'); },
    });
    const decision = await failing.bot.decide(msg());
    const reply = await failing.bot.finishReply(decision, '原文');
    assert.equal(reply.text, '原文', '改写失败必须保留原文');
  } finally {
    failing.cleanup();
  }
});

test('chat.dispatched@1：ignore 带 sent:false，真实发送带回 sent 与 outbound 语义', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const { calls } = installCapabilities(bot, [provider('obs', 'chat.dispatched@1', { mode: 'observe', scope: 'all' })], {
      'obs|chat.dispatched@1': () => ({}),
    });
    const decision = { key: 'web:u:s1', msg: msg() };
    await bot.observeDispatched(decision, { action: 'ignore', sent: false, reason: 'duplicate' });
    const first = callsNamed(calls, 'chat.dispatched@1');
    // 已知缺陷（task-100 审查项）：registry 的 chat.dispatched.input@1 message schema
    // 缺 replyToBot，而 bot.providerMessage 永远带它 → invoke 被 invalid_capability_input
    // 拒绝且被 observeDispatched 静默吞掉。修 schema 前这条保持红灯。
    assert.equal(first.length, 1,
      'chat.dispatched 观察者没收到 ignore 事件：检查 registry message schema 是否缺 replyToBot');
    const ignored = first[0];
    assert.equal(ignored.input.action, 'ignore');
    assert.equal(ignored.input.sent, false);
    assert.equal(ignored.input.reason, 'duplicate');

    await bot.observeDispatched(decision, { action: 'reply', text: '已发', sent: true });
    const sentCall = callsNamed(calls, 'chat.dispatched@1')[1];
    assert.equal(sentCall.input.action, 'reply');
    assert.equal(sentCall.input.sent, true);
    assert.equal(sentCall.input.text, '已发');

    // 观察者失败不影响主流程
    installCapabilities(bot, [provider('obs-fail', 'chat.dispatched@1', { mode: 'observe', scope: 'all' })], {
      'obs-fail|chat.dispatched@1': () => { throw new Error('observer down'); },
    });
    await assert.doesNotReject(() => bot.observeDispatched(decision, { action: 'ignore', sent: false }));

    // 真实发送的 sent 由网关结果推导（app.js 包装层），这里核对装配没有丢语义
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.match(app, /result\.outbound\.ok !== false/, 'sent 必须来自 outbound 结果');
    assert.match(app, /action: reply \? 'reply' : 'ignore'/);
    assert.match(app, /result\.__pluginDispatched/, 'bot 已观察的 ignore 不能被网关重复观察');
    assert.match(app, /consumeDispatchedIgnore/);
  } finally {
    cleanup();
  }
});

test('app.start@1 / app.stop@1：每个插件各一次，payload 带 at 与 settings', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const plugins = [
      provider('p1', 'app.start@1', { mode: 'observe', scope: 'all' }),
      provider('p2', 'app.start@1', { mode: 'observe', scope: 'all' }),
      provider('p1', 'app.stop@1', { mode: 'observe', scope: 'all' }),
      provider('p2', 'app.stop@1', { mode: 'observe', scope: 'all' }),
    ];
    // 同一插件可以同时提供 start/stop；installed() 里每个 id 只放一条
    const installed = [
      { ...plugins[0], provides: { 'app.start@1': { mode: 'observe', scope: 'all' }, 'app.stop@1': { mode: 'observe', scope: 'all' } } },
      { ...plugins[1], provides: { 'app.start@1': { mode: 'observe', scope: 'all' }, 'app.stop@1': { mode: 'observe', scope: 'all' } } },
    ];
    const { calls } = installCapabilities(bot, installed, {
      'p1|app.start@1': () => ({}), 'p2|app.start@1': () => ({}),
      'p1|app.stop@1': () => ({}), 'p2|app.stop@1': () => ({}),
    });

    await bot.observeAppLifecycle('app.start@1');
    const starts = callsNamed(calls, 'app.start@1');
    assert.deepEqual(starts.map(call => call.pluginId).sort(), ['p1', 'p2']);
    assert.equal(starts.length, 2, '每个插件只触发一次');
    for (const call of starts) {
      assert.equal(typeof call.input.at, 'number');
      assert.deepEqual(call.input.settings, {});
    }

    await bot.observeAppLifecycle('app.stop@1');
    const stops = callsNamed(calls, 'app.stop@1');
    assert.deepEqual(stops.map(call => call.pluginId).sort(), ['p1', 'p2']);
    assert.equal(stops.length, 2, 'stop 每个插件一次');

    // 真正的启停装配与去重由 plugin-lifecycle.test.js 验证，不绑定内部函数命名。
  } finally {
    cleanup();
  }
});

test('无插件时：六个扩展点零调用，聊天行为不变', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const { calls } = installCapabilities(bot, [], {});
    const result = await bot.handle(msg());
    assert.equal(result.action, 'reply');
    assert.equal(calls.length, 0, '无插件时不能调用任何扩展点');

    await bot.observeAppLifecycle('app.start@1');
    await bot.observeAppLifecycle('app.stop@1');
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});
