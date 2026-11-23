'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DeepSeekClient } = require('../src/llm/client');

function client(url, model = 'deepseek-flash') {
  return new DeepSeekClient({
    logger: null,
    config: {
      deepseek: { apiKey: 'sk-test', baseUrl: url, model, temperature: 0, maxTokens: 200, timeoutMs: 5000 },
      provider: 'deepseek', paths: { settingsFile: path.join(os.tmpdir(), 'missing-' + Math.random()) },
      env: {}, persona: { name: '鲸鲸' },
    },
  });
}

function server(response, seen) {
  const instance = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      response(req, res);
    });
  });
  return new Promise(resolve => instance.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${instance.address().port}`,
    close: () => new Promise(done => instance.close(done)),
  })));
}

test('webSearch opts into official DeepSeek search and reports annotations/tool calls without changing text return', async () => {
  const seen = [];
  const fake = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: {
      content: 'Current answer',
      annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.test', title: 'Example', start_index: 0, end_index: 7 } }],
      server_tool_calls: [{ index: 0, calls: [{ type: 'deepseek_web_search', kind: 'search', status: 'completed' }] }],
    } }] }));
  }, seen);
  const llm = client(fake.url);
  llm.supportsWebSearch = () => true;
  let metadata;
  const answer = await llm.complete({ system: 'sys', turns: [{ role: 'user', content: 'search this' }], webSearch: true, onWebSearch: value => { metadata = value; } });
  assert.equal(answer, 'Current answer');
  assert.deepEqual(seen[0].tools, [{ type: 'deepseek_web_search' }]);
  assert.deepEqual(metadata.annotations[0].url_citation.url, 'https://example.test');
  assert.equal(metadata.serverToolCalls[0].calls[0].kind, 'search');
  await fake.close();
});

test('search is omitted by default and for unsupported runtimes', async () => {
  const llm = client('https://api.deepseek.com');
  assert.equal(llm.supportsWebSearch(), true);
  assert.equal('tools' in llm.buildPayload({ turns: [{ role: 'user', content: 'hello' }] }), false);
  assert.equal('tools' in llm.buildPayload({ turns: [{ role: 'user', content: 'hello' }], webSearch: true }), true);
  const local = client('http://127.0.0.1:1');
  assert.equal(local.supportsWebSearch(), false);
  assert.equal('tools' in local.buildPayload({ turns: [{ role: 'user', content: 'hello' }], webSearch: true }), false);
  const unsupported = client('https://api.deepseek.com', 'deepseek-v4-pro');
  assert.equal(unsupported.supportsWebSearch(), false);
  assert.equal('tools' in unsupported.buildPayload({ turns: [{ role: 'user', content: 'hello' }], webSearch: true }), false);
});

test('stream reports final annotations and server tool calls through callback', async () => {
  const seen = [];
  const fake = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Answer' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {
      annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.test' } }],
      server_tool_calls: [{ index: 0, calls: [{ type: 'deepseek_web_search', kind: 'search' }] }],
    }, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  }, seen);
  const llm = client(fake.url);
  llm.supportsWebSearch = () => true;
  const text = [];
  let metadata;
  for await (const part of llm.stream({ turns: [{ role: 'user', content: 'search' }], webSearch: true, onWebSearch: value => { metadata = value; } })) text.push(part);
  assert.equal(text.join(''), 'Answer');
  assert.deepEqual(seen[0].tools, [{ type: 'deepseek_web_search' }]);
  assert.equal(metadata.annotations[0].url_citation.url, 'https://example.test');
  assert.equal(metadata.serverToolCalls[0].calls[0].kind, 'search');
  await fake.close();
});
