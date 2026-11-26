'use strict';

/**
 * followup-window（旧 Api3 接话插件）的跨轮闭环回归。
 *
 * 为什么要有这个文件：审查发现 unifiedWasm 的 api3 信封把 lastBot 写死成 null，而这个
 * 插件的 reference.js 第 89 行「没有上一条机器人回复就直接 pass」，于是 state 和 wake
 * 都接上了、插件本身却永远不接话——功能看着在、其实没工作。这里钉住的是**真实链路**：
 * 真实 Bot 管线 → 真实 UnifiedCapabilityDispatcher → 真实 UnifiedPluginRuntime 的授权、
 * 排队、state 读写与输出校验 → 真实旧 Wasm 字节码 → 再回到下一轮判定。
 *
 * 只在「worker 子进程」这一层替换：沙箱/CI 里 spawn 不可靠，进程内执行同一份字节码，
 * 其余（信封、state、授权、fail-open）全部由产品代码决定。不需要微信、不联网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { UnifiedPluginRuntime } = require('../src/services/unifiedPluginRuntime');
const { compileRestricted, executeRestricted, buildWasmPayload, compatOutput } =
  require('../src/services/unifiedWasm');

const FIXTURES = path.join(__dirname, 'fixtures', 'old-wasm');
const WASM = {
  'followup-window': path.join(FIXTURES, 'followup-window.wasm'),
  'context-notes': path.join(FIXTURES, 'context-notes.wasm'),
};
const skip = Object.values(WASM).every(file => fs.existsSync(file))
  ? false : 'tests/fixtures/old-wasm/*.wasm 不在仓库里';
// 兄弟市场仓库里的参考实现：有就做逐条差分，没有就只跑真实字节码（CI 不依赖它）。
const REFERENCE = path.join(__dirname, '..', '..', 'whale-girl-plugins',
  'plugins', 'followup-window', 'src', 'reference.js');

const T0 = Date.parse('2026-11-25T12:00:00.000Z');
const WINDOW_MS = 180000;

/* 全部 12 个 provider 都登记契约：Bot 会 hasProviders 查它们，未登记会抛 unknown_capability。 */
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

/**
 * 只在 worker 边界上替换的运行时：授权/排队/state/输出校验仍然走 UnifiedPluginRuntime，
 * 子进程换成进程内执行同一份 Wasm（与 unifiedWasmWorker 的调用参数保持一致）。
 */
class InProcessWasmRuntime extends UnifiedPluginRuntime {
  spawn(job) {
    try { this.prepare(job); } catch (failure) { this.finish(job, failure); return; }
    job.running = true;
    let value;
    let ok = true;
    try {
      const module = compileRestricted(Buffer.from(job.flow.source, 'base64'), job.flow.level);
      value = executeRestricted(module, job.flow.level, job.capability, job.payload,
        job.flow.settings, job.flow.compat, job.state);
    } catch { ok = false; }
    this.receive(job, { type: 'complete', invocation: job.invocation, ok, value });
  }
}

/** 按安装目录的真实布局落一份 3 级 api3 插件，grant.json 与 read() 的校验项对齐。 */
function installPlugin(root, id, manifest, wasmFile) {
  const dir = path.join(root, 'plugins', id);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const payload = fs.readFileSync(wasmFile);
  const raw = Buffer.from(JSON.stringify({
    format: 'whale-plugin/1', level: 3, id, name: '接话窗口', author: 'tester', version: '2.0.0',
    minAppVersion: '4.3.0', description: 'followup-window 兼容回归',
    entry: 'plugin.wasm', runtime: 'wasm-restricted',
    provides: {
      'chat.pre_reply@1': { mode: 'gate', scope: 'all' },
      'chat.reply@1': { mode: 'enhance', scope: 'all' },
    },
    calls: [], compat: 'api3', ...manifest,
  }));
  fs.writeFileSync(path.join(dir, 'plugin.json'), raw);
  fs.writeFileSync(path.join(dir, 'plugin.wasm'), payload);
  fs.writeFileSync(path.join(dir, 'grant.json'), JSON.stringify({
    enabled: true, epoch: crypto.randomUUID(), packageHash: 'a'.repeat(64), level: 3,
    manifestHash: crypto.createHash('sha256').update(raw).digest('hex'),
    entryHash: crypto.createHash('sha256').update(payload).digest('hex'),
    approvedProviders: Object.keys(JSON.parse(raw.toString('utf8')).provides),
    approvedCalls: [], approvedDataAccess: [], settings: {},
    fullAccess: false, nodeFullConfirmed: false, chatConfirmed: true,
  }));
  return dir;
}

