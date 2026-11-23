'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer } = require('../server');
const { DEFAULT_CONFIG } = require('../src/infra/config');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function install(root, id, source, calls) {
  const directory = path.join(root, 'data', 'plugins', id);
  fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
  const manifest = Buffer.from(JSON.stringify({
    format: 'whale-plugin/1', level: 4, id, name: id, author: '测试', version: '1.0.0',
    minAppVersion: '4.3.0', description: 'SDK', entry: 'plugin.js', runtime: 'node-full',
    provides: { 'tool.run@1': { mode: 'tool', scope: 'manual' } }, calls,
  }));
  const entry = Buffer.from(source);
  fs.writeFileSync(path.join(directory, 'plugin.json'), manifest);
  fs.writeFileSync(path.join(directory, 'plugin.js'), entry);
  fs.writeFileSync(path.join(directory, 'grant.json'), JSON.stringify({
    enabled: true, level: 4, fullAccess: true, nodeFullConfirmed: true, chatConfirmed: false,
    approvedDataAccess: [], epoch: crypto.randomUUID(),
    packageHash: sha(manifest), manifestHash: sha(manifest), entryHash: sha(entry),
    approvedProviders: ['tool.run@1'], approvedCalls: calls, settings: {},
  }));
}

async function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-sdk-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.features.plugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const server = await startServer({ root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, server };
}

const run = (server, id, input) => fetch(server.url + '/api/plugins/run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, capability: 'tool.run@1', input }),
});

test('SDK exposes settings, features, reminders, stickers, diary, moments, wechat, bridge and plugins', async t => {
  const { root, server } = await boot(t);
  const calls = ['settings.read@1', 'features.read@1', 'reminders.list@1', 'stickers.status@1',
    'diary.status@1', 'moments.latest@1', 'wechat.status@1', 'bridge.status@1', 'plugins.status@1'];
  install(root, 'probe', `exports.providers = { 'tool.run@1': async (input, { host }) => {
    const names = ${JSON.stringify(calls)};
    const out = {};
    for (const name of names) {
      try {
        const value = await host.call(name, {});
        out[name] = name === 'settings.read@1' ? typeof value === 'object'
          : name === 'features.read@1' ? Array.isArray(value.features)
            : name === 'reminders.list@1' ? Array.isArray(value.reminders)
              : name === 'stickers.status@1' ? typeof value.status === 'object'
                : name === 'diary.status@1' ? typeof value.status === 'object'
                  : name === 'moments.latest@1' ? Object.hasOwn(value, 'latest')
                    : name === 'wechat.status@1' ? typeof value.bridge === 'object'
                      : name === 'bridge.status@1' ? Object.hasOwn(value, 'online')
                        : Array.isArray(value.items);
      } catch (error) { out[name] = error.code || 'error'; }
    }
    return out;
  } };`, calls);
  const response = await run(server, 'probe', {});
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  for (const [key, value] of Object.entries(body.result)) assert.equal(value, true, key);
});

test('SDK refuses undeclared calls and supports reminder create/cancel', async t => {
  const { root, server } = await boot(t);
  install(root, 'limited', `exports.providers = { 'tool.run@1': async (input, { host }) => {
    try { await host.call('stickers.status@1', {}); } catch (error) { return { code: error.code }; }
  } };`, []);
  const refused = await (await run(server, 'limited', {})).json();
  assert.equal(refused.result.code, 'host_capability_not_declared');

  install(root, 'reminder', `exports.providers = { 'tool.run@1': async (input, { host }) => {
    const created = await host.call('reminders.create@1', { chatId: 'fixture-chat', text: '喝水', at: Date.now() + 600000 });
    const listed = await host.call('reminders.list@1', {});
    await host.call('reminders.cancel@1', { id: created.id });
    return { id: created.id, before: listed.reminders.some(item => item.id === created.id) };
  } };`, ['reminders.create@1', 'reminders.list@1', 'reminders.cancel@1']);
  const response = await run(server, 'reminder', {});
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.result.before, true);
  assert.ok(body.result.id);
});
