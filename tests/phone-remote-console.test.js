'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { createConsole } = require('../tools/remote-console/server');

async function start(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

function stop(server) {
  return new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
    server.closeAllConnections();
  });
}

test('配对、数据白名单、指定操作和内核离线', async t => {
  const token = randomBytes(24).toString('hex');
  const state = { keyMasked: 'example-only', baseUrl: 'internal-address', sourcePreset: '', freeChat: false,
    care: false, stickers: false, voice: false, stickerChance: 0.7, javascriptPlugins: false, momentsPublish: false };
  let requireAt = true;
  let statusCode = 200;
  let statusBody;
  let failStatusAfterSave = false;
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    calls.push([req.method, req.url, parsed]);
    let payload;
    if (req.url === '/api/status') {
      payload = {
        name: '鲸鲸', version: '4.1.8.2', uptimeSec: 81,
        keyMasked: state.keyMasked, baseUrl: state.baseUrl,
        group: { requireAt, freeChat: state.freeChat },
        gateways: [{ platform: 'wechat', bridge: { online: true, uia: true, accountWxid: 'hidden-account' } }],
      };
      if (statusCode !== 200 || statusBody !== undefined) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        return res.end(statusBody ?? JSON.stringify({ ok: false }));
      }
    }
    if (req.url === '/api/features') {
      if (parsed?.key === 'proactiveCare') state.care = parsed.value;
      if (parsed?.key === 'stickers') state.stickers = parsed.value;
      if (parsed?.key === 'javascriptPlugins') state.javascriptPlugins = parsed.value;
      payload = { features: [{ key: 'proactiveCare', value: state.care }, { key: 'stickers', value: state.stickers },
        { key: 'javascriptPlugins', value: state.javascriptPlugins }] };
    }
    if (req.url === '/api/persona') {
      payload = { persona: { sourcePreset: state.sourcePreset, customPrompt: 'private-prompt' } };
    }
    if (req.url === '/api/persona/presets') {
      payload = { presets: [{ id: 'standard', name: '标准', file: 'private-file.json', source: 'builtin' }] };
    }
    if (req.url === '/api/config' && req.method === 'POST') {
      if ('group.freeChat' in parsed.patch) state.freeChat = parsed.patch['group.freeChat'];
      if ('sticker.demandChance' in parsed.patch) state.stickerChance = parsed.patch['sticker.demandChance'];
      if (failStatusAfterSave) statusCode = 500;
      payload = { config: { deepseek: { apiKey: 'private-key' } } };
    }
    if (req.url === '/api/config' && req.method === 'GET') {
      payload = { config: { group: { cooldownSec: 180 }, deepseek: { apiKey: 'private-key' },
        env: { timezone: 'Asia/Shanghai' }, wechat: { ignoreSenders: ['fixture-chat'] }, server: { port: 8787 },
        sticker: { demandChance: state.stickerChance, collectReceived: true } } };
    }
    if (req.url === '/api/settings') {
      payload = { provider: 'deepseek', model: 'test-model', hasKey: true,
        apiKey: 'private-key', keyMasked: 'private-mask', dataDir: 'private-folder',
        providers: { deepseek: { label: 'DeepSeek', model: 'test-model', apiKey: 'private-key' } } };
    }
    if (req.url === '/api/wechat/accounts') {
      payload = { current: 'fixture-account', dbDir: 'private-folder', accounts: [
        { account: 'fixture-account', nick: '测试微信', dbDir: 'private-folder' },
      ] };
    }
    if (req.url === '/api/wechat/account') payload = { current: parsed.account };
    if (req.url === '/api/reminders') payload = { items: [
      { id: 'reminder-1', text: '测试提醒', status: 'pending', wxid: 'private-account' },
    ] };
    if (req.url === '/api/reminders/cancel') payload = { item: { id: parsed.id, status: 'cancelled' } };
    if (req.url === '/api/diary') payload = { status: 'idle', message: '尚未生成日记', file: 'private-file' };
    if (req.url === '/api/diary/generate') payload = { status: 'running', message: '正在生成日记…' };
    if (req.url === '/api/moments/settings') payload = { autoLike: true, autoReadEveryHours: 4, autoLikeMaxPerDay: 2 };
    if (req.url === '/api/moments/latest') payload = { snapshot: { items: [{ nickname: '测试发布者', text: '测试正文' }] } };
    if (req.url === '/api/moments/publish-settings') {
      if (parsed) state.momentsPublish = parsed.featureEnabled;
      payload = { featureEnabled: state.momentsPublish, enabled: false, withImage: false,
        interval: 6, maxPerDay: 1, status: 'idle', account: 'private-publish-account' };
    }
    if (req.url === '/api/moments/publish-test') payload = { status: 'queued' };
    if (req.url === '/api/stickers/status' && state.stickers) payload = { emotions: [{ key: 'x:自定义', label: '自定义', count: 1,
      items: [{ id: '自定义/图.png', name: '图.png', path: 'private-path' }] }] };
    if (req.url.startsWith('/api/stickers/image?')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(Buffer.from([137, 80, 78, 71]));
    }
    if (req.url === '/api/stickers/upload') payload = { uploaded: parsed.files };
    if (req.url === '/api/stickers/test') payload = { queued: { id: 'test' } };
    if (req.url === '/api/stickers/category') payload = { label: parsed.label };
    if (req.url === '/api/persona/preset/save') payload = { preset: { id: 'fixture', name: parsed.name } };
    if (req.url === '/api/persona/preset' && parsed?.id === 'standard') {
      state.sourcePreset = parsed.id;
      payload = { applied: { id: parsed.id } };
    }
    res.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: Boolean(payload), ...payload }));
  });
  await start(upstream);
  const upstreamPort = upstream.address().port;
  t.after(() => upstream.listening && stop(upstream));
  const controlCalls = [];
  const consoleServer = createConsole({
    token, whalePort: upstream.address().port,
    controlLauncher: async (action, body) => {
      if (action === 'voice-toggle') { state.voice = body.enabled; return { ok: true, enabled: state.voice }; }
      if (action === 'voice-read') return { ok: true, enabled: state.voice };
      controlCalls.push(action);
      return { ok: true, message: action };
    },
  });
  const consoleUrl = await start(consoleServer);
  t.after(() => stop(consoleServer));

  const auth = { Authorization: 'Bearer ' + token };
  const get = (url, headers = auth) => fetch(consoleUrl + url, { headers });
  const post = (url, data, headers = auth) => fetch(consoleUrl + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });

  await t.test('登录页和资源可加载，未配对无法访问控制接口', async () => {
    const landing = await get('/', {});
    assert.equal(landing.status, 200);
    assert.match(landing.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await landing.text(), /连接你的鲸鲸/);
    assert.equal((await get('/manifest.webmanifest', {})).status, 200);
    assert.equal((await get('/console/status', {})).status, 401);
    assert.equal((await get('/console/settings', {})).status, 401);
    assert.equal((await fetch(consoleUrl + '/console/pairing', { method: 'HEAD' })).status, 401);
    assert.equal((await fetch(consoleUrl + '/console/pairing', { method: 'HEAD', headers: auth })).status, 204);
    assert.equal((await post('/console/setting', { key: 'freeChat', value: true }, {})).status, 401);
    assert.equal((await get('/console/status', { ...auth, 'Sec-Fetch-Site': 'cross-site' })).status, 401);
    assert.equal(calls.length, 0);
  });

  await t.test('状态仅返回控制台需要的字段', async () => {
    const body = await (await get('/console/status')).text();
    const data = JSON.parse(body);
    assert.equal(data.kernel.version, '4.1.8.2');
    assert.equal(data.bridge.online, true);
    assert.deepEqual(data.presets, [{ id: 'standard', name: '标准', version: '', source: 'builtin' }]);
    assert.doesNotMatch(body, /example-only|internal-address|hidden-account|private-prompt|private-file/);
  });

  await t.test('更改写入本机内核，拒绝任意内核路径和无效数据', async () => {
    const config = await post('/console/setting', { key: 'freeChat', value: true, patch: { provider: 'other' } });
    const result = await config.json();
    assert.equal(result.saved, true);
    assert.equal(result.settings.freeChat, true);
    assert.doesNotMatch(JSON.stringify(result), /private-key/);
    assert.ok(calls.some(([, url, body]) => url === '/api/config' &&
      JSON.stringify(body) === '{"patch":{"group.freeChat":true}}'));
    const feature = await post('/console/setting', { key: 'proactiveCare', value: true });
    assert.equal((await feature.json()).settings.proactiveCare, true);
    const persona = await post('/console/persona', { id: 'standard' });
    assert.equal((await persona.json()).currentPreset, 'standard');
    assert.equal((await post('/console/setting', { key: 'freeChat', value: 'true' })).status, 400);
    assert.equal((await post('/console/setting', { key: 'javascriptPlugins', value: true })).status, 400);
    assert.equal((await post('/console/persona', { id: '../../invalid' })).status, 400);
    assert.equal((await get('/api/config')).status, 404);
    assert.equal((await post('/console/setting', { extra: 'x'.repeat(4100) })).status, 413);
  });

  await t.test('旧版群聊配置按内核同样的规则解释', async () => {
    state.freeChat = ' ON ';
    requireAt = 'false';
    const { settings } = await (await get('/console/status')).json();
    assert.equal(settings.freeChat, true);
    assert.equal(settings.requireAt, false);
  });

  await t.test('详细设置只返回可编辑字段，并逐项校验写入值', async () => {
    const response = await get('/console/settings');
    const content = await response.text();
    assert.doesNotMatch(content, /private-key|apiKey/);
    assert.equal(JSON.parse(content).groups[0].fields[0].value, 180);
    assert.equal((await post('/console/setting', { key: 'group.cooldownSec', value: 90 })).status, 200);
    assert.equal((await post('/console/setting', { key: 'group.cooldownSec', value: -1 })).status, 400);
    assert.equal((await post('/console/setting', { key: 'group.cooldownSec', value: '90' })).status, 400);
    assert.equal((await post('/console/setting', { key: 'server.allowRemote', value: true })).status, 400);
    const fields = Object.fromEntries(JSON.parse(content).groups.flatMap(group => group.fields.map(field => [field.key, field])));
    assert.equal(fields['env.timezone'].type, 'text');
    assert.deepEqual(fields['wechat.ignoreSenders'].value, ['fixture-chat']);
    assert.equal(fields['server.port'].type, 'selectnum');
    assert.equal((await post('/console/setting', { key: 'wechat.ignoreSenders', value: ['fixture-chat-2'] })).status, 200);
    assert.equal((await post('/console/setting', { key: 'wechat.ignoreSenders', value: 'fixture-chat-2' })).status, 400);
    assert.equal((await post('/console/setting', { key: 'server.port', value: 4444 })).status, 400);
    assert.ok(calls.some(([, url, body]) => url === '/api/config' && body?.patch['group.cooldownSec'] === 90));
  });

  await t.test('手机编辑模型时可写入新 Key，读取时只返回配置状态', async () => {
    const body = await (await get('/console/model')).text();
    assert.equal(JSON.parse(body).hasKey, true);
    assert.doesNotMatch(body, /private-key|private-mask|private-folder/);
    assert.equal((await post('/console/model', { model: 'test-model', apiKey: 'fixture-key' })).status, 200);
    assert.equal((await post('/console/model', { keyMasked: 'fixture' })).status, 400);
    assert.equal((await post('/console/model', { baseUrl: 'https://example.invalid/v1' })).status, 400);
    assert.equal((await post('/console/model', { baseUrl: 'http://example.invalid/v1', apiKey: 'fixture-key' })).status, 400);
    assert.equal((await post('/console/model', { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture-key' })).status, 200);
  });

  await t.test('子菜单只可执行预定操作，读取时去掉文件路径和提醒收件人账号', async () => {
    const accounts = await (await post('/console/page', { page: 'bridge' })).text();
    assert.equal(JSON.parse(accounts).selectedAccount, 'fixture-account');
    assert.doesNotMatch(accounts, /private-folder/);
    const reminders = await (await post('/console/page', { page: 'reminders' })).text();
    assert.equal(JSON.parse(reminders).reminders[0].cancelable, true);
    assert.doesNotMatch(reminders, /private-account/);
    assert.equal((await post('/console/page-command', { action: 'cancel-reminder', value: 'reminder-1' }, {})).status, 401);
    assert.equal((await post('/console/page-command', { action: 'cancel-reminder', value: 'reminder-1' })).status, 200);
    assert.equal((await post('/console/page-command', { action: 'switch-account', value: 'fixture-account' })).status, 200);
    assert.equal((await post('/console/page-command', { action: '/api/config' })).status, 400);
  });

  await t.test('手机可管理表情包分类、触发日记和另存人设', async () => {
    const disabled = await (await post('/console/page', { page: 'stickers' })).json();
    assert.equal(disabled.sticker.enabled, false);
    assert.equal(disabled.sticker.collect, true);
    assert.equal(disabled.sticker.manageable, false);
    assert.ok(!calls.some(([, url]) => url === '/api/stickers/status'));
    assert.equal((await post('/console/page-command', { action: 'sticker-toggle', body: { enabled: true } })).status, 200);
    const stickers = await (await post('/console/page', { page: 'stickers' })).json();
    assert.equal(stickers.sticker.categories[0].custom, true);
    assert.equal(stickers.sticker.categories[0].files[0].id, '自定义/图.png');
    assert.doesNotMatch(JSON.stringify(stickers), /private-path/);
    assert.equal((await post('/console/page-command', { action: 'sticker-category', body: { action: 'add', label: '新分类' } })).status, 200);
    assert.equal((await post('/console/page-command', { action: 'sticker-category', body: { action: 'move', label: '新分类' } })).status, 400);
    const diaries = await (await post('/console/page', { page: 'reminders' })).text();
    assert.doesNotMatch(diaries, /private-file/);
    assert.equal((await post('/console/page-command', { action: 'generate-diary' })).status, 200);
    assert.equal((await post('/console/page-command', { action: 'save-persona-preset', body: { name: '测试人设' } })).status, 200);
    assert.equal((await post('/console/page-command', { action: 'delete-persona-preset', value: '../other' })).status, 400);
  });

  await t.test('两个总开关可独立保存，真实试发和预览需要确认或配对', async () => {
    const command = (action, body, headers) => post('/console/page-command', { action, body }, headers);
    assert.equal((await command('voice-toggle', { enabled: true }, {})).status, 401);
    assert.equal((await command('voice-toggle', { enabled: true })).status, 200);
    assert.equal((await (await post('/console/page', { page: 'voice' })).json()).voice.enabled, true);
    assert.equal((await command('voice-toggle', { enabled: false })).status, 200);
    assert.equal((await (await post('/console/page', { page: 'voice' })).json()).voice.enabled, false);
    assert.equal((await command('sticker-frequency', { frequency: 55, ensure: true })).status, 200);
    assert.equal(state.stickerChance, 0.55);
    assert.equal((await command('sticker-folder', { folder: '../elsewhere' })).status, 400);
    assert.equal((await command('sticker-send', { emotion: 'x:自定义' })).status, 400);
    const image = { emotion: 'x:自定义', name: '自定义/图.png' };
    assert.equal((await post('/console/sticker-image', image, {})).status, 401);
    assert.equal((await post('/console/sticker-image', image)).headers.get('content-type'), 'image/png');
    assert.equal((await post('/console/sticker-upload', { emotion: 'x:自定义', file: { name: 'a.png', data: 'dGVzdA==' } })).status, 200);
    assert.equal((await command('sticker-toggle', { enabled: false })).status, 200);
    assert.equal(state.stickers, false);
  });

  await t.test('朋友圈发表与 JavaScript 插件总开关使用与桌面相同的接口', async () => {
    const command = (action, body) => post('/console/page-command', { action, body });
    const content = await (await post('/console/page', { page: 'moments' })).text();
    const page = JSON.parse(content);
    assert.equal(page.moments.featureEnabled, false);
    assert.equal(page.moments.autoLike, true);
    assert.doesNotMatch(content, /private-publish-account/);
    assert.equal((await command('moments-publish-toggle', { enabled: true })).status, 200);
    assert.equal(state.momentsPublish, true);
    assert.equal((await command('moments-publish-now', { withImage: false })).status, 400);
    assert.equal((await command('moments-publish-toggle', { enabled: false })).status, 200);
    assert.equal(state.momentsPublish, false);
    assert.equal((await command('javascript-plugins-toggle', { enabled: true })).status, 400);
    assert.equal((await command('javascript-plugins-toggle', { enabled: true, confirm: true })).status, 200);
    assert.equal(state.javascriptPlugins, true);
    assert.equal((await command('javascript-plugins-toggle', { enabled: false })).status, 200);
    assert.equal(state.javascriptPlugins, false);
    assert.equal((await post('/console/identity', { newBehavior: true, masterRoast: false })).status, 200);
    assert.equal((await post('/console/identity', { newBehavior: 'true' })).status, 400);
  });

  await t.test('内核返回错误或无效 JSON 时不显示为离线', async () => {
    try {
      statusCode = 500;
      const errorResponse = await get('/console/status');
      assert.equal(errorResponse.status, 502);
      assert.match((await errorResponse.json()).error, /HTTP 500/);

      statusCode = 200;
      statusBody = '<html>unexpected response</html>';
      const invalidResponse = await get('/console/status');
      assert.equal(invalidResponse.status, 502);
      assert.match((await invalidResponse.json()).error, /响应无法读取/);
    } finally {
      statusCode = 200;
      statusBody = undefined;
    }
  });

  await t.test('修改成功后即使状态刷新失败，仍确认保存成功', async () => {
    failStatusAfterSave = true;
    try {
      const response = await post('/console/setting', { key: 'freeChat', value: false });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.saved, true);
      assert.match(result.statusError, /HTTP 500/);
      assert.equal(state.freeChat, false);
    } finally {
      failStatusAfterSave = false;
      statusCode = 200;
    }
  });

  await t.test('内核停机后仍可配对查看状态，写入错误单独反馈', async () => {
    await stop(upstream);
    assert.deepEqual(await (await get('/console/status')).json(), { kernel: null });
    assert.equal((await post('/console/setting', { key: 'freeChat', value: false })).status, 503);
  });

  await t.test('内核离线时只接受已配对且明确列出的启动器命令', async () => {
    assert.equal((await post('/console/control', { action: 'start' }, {})).status, 401);
    assert.equal((await post('/console/control', { action: 'powershell' })).status, 400);
    assert.equal((await post('/console/setting', { key: 'quoteReply', value: true })).status, 400);
    for (const action of ['start', 'stop', 'restart', 'restart-bridge', 'restart-wechat']) {
      assert.equal((await post('/console/control', { action })).status, 200);
    }
    assert.equal((await get('/console/diagnostics')).status, 200);
    assert.deepEqual(controlCalls, ['start', 'stop', 'restart', 'restart-bridge', 'restart-wechat', 'diagnostics']);
  });

  await t.test('内核停止后可由桌面启动器读取和保存既有设置', async () => {
    const upstreamCalls = [];
    const offline = createConsole({
      token, whalePort: upstreamPort, managedOffline: true,
      controlLauncher: async (action, payload) => {
        upstreamCalls.push([action, payload.path]);
        return { ok: true, data: { ok: true, config: { group: { freeChat: true } } } };
      },
    });
    const base = await start(offline);
    try {
      const result = await fetch(base + '/console/settings', { headers: auth });
      assert.equal(result.status, 200);
      const saved = await fetch(base + '/console/setting', {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'freeChat', value: false }),
      });
      assert.equal(saved.status, 200);
      assert.ok(upstreamCalls.some(call => call.join(' ') === 'configuration-save /api/config'));
    } finally {
      await stop(offline);
    }
  });
});

