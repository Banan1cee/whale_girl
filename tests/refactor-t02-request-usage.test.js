'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DeepSeekClient } = require('../src/llm/client');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t02-usage-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('whale-t02-usage-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return root;
}

async function fakeServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function clientAt(root, baseUrl) {
  return new DeepSeekClient({ logger: null, config: {
    provider: 'deepseek',
    deepseek: { apiKey: 'test-only-key-123456', baseUrl, model: 'deepseek-chat', temperature: 0.7,
      maxTokens: 100, timeoutMs: 2000, thinking: false },
    env: {}, paths: { root, dataDir: root, settingsFile: path.join(root, 'settings.json') },
  } });
}

function jsonReply(content, promptTokens) {
  return { choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 2, total_tokens: promptTokens + 2 } };
}

function sseFrames(content, promptTokens) {
  return [
    'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } }) + '\n\n',
  ].join('');
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fixture event');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('the client creates distinct opaque per-request context tokens', t => {
  const client = clientAt(temporaryRoot(t), 'http://127.0.0.1:9/v1');
  const first = client.createRequestContext();
  const second = client.createRequestContext();
  assert.match(first.id, /^[a-f0-9]{32}$/);
  assert.match(second.id, /^[a-f0-9]{32}$/);
  assert.notEqual(first.id, second.id);
});

test('interleaved chats with the same purpose and a background request retain separate usage identities', async t => {
  const pending = [];
  const url = await fakeServer(t, async (req, res) => {
    const body = await readBody(req);
    const label = body.messages.at(-1).content;
    pending.push({ label, res });
    if (pending.length !== 3) return;
    for (const item of [pending[2], pending[1], pending[0]]) {
      const prompt = { A: 11, B: 22, background: 7 }[item.label];
      item.res.writeHead(200, { 'content-type': 'application/json' });
      item.res.end(JSON.stringify(jsonReply('reply ' + item.label, prompt)));
    }
  });
  const client = clientAt(temporaryRoot(t), url);
  const contexts = { A: { id: 'turn-a' }, B: { id: 'turn-b' }, background: { id: 'job-c' } };
  await Promise.all([
    client.complete({ turns: [{ role: 'user', content: 'A' }], purpose: 'chat', requestContext: contexts.A }),
    client.complete({ turns: [{ role: 'user', content: 'B' }], purpose: 'chat', requestContext: contexts.B }),
    client.complete({ turns: [{ role: 'user', content: 'background' }], purpose: 'background', requestContext: contexts.background }),
  ]);
  for (const [label, prompt, purpose] of [['A', 11, 'chat'], ['B', 22, 'chat'], ['background', 7, 'background']]) {
    const events = client.usageEvents.filter(event => event.requestId === contexts[label].id);
    assert.equal(events.length, 1, label);
    assert.equal(events[0].promptTokens, prompt, label);
    assert.equal(events[0].purpose, purpose, label);
  }
});

test('all attempts of a complete retry keep one request context and remain additive', async t => {
  let calls = 0;
  const url = await fakeServer(t, async (_req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    const response = calls === 1
      ? { choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 0 } }
      : jsonReply('retry succeeded', 13);
    res.end(JSON.stringify(response));
  });
  const client = clientAt(temporaryRoot(t), url);
  const requestContext = { id: 'retry-context' };
  const text = await client.complete({ turns: [{ role: 'user', content: 'retry' }], purpose: 'chat', requestContext });
  assert.equal(text, 'retry succeeded');
  assert.equal(calls, 2);
  assert.deepEqual(client.usageEvents.map(event => [event.requestId, event.purpose, event.promptTokens]), [
    ['retry-context', 'chat', 9], ['retry-context', 'chat', 13],
  ]);
});

test('stream usage carries its request context while legacy calls retain the background default', async t => {
  const url = await fakeServer(t, async (req, res) => {
    const body = await readBody(req);
    const label = body.messages.at(-1).content;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseFrames(label, label === 'tagged' ? 15 : 17) + 'data: [DONE]\n\n');
  });
  const client = clientAt(temporaryRoot(t), url);
  const tagged = { id: 'stream-context' };
  const taggedText = [];
  for await (const part of client.stream({ turns: [{ role: 'user', content: 'tagged' }], purpose: 'chat', requestContext: tagged })) {
    taggedText.push(part);
  }
  const legacyText = [];
  for await (const part of client.stream({ turns: [{ role: 'user', content: 'legacy' }] })) legacyText.push(part);
  assert.equal(taggedText.join(''), 'tagged');
  assert.equal(legacyText.join(''), 'legacy');
  const taggedEvent = client.usageEvents.find(event => event.requestId === tagged.id);
  assert.equal(taggedEvent.purpose, 'chat');
  assert.equal(taggedEvent.promptTokens, 15);
  const legacyEvent = client.usageEvents.find(event => event.promptTokens === 17);
  assert.equal(legacyEvent.purpose, 'background');
  assert.equal(Object.hasOwn(legacyEvent, 'requestId'), false);
});

test('cancelling one contextual stream does not cancel its interleaved peer', async t => {
  const responses = new Map();
  let received = 0;
  let releaseBoth;
  const bothReceived = new Promise(resolve => { releaseBoth = resolve; });
  const url = await fakeServer(t, async (req, res) => {
    const body = await readBody(req);
    const label = body.messages.at(-1).content;
    responses.set(label, res);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sseFrames(label, label === 'cancel' ? 19 : 23));
    received += 1;
    if (received === 2) releaseBoth();
    if (label === 'keep') {
      await bothReceived;
      res.end('data: [DONE]\n\n');
    }
  });
  const client = clientAt(temporaryRoot(t), url);
  const cancelContext = { id: 'cancel-context' };
  const keepContext = { id: 'keep-context' };
  const controller = new AbortController();
  const collect = async options => {
    const parts = [];
    for await (const piece of client.stream(options)) parts.push(piece);
    return parts.join('');
  };
  const cancelling = collect({ turns: [{ role: 'user', content: 'cancel' }], purpose: 'chat', requestContext: cancelContext, signal: controller.signal });
  const keeping = collect({ turns: [{ role: 'user', content: 'keep' }], purpose: 'chat', requestContext: keepContext });
  await bothReceived;
  await waitFor(() => client.usageEvents.length === 2);
  controller.abort();
  const keptResponse = await keeping;
  const cancelledResponse = await cancelling;
  assert.equal(keptResponse, 'keep');
  assert.equal(cancelledResponse, 'cancel');
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(client.usageEvents.map(event => [event.requestId, event.promptTokens]).sort(), [
    ['cancel-context', 19], ['keep-context', 23],
  ]);
});

test('the client retains only the bounded most-recent usage-event history', t => {
  const client = clientAt(temporaryRoot(t), 'http://127.0.0.1:9/v1');
  for (let i = 0; i < 70; i += 1) {
    client._recordUsage({ usage: { prompt_tokens: i + 1, completion_tokens: 1 } }, 'chat', 'bounded-context');
  }
  assert.equal(client.usageSeq, 70);
  assert.equal(client.usageEvents.length, 64);
  assert.equal(client.usageEvents[0].seq, 7);
  assert.equal(client.usageEvents.at(-1).requestId, 'bounded-context');
});
