'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

let sequence = 0;
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t01-quota-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.paths = { root, dataDir: root, settingsFile: path.join(root, 'settings.json') };
  config.env = { autoDetect: false };
  config.websearch = { enabled: false };
  config.links.enabled = false;
  config.group = { ...config.group, requireAt: false, freeChatChance: 1, maxRepliesPerMinute: 30, cooldownSec: 0, ...options.group };
  config.persona.master = { names: ['FixtureOwner'], wxids: ['fixture-owner'] };
  let clock = Date.parse('2026-11-14T08:00:00Z');
  const store = new Store({ file: path.join(root, 'store.json'), limits: config.memory, now: () => clock });
  const llm = options.llm || { isMock: false, model: 'fixture', async complete() { return 'fixture answer'; } };
  const bot = new Bot({ config, store, llm, logger: null, now: () => new Date(clock), rng: () => 0.99,
    calibration: { trimScale: () => 1, apply: n => ({ scale: 1, calibrated: n, n: 0 }) } });
  const control = { pre: 'pass', ...options };
  const hooks = [];
  bot.messagePlugins = { supports: () => false, async run(hook, context) {
    hooks.push(hook);
    if (control.throwHook === hook) throw new Error('fixture hook failure');
    return { action: hook === 'chat.pre_reply' ? control.pre : 'pass', system: context.system,
      text: hook === 'chat.generate' && control.generated !== undefined ? control.generated : context.text };
  } };
  t.after(() => {
    store.close();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('whale-t01-quota-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { bot, store, config, control, hooks, now: () => clock, advance: ms => { clock += ms; } };
}
function message(id, extra = {}) {
  return { platform: 'web', chatId: id, chatType: 'group', senderId: 'fixture-user', senderName: 'FixtureUser',
    text: 'fixture question', msgId: 't01-' + (++sequence), ...extra };
}
function state(f, msg) { return f.store.ensureSession(f.bot.sessionKey(f.bot.normalize(msg)), msg).state; }
const tick = () => new Promise(setImmediate);

for (const [name, count, extra] of [
  ['31 ordinary sessions', 31, {}], ['40 ordinary sessions', 40, {}],
  ['40 addressed sessions', 40, { atMe: true }], ['40 private sessions', 40, { chatType: 'private' }],
]) {
  test('global quota reserves before concurrent generation: ' + name, async t => {
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let started = 0;
    const f = fixture(t, { llm: { isMock: false, model: 'fixture', async complete() {
      started += 1; await barrier; return 'fixture answer';
    } } });
    const pending = Array.from({ length: count }, (_, i) => f.bot.handle(message('chat-' + i, extra)));
    await tick(); await tick();
    const inFlight = started;
    release();
    const results = await Promise.all(pending);
    assert.equal(inFlight, 30, 'at most 30 calls enter the model before any finalization');
    assert.ok(inFlight > 1, 'cross-session models must stay concurrent');
    assert.equal(results.filter(x => x.action === 'reply').length, 30);
    assert.equal(results.filter(x => x.reason === 'global_minute_cap').length, count - 30);
    assert.equal(f.bot.globalReplyTimes.length, 30);
  });
}

for (const cap of [0, 5, 8, 30]) {
  test('same-session pending decisions honor configured final cap ' + cap, async t => {
    const f = fixture(t, { group: { maxRepliesPerMinute: cap } });
    const count = cap ? cap + 2 : 12;
    const decisions = await Promise.all(Array.from({ length: count }, () => f.bot.decide(message('one-chat', { atMe: true }))));
    const replies = decisions.filter(d => d.action === 'reply');
    assert.equal(replies.length, cap || count);
    assert.ok(decisions.filter(d => d.action === 'ignore').every(d => d.reason === 'burst_limit'));
    for (const decision of replies) f.bot.finalize(decision, 'fixture answer');
    assert.equal(f.bot.globalReplyTimes.length, cap || count);
  });
}

test('an active slow model retains its reservation beyond the idle lease window', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let started = 0;
  const f = fixture(t, { llm: { isMock: false, model: 'fixture', async complete() {
    started++; await barrier; return 'fixture answer';
  } } });
  const pending = Array.from({ length: 30 }, (_, i) => f.bot.handle(message('slow-' + i)));
  await tick(); await tick(); f.advance(120001);
  const extra = f.bot.handle(message('later'));
  await tick(); await tick();
  release();
  const results = await Promise.all([...pending, extra]);
  assert.equal(started, 30);
  assert.equal(results.at(-1).reason, 'global_minute_cap');
});

test('abandoned idle decisions expire and a late finalize cannot bypass current admission', async t => {
  const f = fixture(t);
  const old = await f.bot.decide(message('old'));
  f.advance(120001);
  for (let i = 0; i < 30; i++) assert.equal((await f.bot.handle(message('new-' + i))).action, 'reply');
  assert.deepEqual(f.bot.finalize(old, 'late answer'), []);
  assert.equal(f.bot.globalReplyTimes.length, 30);
});

test('finalize is idempotent for count, stored assistant, and returned bubbles', async t => {
  const f = fixture(t);
  const d = await f.bot.decide(message('once'));
  const first = f.bot.finalize(d, 'fixture answer');
  assert.deepEqual(f.bot.finalize(d, 'fixture second answer'), first);
  assert.equal(f.bot.globalReplyTimes.length, 1);
  assert.equal(f.store.messages(d.key, 100).filter(m => m.role === 'assistant').length, 1);
});

test('empty/plugin-empty/late hook failure release admission for the next turn', async t => {
  for (const kind of ['empty', 'plugin-empty', 'hook-error', 'budget']) {
    const f = fixture(t);
    f.bot.globalReplyTimes = Array(29).fill(f.now());
    let result;
    if (kind === 'empty') {
      f.bot.llm.complete = async () => '米饭';
      result = await f.bot.handle(message('reject-' + kind));
      f.bot.llm.complete = async () => 'fixture answer';
    } else if (kind === 'plugin-empty') {
      f.control.generated = '';
      result = await f.bot.handle(message('reject-' + kind)); delete f.control.generated;
    } else if (kind === 'hook-error') {
      f.control.throwHook = 'chat.generate';
      result = await f.bot.handle(message('reject-' + kind)); delete f.control.throwHook;
    } else {
      const build = f.bot.buildTurns;
      f.bot.buildTurns = () => [{ role: 'user', content: '长'.repeat(150000) }];
      result = await f.bot.handle(message('reject-' + kind)); f.bot.buildTurns = build;
    }
    assert.equal(result.action, 'ignore', kind);
    assert.equal((await f.bot.handle(message('after-' + kind))).action, 'reply', kind);
    assert.equal(f.bot.globalReplyTimes.length, 30, kind);
  }
});

test('a friendly failure is one visible reply and storage failure does not refund it', async t => {
  const f = fixture(t, { group: { maxRepliesPerMinute: 5 } });
  f.bot.llm.complete = async () => { throw new Error('fixture generation failure'); };
  const append = f.store.appendMessage.bind(f.store);
  f.store.appendMessage = (key, row) => { if (row.role === 'assistant') throw new Error('fixture storage failure'); return append(key, row); };
  f.store.checkpoint = () => { throw new Error('fixture checkpoint failure'); };
  for (let i = 0; i < 5; i++) {
    const result = await f.bot.handle(message('faulted', { chatType: 'private' }));
    assert.equal(result.action, 'reply'); assert.equal(result.error, true);
  }
  assert.equal((await f.bot.handle(message('faulted', { chatType: 'private' }))).reason, 'burst_limit');
  assert.equal(f.bot.globalReplyTimes.length, 5);
});

test('cancellation discards a late model result and releases exactly one slot', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  let started = 0;
  const f = fixture(t, { llm: { isMock: false, model: 'fixture', async complete() { started++; await gate; return 'late answer'; } } });
  const pending = Array.from({ length: 30 }, (_, i) => f.bot.handle(message('abort-' + i), i ? {} : { signal: controller.signal }));
  await tick(); await tick(); controller.abort();
  const replacement = f.bot.handle(message('replacement'));
  await tick(); await tick(); release();
  const result = await Promise.all([...pending, replacement]);
  assert.equal(result[0].action, 'ignore');
  assert.equal(result.at(-1).action, 'reply');
  assert.equal(started, 31);
  assert.equal(f.bot.globalReplyTimes.length, 30);
});