function makeConfig(root) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.newBehavior = false;
  config.features.plugins = false;
  config.persona.master = { names: ['Master'], wxids: ['wxid_test_master'] };
  config.admin = { spell: 'test-spell', minutes: 30, allowAll: false };
  // 关键：宿主的「接话窗口」至少 1 分钟（trigger.js:66 + sessionState 的 Math.max(1, …)），
  // 它会自己唤醒同一人的追问。用例把时间推到 1 分钟之后，才分得清「宿主本来就要回」
  // 和「插件把这条唤醒了」——否则测出来的是宿主触发，不是插件。
  config.group.engagedMinutes = 1;
  config.group.requireAt = true;
  config.group.freeChat = false;
  config.group.cooldownSec = 0;
  config.paths = { root, dataDir: path.join(root, 'data'), configFile: path.join(root, 'config.json') };
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.writeFileSync(config.paths.configFile, JSON.stringify(config));
  return config;
}

/**
 * 组装一套「真管线」：Bot + 真 dispatcher + 真 runtime（进程内 worker），时钟可控。
 * mock LLM 只负责给出一句可落库的正文，本次要验的是插件判定与 state 传递。
 */
function makeHarness(t, { pluginId = 'followup-window', wasm = WASM['followup-window'], manifest = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-followup-'));
  const clock = { at: T0 };
  const config = makeConfig(root);
  const store = new Store({ file: path.join(root, 'store.json'), limits: config.memory });
  const llm = {
    isMock: true, model: 'mock', reload() {}, describe() { return {}; },
    complete: async () => '我在呢', stream: async function* () { yield '我在呢'; },
  };
  const bot = new Bot({ config, store, llm, logger: null, now: () => new Date(clock.at),
    rng: () => 0.99, mockChunkDelayMs: 0 });
  installPlugin(root, pluginId, manifest, wasm);
  const runtime = new InProcessWasmRuntime({ dataDir: root, enabled: () => true });
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: runtime, logger: null });
  for (const [name, builtin] of Object.entries(BUILTINS)) dispatcher.define(name, { builtin });
  bot.capabilities = dispatcher;
  t.after(() => {
    runtime.closed = true;
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });
  return { bot, store, runtime, dispatcher, clock, root };
}

const groupMsg = (senderId, text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1', chatType: 'group', senderId,
  senderName: senderId === 'u1' ? '甲' : '乙', text, ...extra,
});

test('接话窗口闭环：第一次回复开窗、同一人 180 秒内追问被唤醒、别人插话当场收口', { skip }, async t => {
  const { bot, store, clock } = makeHarness(t);

  // ① 被 @ 的一问一答：正常回复并落库，插件在 chat.reply 里把窗口重开成 3 句。
  const first = await bot.handle(groupMsg('u1', '在吗', { atMe: true }));
  assert.equal(first.action, 'reply', '第一条被 @ 的消息必须正常回复：' + JSON.stringify(first));
  const key = bot.sessionKey(groupMsg('u1', '在吗'));
  const assistant = store.messages(key, 12).filter(row => row.role === 'assistant').at(-1);
  assert.ok(assistant, '回复必须落库，否则下一轮没有 lastBot');
  assert.equal(assistant.replyToUserId, 'u1', '助手消息要记住她回的是谁，插件靠它判断「别人插话」');

  // ② 同一人在窗口内追问，且没有被 @：只有插件 wake 才能开口。
  clock.at = T0 + 90000;
  const followup = await bot.handle(groupMsg('u1', '为什么这么说'));
  assert.equal(followup.action, 'reply',
    '180 秒内同一人追问应当被 lastBot + state 唤醒，实际：' + JSON.stringify(followup));
  assert.ok(followup.bubbles.length > 0, '唤醒后要真的产出可发送的气泡');

  // ③ 别人插话：不同 senderId 对不上 lastBot.targetId，插件收口并记住 interrupted。
  clock.at = T0 + 120000;
  const other = await bot.handle(groupMsg('u2', '我也来了'));
  assert.equal(other.action, 'ignore', '别人插话时不该接：' + JSON.stringify(other));

  // ④ 收口后同一个人再追问也不再接——证明「打断」这件事真的写进了跨轮 state。
  clock.at = T0 + 150000;
  const afterInterrupt = await bot.handle(groupMsg('u1', '然后呢'));
  assert.equal(afterInterrupt.action, 'ignore',
    '被打断之后同一人追问不该再唤醒（interrupted 没落库就会在这里复活）：' + JSON.stringify(afterInterrupt));
});

