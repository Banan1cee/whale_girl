'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { handleChat } = require('../src/services/chat');
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
  bot.messagePlugins = { supports: () => false, async run(hook, context) {
    calls.hooks.push(hook);
    if (control.throwHook === hook) throw new Error('fixture plugin failure');
    if (hook === 'chat.reply' && control.afterReply) await control.afterReply();
    return { action: 'pass', system: context.system, text: hook === 'chat.generate' && control.generated !== undefined ? control.generated
      : hook === 'chat.reply' && control.transform ? control.transform(context.text) : context.text };
  } };
  t.after(() => { store.close(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  async function sse(id = 'fixture-sse') {
    const req = new PassThrough(); const res = new Response();
    const running = handleChat({ bot, config, logger: { error() {} } }, req, res);
    req.end(JSON.stringify({ text: 'fixture question', senderName: 'FixtureUser', sessionId: id }));
    return { res, running };
  }
  return { bot, store, calls, sse, async nonstream() { return bot.handle({ platform: 'web', chatId: 'fixture-nonstream', chatType: 'private', senderId: 'fixture-user', senderName: 'FixtureUser', text: 'fixture question' }); } };
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
    const f = fixture(t, control); const { res, running } = await f.sse(); await running;
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
      assert.equal(streamedHooks.filter(x => x === 'chat.reply').length, 1);
      assert.equal(streamedHooks.filter(x => x === 'chat.before_send').length, 1);
    } else { assert.equal(done.error, true); assert.equal(done.reason, 'llm_error'); }
    if (plain.stickerCategory) assert.equal(done.stickerCategory, plain.stickerCategory);
  });
}

test('real upstream stream stays active while early meta precedes delayed final text', async t => {
  let release; let entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { chunks: ['fixture raw'], afterChunk: async () => { entered(); await barrier; }, transform: () => 'fixture final' });
  const { res, running } = await f.sse(); await reached;
  const beforeFinish = res.events(); release(); await running;
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
  const { res, running } = await f.sse(); await reached; res.emit('close'); await running;
  assert.equal(f.calls.streamOptions.signal.aborted, true);
  assert.equal(f.calls.upstreamClosed, true);
  assert.equal(res.events().filter(x => ['delta', 'done'].includes(x.type)).length, 0);
  assert.equal(f.bot.globalReplyTimes.length, 0);
});

test('disconnect after public text never refunds an already finalized reply', async t => {
  const f = fixture(t, { raw: 'fixture answer' });
  const { res, running } = await f.sse();
  res.on('frame', frame => { if (frame.includes('"type":"delta"')) res.emit('close'); });
  await running;
  assert.equal(f.bot.globalReplyTimes.length, 1);
});

test('all split points inside known control prefixes remain private', async t => {
  for (const mark of ['[[sticker:开心]]', '((silence:5))', '[[diary:latest]]']) {
    for (let split = 1; split < mark.length; split++) {
      const f = fixture(t, { raw: 'prefix' + mark + 'suffix', chunks: ['prefix' + mark.slice(0, split), mark.slice(split) + 'suffix'] });
      const { res, running } = await f.sse('split-' + split); await running;
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
  const { res, running } = await f.sse(); await running;
  const events = res.events(); const done = events.at(-1);
  assert.equal(done.error, true); assert.equal(done.reason, 'llm_error');
  assert.ok(done.text.length < 300);
  assert.ok(res.frames.join('').length < 2000);
  assert.equal(f.calls.upstreamClosed, true);
});

test('plugin failure after generation has the same canonical error on both consumers', async t => {
  for (const hook of ['chat.reply', 'chat.before_send']) {
    const f = fixture(t, { raw: 'fixture original', throwHook: hook });
    const { res, running } = await f.sse('failure-' + hook); await running;
    const done = res.events().at(-1);
    const plain = await f.nonstream();
    assert.equal(done.error, true); assert.equal(plain.error, true);
    assert.equal(done.text, plain.reply); assert.deepEqual(done.bubbles, plain.bubbles);
    assert.equal(f.calls.hooks.filter(x => x === hook).length, 2, 'once per logical turn, no hook retry');
    assert.equal(f.bot.globalReplyTimes.length, 2, 'both friendly outputs count');
  }
});

test('cancellation during reply plugin stops before_send and releases the result', async t => {
  let entered; let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { raw: 'fixture original', afterReply: async () => { entered(); await gate; } });
  const { res, running } = await f.sse(); await reached; res.emit('close'); release(); await running;
  assert.equal(f.calls.hooks.filter(x => x === 'chat.before_send').length, 0);
  assert.equal(res.events().filter(x => x.type === 'delta').length, 0);
  assert.equal(f.bot.globalReplyTimes.length, 0);
});
