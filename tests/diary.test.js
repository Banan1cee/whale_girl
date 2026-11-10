'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiaryService, dayKey } = require('../src/services/diary');
const { loadConfig } = require('../src/infra/config');
const { applyConfigPatch } = require('../src/infra/configPatch');
const register = require('../src/http/routes/diary');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diary-'));
  let now = new Date(2026, 10, 6, 22, 59).getTime();
  const calls = [], logs = [], queued = [];
  const config = {
    paths: { dataDir: dir },
    diary: { enabled: false, time: '23:00', sendToOwner: false },
    persona: {
      name: '测试角色',
      ownerName: '主人',
      customPrompt: '温柔的语气',
      master: { names: ['主人'], wxids: ['wxid_master'] },
    },
  };
  const owner = {
    platform: 'wechat',
    chatType: 'private',
    chatId: 'wechat:u:wxid_master',
    title: '主人',
    messages: [
      { role: 'user', text: '昨天的秘密', ts: now - 86400000 },
      { role: 'user', name: '主人', text: '今天读完一本书', ts: now - 60000 },
      { role: 'assistant', text: '真不错', ts: now },
      { role: 'user', text: '未来不应该出现', ts: now + 86400000 },
    ],
  };
  const stranger = {
    platform: 'wechat',
    chatType: 'private',
    chatId: 'wechat:u:wxid_other',
    title: '路人',
    messages: [{ role: 'user', name: '路人', text: '不该出现在日记里', ts: now - 30000 }],
  };
  const store = { sessions: new Map([['test-chat', owner], ['other-chat', stranger]]) };
  const llm = { isMock: false, complete: async (input) => { calls.push(input); return '## 今天\n\n和主人聊了读书的事，很开心。'; } };
  const logger = { info: (s) => logs.push(s), warn: (s) => logs.push(s) };
  const make = () => new DiaryService(config, {
    store, llm, logger, now: () => now,
    enqueue: (item) => { queued.push(item); return item; },
  });
  const service = make();
  t.after(() => { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, store, llm, calls, logs, queued, service, make, setNow: (v) => { now = v; }, advance: (v) => { now += v; } };
}

test('日记：默认关闭；按本地时间生成，重启去重，第二天独立文件', async (t) => {
  const f = fixture(t);
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  f.config.diary.enabled = true;
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  f.advance(60000);
  await f.service.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.status().status, 'done');
  assert.ok(fs.existsSync(path.join(f.dir, 'diary', '2026', '11-06.md')));
  const restarted = f.make();
  await restarted.tick();
  await restarted.generate();
  assert.equal(f.calls.length, 1);
  f.advance(86400000);
  await restarted.tick();
  assert.equal(f.calls.length, 2);
  assert.ok(fs.existsSync(path.join(f.dir, 'diary', '2026', '11-07.md')));
  restarted.stop();
});

test('日记：手动每天仅一篇，使用月日文件名，只取当天并沿用人设', async (t) => {
  const f = fixture(t);
  await f.service.generate();
  const first = f.service.status().file;
  await f.service.generate();
  const second = f.service.status().file;
  assert.equal(first, '2026/11-06.md');
  assert.equal(first, second);
  assert.equal(f.calls.length, 1);
  assert.ok(first.endsWith('.md') && second.endsWith('.md'));
  assert.match(fs.readFileSync(path.join(f.dir, 'diary', first), 'utf8'), /^# 2026-11-06 日记/);
  const prompt = f.calls[0];
  assert.match(prompt.system, /测试角色/);
  assert.match(prompt.system, /温柔的语气/);
  assert.match(prompt.turns[0].content, /今天读完一本书/);
  assert.match(prompt.turns[0].content, /主人/);
  assert.doesNotMatch(prompt.turns[0].content, /昨天的秘密|未来不应该出现|test-chat|不该出现在日记里/);
  assert.doesNotMatch(f.logs.join('\n'), /今天读完一本书|和朋友聊了读书/);
});

test('日记：已有旧格式当天日记时，手动和自动都跳过', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'diary'));
  const legacy = '2026-11-06-120000-abcd1234.md';
  fs.writeFileSync(path.join(f.dir, 'diary', legacy), '旧日记');
  await f.service.generate();
  f.config.diary.enabled = true;
  f.advance(60000);
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.status().file, legacy);
  assert.equal(fs.readFileSync(path.join(f.dir, 'diary', legacy), 'utf8'), '旧日记');
});