test('窗口过期与纯捧场都不接：state 在但 lastBot.at 太旧 / 正文是附和', { skip }, async t => {
  const { bot, clock } = makeHarness(t);
  await bot.handle(groupMsg('u1', '在吗', { atMe: true }));

  clock.at = T0 + WINDOW_MS + 1000;
  const expired = await bot.handle(groupMsg('u1', '为什么这么说'));
  assert.equal(expired.action, 'ignore', '超过 180 秒窗口不该接：' + JSON.stringify(expired));

  // 新窗口：重新被 @ 一次开窗，等宿主的接话窗口也过期后再用纯捧场试探，
  // 这样「不回」只能归因于插件的 ACK 分支，而不是宿主本来就不想回。
  clock.at = T0 + WINDOW_MS + 3000;
  assert.equal((await bot.handle(groupMsg('u1', '再聊会儿', { atMe: true }))).action, 'reply');
  clock.at = T0 + WINDOW_MS + 70000;
  const ack = await bot.handle(groupMsg('u1', '嗯'));
  assert.equal(ack.action, 'ignore', '纯捧场不该占一轮回复：' + JSON.stringify(ack));
});

test('api3 信封的 lastBot/now 由宿主收口，不透整条数据库记录', { skip }, () => {
  const message = { platform: 'wechat', chatType: 'group', chatId: 'g1', senderId: 'u1',
    text: '在吗', atMe: false, mentionedNames: [] };
  const envelope = JSON.parse(buildWasmPayload(3, 'chat.pre_reply@1', {
    message, localWechat: false, now: T0,
    // 模拟宿主传了带内部字段的记录：信封必须只留 text/at/targetId。
    lastBot: { text: '我在', at: T0 - 1000, targetId: 'u1', uid: 'u1', seq: 7, name: '鲸鲸' },
  }, {}, 'api3').toString('utf8'));
  assert.deepEqual(Object.keys(envelope.lastBot).sort(), ['at', 'targetId', 'text']);
  assert.equal(envelope.lastBot.targetId, 'u1');
  assert.equal(envelope.now, T0, 'now 必须用宿主给的时间，插件侧 Date.now 过不了窗口测试');

  const empty = JSON.parse(buildWasmPayload(3, 'chat.pre_reply@1',
    { message, localWechat: false }, {}, 'api3').toString('utf8'));
  assert.equal(empty.lastBot, null, '没有上一条助手回复时保持 null（旧插件的 pass 分支）');
  assert.ok(Number.isInteger(empty.now) && empty.now > 0, '宿主没给 now 时退回进程时间，不能是 0');
});

test('3 级 chat.received@1 在 api3 下可用，不会运行时报 invalid_wasm_compat', { skip }, () => {
  const message = { platform: 'wechat', chatType: 'group', chatId: 'g1', senderId: 'u1',
    text: '在吗', atMe: false, mentionedNames: [] };
  // 安装期能装载信封（旧实现这里直接抛 invalid_wasm_compat）
  const payload = buildWasmPayload(3, 'chat.received@1', { message, localWechat: false }, {}, 'api3');
  assert.equal(JSON.parse(payload.toString('utf8')).hook, 'chat.received');

  const module = compileRestricted(fs.readFileSync(WASM['followup-window']), 3);
  const output = executeRestricted(module, 3, 'chat.received@1', { message, localWechat: false }, {}, 'api3');
  assert.deepEqual(output, {}, 'observe 的返回值由宿主丢弃，不能按接话契约校验');
  // 未知字段也只投影成 {}：旧插件回显别的东西不该把观察者打成失败
  assert.deepEqual(compatOutput('chat.received@1', { whatever: 1 }, {}), {});
});