test('主机状态卡与主机操作', async t => {
  const token = randomBytes(24).toString('hex');
  const upstream = http.createServer((req, res) => {
    const payload = req.url === '/api/status'
      ? { ok: true, name: '鲸鲸', version: '4.1.8.2', uptimeSec: 60,
        gateways: [{ platform: 'wechat', bridge: { online: true, uia: true } }] }
      : { ok: false };
    res.writeHead(req.url === '/api/status' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await start(upstream);
  t.after(() => upstream.listening && stop(upstream));
  const hostState = { locked: true, inputDesktop: 'Default', logonUI: false, foreground: 'explorer',
    idleSeconds: 125, sessionId: 1, keepAwake: 'system', remoteProcessLaunch: false, autoStart: false,
    processLaunchAllowed: true, hostname: 'fixture-pc', uptimeSeconds: 3600 };
  const commands = [];
  let launcherDown = false;
  const consoleServer = createConsole({
    token, whalePort: upstream.address().port,
    controlLauncher: async (action, payload) => {
      if (launcherDown) throw new Error('无法连接电脑上的鲸鲸启动器，请确认它已打开。');
      commands.push([action, payload]);
      if (action === 'host-state') return { ok: true, data: { ...hostState } };
      if (action === 'host-keep-awake') { hostState.keepAwake = payload.mode; return { ok: true, data: { mode: payload.mode } }; }
      if (action === 'host-wake-display') return { ok: true, message: '已点亮屏幕。' };
      if (action === 'host-display-off') return { ok: true, message: '已发送关屏指令。' };
      if (action === 'host-config') {
        if (typeof payload.remoteProcessLaunch === 'boolean') hostState.remoteProcessLaunch = payload.remoteProcessLaunch;
        if (typeof payload.autoStart === 'boolean') hostState.autoStart = payload.autoStart;
        return { ok: true, data: { remoteProcessLaunch: hostState.remoteProcessLaunch, autoStart: hostState.autoStart } };
      }
      return { ok: false, error: '未知操作。' };
    },
  });
  const consoleUrl = await start(consoleServer);
  t.after(() => stop(consoleServer));

  const auth = { Authorization: 'Bearer ' + token };
  const get = (url, headers = auth) => fetch(consoleUrl + url, { headers });
  const post = (url, data, headers = auth) => fetch(consoleUrl + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });

  await t.test('主机状态需要配对，且把启动器数据与内核状态合并返回', async () => {
    assert.equal((await get('/console/host', {})).status, 401);
    const response = await get('/console/host');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.locked, true);
    assert.equal(body.data.keepAwake, 'system');
    assert.equal(body.data.hostname, 'fixture-pc');
    assert.equal(body.data.kernelRunning, true);
    assert.equal(body.data.bridgeOnline, true);
    // host-* 只在带参的主机端点使用，不能从只传一个 action 的 /console/control 混进来。
    assert.equal((await post('/console/control', { action: 'host-state' })).status, 400);
  });

  await t.test('主机操作拒绝未知动作、缺少确认和非布尔开关值', async () => {
    assert.equal((await post('/console/host-command', { action: 'shutdown' })).status, 400);
    const missing = await post('/console/host-command', { action: 'keep-awake', value: 'system' });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, '这个操作需要二次确认。');
    assert.equal((await post('/console/host-command', { action: 'keep-awake', value: 'always', confirm: true })).status, 400);
    assert.equal((await post('/console/host-command', { action: 'remote-process-launch', value: 'yes', confirm: true })).status, 400);
    assert.equal((await post('/console/host-command', { action: 'auto-start', value: 1, confirm: true })).status, 400);
    assert.equal((await post('/console/host-command', { action: 'keep-awake', value: 'system' }, {})).status, 401);
  });

  await t.test('保活、点亮/关闭屏幕和两个开关映射到启动器动作', async () => {
    let response = await post('/console/host-command', { action: 'keep-awake', value: 'display', confirm: true });
    assert.equal(response.status, 200);
    assert.ok(commands.some(([action, payload]) => action === 'host-keep-awake' && payload.mode === 'display'));
    response = await post('/console/host-command', { action: 'wake-display' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, '已点亮屏幕。');
    // 关屏不需要二次确认，但必须真的转发到启动器。
    response = await post('/console/host-command', { action: 'display-off' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, '已发送关屏指令。');
    assert.ok(commands.some(([action]) => action === 'host-display-off'));
    response = await post('/console/host-command', { action: 'remote-process-launch', value: true, confirm: true });
    assert.equal(response.status, 200);
    assert.ok(commands.some(([action, payload]) => action === 'host-config' && payload.remoteProcessLaunch === true));
    response = await post('/console/host-command', { action: 'auto-start', value: true, confirm: true });
    assert.equal(response.status, 200);
    assert.ok(commands.some(([action, payload]) => action === 'host-config' && payload.autoStart === true));
    const hostAfter = (await (await get('/console/host')).json()).data;
    assert.equal(hostAfter.keepAwake, 'display');
    assert.equal(hostAfter.remoteProcessLaunch, true);
    assert.equal(hostAfter.autoStart, true);
  });

  await t.test('启动器不可用时主机状态与命令都返回 503', async () => {
    launcherDown = true;
    try {
      const response = await get('/console/host');
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, '启动器未运行，主机状态不可用。');
      assert.equal((await post('/console/host-command', { action: 'wake-display' })).status, 503);
    } finally {
      launcherDown = false;
    }
  });
});