test('日记：模型生成期间出现当天文件也不覆盖', async (t) => {
  const f = fixture(t);
  let release;
  f.llm.complete = () => new Promise((resolve) => { release = resolve; });
  const pending = f.service.generate();
  const dir = path.join(f.dir, 'diary', '2026');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '11-06.md'), '先完成的日记');
  release('后完成的日记');
  await pending;
  assert.equal(fs.readFileSync(path.join(dir, '11-06.md'), 'utf8'), '先完成的日记');
  assert.deepEqual(fs.readdirSync(dir), ['11-06.md']);
});

test('日记：手动生成后自动与重启均不重复，跨年同月日不冲突', async (t) => {
  const f = fixture(t);
  await f.service.generate();
  f.config.diary.enabled = true;
  f.advance(60000);
  await f.service.tick();
  const restarted = f.make();
  await restarted.generate();
  assert.equal(f.calls.length, 1);
  const nextYear = new Date(2027, 10, 6, 23, 0).getTime();
  f.setNow(nextYear);
  f.store.sessions.get('test-chat').messages.push({ role: 'user', text: '明年的今天', ts: nextYear });
  await restarted.tick();
  assert.equal(f.calls.length, 2);
  assert.ok(fs.existsSync(path.join(f.dir, 'diary', '2026', '11-06.md')));
  assert.ok(fs.existsSync(path.join(f.dir, 'diary', '2027', '11-06.md')));
  restarted.stop();
});

test('日记：空日/演示模型不伪造文档，输入预算有界', async (t) => {
  const f = fixture(t);
  const owner = f.store.sessions.get('test-chat');
  const messages = owner.messages;
  f.store.sessions.clear();
  await f.service.generate();
  assert.equal(f.service.status().status, 'empty');
  assert.equal(f.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(f.dir, 'diary')));
  f.store.sessions.set('test-chat', owner);
  f.llm.isMock = true;
  await f.service.generate();
  assert.equal(f.service.status().status, 'failed');
  assert.ok(!fs.existsSync(path.join(f.dir, 'diary')));
  f.llm.isMock = false;
  for (let i = 0; i < 1000; i++) messages.push({ role: 'user', text: '长'.repeat(2000), ts: messages[1].ts });
  await f.service.generate();
  assert.ok(f.calls[0].turns[0].content.length < 25000);
});

test('日记：并发请求合并，失败不记成功且五分钟后可重试', async (t) => {
  const f = fixture(t);
  let release;
  f.llm.complete = () => new Promise((resolve) => { release = resolve; });
  const a = f.service.generate();
  assert.equal(f.service.status().status, 'running');
  assert.equal(f.service.generate(), a);
  release('日记正文');
  await a;
  assert.equal(fs.readdirSync(path.join(f.dir, 'diary', '2026')).length, 1);
  // 次日测试失败重试，避免第一篇日记按每日去重规则拦截。
  f.advance(86400000);
  f.config.diary.enabled = true;
  f.advance(60000);
  let calls = 0;
  f.llm.complete = async () => { calls++; throw Object.assign(new Error('模型超时'), { code: 'ETIMEDOUT' }); };
  await f.service.tick();
  assert.equal(f.service.status().status, 'failed');
  assert.ok(!fs.existsSync(path.join(f.dir, 'diary', '2026', '11-07.md')));
  await f.service.tick();
  assert.equal(calls, 1);
  f.advance(5 * 60000);
  f.llm.complete = async () => { calls++; return '重试后的日记'; };
  await f.service.tick();
  assert.equal(calls, 2);
  assert.equal(f.service.status().status, 'done');
  assert.match(f.logs.join('\n'), /type=Error code=ETIMEDOUT/);
});

test('日记：停止后不落盘；跨午夜仍归属于请求时日期', async (t) => {
  const f = fixture(t);
  let release;
  f.setNow(new Date(2026, 10, 6, 23, 59).getTime());
  f.llm.complete = () => new Promise((resolve) => { release = resolve; });
  const pending = f.service.generate();
  f.advance(120000);
  release('午夜生成');
  await pending;
  assert.equal(f.service.status().file, '2026/11-06.md');
  f.store.sessions.get('test-chat').messages.push({ role: 'user', text: '新的一天', ts: new Date(2026, 10, 7, 0, 0).getTime() });
  const stopped = f.service.generate();
  f.service.stop();
  release('不应写入');
  await stopped;
  assert.equal(fs.readdirSync(path.join(f.dir, 'diary', '2026')).length, 1);
  assert.equal(dayKey(new Date(2026, 0, 2)), '2026-01-02');
});