test('与真实旧 Wasm 逐条差分：pre_reply 判定要和参考实现完全一致', { skip }, async t => {
  let reference;
  try {
    reference = require(REFERENCE);
  } catch {
    t.skip('兄弟市场仓库的 reference.js 不在：只跑真实字节码用例');
    return;
  }
  const module = compileRestricted(fs.readFileSync(WASM['followup-window']), 3);
  const message = { platform: 'wechat', chatType: 'group', chatId: 'g1', senderId: 'u1',
    senderName: '甲', text: '为什么这么说', atMe: false, replyToBot: false, msgId: 'm9', chatTitle: '示例群',
    mentionedNames: [] };
  const lastBot = { text: '刚说到那件事', at: T0 - 30000, targetId: 'u1' };
  const cases = [
    ['没有上一条回复', { state: {}, lastBot: null, now: T0 }],
    ['窗口内追问（有线索）', { state: { left: 3, interrupted: false }, lastBot, now: T0 }],
    ['额度用完', { state: { left: 0, interrupted: false }, lastBot, now: T0 }],
    ['已被打断', { state: { left: 2, interrupted: true }, lastBot, now: T0 }],
    ['正好 180 秒仍在窗口内', { state: { left: 2, interrupted: false }, lastBot, now: lastBot.at + WINDOW_MS }],
    ['超过 180 秒', { state: { left: 2, interrupted: false }, lastBot, now: lastBot.at + WINDOW_MS + 1 }],
    ['纯捧场', { state: { left: 3, interrupted: false }, lastBot, now: T0, text: '嗯' }],
    ['在叫别人', { state: { left: 3, interrupted: false }, lastBot, now: T0,
      message: { ...message, mentionedNames: ['乙'] } }],
    ['别人插话', { state: { left: 3, interrupted: false }, lastBot, now: T0,
      message: { ...message, senderId: 'u2' } }],
    ['被明确叫到', { state: { left: 1, interrupted: true }, lastBot, now: T0,
      message: { ...message, atMe: true } }],
  ];
  for (const [name, spec] of cases) {
    const input = {
      message: spec.message || message, localWechat: false, now: spec.now,
      lastBot: spec.lastBot, state: spec.state, text: spec.text,
    };
    const envelope = JSON.parse(buildWasmPayload(3, 'chat.pre_reply@1', input, {}, 'api3',
      spec.state).toString('utf8'));
    const wasm = compatOutput('chat.pre_reply@1',
      executeRestricted(module, 3, 'chat.pre_reply@1', input, {}, 'api3', spec.state), input);
    const json = reference.decide(envelope);
    assert.equal(wasm.action, json.action, `${name}：动作不一致（wasm=${wasm.action} ref=${json.action}）`);
    assert.deepEqual(wasm.state, json.state, `${name}：回写的 state 不一致`);
  }
});

test('四个 state 聊天能力都拿到受控的 now 与 lastBot', { skip }, async t => {
  // 假 worker 只记录输入，用来钉住契约：pre_reply / prompt / reply / before_send
  // 四个能力都必须看到同一份 {now, lastBot}，少一个旧插件就会在某个环节退化成 pass。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-turnctx-'));
  const clock = { at: T0 + 5000 };
  const config = makeConfig(root);
  const store = new Store({ file: path.join(root, 'store.json'), limits: config.memory });
  const llm = { isMock: true, model: 'mock', reload() {}, describe() { return {}; },
    complete: async () => '我在呢', stream: async function* () { yield '我在呢'; } };
  const bot = new Bot({ config, store, llm, logger: null, now: () => new Date(clock.at),
    rng: () => 0.99, mockChunkDelayMs: 0 });
  const key = bot.sessionKey(groupMsg('u1', 'x'));
  store.appendMessage(key, { role: 'assistant', name: '鲸鲸', replyToUserId: 'u1', text: '我在', ts: T0 });
  const calls = [];
  const plugins = [{
    id: 'recording',
    provides: {
      'chat.pre_reply@1': { mode: 'gate', scope: 'all' },
      'chat.prompt@1': { mode: 'enhance', scope: 'all' },
      'chat.reply@1': { mode: 'enhance', scope: 'all' },
      'chat.before_send@1': { mode: 'enhance', scope: 'all' },
    },
    dataAccess: [], settings: {},
  }];
  const runtime = {
    installed: () => plugins,
    invoke: async (plugin, name, input) => {
      calls.push({ name, input });
      if (name === 'chat.pre_reply@1') return { action: 'pass' };
      if (name === 'chat.prompt@1') return { system: input.system };
      return { text: input.text };
    },
  };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: runtime, logger: null });
  for (const [name, builtin] of Object.entries(BUILTINS)) dispatcher.define(name, { builtin });
  bot.capabilities = dispatcher;
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); });

  const decision = await bot.decide(groupMsg('u1', '为什么这么说', { atMe: true }));
  assert.equal(decision.action, 'reply');
  await bot.finishReply(decision, '草稿正文');

  const names = calls.map(call => call.name);
  for (const name of ['chat.pre_reply@1', 'chat.prompt@1', 'chat.reply@1', 'chat.before_send@1']) {
    assert.ok(names.includes(name), '缺少 ' + name + ' 调用：' + names.join(','));
    const input = calls.find(call => call.name === name).input;
    assert.equal(input.now, T0 + 5000, name + ' 的 now 必须来自宿主时钟');
    assert.deepEqual(input.lastBot, { text: '我在', at: T0, targetId: 'u1' },
      name + ' 的 lastBot 必须只带 text/at/targetId');
    assert.ok(Array.isArray(input.message.mentionedNames), name + ' 的 message 必须带 mentionedNames');
  }
});

