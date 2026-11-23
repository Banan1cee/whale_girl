'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { handleChat } = require('../src/http/chatHandler');
const { createStreamingChat } = require('../src/services/streamingChat');

// 有界等待：SSE 事件等不到时必须让测试失败，而不是把整个测试进程挂死。
function within(promise, ms = 8000, label = 'wait') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bounded wait timeout: ' + label)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

class Response extends EventEmitter {
  constructor() { super(); this.frames = []; this.writableEnded = false; }
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; }
  write(value) { this.frames.push(value); this.emit('frame', value); return true; }
  end(value) { if (value) this.frames.push(value); this.writableEnded = true; }
  events() { return this.frames.join('').split('\n\n').filter(x => x.startsWith('data: ')).map(x => JSON.parse(x.slice(6))); }
}
function fixture(t, control = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t01-result-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.paths = { root, dataDir: root, settingsFile: path.join(root, 'settings.json') };
  config.env = { autoDetect: false }; config.websearch = { enabled: false }; config.links.enabled = false;
  config.persona.master = { names: control.owner ? ['FixtureUser'] : [], wxids: [] };
  const store = new Store({ file: path.join(root, 'store.json'), limits: config.memory });
  const calls = { complete: 0, stream: 0, hooks: [], streamOptions: null };
  const llm = { isMock: false, model: 'fixture', usageSeq: 0, usageEvents: [],
    async complete() { calls.complete++; if (control.fail) throw new Error('fixture failure'); return control.raw || ''; },
    async *stream(options) {
      calls.stream++; calls.streamOptions = options;
      try {
        if (control.beforeChunk) await control.beforeChunk(options.signal);
        for (const chunk of control.chunks || [control.raw || '']) {
          if (options.signal?.aborted) return;
          yield chunk;
          if (control.afterChunk) await control.afterChunk(options.signal);
        }
        if (control.fail) throw new Error('fixture failure');
      } finally { calls.upstreamClosed = true; }
    } };
  const bot = new Bot({ config, store, llm, logger: null, rng: () => 0.99,
    calibration: { trimScale: () => 1, apply: n => ({ scale: 1, calibrated: n, n: 0 }) } });
  bot.diary = { readForChat: () => 'fixture diary content' };
  // 旧的 messagePlugins 钩子已退役；这里用统一的 capability 调度 seam 注入
  // 合成插件，既能覆盖 chat.generate@1 替换，也能覆盖 chat.reply@1 改写/失败。
  const wantsGenerate = control.generated !== undefined
    || control.throwHook === 'chat.generate' || control.throwHook === 'chat.generate@1';
  const wantsReply = control.transform !== undefined || Boolean(control.afterReply)
    || control.throwHook === 'chat.reply' || control.throwHook === 'chat.reply@1' || control.throwHook === 'chat.before_send';
  // replace 的失败会向上抛；enhance 的失败按契约会被忽略（sideEffect=none），
  // 所以「回复插件失败」用例必须用 replace 才能测到统一错误路径。
  const replyMode = control.throwHook === 'chat.reply' || control.throwHook === 'chat.reply@1'
    || control.throwHook === 'chat.before_send' ? 'replace' : 'enhance';
  bot.pluginRuntime.installed = () => {
    const list = [];
    if (wantsGenerate) list.push({ id: 'fixture-generate', provides: { 'chat.generate@1': { mode: 'replace', scope: 'all' } }, settings: {}, executionTimeoutMs: 30000 });
    if (wantsReply) list.push({ id: 'fixture-reply', provides: { 'chat.reply@1': { mode: replyMode, scope: 'all' } }, settings: {}, executionTimeoutMs: 30000 });
    return list;
  };
  bot.pluginRuntime.invoke = async (flow, capability, input) => {
    calls.hooks.push(capability);
    const legacy = capability === 'chat.generate@1' ? 'chat.generate' : 'chat.reply';
    if (control.throwHook === capability || control.throwHook === legacy) throw new Error('fixture plugin failure');
    if (capability === 'chat.generate@1') {
      if (control.beforeGenerate) await control.beforeGenerate();
      return { text: control.generated !== undefined ? control.generated : input.text };
    }
    if (control.afterReply) await control.afterReply();
    return { text: control.transform ? control.transform(input.text) : input.text };
  };
  const runtime = { bot, config, logger: { error() {} }, chat: {
    stream: createStreamingChat(bot, { error() {} }, { handle: (message, options) => bot.handle(message, options) }),
  } };
  t.after(() => { store.close(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  async function sse(id = 'fixture-sse', extra = {}) {
    const req = new PassThrough(); const res = new Response();
    const running = handleChat(runtime, req, res);
    req.end(JSON.stringify({ text: 'fixture question', senderName: 'FixtureUser', sessionId: id, ...extra }));
    return { res, running };
  }
  return { bot, store, calls, sse, runtime, async nonstream() { return within(bot.handle({ platform: 'web', chatId: 'fixture-nonstream', chatType: 'private', senderId: 'fixture-user', senderName: 'FixtureUser', text: 'fixture question' }), 8000, 'nonstream'); } };
}

for (const [name, control] of [
  ['sticker', { raw: 'fixture answer[[sticker:开心]]', chunks: ['fixture answer[[sti', 'cker:开', '心]]'] }],
  ['plugin rewrite', { raw: 'fixture original', transform: () => 'fixture transformed' }],
  ['canned plugin reply', { raw: 'unused', generated: 'fixture fixed[[sticker:开心]]', transform: s => s.replace('fixed', 'transformed') }],
  ['authorized diary', { raw: 'prefix[[diary:latest]]suffix', owner: true }],
  ['denied diary', { raw: 'prefix[[diary:latest]]suffix' }],
  ['empty normalized output', { raw: '米饭' }],
  ['error before output', { raw: '', fail: true }],
  ['error after partial marker', { raw: 'fixture partial[[sticker:', fail: true }],
]) {
  test('same canonical SSE and nonstream result: ' + name, async t => {
    const f = fixture(t, control); const { res, running } = await f.sse(); await within(running, 8000, 'sse');
    const events = res.events(); const done = events.find(x => x.type === 'done');
    const delta = events.filter(x => x.type === 'delta').map(x => x.text).join('');
    const streamedHooks = [...f.calls.hooks];
    const plain = await f.nonstream();
    assert.equal(events[0].type, 'meta');
    assert.ok(done, 'completion event remains present');
    assert.equal(done.text, plain.action === 'ignore' ? '' : plain.reply);
    assert.equal(delta, done.text, 'only final public text is emitted');
    assert.deepEqual(done.bubbles, plain.bubbles || []);
    assert.doesNotMatch(delta, /\[\[(?:sticker|diary)|\(\(silence/i);
    const rows = f.store.messages('web:u:fixture-sse:private', 100).filter(m => m.role === 'assistant');
    if (control.owner) { assert.equal(rows[0].text, 'prefix（读取日记）suffix'); assert.ok(!rows[0].text.includes('fixture diary content')); }
    if (!control.fail) {
      const replyPlugin = control.transform !== undefined || control.afterReply || control.throwHook === 'chat.reply';
      assert.equal(streamedHooks.filter(x => x === 'chat.reply@1').length, replyPlugin ? 1 : 0,
        'no legacy chat.before_send retry; reply plugin runs once when declared');
    } else { assert.equal(done.error, true); assert.equal(done.reason, 'llm_error'); }
    if (plain.stickerCategory) assert.equal(done.stickerCategory, plain.stickerCategory);
  });
}

test('real upstream stream stays active while early meta precedes delayed final text', async t => {
  let release; let entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { chunks: ['fixture raw'], afterChunk: async () => { entered(); await barrier; }, transform: () => 'fixture final' });
  const { res, running } = await f.sse(); await within(reached, 8000, 'upstream reached');
  const beforeFinish = res.events(); release(); await within(running, 8000, 'sse');
  assert.equal(beforeFinish[0].type, 'meta');
  assert.equal(beforeFinish.filter(x => x.type === 'delta').length, 0, 'text waits for plugin and canonical normalization');
  assert.equal(f.calls.stream, 1); assert.equal(f.calls.complete, 0);
  assert.equal(f.calls.streamOptions.purpose, 'chat');
  assert.equal(f.calls.upstreamClosed, true);
});

test('disconnect aborts upstream, emits no delayed text, and does not consume quota', async t => {
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { chunks: ['prefix[[sticker:'], afterChunk: async signal => {
    entered(); if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } });
  const { res, running } = await f.sse(); await within(reached, 8000, 'upstream reached'); res.emit('close'); await within(running, 8000, 'sse');
  assert.equal(f.calls.streamOptions.signal.aborted, true);
  assert.equal(f.calls.upstreamClosed, true);
  assert.equal(res.events().filter(x => ['delta', 'done'].includes(x.type)).length, 0);
  assert.equal(f.bot.globalReplyTimes.length, 0);
  assert.equal(f.bot._replyQuota.pending.size, 0, 'abort must release the in-flight reservation');
});

test('disconnect after meta but before generation releases the reservation', async t => {
  let entered; let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { raw: 'fixture answer', beforeChunk: async () => { entered(); await gate; } });
  const { res, running } = await f.sse(); await within(reached, 8000, 'generation reached');
  res.emit('close'); release(); await within(running, 8000, 'sse');
  assert.equal(f.bot.globalReplyTimes.length, 0);
  assert.equal(f.bot._replyQuota.pending.size, 0, 'decision reservation must not survive abort before generate');
  assert.equal(res.events().filter(x => ['delta', 'done'].includes(x.type)).length, 0);
});

test('disconnect during decide cancels plugin dispatch and releases the reservation', async t => {
  let entered; let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  // chat.generate 在 decide 内部、按会话串行队列里执行；断线必须让排队/在途分发
  // 收到 signal 并抛出 capability_aborted，而不是等插件自然结束。
  const f = fixture(t, { generated: 'plugin text', beforeGenerate: async () => { entered(); await gate; } });
  const { res, running } = await f.sse(); await within(reached, 8000, 'plugin dispatch reached');
  res.emit('close'); release(); await within(running, 8000, 'sse');
  assert.equal(f.bot.globalReplyTimes.length, 0);
  assert.equal(f.bot._replyQuota.pending.size, 0, 'aborted decide must not keep its lease');
  assert.equal(res.events().filter(x => ['delta', 'done'].includes(x.type)).length, 0);
});

test('disconnect after public text never refunds an already finalized reply', async t => {
  const f = fixture(t, { raw: 'fixture answer' });
  const { res, running } = await f.sse();
  res.on('frame', frame => { if (frame.includes('"type":"delta"')) res.emit('close'); });
  await within(running, 8000, 'sse');
  assert.equal(f.bot.globalReplyTimes.length, 1);
});

test('all split points inside known control prefixes remain private', async t => {
  for (const mark of ['[[sticker:开心]]', '((silence:5))', '[[diary:latest]]']) {
    for (let split = 1; split < mark.length; split++) {
      const f = fixture(t, { raw: 'prefix' + mark + 'suffix', chunks: ['prefix' + mark.slice(0, split), mark.slice(split) + 'suffix'] });
      const { res, running } = await f.sse('split-' + split); await within(running, 8000, 'sse');
      const events = res.events();
      const text = events.filter(x => x.type === 'delta').map(x => x.text).join('');
      assert.equal(text, 'prefixsuffix', mark + ':' + split);
      assert.equal(events.at(-1).text, text);
    }
  }
});

test('buffer overflow is bounded and returns only one friendly error result', async t => {
  const raw = 'x'.repeat(300000);
  const f = fixture(t, { raw, chunks: [raw.slice(0, 150000), raw.slice(150000)] });
  const { res, running } = await f.sse(); await within(running, 8000, 'sse');
  const events = res.events(); const done = events.at(-1);
  assert.equal(done.error, true); assert.equal(done.reason, 'llm_error');
  assert.ok(done.text.length < 300);
  assert.ok(res.frames.join('').length < 2000);
  assert.equal(f.calls.upstreamClosed, true);
});

test('plugin failure after generation has the same canonical error on both consumers', async t => {
  for (const capability of ['chat.reply@1']) {
    const f = fixture(t, { raw: 'fixture original', throwHook: capability });
    const { res, running } = await f.sse('failure-' + capability); await within(running, 8000, 'sse');
    const done = res.events().at(-1);
    const plain = await f.nonstream();
    assert.equal(done.error, true); assert.equal(plain.error, true);
    assert.equal(done.text, plain.reply); assert.deepEqual(done.bubbles, plain.bubbles);
    assert.equal(f.calls.hooks.filter(x => x === capability).length, 2, 'once per logical turn, no hook retry');
    assert.equal(f.bot.globalReplyTimes.length, 2, 'both friendly outputs count');
  }
});

test('生成插件失败按真实故障收尾：不回退内置模型、不落库也不占配额', async t => {
  // chat.generate@1 是 replace + billable-model-call：插件已经调过一次模型，
  // 再回退内置模型就是二次计费。这里只验证「失败即收尾，不重复生成」的语义。
  const f = fixture(t, { throwHook: 'chat.generate@1' });
  const plain = await f.nonstream();
  assert.deepEqual(plain, { action: 'ignore', reason: 'error' });
  assert.equal(f.calls.complete, 0, '不能回退内置模型重复计费');
  assert.equal(f.calls.hooks.filter(x => x === 'chat.generate@1').length, 1);
  assert.equal(f.bot._replyQuota.pending.size, 0, '失败不能留下配额租约');
  const key = 'web:u:fixture-nonstream:private';
  assert.equal(f.store.messages(key, 10).filter(row => row.role === 'assistant').length, 0);

  const events = [];
  const stream = createStreamingChat(f.bot, { error() {} });
  for await (const event of stream({
    platform: 'web', chatId: 'fixture-generate-fail', chatType: 'private',
    senderId: 'fixture-user', senderName: 'FixtureUser', text: 'fixture question',
  })) events.push(event);
  assert.deepEqual(events, [{ type: 'decision_error' }], '流式入口同样不能把故障伪装成正常回复');
});

test('cancellation during reply plugin stops the result stage and releases the reply', async t => {
  let entered; let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { raw: 'fixture original', afterReply: async () => { entered(); await gate; } });
  const { res, running } = await f.sse(); await within(reached, 8000, 'reply plugin reached'); res.emit('close'); release(); await within(running, 8000, 'sse');
  assert.equal(f.calls.hooks.filter(x => x === 'chat.reply@1').length, 1);
  assert.equal(res.events().filter(x => x.type === 'delta').length, 0);
  assert.equal(f.bot.globalReplyTimes.length, 0);
  assert.equal(f.bot._replyQuota.pending.size, 0, 'abort during result stage releases the lease');
});

test('mocked group guard makes safe text the only canonical/persisted output; private diary untouched', async t => {
  const memory = require('../src/memory');
  const original = memory.guardReply;
  memory.guardReply = () => ({ leak: true, reason: 'fixture_guard', score: 1 });
  t.after(() => { memory.guardReply = original; });
  const f = fixture(t, { raw: 'prefix[[diary:latest]]suffix', owner: true });
  const { res, running } = await f.sse('guard-group', { mode: 'group', atMe: true });
  await within(running, 8000, 'group sse');
  const events = res.events(); const done = events.find(x => x.type === 'done');
  const delta = events.filter(x => x.type === 'delta').map(x => x.text).join('');
  assert.equal(done.text, '这个我不清楚呀');
  assert.deepEqual(done.bubbles, ['这个我不清楚呀']);
  assert.equal(delta, done.text, 'SSE delta 必须是安全正文');
  const groupMsg = { platform: 'web', chatId: 'guard-group:group', chatType: 'group', senderId: 'web-g-FixtureUser', senderName: 'FixtureUser', text: 'fixture question', atMe: true };
  const plainGroup = await f.bot.handle(groupMsg);
  assert.equal(plainGroup.reply, '这个我不清楚呀');
  assert.deepEqual(plainGroup.bubbles, ['这个我不清楚呀']);
  const groupKey = f.bot.sessionKey(f.bot.normalize(groupMsg));
  const groupRows = f.store.messages(groupKey, 100).filter(m => m.role === 'assistant');
  assert.ok(groupRows.length > 0);
  assert.ok(groupRows.every(m => m.text === '这个我不清楚呀'), '落库也只能是安全正文');
  assert.ok(!groupRows.some(m => m.text.includes('fixture diary content') || m.text.includes('（读取日记）')));
  // 私聊日记：guard 只作用于群聊，日记占位符语义不变。
  const privateMsg = { platform: 'web', chatId: 'guard-private:private', chatType: 'private', senderId: 'web-u-guard-private', senderName: 'FixtureUser', text: 'fixture question' };
  const plainPrivate = await f.bot.handle(privateMsg);
  assert.ok(plainPrivate.reply.includes('fixture diary content'));
  const privateKey = f.bot.sessionKey(f.bot.normalize(privateMsg));
  const privateRows = f.store.messages(privateKey, 100).filter(m => m.role === 'assistant');
  assert.ok(privateRows.at(-1).text.includes('（读取日记）'), '私聊仍只存日记占位符');
  assert.ok(!privateRows.at(-1).text.includes('fixture diary content'));
});
