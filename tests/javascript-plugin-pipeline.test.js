'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { startServer } = require('../server');
const { DEFAULT_CONFIG } = require('../src/infra/config');

test('真实内核 API 4 搜索阶段可替代默认检索，结果进入后续插件和回复提示词；关闭总闸恢复原流程', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-api4-pipeline-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.features.javascriptPlugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  config.websearch.enabled = false; config.links.enabled = false;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const directory = path.join(root, 'data', 'plugins'); fs.mkdirSync(directory, { recursive: true });
  const flow = { id: 'search-integration', api: 4, kind: 'message', hooks: ['chat.search', 'chat.search_result', 'chat.generate'],
    permissions: ['system.full'], javascript: `exports.hooks={
      'chat.search':async ctx=>({search:await ctx.whale.search(ctx.message.text)}),
      'chat.search_result':ctx=>({search:{...ctx.search,text:ctx.search.text+' verified'}}),
      'chat.generate':ctx=>({text:ctx.search.items[0].title+' '+ctx.webText})
    };`, executionTimeoutMs: 5000 };
  const bytes = Buffer.from(JSON.stringify(flow));
  fs.writeFileSync(path.join(directory, flow.id + '.flow.json'), bytes);
  fs.writeFileSync(path.join(directory, flow.id + '.enabled'), '');
  fs.writeFileSync(path.join(directory, flow.id + '.flow-grant.json'), JSON.stringify({ enabled: true, fullAccess: true,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'), settings: {} }));
  const server = await startServer({ root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  let searches = 0;
  server.runtime.pluginHost.search = async () => { searches++; return {
    status: 'ok', reason: 'fixture', text: 'SOURCE', items: [{ title: 'RESULT', url: 'https://example.test/source' }],
  }; };
  const capability = await (await fetch(server.url + '/api/plugins/capabilities')).json();
  assert.equal(capability.enabled, true); assert.ok(capability.hooks.includes('chat.search'));
  const msg = { platform: 'web', chatType: 'private', chatId: 'test-chat', senderId: 'test-user', text: '帮我查一下比赛比分' };
  const decision = await server.runtime.bot.decide(msg);
  assert.equal(decision.action, 'reply'); assert.equal(decision.msg.webText, 'SOURCE verified');
  assert.equal(server.runtime.bot.pluginContext(decision).search.items[0].publishedAt, null);
  let reply = ''; for await (const chunk of server.runtime.bot.generate(decision)) reply += chunk;
  assert.match(reply, /RESULT SOURCE verified/); assert.equal(searches, 1);
  const response = await fetch(server.url + '/api/features', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'javascriptPlugins', value: false }) });
  assert.equal(response.status, 200);
  await server.runtime.bot.javascriptPlugins.reconcile();
  assert.equal(server.runtime.bot.javascriptPlugins.workers.size, 0);
  assert.equal((await (await fetch(server.url + '/api/plugins/status')).json()).items.length, 0);
});
