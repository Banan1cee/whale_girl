'use strict';

/**
 * 人设写入 / 设置写入能力（persona.write@1 / settings.write@1）的验收。
 *
 * 两条硬要求：
 *   1. 路由的写入口和插件 host.call 走同一条能力，返回结构不变；
 *   2. 插件能用「改设置」授权改普通设置，但改不了密钥 —— 密钥只从本机设置页写入。
 */

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-feature-persona-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.features.plugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const server = await startServer({ root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  return { root, server };
}

const getJson = async (url, route) => (await fetch(url + route)).json();
const runPlugin = (url, id) => fetch(url + '/api/plugins/run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, capability: 'tool.run@1', input: {} }),
});

test('宿主内部写人设/设置返回原结构，密钥照旧可写', async t => {
  const { server } = await boot(t);
  const written = await server.runtime.capabilities.invokeHost('persona.write@1', { name: '宿主改的人设' });
  assert.equal(written.ok, true);
  assert.equal(written.persona.name, '宿主改的人设');
  assert.equal(typeof written.tokenCheck.tokens, 'number');
  assert.ok(Array.isArray(written.warnings));
  assert.equal(typeof written.llm.model, 'string');

  // 指到本机关闭的端口：人设 token 精确计数会尝试请求服务商，这里不该打真实网络。
  const saved = await server.runtime.capabilities.invokeHost('settings.write@1', {
    userName: '宿主称呼', apiKey: 'sk-host-key-123456',
    provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-model',
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.userName, '宿主称呼');
  const after = await getJson(server.url, '/api/settings');
  assert.equal(after.hasKey, true, '宿主路径仍能写入 API Key');
  assert.equal(after.userName, '宿主称呼');
});

test('插件可以写人设与普通设置，但写不进密钥', async t => {
  const { root, server } = await boot(t);
  await server.runtime.capabilities.invokeHost('settings.write@1', {
    apiKey: 'sk-host-key-123456', provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-model',
  });
  const before = await getJson(server.url, '/api/settings');
  assert.equal(before.hasKey, true);

  install(root, 'writer', `exports.providers = { 'tool.run@1': async (input, { host }) => {
  const persona = await host.call('persona.write@1', { name: '插件改的人设', personality: '安静一点' });
  const read = await host.call('persona.read@1', {});
  const settings = await host.call('settings.write@1', {
    userName: '插件称呼', apiKey: 'sk-plugin-attempt', visionApiKey: 'sk-plugin-vision',
  });
  // 切模型会换服务商和计费主体，属于设置页的明确操作，插件借人设写入也切不了。
  const switchAttempt = await host.call('persona.write@1', { model: 'plugin-model' });
  return { personaOk: persona.ok, name: read.name, settingsOk: settings.ok, switchOk: switchAttempt.ok };
} };`, ['persona.read@1', 'persona.write@1', 'settings.write@1']);

  const response = await runPlugin(server.url, 'writer');
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.result, { personaOk: true, name: '插件改的人设', settingsOk: true, switchOk: true });

  const persona = await getJson(server.url, '/api/persona');
  assert.equal(persona.persona.name, '插件改的人设');

  const after = await getJson(server.url, '/api/settings');
  assert.equal(after.userName, '插件称呼', '普通设置可以写');
  assert.equal(after.hasKey, true);
  assert.equal(after.keyMasked, before.keyMasked, '插件改不了主人的 Key');
  assert.equal(after.model, 'fixture-model', '插件不能借人设写入切模型');

  const settingsFile = path.join(root, 'data', 'settings.json');
  const stored = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
  assert.ok(stored.includes('sk-host-key-123456') || stored === '', '本机写入的 Key 不该被插件覆盖');
  assert.equal(stored.includes('sk-plugin-attempt'), false);
  assert.equal(stored.includes('sk-plugin-vision'), false);
});
