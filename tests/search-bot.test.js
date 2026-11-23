'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const searchService = require('../src/services/search');

function fixture(t, nativeSearch = true) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.links.enabled = false;
  config.features.envContext = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-chat-search-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const calls = [];
  const llm = {
    isMock: false, model: nativeSearch ? 'deepseek-flash' : 'qwen-plus',
    supportsWebSearch: () => nativeSearch,
    async complete(options) { calls.push(options); return '这里是核实后的比分。'; },
    async *stream(options) { calls.push(options); yield '这里是核实后的比分。'; },
  };
  const bot = new Bot({ config, store, llm });
  return { bot, calls, message: {
    platform: 'web', chatId: 'search-test', chatType: 'private', senderId: 'user', senderName: '小海', text: '帮我查一下今天的比分',
  } };
}

test('回复决策不调用搜索模型，最终聊天请求才启用内置搜索', async t => {
  const { bot, calls, message } = fixture(t);
  t.mock.method(searchService, 'search', async () => assert.fail('不应执行独立搜索'));
  bot.plugins.supports = () => true;
  const decision = await bot.decide(message);
  assert.equal(decision.action, 'reply');
  assert.equal(calls.length, 0);
  for await (const piece of bot.generate(decision)) assert.ok(piece);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].webSearch, true);
  assert.match(calls[0].turns.at(-1).content, /今天的比分/);
});

test('官方 Flash 有链接时只声明读网页，标题与日期随请求处理', async t => {
  const { bot, message } = fixture(t);
  bot.config.links.enabled = true;
  bot.linkReader = async () => assert.fail('不应本地抓取链接');
  bot.now = () => new Date('2026-11-22T00:05:00+08:00');
  bot.config.env.timezone = 'Asia/Shanghai';
  const toolCalls = [{ index: 0, calls: [{ kind: 'read_link', signature: 'test-web-context' }] }];
  let captured;
  bot.llm.complete = async options => {
    captured = options;
    if (options.readUrl) {
      options.onTitle('网页要点');
      options.onWebSearch({ serverToolCalls: toolCalls });
    }
    return '这里是文章摘要。';
  };
  const request = { ...message, text: '请总结 https://example.test/story' };
  assert.equal((await bot.handle(request)).action, 'reply');
  assert.equal(captured.readUrl, true);
  assert.equal(captured.webSearch, false);
  assert.equal(captured.safetyCheck, true);
  assert.match(captured.latestReminder, /^2026-11-22,星期日,,Web,中文$/);
  assert.equal(bot.store.ensureSession(bot.sessionKey(request)).title, '网页要点');
  const followup = await bot.decide({ ...request, text: '这篇文章还有哪些信息' });
  assert.deepEqual(followup.turns.find(turn => turn.role === 'assistant').server_tool_calls, toolCalls);
  bot.config.links.enabled = false;
  const decision = await bot.decide({ ...request, text: '再看 https://example.test/another' });
  assert.ok(decision.turns.every(turn => !turn.server_tool_calls));
  assert.equal(bot.chatModelOptions(decision).readUrl, false);
  assert.equal(bot.chatModelOptions(decision).title, false);
});

test('清空私聊后即使复用消息序号也不回放旧网页', async t => {
  const { bot, message } = fixture(t);
  bot.config.links.enabled = true;
  bot.llm.complete = async options => {
    if (options.readUrl) options.onWebSearch({ serverToolCalls: [{ calls: [{ kind: 'read_link', signature: 'old-link' }] }] });
    return options.readUrl ? '旧网页的摘要' : '全新的回复';
  };
  assert.equal((await bot.handle({ ...message, text: '请总结 https://example.test/article' })).action, 'reply');
  assert.equal(bot.store.resetSession(bot.sessionKey(message)), true);
  assert.equal((await bot.handle(message)).action, 'reply');
  const decision = await bot.decide({ ...message, text: '请继续新话题' });
  assert.ok(decision.turns.every(turn => !turn.server_tool_calls));
});

test('复读重写沿用原生审核，只保存采用的标题', async t => {
  const { bot, message } = fixture(t);
  const attempts = [];
  bot.llm.complete = async options => {
    attempts.push(options);
    const rewriting = attempts.length > 1;
    options.onTitle(rewriting ? '采用的标题' : '丢弃的标题');
    return rewriting ? '目前还没查到可靠的比分' : message.text;
  };
  assert.equal((await bot.handle(message)).action, 'reply');
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(options => options.safetyCheck && options.webSearch && options.latestReminder));
  assert.equal(bot.store.ensureSession(bot.sessionKey(message)).title, '采用的标题');
});

