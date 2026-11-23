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

function installPlugin(root, { id = 'word-count', source, manifest: extra = {} }) {
  const directory = path.join(root, 'data', 'plugins', id);
  fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
  const manifest = Buffer.from(JSON.stringify({
    format: 'whale-plugin/1', level: 4, id, name: '字数', author: '测试', version: '1.0.0',
    minAppVersion: '4.3.0', description: '统计字符数', entry: 'plugin.js', runtime: 'node-full',
    provides: { 'tool.run@1': { mode: 'tool', scope: 'manual' } },
    calls: ['status.read@1'], ...extra,
  }));
  const entry = Buffer.from(source);
  fs.writeFileSync(path.join(directory, 'plugin.json'), manifest);
  fs.writeFileSync(path.join(directory, 'plugin.js'), entry);
  fs.writeFileSync(path.join(directory, 'grant.json'), JSON.stringify({
    enabled: true, level: 4, fullAccess: true, nodeFullConfirmed: true, epoch: crypto.randomUUID(),
    packageHash: sha(manifest), manifestHash: sha(manifest), entryHash: sha(entry),
    approvedProviders: Object.keys(JSON.parse(manifest).provides),
    approvedCalls: JSON.parse(manifest).calls, settings: {},
  }));
  return directory;
}

test('a locally installed whale-plugin/1 tool runs end to end through the local API', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-e2e-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.features.plugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  installPlugin(root, {
    source: `exports.providers = { 'tool.run@1': async (input, { host }) => {
      const status = await host.call('status.read@1', {});
      return { chars: [...String(input.text || '')].length, appVersion: status.version };
    } };`,
  });
  const server = await startServer({ root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const status = await (await fetch(server.url + '/api/plugins/status')).json();
  assert.equal(status.enabled, true);
  assert.deepEqual(status.items.map(item => item.id), ['word-count']);
  assert.deepEqual(status.items[0].provides, { 'tool.run@1': { mode: 'tool', scope: 'manual' } });

  const response = await fetch(server.url + '/api/plugins/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'word-count', capability: 'tool.run@1', input: { text: '深海鲸鱼' } }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.result.chars, 4);
  assert.equal(body.result.appVersion, server.runtime.version);

  // 只允许手动执行 tool.run@1；其他能力不能被这个口调起。
  const rejected = await fetch(server.url + '/api/plugins/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'word-count', capability: 'chat.handle@1', input: {} }),
  });
  assert.equal(rejected.status, 400);
});

test('a repeated inbound message reaches the takeover provider only once', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-takeover-'));
  let server;
  t.after(async () => {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.features.plugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  config.gateway.wechat.inboundToken = 'test-takeover-token';
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  installPlugin(root, {
    id: 'takeover',
    source: `exports.providers = { 'chat.handle@1': () => ({ action: 'reply', reply: 'fixture reply' }) };`,
    manifest: { provides: { 'chat.handle@1': { mode: 'replace', scope: 'all' } }, calls: [] },
  });
  server = await startServer({ root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  // 只替换执行器传输，保留授权、路由与去重路径，测试不依赖创建子进程。
  const plugins = server.runtime.plugins;
  const transport = t.mock.method(plugins, 'spawn', job => {
    plugins.finish(job, null, { action: 'reply', reply: 'fixture reply' });
  });
  const receive = async () => {
    const res = await fetch(server.url + '/webhook/wechat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': 'test-takeover-token', 'x-whale-bridge': '1' },
      body: JSON.stringify({ chat_id: 'fixture-chat', chat_type: 'private', sender_id: 'fixture-sender', text: 'example', msg_id: 'fixture-1' }),
    });
    assert.equal(res.status, 200);
    return res.json();
  };
  const [first, second] = await Promise.all([receive(), receive()]);
  const reply = [first, second].find(result => result.action === 'reply');
  const ignored = [first, second].find(result => result.action === 'ignore');
  assert.equal(reply?.reply, 'fixture reply');
  assert.equal(ignored?.reason, 'duplicate');
  assert.equal(transport.mock.callCount(), 1);
});

test('takeover replies go through host bubbles, store and per-session quota', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-govern-'));
  let server;
  t.after(async () => {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.features.plugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  // 让宿主治理的效果在响应里直接可见：20 字上限 + 只允许 1 个气泡 + 每分钟 5 条（schema 下限）。
  config.chat.privateMaxChars = 20;
  config.chat.groupMaxChars = 20;
  config.chat.maxBubbles = 1;
  config.group.maxRepliesPerMinute = 5;
  // 关闭随机补表情：否则纯标点可能被宿主补一个 emoji 气泡，就不构成「清理后无正文」。
  // （persona 存储会把 emojiLevel 覆盖成空串，所以这里显式给一个趋近 0 的正概率。）
  config.chat.emojiChance = 1e-9;
  config.gateway.wechat.inboundToken = 'test-govern-token';
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  installPlugin(root, {
    id: 'govern',
    source: `exports.providers = { 'chat.handle@1': () => ({ action: 'reply', reply: 'x' }) };`,
    manifest: { provides: { 'chat.handle@1': { mode: 'replace', scope: 'all' } }, calls: [] },
  });
  server = await startServer({ root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  const plugins = server.runtime.plugins;
  const pluginReply = { action: 'reply', reply: '' };
  const transport = t.mock.method(plugins, 'spawn', job => plugins.finish(job, null, pluginReply));
  const receive = async (msgId, overrides = {}) => {
    const res = await fetch(server.url + '/webhook/wechat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': 'test-govern-token', 'x-whale-bridge': '1' },
      body: JSON.stringify({
        chat_id: 'govern-chat', chat_type: 'private', sender_id: 'govern-sender', text: 'example', msg_id: msgId,
        ...overrides,
      }),
    });
    assert.equal(res.status, 200);
    return res.json();
  };

  // 空回复：插件只回了标点，宿主清理后没有可发正文，结果阶段直接忽略，不落库、不占配额。
  // （reply 为空串会在输出契约层被判 invalid_capability_output，那是失败语义，不在本卡范围。）
  pluginReply.action = 'reply';
  pluginReply.reply = '。';
  const empty = await receive('govern-empty');
  assert.deepEqual([empty.action, empty.reason], ['ignore', 'empty_reply']);
  const key = 'wechat:u:govern-chat';
  const assistantCount = () => server.runtime.bot.store.messages(key, 20).filter(row => row.role === 'assistant').length;
  const storedText = () => server.runtime.bot.store.messages(key, 20).filter(row => row.role === 'assistant')[0]?.text || '';
  assert.equal(assistantCount(), 0, '治理后没有气泡时不能留下助手记录');

  // 正常回复：字数与气泡都由宿主治理，插件自带的 bubbles 不直接下发。
  pluginReply.action = 'reply';
  pluginReply.reply = '第一句，第二句，第三句，这句话明显超过二十个字的上限了';
  pluginReply.bubbles = ['插件自带气泡'];
  const replied = await receive('govern-1');
  assert.equal(replied.action, 'reply');
  assert.ok(Array.from(replied.reply).length <= 20, '回复要受 privateMaxChars 约束：' + replied.reply);
  assert.notEqual(replied.reply, pluginReply.reply);
  assert.ok(replied.reply.endsWith('…'));
  // finalize 会把气泡末尾的省略号再剥掉，所以气泡是最终正文的前缀，不是逐字相等。
  assert.equal(replied.bubbles.length, 1);
  assert.ok(replied.reply.startsWith(replied.bubbles[0]));
  assert.equal(replied.bubbles[0], replied.bubbles[0].trim());
  assert.ok(!replied.bubbles.includes('插件自带气泡'));

  // 接管回复也进正常记忆。落库发生在字数截断之前（与普通回复一致），
  // 所以存的是清理后的原正文，长度不小于发出去的截断正文。
  assert.equal(assistantCount(), 1);
  assert.ok(storedText().startsWith(replied.bubbles[0]));
  assert.ok(Array.from(storedText()).length >= Array.from(replied.reply).length);

  // 群聊走同一套结果阶段：groupMaxChars 同样生效，气泡仍由宿主决定。
  const groupReplied = await receive('govern-group', {
    chat_id: 'govern-group', chat_type: 'group', sender_id: 'govern-member', chat_title: '测试群',
  });
  assert.equal(groupReplied.action, 'reply');
  assert.ok(Array.from(groupReplied.reply).length <= 20, '群聊要受 groupMaxChars 约束：' + groupReplied.reply);
  assert.ok(groupReplied.reply.endsWith('…'));
  assert.equal(groupReplied.bubbles.length, 1);

  // 同会话一分钟内第 6 条：走正常配额拒绝，不再落库（插件仍被调用，由宿主拦下）。
  for (let index = 2; index <= 5; index += 1) {
    const extra = await receive('govern-' + index);
    assert.equal(extra.action, 'reply', '第 ' + index + ' 条应正常回复');
  }
  const denied = await receive('govern-6');
  assert.equal(denied.action, 'ignore');
  assert.equal(denied.reason, 'burst_limit');
  assert.equal(assistantCount(), 5);
  assert.equal(transport.mock.callCount(), 8);

  // 宿主内置结果（管理员魔咒回退 / 排队期间接管被撤下）已经是最终结果：
  // 不能再进第二次结果阶段，command/reason/mock 必须原样保留、也不能多写一条记录。
  const capabilities = server.runtime.capabilities;
  const originalInvoke = capabilities.invoke;
  const originalHasProviders = capabilities.hasProviders.bind(capabilities);
  const originalInstalled = plugins.installed.bind(plugins);
  const originalHandle = server.runtime.bot.handle;
  const originalFinish = server.runtime.bot.finishTakeoverReply;
  const hostResult = { action: 'reply', reply: '宿主结果', bubbles: ['宿主结果'], reason: 'command', commandType: 'admin_spell', mock: true };
  let finishCalls = 0;
  server.runtime.bot.handle = async () => hostResult;
  server.runtime.bot.finishTakeoverReply = (...args) => {
    finishCalls += 1;
    return originalFinish.apply(server.runtime.bot, args);
  };
  try {
    // ① 复刻 dispatcher 的 fallbackBuiltin 分支：builtin 回给 dispatcher 的必须只是
    // chat.handle 契约字段，宿主完整结果走旁路返回。
    let builtinShape = null;
    capabilities.invoke = async (name, input, options) => {
      builtinShape = await options.builtin();
      return builtinShape;
    };
    try {
      const viaHost = await server.runtime.chat.handle({
        platform: 'wechat', chatId: 'govern-host', chatType: 'private', senderId: 'govern-sender', text: '宿主处理', msgId: 'govern-host-1',
      });
      assert.deepEqual(viaHost, hostResult, '宿主结果原样返回，保留 command/reason/mock');
      assert.deepEqual(Object.keys(builtinShape).sort(), ['action', 'bubbles', 'reason', 'reply'],
        'builtin 交给 dispatcher 的只能是插件输出契约字段');
      require('../src/services/capabilitySchema').validate('chat.handle.output@1', builtinShape, 'invalid_capability_output');
      assert.equal(finishCalls, 0, '宿主已处理的结果不能再进结果阶段');
      assert.equal(server.runtime.bot.store.messages('wechat:u:govern-host', 20)
        .filter(row => row.role === 'assistant').length, 0, '不能重复落库');
    } finally {
      capabilities.invoke = originalInvoke;
    }

    // ② 真 dispatcher 的「排队期间接管被撤下」：入口仍认为有接管，dispatch 时提供者为空，
    // 必须走 builtin、返回宿主结果，而不是被插件输出契约校验打回 500 或二次治理。
    let armed = false;
    capabilities.hasProviders = name => {
      const hit = originalHasProviders(name);
      if (hit) armed = true;
      return hit;
    };
    plugins.installed = () => (armed ? [] : originalInstalled());
    try {
      const revoked = await server.runtime.chat.handle({
        platform: 'wechat', chatId: 'govern-revoked', chatType: 'private', senderId: 'govern-sender', text: '排队中撤下', msgId: 'govern-revoked-1',
      });
      assert.deepEqual(revoked, hostResult);
      assert.equal(finishCalls, 0);
      assert.equal(server.runtime.bot.store.messages('wechat:u:govern-revoked', 20)
        .filter(row => row.role === 'assistant').length, 0);
    } finally {
      capabilities.hasProviders = originalHasProviders;
      plugins.installed = originalInstalled;
    }
  } finally {
    capabilities.invoke = originalInvoke;
    capabilities.hasProviders = originalHasProviders;
    plugins.installed = originalInstalled;
    server.runtime.bot.handle = originalHandle;
    server.runtime.bot.finishTakeoverReply = originalFinish;
  }
});

test('admin preflight fallback uses the takeover builtin override instead of self-waiting on the session queue', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-admin-fallback-'));
  let server;
  t.after(async () => {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.features.plugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  config.admin.spell = '测试口令';
  config.persona.master = { names: ['测试主人'], wxids: ['wxid_fixture_owner'] };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  installPlugin(root, {
    id: 'takeover-admin', source: `exports.providers = { 'chat.handle@1': () => ({ action: 'reply', reply: 'plugin' }) };`,
    manifest: { provides: { 'chat.handle@1': { mode: 'replace', scope: 'all' } }, calls: [] },
  });
  server = await startServer({ root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  // 真实 dispatcher + 真实会话队列：管理员魔咒必须走宿主前置回退，插件完全不参与。
  const spawn = t.mock.method(server.runtime.plugins, 'spawn', () => { throw new Error('takeover must not run'); });
  const message = {
    platform: 'wechat', chatId: 'admin-fallback', chatType: 'private',
    senderId: 'wxid_fixture_owner', senderName: '测试主人', text: '测试口令', msgId: 'admin-fallback-1',
  };
  // 有界等待：修复前这里会二次排同一个会话队列（自等）而永远不返回。
  const result = await Promise.race([
    server.runtime.chat.handle(message),
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('admin fallback self-waited on the session queue')), 3000).unref();
    }),
  ]);
  assert.equal(result.action, 'reply');
  assert.equal(result.reason, 'command');
  assert.equal(result.commandType, 'admin_spell');
  assert.match(result.reply, /管理员魔咒已生效/);
  assert.equal(spawn.mock.callCount(), 0, '管理员前置回退不能进插件');
  const key = server.runtime.bot.sessionKey(message);
  const assistant = server.runtime.bot.store.messages(key, 10).filter(row => row.role === 'assistant');
  assert.equal(assistant.length, 1, '宿主结果只能落一次库');
  assert.equal(server.runtime.bot._replyQuota.committed.get(key).length, 1, '只能提交一次配额');
});

test('takeover failure classes stay fail-closed and only side-effect-free dispatch errors fall back', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-takeover-fail-'));
  let server;
  t.after(async () => {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.features.plugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  // 回退用例会让内置管线真的生成回复：关掉搜索/链接，避免测试依赖网络。
  config.websearch.enabled = false;
  config.links.enabled = false;
  config.gateway.wechat.inboundToken = 'test-failure-token';
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  installPlugin(root, {
    id: 'takeover-fail', source: `exports.providers = { 'chat.handle@1': () => ({ action: 'reply', reply: 'x' }) };`,
    manifest: { provides: { 'chat.handle@1': { mode: 'replace', scope: 'all' } }, calls: [] },
  });
  server = await startServer({ root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  const { capabilities, bot } = server.runtime;
  const originalInvoke = capabilities.invoke;
  t.after(() => { capabilities.invoke = originalInvoke; });
  const receive = async (msgId, text = 'example') => {
    const res = await fetch(server.url + '/webhook/wechat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': 'test-failure-token', 'x-whale-bridge': '1' },
      body: JSON.stringify({ chat_id: 'failure-chat', chat_type: 'private', sender_id: 'failure-sender', text, msg_id: msgId }),
    });
    return { status: res.status, body: await res.json() };
  };
  const assistantCount = () => server.runtime.bot.store.messages('wechat:u:failure-chat', 20)
    .filter(row => row.role === 'assistant').length;
  const failWith = code => {
    capabilities.invoke = async () => { throw Object.assign(new Error(code), { code }); };
  };

  // ① 授权失效：消息已经过前置闸，插件可能执行过一部分，只能 fail closed。
  failWith('grant_revoked');
  const revoked = await receive('fail-revoked');
  assert.equal(revoked.status, 200);
  assert.deepEqual([revoked.body.action, revoked.body.reason], ['ignore', 'capability_revoked']);
  assert.equal(assistantCount(), 0, '授权失效不能落库，也不能回退内置流程');

  // ② 输出不合契约：插件已经跑过，半成品不能下发、也不能再生成一遍。
  failWith('invalid_capability_output');
  const invalid = await receive('fail-output');
  assert.deepEqual([invalid.body.action, invalid.body.reason], ['ignore', 'invalid_plugin_output']);
  assert.equal(assistantCount(), 0);

  // ③ 真实故障（进程退出/超时/插件报错）：交给上层按错误收尾，不被吞成 ignore。
  failWith('plugin_process_exit');
  const faulty = await receive('fail-real');
  assert.equal(faulty.status, 500);
  assert.equal(faulty.body.ok, false);
  assert.equal(assistantCount(), 0);

  // ④ 插件还没开始执行、消息也还没占位：这类调度失败没有可重复的副作用，
  //    允许回退内置流程，而且整条消息只接收/回复一次。
  failWith('capability_queue_limit');
  const fallback = await receive('fail-fallback', '在吗');
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.action, 'reply', '无副作用的调度失败应回退内置流程：' + JSON.stringify(fallback.body));
  assert.equal(assistantCount(), 1, '回退后只允许内置流程回一条');
  const duplicate = await receive('fail-fallback', '在吗');
  assert.deepEqual([duplicate.body.action, duplicate.body.reason], ['ignore', 'duplicate'],
    '回退后同一条消息必须仍由去重闸拦住，不能二次接收');
  assert.equal(assistantCount(), 1);

  // ⑤ 已经占位之后再失败：即使故障本身无副作用，也不允许回退（否则是第二条接收路径）。
  capabilities.invoke = async (name, input, options) => {
    await options.preflight(input);
    throw Object.assign(new Error('busy after receipt'), { code: 'capability_queue_limit' });
  };
  const received = await receive('fail-received');
  assert.equal(received.status, 500, '已占位的失败只能如实上报，不能回退内置流程');
  assert.equal(assistantCount(), 1);
});

test('a revoked or tampered plugin stops running and late features stay closed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plugin-e2e2-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.features.plugins = true;
  config.features.envContext = false;
  config.features.memorySnapshot = false;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const directory = installPlugin(root, {
    id: 'totals', source: `exports.providers = { 'tool.run@1': () => ({ ok: true }) };`,
  });
  const server = await startServer({ root, port: 0, host: '127.0.0.1', env: { WHALE_LOG_FILE: '', WHALE_LOG_LEVEL: 'silent' } });
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const run = () => fetch(server.url + '/api/plugins/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'totals', capability: 'tool.run@1', input: {} }),
  });
  assert.equal((await run()).status, 200);
  // 改入口文件但不动授权：摘要不匹配，立即失效。
  fs.appendFileSync(path.join(directory, 'plugin.js'), '\n// tampered');
  assert.equal((await run()).status, 404);
  // 删除授权同样立即失效。
  fs.writeFileSync(path.join(directory, 'plugin.js'), `exports.providers = { 'tool.run@1': () => ({ ok: true }) };`);
  fs.unlinkSync(path.join(directory, 'grant.json'));
  assert.equal((await run()).status, 404);
});
