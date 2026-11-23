'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PluginHost } = require('../src/services/pluginHost');

function fixture(overrides = {}, dependencies = {}) {
  const config = { paths: { dataDir: 'data' }, websearch: {}, env: { timezone: 'Asia/Shanghai' } };
  const runtime = {
    version: '4.3.0',
    config,
    llm: { complete: async options => { assert.equal(options.purpose, 'plugin'); return 'model text'; } },
    plugins: { isApproved: () => true },
    ...overrides,
  };
  return { runtime, host: new PluginHost(runtime, dependencies) };
}

const flow = (calls = ['status.read@1']) => ({ id: 'demo', packageHash: 'a'.repeat(64), calls });

test('status.read@1 only returns the declared summary shape', async () => {
  const { host } = fixture();
  assert.deepEqual(await host.call('status.read@1', {}, flow()), {
    version: '4.3.0', running: true, pluginProtocol: 'whale-plugin/1',
  });
});

test('undeclared, disabled and unknown host calls are refused before running', async () => {
  const { host } = fixture();
  await assert.rejects(host.call('status.read@1', {}, flow([])), { code: 'host_capability_not_declared' });
  await assert.rejects(host.call('message.submit@1', { chatId: 'c', text: 'x' }, flow(['message.submit@1'])),
    { code: 'host_capability_disabled' });
  await assert.rejects(host.call('api.read@1', {}, flow(['api.read@1'])), { code: 'host_capability_unknown' });
  await assert.rejects(host.call('status.read@1', { extra: true }, flow()), { code: 'invalid_host_capability_input' });
});

test('revoked grants cannot reach the host', async () => {
  const { host } = fixture({ plugins: { isApproved: () => false } });
  await assert.rejects(host.call('status.read@1', {}, flow()), { code: 'grant_revoked' });
});

test('search.query@1 projects provider results into the contract and clamps the timeout', async () => {
  const seen = [];
  const { host } = fixture({}, { search: async input => { seen.push(input); return {
    status: 'ok', text: 'x'.repeat(5), items: [{ title: 'T', url: 'https://e.test', snippet: 'S', raw: 'dropped' }],
  }; } });
  const out = await host.call('search.query@1', { query: '天气', timeoutMs: 9000 }, flow(['search.query@1']));
  assert.equal(seen[0].config.enabled, true);
  assert.equal(seen[0].config.timeoutMs <= 30000 && seen[0].config.timeoutMs >= 500, true);
  assert.deepEqual(out.items, [{ title: 'T', url: 'https://e.test', snippet: 'S', publishedAt: null, fetchedAt: null }]);
  assert.equal(out.status, 'ok');
});

test('model.complete@1 is the only way a plugin gets model text', async () => {
  const { host } = fixture();
  const out = await host.call('model.complete@1', { turns: [{ role: 'user', content: 'hi' }] },
    flow(['model.complete@1']));
  assert.deepEqual(out, { text: 'model text' });
  await assert.rejects(host.call('model.complete@1', { turns: [{ role: 'system', content: 'x' }] },
    flow(['model.complete@1'])), { code: 'invalid_host_capability_input' });
});