test('日记配置：旧配置默认关闭，时间统一规范化，保存后重载保留', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'config.json'), '{}');
  const runtime = { config: loadConfig({ root: f.dir, env: {} }), logger: { info() {} }, llm: { reload() {} } };
  assert.deepEqual(runtime.config.diary, { enabled: false, time: '23:00', sendToOwner: false });
  for (const time of ['24:00', '12:60', '25:00', '']) {
    assert.throws(() => applyConfigPatch(runtime, { 'diary.time': time }), { statusCode: 400 });
  }
  applyConfigPatch(runtime, { 'diary.enabled': true, 'diary.sendToOwner': true, 'diary.time': '8:00' });
  assert.deepEqual(loadConfig({ root: f.dir, env: {} }).diary, { enabled: true, time: '08:00', sendToOwner: true });
});

test('日记接口：仅本机可读写，后台生成立即返回且不会重复启动', async (t) => {
  const f = fixture(t);
  const routes = {};
  register({ get: (p, fn) => { routes[p] = fn; }, post: (p, fn) => { routes[p] = fn; } });
  const runtime = { diary: f.service };
  for (const fn of Object.values(routes)) {
    assert.throws(() => fn(runtime, { socket: { remoteAddress: '192.0.2.1' } }), { statusCode: 403 });
  }
  let release;
  f.llm.complete = () => new Promise((resolve) => { release = resolve; });
  const res = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
  const req = { socket: { remoteAddress: '127.0.0.1' } };
  routes['/api/diary/generate'](runtime, req, res);
  assert.equal(res.code, 202);
  assert.equal(res.body.status, 'running');
  const pending = f.service.pending;
  routes['/api/diary/generate'](runtime, req, res);
  assert.equal(f.service.pending, pending);
  release('测试正文');
  await pending;
  routes['/api/diary'](runtime, req, res);
  assert.equal(res.body.status, 'done');
});

test('日记：成功后不会每五分钟重新生成，状态保持已保存', async (t) => {
  const f = fixture(t);
  f.config.diary.enabled = true;
  f.advance(60000);   // 23:00，到达自动时间
  await f.service.tick();
  assert.equal(f.calls.length, 1);
  assert.match(f.service.status().message, /^已保存/);

  f.advance(5 * 60000);
  await f.service.tick();
  assert.equal(f.calls.length, 1, '已有当天日记时不该再调用模型');
  assert.equal(f.service.status().status, 'done');
  assert.match(f.service.status().message, /^已保存/, '状态不该被改回「已跳过」');
});

test('日记：自动失败最多重试三次，避免整晚反复调用模型', async (t) => {
  const f = fixture(t);
  f.config.diary.enabled = true;
  f.advance(60000);
  let calls = 0;
  f.llm.complete = async () => { calls++; throw Object.assign(new Error('模型超时'), { code: 'ETIMEDOUT' }); };

  for (let i = 0; i < 6; i++) {
    await f.service.tick();
    f.advance(5 * 60000);
  }
  assert.equal(calls, 3);
  assert.equal(f.service.status().status, 'failed');
  assert.match(f.service.status().message, /自动尝试 3 次/);
  assert.ok(!fs.existsSync(path.join(f.dir, 'diary', '2026', '11-06.md')));
});

test('日记：生成中停止时状态不留在 running', async (t) => {
  const f = fixture(t);
  let release;
  f.llm.complete = () => new Promise((resolve) => { release = resolve; });
  const pending = f.service.generate();
  f.service.stop();
  release('不应写入');
  await pending;

  assert.notEqual(f.service.status().status, 'running');
  assert.match(f.service.status().message, /已停止/);
  assert.ok(!fs.existsSync(path.join(f.dir, 'diary')));
});

test('日记：停止后模型才报错，也不该把状态改成失败', async (t) => {
  const f = fixture(t);
  let reject;
  f.llm.complete = () => new Promise((_, fail) => { reject = fail; });
  const pending = f.service.generate();
  f.service.stop();
  reject(Object.assign(new Error('模型断开'), { code: 'ECONNRESET' }));
  await pending;
  assert.match(f.service.status().message, /已停止/);
});

test('日记：启动时发现当天已有文件，状态直接显示已完成', (t) => {
  const f = fixture(t);
  const dir = path.join(f.dir, 'diary', '2026');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '11-06.md'), '已有日记');
  const service = f.make();
  service.start();
  try {
    assert.equal(service.status().status, 'done');
    assert.equal(service.status().file, '2026/11-06.md');
  } finally {
    service.stop();
  }
});

