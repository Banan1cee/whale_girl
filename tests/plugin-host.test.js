'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PluginHost } = require('../src/services/pluginHost');
const { ReminderService } = require('../src/services/reminderService');
const { StickerService } = require('../src/services/stickerService');
const features = require('../src/infra/features');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sdk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  let approved = true;
  let now = Date.now();
  const config = { paths: { dataDir: dir }, reminder: { enabled: false },
    gateway: { wechat: { inboundToken: 'test-placeholder' } } };
  const r = { config, version: '4.1.2', bot: { javascriptPlugins: { isApproved: () => approved } },
    pluginApiUrl: 'http://127.0.0.1:12345', stickerService: { jobs: new Map() },
    llm: { complete: async options => { assert.equal(options.purpose, 'plugin'); return options.turns[0].content; } } };
  r.reminders = new ReminderService(config, { now: () => now });
  r.reminders.pluginAllowed = () => approved;
  return { r, flow: { id: 'sdk-test', hash: 'test-hash', executionTimeoutMs: 30000 },
    revoke: () => { approved = false; }, advance: ms => { now += ms; } };
}

test('API 4 exposes all kernel API endpoints; token stays on same loopback origin', async t => {
  const f = fixture(t); const calls = [];
  const host = new PluginHost(f.r, { fetcher: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ ok: true, value: 7 }));
  } });
  const out = await host.call('api', { url: '/api/config', method: 'POST', body: { patch: { 'features.javascriptPlugins': true } } }, f.flow);
  assert.equal(out.body.value, 7); assert.equal(calls[0].options.headers['x-bot-token'], 'test-placeholder');
  assert.equal(calls[0].options.redirect, 'error');
  for (const url of ['https://example.test/api/config', '//example.test/api/config', '/healthz',
    'http://127.0.0.1:12346/api/config', 'http://user@127.0.0.1:12345/api/config'])
    await assert.rejects(host.call('api', { url }, f.flow), /host_invalid_api_url/);
  assert.equal(calls.length, 1);
  f.revoke(); await assert.rejects(host.call('api', { url: '/api/status' }, f.flow), /grant_revoked/);
});

test('API 4 explicit search carries freshness/date hints and never invents publication time', async t => {
  const f = fixture(t); let captured;
  const host = new PluginHost(f.r, { search: async input => {
    captured = input;
    return { status: 'ok', text: 'evidence', items: [{ title: 'fixture', url: 'https://example.test/report' }] };
  } });
  const search = await host.call('search', { query: '湖人勇士比分', dateRange: { start: '2026-11-12', end: '2026-11-12' } }, f.flow);
  assert.match(captured.text, /2026-11-12.*湖人勇士/); assert.equal(captured.force, true);
  assert.equal(captured.config.enabled, true); assert.equal(search.items[0].publishedAt, null);
  assert.equal(search.dateFilter, 'query_hint_only');
  await assert.rejects(host.call('search', { query: 'test', dateRange: { start: 'bad', end: 'bad' } }, f.flow), /host_invalid_date_range/);
  assert.equal(await host.call('model', { turns: [{ role: 'user', content: 'test' }] }, f.flow), 'test');
});

test('Plugin text/voice queue preserves metadata, bypasses reminder toggle and refuses retry', async t => {
  const f = fixture(t); const host = new PluginHost(f.r);
  const queued = await host.call('send', { chatId: 'test-conversation', text: 'fixture', type: 'voice' }, f.flow);
  const [item] = f.r.reminders.due();
  assert.equal(item.pluginId, f.flow.id); assert.equal(item.pluginHash, f.flow.hash);
  assert.equal(item.delivery, 'voice'); assert.equal(f.r.reminders.list().length, 0);
  assert.equal(f.r.reminders.ack(queued.id, { ok: false }).item.status, 'unconfirmed');
  f.advance(300000); assert.deepEqual(f.r.reminders.due(), []);
  const status = await host.call('delivery', { id: queued.id }, f.flow);
  assert.equal(status.confirmed, false);
});

test('Disable or process restart cancels unclaimed plugin work and never replays uncertain sends', async t => {
  const f = fixture(t); const host = new PluginHost(f.r);
  const queued = await host.call('send', { chatId: 'test-conversation', text: 'fixture' }, f.flow);
  f.revoke(); assert.deepEqual(f.r.reminders.due(), []);
  assert.equal(f.r.reminders.items.find(row => row.id === queued.id).status, 'cancelled');
  await assert.rejects(host.call('send', { chatId: 'test-conversation', text: 'fixture' }, f.flow), /grant_revoked/);
  assert.equal(features.isOn({}, 'javascriptPlugins'), false);
});

test('Image SDK uses the real sticker queue and cancels a task after plugin revocation', async t => {
  const f = fixture(t);
  f.r.config.root = f.r.config.paths.dataDir;
  f.r.config.features = { stickers: true };
  f.r.stickerService = new StickerService(f.r.config);
  f.r.stickerService.pluginAllowed = () => f.r.bot.javascriptPlugins.isApproved();
  const host = new PluginHost(f.r);
  const file = path.join(f.r.config.paths.dataDir, 'test.png');
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64'));
  const queued = await host.call('send', { chatId: 'test-conversation', type: 'image', file }, f.flow);
  assert.equal(f.r.stickerService.pending().length, 1);
  f.revoke();
  assert.deepEqual(f.r.stickerService.pending(), []);
  assert.equal(f.r.stickerService.jobs.get(queued.id).status, 'cancelled');
});