test('normal denied decisions do not apply speculative engagement or consent effects', async t => {
  for (const kind of ['global', 'session', 'plugin-empty', 'muted', 'plugin-skip']) {
    const f = fixture(t);
    const msg = message('effects-' + kind, { atMe: true, text: '可以骂我' });
    const current = state(f, msg);
    if (kind === 'global') f.bot.globalReplyTimes = Array(30).fill(f.now());
    if (kind === 'session') current.replyTimes = Array(30).fill(f.now());
    if (kind === 'plugin-empty') f.control.generated = '';
    if (kind === 'muted') current.mutedUntil = f.now() + 600000;
    if (kind === 'plugin-skip') f.control.pre = 'skip';
    const before = structuredClone(current);
    const d = await f.bot.decide(msg);
    assert.equal(d.action, 'ignore', kind);
    for (const field of ['engagedUntil', 'engagedBy', 'silentUntil', 'consent']) assert.deepEqual(current[field], before[field], kind + ':' + field);
  }
});

test('silent/muted/plugin and early reminder/dismiss/admin lane precedence remains', async t => {
  for (const [kind, expectedAction, expectedReason] of [
    ['silent-peer', 'ignore', 'silent'], ['silent-owner', 'reply', 'addressed'],
    ['muted-owner', 'ignore', 'muted'], ['plugin-wake-muted', 'ignore', 'muted'],
    ['dismiss', 'reply', 'dismissed'], ['reminder', 'reply', 'reminder_list'], ['admin', 'command', 'admin'],
  ]) {
    const f = fixture(t);
    const m = message(kind, { atMe: true }); const s = state(f, m);
    if (kind.startsWith('silent')) s.silentUntil = f.now() + 600000;
    if (kind.endsWith('owner')) { m.platform = 'wechat'; m.senderId = 'fixture-owner'; Object.assign(state(f, m), s); }
    if (kind.startsWith('muted') || kind === 'plugin-wake-muted') state(f, m).mutedUntil = f.now() + 600000;
    if (kind === 'plugin-wake-muted') f.control.pre = 'wake';
    if (kind === 'dismiss') { m.text = '闭嘴'; s.mutedUntil = f.now() + 600000; }
    if (kind === 'reminder') { m.text = '提醒列表'; s.mutedUntil = f.now() + 600000; f.bot.reminders = { pendingFor: () => [] }; }
    if (kind === 'admin') { m.text = '管理状态'; s.mutedUntil = f.now() + 600000; }
    const result = await f.bot.decide(m);
    assert.equal(result.action, expectedAction, kind); assert.equal(result.reason, expectedReason, kind);
    if (['dismiss', 'reminder', 'admin'].includes(kind)) assert.ok(!f.hooks.includes('chat.pre_reply'), kind);
  }
});
