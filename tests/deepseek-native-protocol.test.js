'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DeepSeekClient, LlmError } = require('../src/llm/client');

function makeClient() {
  const client = new DeepSeekClient({
    logger: null,
    config: { provider: 'deepseek', deepseek: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, paths: {}, env: {} },
  });
  return client;
}

test('native payload declares web/read tools and preserves latest reminder, images, and server tool calls', () => {
  const client = makeClient();
  const payload = client.buildPayload({
    webSearch: true,
    readUrl: true,
    safetyCheck: true,
    title: true,
    turns: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] },
      { role: 'assistant', content: 'Earlier', server_tool_calls: [{ index: 0, calls: [{ type: 'deepseek_read_url' }] }] },
    ],
  });
  assert.deepEqual(payload.tools, [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }]);
  assert.deepEqual(payload.safety_check, { level: 'high' });
  assert.deepEqual(payload.title, { enabled: true });
  assert.deepEqual(payload.messages[1].server_tool_calls[0].calls[0].type, 'deepseek_read_url');
  const reminder = client.buildPayload({ latestReminder: '2026-11-22,Sunday,,Web,中文', turns: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(reminder.messages.map(message => message.role), ['latest_reminder', 'user']);
});

test('native protocol is limited to supported official endpoint paths', () => {
  const client = makeClient();
  assert.equal(client.supportsNativeProtocol(), true);
  client.baseUrl = 'https://api.deepseek.com/chat/completions';
  assert.equal(client.supportsNativeProtocol(), true);
  client.baseUrl = 'https://api.deepseek.com/v1/chat/completions';
  assert.equal(client.supportsNativeProtocol(), true);
  client.baseUrl = 'https://proxy.example/chat/completions';
  assert.equal(client.supportsNativeProtocol(), false);
  const plain = client.buildPayload({ title: true, safetyCheck: true, stream: true, latestReminder: 'latest', turns: [{ role: 'assistant', content: 'past', server_tool_calls: [{ id: 'native' }] }, { role: 'user', content: 'hi' }] });
  assert.equal('title' in plain, false);
  assert.equal('safety_check' in plain, false);
  assert.equal('stream_options' in plain, false);
  assert.equal(plain.messages[0].server_tool_calls, undefined);
  assert.deepEqual(plain.messages.map(message => message.role), ['assistant', 'user', 'user']);
});

test('refusal is raised before native metadata callbacks', async () => {
  const client = makeClient();
  client._open = async () => ({ res: { statusCode: 200 } });
  client._readAll = async () => JSON.stringify({ choices: [{ finish_reason: 'content_filter', message: { content: '', refusal: 'blocked', title: 'must-not-leak', annotations: [{ url: 'https://example.test' }] } }] });
  const called = [];
  await assert.rejects(() => client.complete({ turns: [{ role: 'user', content: 'unsafe' }], title: true, webSearch: true, onTitle: value => called.push(value), onWebSearch: value => called.push(value) }), err => err instanceof LlmError && err.code === 'refusal');
  assert.deepEqual(called, []);
});

test('high-safety stream requires a terminal marker before yielding buffered text', async () => {
  const { Readable } = require('node:stream');
  const client = makeClient();
  client._open = async () => ({ req: { destroy() {} }, res: Object.assign(Readable.from([Buffer.from('data: {"choices":[{"delta":{"content":"unsafe?"}}]}\n\n')]), { statusCode: 200 }) });
  const output = [];
  await assert.rejects(async () => { for await (const piece of client.stream({ turns: [{ role: 'user', content: 'hi' }], safetyCheck: true })) output.push(piece); }, err => err instanceof LlmError && err.code === 'incomplete_stream');
  assert.deepEqual(output, []);
  client._open = async () => ({ req: { destroy() {} }, res: Object.assign(Readable.from([Buffer.from('data: {"choices":[{"delta":{"content":"safe"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')]), { statusCode: 200 }) });
  const completed = [];
  for await (const piece of client.stream({ turns: [{ role: 'user', content: 'hi' }], safetyCheck: true })) completed.push(piece);
  assert.deepEqual(completed, ['safe']);
});

test('complete reports native title and turns content-filter refusal into friendly error', async () => {
  const client = makeClient();
  client._open = async () => ({ res: { statusCode: 200 } });
  client._readAll = async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok', title: 'A title' } }] });
  let title;
  assert.equal(await client.complete({ turns: [{ role: 'user', content: 'hi' }], title: true, onTitle: value => { title = value; } }), 'ok');
  assert.equal(title, 'A title');
  client._readAll = async () => JSON.stringify({ choices: [{ finish_reason: 'content_filter', message: { content: '', refusal: 'blocked' } }] });
  await assert.rejects(() => client.complete({ turns: [{ role: 'user', content: 'unsafe' }], safetyCheck: true }), err => err instanceof LlmError && err.code === 'refusal' && !err.message.includes('blocked'));
});
