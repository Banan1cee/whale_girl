'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DeepSeekClient } = require('../src/llm/client');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t02-model-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('whale-t02-model-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const deepseek = {
    model: options.model || 'deepseek-chat',
    apiKey: 'test-only-key-123456',
    baseUrl: 'http://127.0.0.1:9/v1',
    maxTokens: 700,
    frequencyPenalty: 0.25,
    presencePenalty: 0.2,
    thinking: false,
  };
  if (Object.hasOwn(options, 'temperature')) deepseek.temperature = options.temperature;
  const client = new DeepSeekClient({
    logger: null,
    config: {
      provider: options.provider || 'deepseek',
      deepseek,
      env: {},
      paths: { root, dataDir: root, settingsFile: path.join(root, 'settings.json') },
    },
  });
  return { root, client };
}

function payload(client, extra = {}) {
  return client.buildPayload({ system: 'fixture', turns: [{ role: 'user', content: 'fixture' }], ...extra });
}

test('an explicit temperature zero is preserved in the ordinary model payload', t => {
  const { client } = fixture(t, { temperature: 0 });
  assert.equal(client.temperature, 0, 'config resolution already preserves zero');
  assert.equal(payload(client).temperature, 0);
});

test('missing, blank and non-finite temperatures use the default rather than becoming zero', t => {
  const missing = fixture(t);
  assert.equal(payload(missing.client).temperature, 0.95);
  for (const value of ['', null, NaN, Infinity]) {
    missing.client.temperature = value;
    assert.equal(payload(missing.client).temperature, 0.95, 'invalid temperature=' + String(value));
  }
});

test('temperature bounds and the conservative retry setting remain intentional', t => {
  const { client } = fixture(t, { temperature: 0 });
  client.temperature = -1;
  assert.equal(payload(client).temperature, 0);
  client.temperature = 3;
  assert.equal(payload(client).temperature, 2);
  client.temperature = 0;
  assert.equal(payload(client, { safe: true }).temperature, 0.7);
  client.provider = 'zhipu';
  client.temperature = 2;
  assert.equal(payload(client).temperature, 0.99);
});

test('model payload capabilities preserve OpenAI reasoning and standard-family fields', t => {
  const { client } = fixture(t, { temperature: 0.7 });
  client.frequencyPenalty = 0.25;
  client.presencePenalty = 0.2;
  for (const model of ['gpt-5-mini', 'gpt5', 'o1', 'o3-mini', 'o4-mini', 'chatgpt-4o']) {
    client.model = model;
    const built = payload(client);
    assert.equal(Object.hasOwn(built, 'temperature'), false, model);
    assert.equal(Object.hasOwn(built, 'max_tokens'), false, model);
    assert.equal(Object.hasOwn(built, 'frequency_penalty'), false, model);
    assert.equal(Object.hasOwn(built, 'presence_penalty'), false, model);
    assert.ok(Number(built.max_completion_tokens) > 0, model);
  }
  for (const model of ['deepseek-chat', 'claude-sonnet-4', 'my-custom-model']) {
    client.model = model;
    const built = payload(client);
    assert.equal(built.temperature, 0.7, model);
    assert.ok(Number(built.max_tokens) > 0, model);
  }
});

test('unknown model family retains provider fallback and existing thinking payloads', t => {
  const { client } = fixture(t, { model: 'custom-model', provider: 'qwen', temperature: 0.6 });
  const built = payload(client, { thinking: false });
  assert.equal(built.temperature, 0.6);
  assert.equal(built.enable_thinking, false);
  client.model = 'claude-sonnet-4';
  const claude = payload(client, { thinking: true });
  assert.deepEqual(claude.thinking, { type: 'enabled', budget_tokens: 1024 });
});