test('官方 Flash 的配额错误不会切换到外部模型', async t => {
  const { bot, message } = fixture(t);
  bot.llm.complete = async () => { throw new Error('429 rate limit'); };
  bot.llm.switchFallback = () => assert.fail('不能切到第三方');
  const result = await bot.handle(message);
  assert.equal(result.reason, 'llm_error');
});

test('其他模型继续使用独立搜索，搜索资料进入回复上下文', async t => {
  const { bot, calls, message } = fixture(t, false);
  const search = t.mock.method(searchService, 'search', async ({ text }) => {
    assert.match(text, /今天的比分/);
    return { status: 'ok', text: 'STANDALONE_SOURCE 比分 2:1', items: [] };
  });
  const result = await bot.handle(message);
  assert.equal(result.action, 'reply');
  assert.equal(search.mock.callCount(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].webSearch, false);
  assert.match(JSON.stringify(calls[0].turns), /STANDALONE_SOURCE/);
});

test('其他模型使用插件资料时不重复调用独立搜索', async t => {
  const { bot, calls, message } = fixture(t, false);
  t.mock.method(searchService, 'search', async () => assert.fail('不应重复搜索'));
  const plugin = { id: 'search-fixture', provides: { 'chat.search@1': { mode: 'replace', scope: 'all' } } };
  t.mock.method(bot.pluginRuntime, 'installed', () => [plugin]);
  t.mock.method(bot.pluginRuntime, 'invoke', async (_plugin, capability) => {
    assert.equal(capability, 'chat.search@1');
    return { status: 'ok', text: 'PLUGIN_SOURCE 比分 2:1', items: [] };
  });
  const result = await bot.handle(message);
  assert.equal(result.action, 'reply');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].webSearch, false);
  assert.match(JSON.stringify(calls[0].turns), /PLUGIN_SOURCE/);
});

test('搜索插件失败时安全回退宿主内置搜索，不把整轮回复判死', async t => {
  const { bot, calls, message } = fixture(t, false);
  t.mock.method(bot.pluginRuntime, 'installed', () => [
    { id: 'broken-search', provides: { 'chat.search@1': { mode: 'replace', scope: 'all' } }, settings: {} },
  ]);
  t.mock.method(bot.pluginRuntime, 'invoke', async () => {
    throw Object.assign(new Error('search plugin failed'), { code: 'plugin_error' });
  });
  const fallback = t.mock.method(searchService, 'search', async () => ({ status: 'ok', text: 'BUILTIN_FALLBACK 比分 2:1', items: [] }));
  const result = await bot.handle(message);
  assert.equal(result.action, 'reply', '搜索插件故障不能让本轮变成 ignore/error');
  assert.equal(fallback.mock.callCount(), 1, '只读搜索失败后可以安全回退一次内置搜索');
  assert.match(JSON.stringify(calls[0].turns), /BUILTIN_FALLBACK/);
});

test('搜索插件和内置搜索都失败时降级为无联网资料，仍正常回复', async t => {
  const { bot, calls, message } = fixture(t, false);
  t.mock.method(bot.pluginRuntime, 'installed', () => [
    { id: 'broken-search', provides: { 'chat.search@1': { mode: 'replace', scope: 'all' } }, settings: {} },
  ]);
  t.mock.method(bot.pluginRuntime, 'invoke', async () => {
    throw Object.assign(new Error('search plugin failed'), { code: 'plugin_error' });
  });
  t.mock.method(searchService, 'search', async () => { throw Object.assign(new Error('builtin search failed'), { code: 'network_error' }); });
  const recorded = [];
  const appendEvent = bot.store.appendEvent.bind(bot.store);
  t.mock.method(bot.store, 'appendEvent', (key, event) => { recorded.push(event); return appendEvent(key, event); });
  const result = await bot.handle(message);
  assert.equal(result.action, 'reply');
  assert.ok(recorded.some(event => event.type === 'web' && event.status === 'failed'),
    '降级要留下 failed 的搜索事件作为证据');
});

test('搜索阶段被取消时按取消收尾，不回退也不继续生成', async t => {
  const { bot, message } = fixture(t, false);
  t.mock.method(bot.pluginRuntime, 'installed', () => [
    { id: 'slow-search', provides: { 'chat.search@1': { mode: 'replace', scope: 'all' } }, settings: {} },
  ]);
  const abort = new AbortController();
  t.mock.method(bot.pluginRuntime, 'invoke', async () => new Promise((_resolve, reject) => {
    abort.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { code: 'capability_aborted' }));
    }, { once: true });
  }));
  const fallback = t.mock.method(searchService, 'search', async () => assert.fail('取消后不能回退内置搜索'));
  const pending = bot.handle(message, { signal: abort.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  abort.abort();
  const result = await pending;
  assert.deepEqual(result, { action: 'ignore', reason: 'cancelled' });
  assert.equal(fallback.mock.callCount(), 0);
});