test('context-notes 跨轮 state：now 与上一轮 state 一起决定便签，prompt/before_send 都走真 Wasm', { skip }, async t => {
  const manifest = {
    id: 'context-notes',
    provides: {
      'chat.prompt@1': { mode: 'enhance', scope: 'all' },
      'chat.before_send@1': { mode: 'enhance', scope: 'all' },
    },
    dataAccess: ['chat.history', 'model.prompt'],
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-notes-'));
  const clock = { at: T0 };
  const config = makeConfig(root);
  const store = new Store({ file: path.join(root, 'store.json'), limits: config.memory });
  const bot = new Bot({ config, store, llm: { isMock: true }, logger: null,
    now: () => new Date(clock.at), rng: () => 0.99, mockChunkDelayMs: 0 });
  installPlugin(root, 'context-notes', manifest, WASM['context-notes']);
  // grant 里要真的批准 dataAccess，否则投影会把 system/history 摘掉
  const grantFile = path.join(root, 'plugins', 'context-notes', 'grant.json');
  const grant = JSON.parse(fs.readFileSync(grantFile, 'utf8'));
  grant.approvedDataAccess = ['chat.history', 'model.prompt'];
  fs.writeFileSync(grantFile, JSON.stringify(grant));
  const runtime = new InProcessWasmRuntime({ dataDir: root, enabled: () => true });
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: runtime, logger: null });
  for (const [name, builtin] of Object.entries(BUILTINS)) dispatcher.define(name, { builtin });
  bot.capabilities = dispatcher;
  t.after(() => {
    runtime.closed = true;
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });

  // 三轮都走 Bot 的真实判定链（decide → applyPromptHooks → dispatcher → Wasm），
  // 每轮只有宿主本条 @ 她才会回，所以 chat.prompt 一定被调用；时钟自己推。
  const ask = async (text, minutesLater) => {
    clock.at = T0 + minutesLater;
    const decision = await bot.decide(groupMsg('u1', text, { atMe: true }));
    assert.equal(decision.action, 'reply', '第 ' + minutesLater + ' 秒这轮应当进入回复：' + JSON.stringify(decision.reason));
    assert.equal(typeof decision.system, 'string');
    return decision.system;
  };

  const first = await ask('在吗', 0);
  assert.ok(first.length > 200, '原本的 system 不能被插件清空');
  assert.match(first, /【本轮上下文】/, 'context-notes 要真的接上（旧 Wasm 跑通）');

  // 第二轮：30 秒后。「上一句在 30 秒前」只能来自上一轮写回的 state.at + 宿主 now，
  // 插件自己取 Date.now() 时这里会变成真实时钟差（旧实现就是这样漏掉的）。
  const second = await ask('在吗', 30000);
  assert.match(second, /上一句在 30 秒前/, 'now 与跨轮 state.at 必须一起生效：' + second);

  // 第三轮：同一个人连续出现次数要跨轮累计（state.top/topN）。
  const third = await ask('在吗', 60000);
  assert.match(third, /这位今天已经第 3 次找你/, '同一个人连续出现次数要跨轮累计：' + third);

  const cleaned = await bot.applyBeforeSend({ key: bot.sessionKey(groupMsg('u1', 'x')), msg: groupMsg('u1', 'x') },
    '**你好**  世界', {});
  assert.equal(cleaned, '你好 世界', 'before_send 仍要清 Markdown 与多余空白');

});
