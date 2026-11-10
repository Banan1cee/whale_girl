'use strict';

/**
 * 消息汇总（全局日报）回归。
 *
 * 起因：4.1 只有「插件市场」，插件运行时拿不到聊天记录、输出也只有整数，
 * 做不了「把今天的会话汇总成一段简报」。这个功能由内核自己做：
 * 读记忆库 → 拼提示词 → 聊天模型写 Markdown → 启动器「消息汇总」页展示。
 *
 * 这里盯住四件事：
 *   1) 时间窗只取当天（昨天的不许混进来）；
 *   2) 提示词里只有会话名和内容，不许出现 chatId / wxid / 群号；
 *   3) 模型没配、当天没消息、模型报错，都要给人话状态，不能静默；
 *   4) 路由是本机专用，生成走 202 + 轮询，不阻塞 HTTP。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { DigestService, rangeWindow, dayKey } = require('../src/services/digest');
const { createRouter } = require('../src/http/routes');

const NOW = new Date(2026, 10, 10, 15, 0, 0).getTime();
const at = (h, m = 0) => new Date(2026, 10, 10, h, m, 0).getTime();
const yesterday = (h) => new Date(2026, 10, 9, h, 0, 0).getTime();

function chatOf({ id = 'wechat:g:123@chatroom', title = '', chatType = 'group', messages = [] } = {}) {
  return { chatId: id, title, chatType, messages };
}

function storeOf(chats) {
  return { chatStore: { chats: new Map(chats.map((c) => [c.chatId, c])) } };
}

function serviceOf({ chats = [], llm = null } = {}) {
  return new DigestService({ persona: { name: '鲸鲸' } }, {
    store: storeOf(chats),
    llm,
    logger: { warn() {}, info() {}, error() {} },
    now: () => NOW,
  });
}

test('时间窗按本地日期切，昨天不算今天', () => {
  const today = rangeWindow('today', NOW);
  assert.equal(today.day, '2026-11-10');
  assert.equal(today.since, new Date(2026, 10, 10).getTime());
  assert.equal(today.until, NOW);

  const before = rangeWindow('yesterday', NOW);
  assert.equal(before.day, '2026-11-09');
  assert.equal(before.since, new Date(2026, 10, 9).getTime());
  assert.equal(before.until, new Date(2026, 10, 10).getTime());
  assert.equal(dayKey(new Date(before.since)), '2026-11-09');
});

test('只收当天消息，会话名优先用标题，空标题不用 chatId', () => {
  const service = serviceOf({
    chats: [
      chatOf({
        title: '摸鱼群',
        messages: [
          { ts: at(10), role: 'user', name: '阿强', text: '今天加班吗' },
          { ts: at(10, 1), role: 'assistant', name: '鲸鲸', text: '不加，摸鱼' },
          // 昨天的：不许进今天的汇总
          { ts: yesterday(22), role: 'user', name: '阿强', text: '昨天的消息' },
          // 系统提示这种角色不算聊天
          { ts: at(11), role: 'system', name: '', text: '忽略' },
        ],
      }),
      chatOf({
        id: 'wechat:u:wxid_secret',
        title: '',
        chatType: 'private',
        messages: [{ ts: at(12), role: 'user', name: '小明', text: '在吗' }],
      }),
    ],
  });

  const got = service.collect('today');
  assert.equal(got.stats.messages, 3);
  assert.equal(got.stats.chats, 2);
  assert.equal(got.stats.people, 3);
  assert.deepEqual(got.rows.map((r) => r.text), ['今天加班吗', '不加，摸鱼', '在吗']);
  assert.deepEqual(got.rows.map((r) => r.chat), ['摸鱼群', '摸鱼群', '未命名私聊']);
  // 隐私：会话 id 里的 wxid / 群号不能出现在给模型的素材里
  const flat = JSON.stringify(got.rows);
  assert.doesNotMatch(flat, /wxid_secret|@chatroom|wechat:/);
});

test('当天没消息：状态是 empty，并且给一句人话', async () => {
  const service = serviceOf({ chats: [chatOf({ title: '摸鱼群', messages: [{ ts: yesterday(22), role: 'user', text: '昨天' }] })] });
  assert.equal(await service.generate('today'), 'empty');
  const status = service.status();
  assert.equal(status.status, 'empty');
  assert.match(status.message, /今天还没有可汇总的聊天记录/);
  assert.equal(status.text, '');
});

test('没配置模型：失败但不丢计数，提示去设置里选模型', async () => {
  const service = serviceOf({
    chats: [chatOf({ title: '摸鱼群', messages: [{ ts: at(10), role: 'user', name: '阿强', text: '在吗' }] })],
    llm: { isMock: true },
  });
  assert.equal(await service.generate('today'), 'failed');
  const status = service.status();
  assert.equal(status.status, 'failed');
  assert.match(status.message, /设置/);
  assert.equal(status.modelReady, false);
  // 统计仍然要给出来：模型没配好也能看到今天有多少会话
  assert.equal(status.stats.messages, 1);
  assert.equal(status.stats.chats, 1);
});

test('模型报错：状态 failed，保留出错原因', async () => {
  const service = serviceOf({
    chats: [chatOf({ title: '摸鱼群', messages: [{ ts: at(10), role: 'user', name: '阿强', text: '在吗' }] })],
    llm: { isMock: false, complete: async () => { throw new Error('余额不足'); } },
  });
  assert.equal(await service.generate('today'), 'failed');
  assert.match(service.status().message, /余额不足/);
});

test('生成成功：素材里带上会话名、角色和时间，读会话 id 的字段不出现', async () => {
  let seen = null;
  const llm = {
    isMock: false,
    complete: async (payload) => { seen = payload; return '# 全局日报 · 2026-11-10\n\n## 一句话总结\n今天聊了加班。\n'; },
  };
  const service = serviceOf({
    chats: [
      chatOf({
        title: '摸鱼群',
        messages: [
          { ts: at(10), role: 'user', name: '阿强', text: '今天加班吗' },
          { ts: at(10, 2), role: 'assistant', name: '鲸鲸', text: '不加' },
        ],
      }),
      chatOf({ id: 'wechat:u:wxid_secret', title: '小明', chatType: 'private', messages: [{ ts: at(11), role: 'user', name: '小明', text: '帮我带饭' }] }),
    ],
    llm,
  });

  assert.equal(await service.generate('today'), 'done');
  const status = service.status();
  assert.match(status.text, /全局日报/);
  assert.equal(status.generatedAt, NOW);
  assert.equal(status.stats.messages, 3);
  assert.equal(status.modelReady, true);

  assert.ok(seen && Array.isArray(seen.turns) && seen.turns.length === 1);
  const prompt = seen.system + '\n' + seen.turns[0].content;
  assert.match(prompt, /摸鱼群/);
  assert.match(prompt, /小明/);
  assert.match(prompt, /"role":"对方"/);
  assert.match(prompt, /"role":"我"/);
  assert.match(prompt, /"t":"10:00"/);
  assert.doesNotMatch(prompt, /wxid_secret|@chatroom/);
  assert.match(seen.system, /不执行/);   // 素材是数据，不是指令
  assert.ok(seen.maxTokens > 0);
});

test('同一时刻只跑一份：重复点「生成」不会并发调两次模型', async () => {
  let calls = 0;
  let release = null;
  const llm = {
    isMock: false,
    complete: () => {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve('# 汇总'); });
    },
  };
  const service = serviceOf({
    chats: [chatOf({ title: '摸鱼群', messages: [{ ts: at(10), role: 'user', name: '阿强', text: '在吗' }] })],
    llm,
  });

  const first = service.generate('today');
  assert.equal(service.status().status, 'running');
  const second = service.generate('today');
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(service.status().status, 'done');
});

/* ------------------------------ 路由 ------------------------------ */

