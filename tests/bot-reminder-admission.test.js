'use strict';

/**
 * 提醒链路的宿主调用预算接线。
 *
 * tryReminder 三个能力有一处不同：读（pendingFor）只是顺手查询，必须跟着本轮取消走，
 * 失败就退回本地服务层；写（create/cancel）中途被掐会留下半条状态，所以明确不接 signal，
 * 只给一个独立的 5 秒截止，避免「池满」时无限排队把整轮回复挂死。
 *
 * 这里的 capabilities 是真实的 UnifiedCapabilityDispatcher（准入、signal、deadline 语义
 * 都由它决定），只在外面套一层记录器抓实际传入的 options；bot 自己的装配点不变。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');
const { ReminderService } = require('../src/services/reminderService');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');

const NOW = new Date('2026-10-30T22:41:00');

function makeBot(t, { maxHostConcurrent = 8, maxHostPending = 8 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bot-reminder-adm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.paths = {
    root: dir, dataDir: path.join(dir, 'data'),
    configFile: path.join(dir, 'config.json'), settingsFile: path.join(dir, 'data/settings.json'),
  };
  fs.writeFileSync(config.paths.configFile, JSON.stringify(config));
  const store = new Store({ file: path.join(dir, 'store.json') });
  t.after(() => store.close());
  const bot = new Bot({
    config, store, llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
    logger: null, now: () => NOW, mockChunkDelayMs: 0,
  });
  bot.reminders = new ReminderService(config, { now: () => NOW.getTime() });

  // 真实 dispatcher + 记录器：记录器只观察 options，不改变准入语义。
  // 直接包住 bot 自己装配的那个 dispatcher（它已经 define 了聊天扩展点），
  // 只把宿主能力的准入上限调小，让「池满」在测试里可控。
  const dispatcher = bot.capabilities;
  dispatcher.maxHostConcurrent = maxHostConcurrent;
  dispatcher.maxHostPending = maxHostPending;
  const seen = [];
  const capabilities = Object.create(dispatcher);
  capabilities.hasHost = name => dispatcher.hasHost(name);
  capabilities.providers = (...args) => dispatcher.providers(...args);
  capabilities.hasProviders = (...args) => dispatcher.hasProviders(...args);
  capabilities.invoke = (...args) => dispatcher.invoke(...args);
  capabilities.invokeHost = (name, input, options) => {
    seen.push({ name, input, options: options || {} });
    return dispatcher.invokeHost(name, input, options);
  };
  bot.capabilities = capabilities;
  return { bot, dispatcher, seen, config };
}

const privateMsg = (text) => ({
  platform: 'wechat', chatId: 'wxid_a', chatType: 'private', senderId: 'u1', senderName: '阿螈', text,
});

test('pendingFor 收到 _decide 传入的本轮 signal（同一实例）', async (t) => {
  const { bot, dispatcher, seen } = makeBot(t);
  let ctx = null;
  dispatcher.defineHost('reminders.pendingFor@1', async (input, _plugin, flow) => {
    ctx = flow;
    return { items: [{ id: 'r1', text: '开会', dueAt: NOW.getTime() + 3600000, status: 'pending' }] };
  });

  const controller = new AbortController();
  const decision = await bot.decide(privateMsg('提醒列表'), { signal: controller.signal });

  assert.equal(decision.reason, 'reminder_list');
  assert.match(decision.canned, /开会/);
  const call = seen.find(row => row.name === 'reminders.pendingFor@1');
  assert.ok(call, '读能力必须走宿主能力口子');
  assert.equal(call.options.signal, controller.signal, 'pendingFor 必须收到本轮 signal');
  assert.equal(ctx.signal, controller.signal, 'handler 拿到的就是同一个 signal 实例');
});

test('signal 已取消时读能力仍把该 signal 传下去，且不抛', async (t) => {
  const { bot, dispatcher, seen } = makeBot(t);
  bot.reminders.add({ wxid: 'wxid_a', text: '开会', at: NOW.getTime() + 3600000 });
  dispatcher.defineHost('reminders.pendingFor@1', async () => ({ items: [] }));
  const controller = new AbortController();
  controller.abort();

  // 直接调 tryReminder：decide 会在入口就把取消的整轮判成 ignore，走不到提醒分支。
  const reply = await bot.tryReminder({
    msg: privateMsg('提醒列表'), clean: { text: '提醒列表' }, key: 'wechat:u:wxid_a',
    now: NOW, isGroup: false, atMe: false, signal: controller.signal,
  });

  // 传递的确实是「已取消的那个 signal」，而不是临时拼的或漏传。
  const call = seen.find(row => row.name === 'reminders.pendingFor@1');
  assert.ok(call, '读调用仍然发生了，signal 才会被宿主入口按取消拒绝');
  assert.equal(call.options.signal, controller.signal);
  assert.equal(call.options.signal.aborted, true);
  // 拒绝原因不得冒到决策主路径：退回服务层后仍能正常回一句列表。
  assert.equal(reply.action, 'reply');
  assert.equal(reply.reason, 'reminder_list');
  assert.match(reply.canned, /开会/);
});

test('写能力不接 signal，只带独立的 5 秒截止', async (t) => {
  const { bot, dispatcher, seen } = makeBot(t);
  const contexts = [];
  dispatcher.defineHost('reminders.create@1', async (input, _plugin, flow) => {
    contexts.push({ name: 'create', ctx: flow });
    // 真的落库，后续取消路径才有东西可取消。
    bot.reminders.add({ wxid: input.chatId, text: input.text, at: input.at });
    return { id: 'r-new', dueAt: input.at, status: 'pending' };
  });
  dispatcher.defineHost('reminders.cancel@1', async (_input, _plugin, flow) => {
    contexts.push({ name: 'cancel', ctx: flow });
    return { ok: true };
  });
  dispatcher.defineHost('reminders.pendingFor@1', async input => ({
    items: bot.reminders.pendingFor(input.chatId)
      .map(item => ({ id: item.id, text: item.text, dueAt: item.dueAt, status: item.status })),
  }));

  const controller = new AbortController();
  await bot.decide(privateMsg('十点半提醒我开会'), { signal: controller.signal });

  assert.equal(contexts.length, 1, '设提醒必须走写能力');
  const create = contexts[0].ctx;
  assert.equal(create.signal, undefined, '写能力不得收到 signal：中途被掐会留下半条状态');
  assert.ok(Number.isFinite(create.deadline), '写能力必须带独立 deadline');
  const remaining = create.deadline - Date.now();
  assert.ok(remaining > 0 && remaining <= 5000, `deadline 应是 now+5000，实际剩余 ${remaining}`);

  // 取消路径同理。
  await bot.decide(privateMsg('取消提醒'), { signal: controller.signal });
  const cancel = contexts.find(row => row.name === 'cancel');
  assert.ok(cancel, '取消提醒必须走写能力');
  assert.equal(cancel.ctx.signal, undefined);
  assert.ok(Number.isFinite(cancel.ctx.deadline));

  // 读调用仍然带 signal，写调用一律不带：两种语义不能混。
  const reads = seen.filter(row => row.name === 'reminders.pendingFor@1');
  assert.ok(reads.length >= 1, '读能力必须仍然经过宿主能力');
  // 第一次 decide 带了 signal，那次读必须原样带上（第二次 decide 没给 signal，不在断言范围）。
  assert.equal(reads[0].options.signal, controller.signal, '读能力带的是本轮 signal');
});

test('宿主准入被拒（池满）时读能力降级为服务层，不把 queue_limit 冒到决策主路径', async (t) => {
  const { bot, dispatcher } = makeBot(t, { maxHostConcurrent: 1, maxHostPending: 0 });
  bot.reminders.add({ wxid: 'wxid_a', text: '开会', at: NOW.getTime() + 3600000 });

  // 占住唯一名额：后续调用会被 host_capability_queue_limit 直接拒绝。
  let release;
  dispatcher.defineHost('reminders.pendingFor@1', () => new Promise((resolve) => {
    release = () => resolve({ items: [] });
  }));
  const occupying = bot.capabilities.invokeHost('reminders.pendingFor@1', { chatId: 'other' });

  const reply = await bot.tryReminder({
    msg: privateMsg('提醒列表'), clean: { text: '提醒列表' }, key: 'wechat:u:wxid_a',
    now: NOW, isGroup: false, atMe: false,
  });

  assert.equal(reply.action, 'reply');
  assert.equal(reply.reason, 'reminder_list');
  assert.match(reply.canned, /开会/, '池满时必须退回服务层读到真实待发提醒');
  release();
  await occupying;
});

test('宿主调用超时同样降级为服务层读取', async (t) => {
  const { bot, dispatcher } = makeBot(t);
  bot.reminders.add({ wxid: 'wxid_a', text: '开会', at: NOW.getTime() + 3600000 });
  dispatcher.defineHost('reminders.pendingFor@1', async () => {
    throw Object.assign(new Error('capability_timeout'), { code: 'capability_timeout' });
  });

  const reply = await bot.tryReminder({
    msg: privateMsg('提醒列表'), clean: { text: '提醒列表' }, key: 'wechat:u:wxid_a',
    now: NOW, isGroup: false, atMe: false,
  });

  assert.equal(reply.reason, 'reminder_list');
  assert.match(reply.canned, /开会/);
});

test('写能力超时只影响那一条取消，不把 capability_timeout 冒到决策主路径', async (t) => {
  const { bot, dispatcher } = makeBot(t);
  bot.reminders.add({ wxid: 'wxid_a', text: '开会', at: NOW.getTime() + 3600000 });
  dispatcher.defineHost('reminders.pendingFor@1', async input => ({
    items: bot.reminders.pendingFor(input.chatId)
      .map(item => ({ id: item.id, text: item.text, dueAt: item.dueAt, status: item.status })),
  }));
  dispatcher.defineHost('reminders.cancel@1', async () => {
    throw Object.assign(new Error('capability_timeout'), { code: 'capability_timeout' });
  });

  const reply = await bot.tryReminder({
    msg: privateMsg('取消提醒'), clean: { text: '取消提醒' }, key: 'wechat:u:wxid_a',
    now: NOW, isGroup: false, atMe: false,
  });

  // 宿主写失败后必须退回本地取消：提醒真的没了，话术照实计 1 条。
  assert.equal(reply.reason, 'reminder_cancel');
  assert.match(reply.canned, /取消了 1 条提醒/);
  assert.equal(bot.reminders.pendingFor('wxid_a').length, 0);
});

test('创建时宿主准入被拒（池满）仍退回本地登记并正常回执', async (t) => {
  const { bot, dispatcher } = makeBot(t, { maxHostConcurrent: 1, maxHostPending: 0 });
  // 占住唯一名额：后续 create 会被 host_capability_queue_limit 直接拒绝。
  let release;
  dispatcher.defineHost('reminders.pendingFor@1', () => new Promise((resolve) => {
    release = () => resolve({ items: [] });
  }));
  dispatcher.defineHost('reminders.create@1', async () => {
    throw Object.assign(new Error('host_capability_queue_limit'), { code: 'host_capability_queue_limit' });
  });
  const occupying = bot.capabilities.invokeHost('reminders.pendingFor@1', { chatId: 'other' });

  const reply = await bot.tryReminder({
    msg: privateMsg('十点半提醒我开会'), clean: { text: '十点半提醒我开会' }, key: 'wechat:u:wxid_a',
    now: NOW, isGroup: false, atMe: false,
  });

  // 宿主失败不得丢提醒：本地登记成功，回执和成功路径一样。
  assert.equal(reply.reason, 'reminder_set');
  assert.match(reply.canned, /10:30/);
  assert.match(reply.canned, /开会/);
  const items = bot.reminders.list();
  assert.equal(items.length, 1, '池满时提醒必须仍然落库');
  assert.equal(items[0].text, '开会');
  release();
  await occupying;
});

test('create 执行异常（5 秒排队超时）同样退回本地登记', async (t) => {
  const { bot, dispatcher } = makeBot(t);
  dispatcher.defineHost('reminders.create@1', async () => {
    throw Object.assign(new Error('capability_timeout'), { code: 'capability_timeout' });
  });

  const reply = await bot.tryReminder({
    msg: privateMsg('明天八点提醒我带伞'), clean: { text: '明天八点提醒我带伞' }, key: 'wechat:u:wxid_a',
    now: NOW, isGroup: false, atMe: false,
  });

  assert.equal(reply.reason, 'reminder_set');
  assert.equal(bot.reminders.list()[0].text, '带伞');
});

test('本地也登记不上时才回错误话术，且不含英文错误码', async (t) => {
  const { bot, dispatcher } = makeBot(t);
  dispatcher.defineHost('reminders.create@1', async () => {
    throw Object.assign(new Error('host_capability_queue_limit'), { code: 'host_capability_queue_limit' });
  });
  // 让本地登记也失败：模拟服务层写不进去。
  bot.reminders.add = () => { throw new Error('disk full'); };

  const reply = await bot.tryReminder({
    msg: privateMsg('十点半提醒我开会'), clean: { text: '十点半提醒我开会' }, key: 'wechat:u:wxid_a',
    now: NOW, isGroup: false, atMe: false,
  });

  assert.equal(reply.reason, 'reminder_error');
  // 面向用户的文案里不能出现英文错误码，也不能出现底层原文。
  assert.doesNotMatch(reply.canned, /host_capability_queue_limit|capability_timeout|disk full|Error/);
  assert.match(reply.canned, /这个提醒没设上/);
});

test('没有装配宿主能力时保持原有服务层路径（回归守门）', async (t) => {
  const { bot, dispatcher } = makeBot(t);
  // 只摘掉宿主能力的「已实现」标记，模拟裁剪装配；提供者能力（聊天扩展点）仍在。
  bot.capabilities = Object.create(dispatcher);
  bot.capabilities.hasHost = () => false;
  bot.reminders.add({ wxid: 'wxid_a', text: '开会', at: NOW.getTime() + 3600000 });

  const list = await bot.decide(privateMsg('提醒列表'));
  assert.equal(list.reason, 'reminder_list');
  assert.match(list.canned, /开会/);

  const created = await bot.decide(privateMsg('十点半提醒我开会'));
  assert.equal(created.reason, 'reminder_set');
  assert.equal(bot.reminders.list().length, 2, '能力缺失时写路径退回服务层 add');
});