test('日记：文件系统不支持硬链接时退回独占写入', async (t) => {
  const f = fixture(t);
  const original = fs.linkSync;
  fs.linkSync = () => {
    const err = new Error('no hardlink');
    err.code = 'EPERM';
    throw err;
  };
  try {
    await f.service.generate();
  } finally {
    fs.linkSync = original;
  }
  assert.equal(f.service.status().status, 'done');
  assert.ok(fs.existsSync(path.join(f.dir, 'diary', '2026', '11-06.md')));
});

test('日记：启动时清理一天前的临时文件，保留新文件', (t) => {
  const f = fixture(t);
  const dir = path.join(f.dir, 'diary', '2026');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, '11-06.md.dead.tmp');
  const fresh = path.join(dir, '11-06.md.live.tmp');
  fs.writeFileSync(stale, '半截');
  fs.writeFileSync(fresh, '正在写');
  const old = new Date(Date.now() - 2 * 24 * 60 * 60000);
  fs.utimesSync(stale, old, old);

  const service = f.make();
  service.start();
  try {
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    service.stop();
  }
});

test('日记：单个会话缺少 messages 时跳过，不影响其他会话', async (t) => {
  const f = fixture(t);
  f.store.sessions.set('broken', { messages: null });
  await f.service.generate();
  assert.equal(f.service.status().status, 'done');
  assert.equal(f.calls.length, 1);
});

test('日记：手动失败后不会被下一次 tick 当成昨天清掉', async (t) => {
  const f = fixture(t);
  f.llm.complete = async () => { throw Object.assign(new Error('模型超时'), { code: 'ETIMEDOUT' }); };
  await f.service.generate();
  assert.equal(f.service.status().status, 'failed');
  await f.service.tick();
  assert.equal(f.service.status().status, 'failed');
});

test('日记：时间配置非法时只警告一次，不生成', async (t) => {
  const f = fixture(t);
  f.config.diary.enabled = true;
  f.config.diary.time = '25:00';
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.filter((line) => line.includes('日记时间配置不合法')).length, 1);
});

test('日记：当天路径被目录占用时明确失败，不覆盖', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'diary', '2026', '11-06.md'), { recursive: true });
  await f.service.generate();
  assert.equal(f.service.status().status, 'failed');
  assert.match(f.logs.join('\n'), /DIARY_FILE_CONFLICT/);
});

test('日记：打开 sendToOwner 后把全文交给发送队列', async (t) => {
  const f = fixture(t);
  f.config.diary.sendToOwner = true;
  await f.service.generate();
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].wxid, 'wxid_master');
  assert.equal(f.queued[0].chatType, 'private');
  assert.equal(f.queued[0].kind, 'diary');
  assert.match(f.queued[0].text, /^# 2026-11-06 日记/);
  assert.match(f.queued[0].text, /和主人聊了读书/);
});

test('日记：sendToOwner 关闭时不入发送队列', async (t) => {
  const f = fixture(t);
  await f.service.generate();
  assert.equal(f.queued.length, 0);
});

test('日记：索引只存摘要，readForChat 能按日期或最新读取', async (t) => {
  const f = fixture(t);
  await f.service.generate();
  const index = JSON.parse(fs.readFileSync(path.join(f.dir, 'diary', 'index.json'), 'utf8'));
  assert.equal(index.entries['2026-11-06'].file, '2026/11-06.md');
  assert.match(index.entries['2026-11-06'].summary, /和主人聊了读书/);
  assert.match(f.service.readForChat('2026-11-06'), /和主人聊了读书/);
  assert.match(f.service.readForChat('latest'), /【2026-11-06】/);
  assert.equal(f.service.readForChat('../../etc/passwd'), null);
});

test('日记：没配置主人时不生成', async (t) => {
  const f = fixture(t);
  f.config.persona.master = { names: [], wxids: [] };
  f.config.persona.ownerName = '';
  await f.service.generate();
  assert.equal(f.service.status().status, 'empty');
  assert.equal(f.calls.length, 0);
});

test('日记：跨天后不把昨天的已完成状态带到今天', async (t) => {
  const f = fixture(t);
  await f.service.generate();
  assert.equal(f.service.status().status, 'done');
  f.advance(86400000);   // 第二天 22:59，还没到生成时间
  await f.service.tick();
  assert.equal(f.service.status().status, 'idle');
  assert.equal(f.service.status().file, '');
});