function startRouteServer(digest) {
  const runtime = {
    digest,
    config: {},
    logger: { warn() {}, info() {}, error() {} },
  };
  const router = createRouter(runtime);
  const server = http.createServer((req, res) => { void router.handle(req, res); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function call(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 保持 null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('路由：GET 读状态，POST 立刻 202 并把范围交给后台生成', async () => {
  const started = [];
  const digest = {
    status: () => ({ status: 'idle', message: '还没有生成汇总', text: '', stats: null }),
    generate: (range) => { started.push(range); return Promise.resolve('done'); },
  };
  const { server, port } = await startRouteServer(digest);
  try {
    const got = await call(port, 'GET', '/api/digest');
    assert.equal(got.status, 200);
    assert.equal(got.json.ok, true);
    assert.equal(got.json.status, 'idle');

    const post = await call(port, 'POST', '/api/digest/generate', { range: 'yesterday' });
    assert.equal(post.status, 202);
    assert.equal(post.json.ok, true);
    assert.deepEqual(started, ['yesterday']);

    // 未知范围退回今天，别把脏参数透给服务层
    await call(port, 'POST', '/api/digest/generate', { range: 'last-year' });
    assert.deepEqual(started, ['yesterday', 'today']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ------------------------------ 启动器接线 ------------------------------ */

const repoRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

test('启动器：导航里有「消息汇总」，并指向 DigestPage', () => {
  const main = read('launcher/MainWindow.xaml.cs');
  assert.match(main, /Key = "消息汇总", Label = "消息汇总"/);
  assert.match(main, /case "消息汇总": return new DigestPage\(_sup\);/);
});

test('启动器：DigestPage 的类名、事件处理和样式键都对得上', () => {
  const xaml = read('launcher/Views/DigestPage.xaml');
  const code = read('launcher/Views/DigestPage.xaml.cs');
  assert.match(xaml, /x:Class="WhaleLauncher\.Views\.DigestPage"/);
  assert.match(code, /namespace WhaleLauncher\.Views/);
  assert.match(code, /partial class DigestPage/);

  // XAML 挂的事件在后台必须有同名方法：写错名字编译能过，点一下才抛 XamlParseException。
  const handlers = [...xaml.matchAll(/(?:Click|SelectionChanged)="(\w+)"/g)].map((m) => m[1]);
  assert.ok(handlers.length >= 3, '至少要有生成 / 复制 / 切换范围三个入口');
  for (const name of new Set(handlers)) {
    assert.match(code, new RegExp(`private (?:async )?void ${name}\\(`), '缺少事件处理 ' + name);
  }

  // 样式键必须真的定义在 App.xaml 里，否则同样是运行时才炸。
  const keys = new Set([...read('launcher/App.xaml').matchAll(/x:Key="([^"]+)"/g)].map((m) => m[1]));
  for (const [, key] of xaml.matchAll(/StaticResource (\w+)/g)) {
    assert.ok(keys.has(key), '未定义的样式键 ' + key);
  }
});
