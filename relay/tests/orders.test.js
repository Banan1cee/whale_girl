'use strict';

/**
 * orders.js 的测试。全部在临时目录里跑，结束后递归删除，不碰 relay/state。
 * 只断言结构和行为，不打印订单内容/聊天文本（privacy-scan 要求）。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const orders = require('../lib/orders');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const roots = [];

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-orders-'));
  roots.push(root);
  return root;
}

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out.push(full);
    if (entry.isDirectory()) out.push(...walk(full));
  }
  return out;
}

function sectionOf(md, name) {
  const lines = md.split('\n');
  const start = lines.findIndex((line) => line.includes('【' + name + '】'));
  assert.ok(start >= 0, '缺少小节 ' + name);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- 1. 新建 ----------

test('ensureOrder 新建：字段、目录、index、骨架', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  assert.ok(fs.existsSync(path.join(root, 'orders', 'index.json')), 'createOrders 应初始化 index.json');

  const { order, created } = store.ensureOrder({ chatId: 'wxid_case_a', nickname: '客户A' });
  assert.equal(created, true);
  assert.match(order.orderId, /^ord-\d{8}-[0-9a-f]{6}$/);
  assert.equal(order.chatId, 'wxid_case_a');
  assert.equal(order.nickname, '客户A');
  assert.equal(order.status, 'intake');
  assert.equal(order.title, '');
  assert.equal(order.deskSessionId, null);
  assert.equal(order.workerSessionId, null);
  assert.deepEqual(order.pendingQuestions, []);
  assert.equal(order.pendingReport, '');
  assert.ok(Number.isFinite(Date.parse(order.createdAt)));
  assert.equal(order.updatedAt, order.createdAt);

  const p = store.paths(order.orderId);
  assert.ok(fs.existsSync(p.orderJson));
  assert.ok(fs.existsSync(p.orderMd));
  assert.ok(fs.statSync(p.workspace).isDirectory());
  assert.ok(fs.statSync(p.deliverables).isDirectory());
  assert.equal(path.resolve(p.dir), path.join(root, 'orders', order.orderId));

  const onDisk = JSON.parse(fs.readFileSync(p.orderJson, 'utf8'));
  assert.equal(onDisk.orderId, order.orderId);
  assert.equal(onDisk.status, 'intake');

  const md = store.readOrderMd(order.orderId);
  for (const sec of ['【需求】', '【验收】', '【口径】']) assert.ok(md.includes(sec), '骨架缺少 ' + sec);

  const index = orders.rebuildIndex(root);
  assert.deepEqual(Object.keys(index), [order.orderId]);
  assert.equal(index[order.orderId].status, 'intake');
  assert.equal(index[order.orderId].chatId, 'wxid_case_a');
});

test('ensureOrder 复用：同一 chatId 的 intake/working 单', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const first = store.ensureOrder({ chatId: 'wxid_case_b', nickname: '客户B' });
  const second = store.ensureOrder({ chatId: 'wxid_case_b', nickname: '客户B' });
  assert.equal(second.created, false);
  assert.equal(second.order.orderId, first.order.orderId);

  // working 仍然算未关闭
  store.updateOrder(first.order.orderId, { status: 'working' });
  const third = store.ensureOrder({ chatId: 'wxid_case_b' });
  assert.equal(third.created, false);
  assert.equal(third.order.orderId, first.order.orderId);
  assert.equal(third.order.status, 'working');

  // delivered 之后要开新单
  store.updateOrder(first.order.orderId, { status: 'delivered' });
  const fourth = store.ensureOrder({ chatId: 'wxid_case_b' });
  assert.equal(fourth.created, true);
  assert.notEqual(fourth.order.orderId, first.order.orderId);

  // 不同客户互不影响
  const other = store.ensureOrder({ chatId: 'wxid_case_c' });
  assert.equal(other.created, true);
  assert.notEqual(other.order.orderId, fourth.order.orderId);
  assert.equal(store.findOpenOrderByChat('wxid_case_b').orderId, fourth.order.orderId);
  assert.equal(store.findOpenOrderByChat('wxid_不存在'), null);
});

test('ensureOrder 复用时会更新昵称', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const first = store.ensureOrder({ chatId: 'wxid_case_d', nickname: '旧昵称' });
  const again = store.ensureOrder({ chatId: 'wxid_case_d', nickname: '新昵称' });
  assert.equal(again.created, false);
  assert.equal(again.order.orderId, first.order.orderId);
  assert.equal(again.order.nickname, '新昵称');
  assert.equal(store.loadOrder(first.order.orderId).nickname, '新昵称');
});

test('ensureOrder 参数校验', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  assert.throws(() => store.ensureOrder({}), TypeError);
  assert.throws(() => store.ensureOrder({ chatId: '   ' }), TypeError);
});

// ---------- 2. 索引重建 ----------

test('index 重建：删除/损坏/落后都能自愈', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const a = store.ensureOrder({ chatId: 'wxid_idx_a' }).order;
  const indexFile = path.join(root, 'orders', 'index.json');

  // 场景一：索引文件整个没了
  fs.unlinkSync(indexFile);
  const reused = store.ensureOrder({ chatId: 'wxid_idx_a' });
  assert.equal(reused.created, false, '索引丢失后仍应复用（自动重建）');
  assert.equal(reused.order.orderId, a.orderId);
  assert.ok(fs.existsSync(indexFile), '读取时应把索引补回来');

  // 场景二：索引内容是垃圾
  fs.writeFileSync(indexFile, '{ 这不是 json', 'utf8');
  const reused2 = store.ensureOrder({ chatId: 'wxid_idx_a' });
  assert.equal(reused2.created, false);
  assert.deepEqual(Object.keys(orders.rebuildIndex(root)), [a.orderId]);

  // 场景三：order.json 才是事实来源 —— 删掉订单目录后重建要剔除条目
  fs.rmSync(store.paths(a.orderId).dir, { recursive: true, force: true });
  const rebuilt = orders.rebuildIndex(root);
  assert.deepEqual(rebuilt, {});
  // 新单照常
  const b = store.ensureOrder({ chatId: 'wxid_idx_b' });
  assert.equal(b.created, true);
});

test('index 落后于订单目录（崩溃在写索引前）也能自愈', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const a = store.ensureOrder({ chatId: 'wxid_idx_c' }).order;
  const indexFile = path.join(root, 'orders', 'index.json');
  // 模拟：index.json 里没有这条（order.json 已写但索引没写），并把 index 写旧
  fs.writeFileSync(indexFile, '{}\n', 'utf8');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(indexFile, past, past);
  assert.equal(store.findOpenOrderByChat('wxid_idx_c').orderId, a.orderId);
});

// ---------- 3. updateOrder ----------

test('updateOrder 状态机字段更新（order.json 与 index 同步）', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_upd_a' }).order;
  const p = store.paths(order.orderId);

  const working = store.updateOrder(order.orderId, {
    status: 'working',
    title: '做个小工具',
    deskSessionId: 'sess-desk-1',
    pendingQuestions: ['预算多少？', '什么时候要？'],
    pendingReport: '已开工',
  });
  assert.equal(working.status, 'working');
  assert.equal(working.title, '做个小工具');
  assert.equal(working.deskSessionId, 'sess-desk-1');
  assert.deepEqual(working.pendingQuestions, ['预算多少？', '什么时候要？']);
  assert.equal(working.pendingReport, '已开工');
  assert.ok(Date.parse(working.updatedAt) >= Date.parse(order.updatedAt));

  const onDisk = JSON.parse(fs.readFileSync(p.orderJson, 'utf8'));
  assert.equal(onDisk.status, 'working');
  assert.equal(onDisk.deskSessionId, 'sess-desk-1');
  assert.equal(onDisk.workerSessionId, null);

  const index = orders.rebuildIndex(root);
  assert.equal(index[order.orderId].status, 'working');
  assert.equal(index[order.orderId].deskSessionId, 'sess-desk-1');

  const delivered = store.updateOrder(order.orderId, { status: 'delivered', workerSessionId: 'sess-worker-1' });
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.workerSessionId, 'sess-worker-1');
});

test('updateOrder 非法状态抛错、未知字段忽略、身份字段不变', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_upd_b' }).order;

  assert.throws(() => store.updateOrder(order.orderId, { status: 'weird' }), TypeError);
  assert.throws(() => store.updateOrder('ord-20260101-aaaaaa', { title: 'x' }), /订单不存在/);

  // 整单回传（含 orderId/createdAt）+ 未知字段：不抛，身份字段不动，未知字段不落盘
  const back = store.updateOrder(order.orderId, Object.assign({}, order, { title: '改标题', mystery: '不该落盘' }));
  assert.equal(back.orderId, order.orderId);
  assert.equal(back.createdAt, order.createdAt);
  assert.equal(back.title, '改标题');
  assert.equal(back.mystery, undefined);
  assert.equal(JSON.parse(fs.readFileSync(store.paths(order.orderId).orderJson, 'utf8')).mystery, undefined);
});

// ---------- 4. appendEvent / worker / thread / md ----------

test('appendEvent 一行一条 JSONL，时间 ISO', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_app_a' }).order;
  const p = store.paths(order.orderId);

  store.appendEvent(order.orderId, { type: 'inbound', chars: 12 });
  store.appendEvent(order.orderId, { type: 'turn_start', turn: 'desk', at: '2026-11-21T00:00:00.000Z' });
  store.appendEvent(order.orderId, { type: 'status', from: 'intake', to: 'working' });

  const lines = readLines(p.events);
  assert.equal(lines.length, 3);
  const events = lines.map((line) => JSON.parse(line));
  assert.equal(events[0].type, 'inbound');
  assert.ok(Number.isFinite(Date.parse(events[0].at)));
  assert.equal(events[1].at, '2026-11-21T00:00:00.000Z', '显式 at 应保留');
  assert.equal(events[2].to, 'working');
  assert.throws(() => store.appendEvent(order.orderId, 'not-an-object'), TypeError);
  assert.throws(() => store.appendEvent('ord-20260101-bbbbbb', { type: 'x' }), /订单不存在/);
});

test('appendEvent 超长事件被压成合法 JSON 且单行 < 4KB', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_app_b' }).order;
  const p = store.paths(order.orderId);

  store.appendEvent(order.orderId, { type: 'turn_end', text: 'x'.repeat(9000), meta: { note: 'y'.repeat(2000) } });
  const lines = readLines(p.events);
  assert.equal(lines.length, 1);
  assert.ok(Buffer.byteLength(lines[0]) < 4096, '单行应 < 4KB');
  const event = JSON.parse(lines[0]);
  assert.equal(event.type, 'turn_end');
  assert.equal(event.truncated, true);
  assert.ok(event.text.length < 9000);
  // JSONL 仍可整体解析
  assert.doesNotThrow(() => readLines(p.events).forEach((line) => JSON.parse(line)));
});

test('appendWorkerEvents / appendWorkerEvent 追加到 worker.jsonl', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_app_c' }).order;
  const p = store.paths(order.orderId);

  assert.equal(store.appendWorkerEvents(order.orderId, [{ seq: 1, type: 'assistant' }, { seq: 2, type: 'tool' }]), 2);
  assert.equal(store.appendWorkerEvent(order.orderId, { seq: 3, type: 'done' }), 1);
  assert.equal(store.appendWorkerEvents(order.orderId, []), 0);

  const lines = readLines(p.workerJsonl);
  assert.equal(lines.length, 3);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.equal(parsed[0].seq, 1);
  assert.equal(parsed[1].type, 'tool');
  assert.equal(parsed[2].seq, 3);
});

test('appendThread 追加 markdown，段间空行，超长切段', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_app_d' }).order;
  const p = store.paths(order.orderId);

  const first = store.appendThread(order.orderId, '## 客户\n\n第一轮需求');
  assert.equal(first.segments, 1);
  store.appendThread(order.orderId, '## 前台\n\n已收到');
  const text = fs.readFileSync(p.threadMd, 'utf8');
  assert.ok(text.indexOf('第一轮需求') < text.indexOf('已收到'));
  assert.ok(text.includes('\n\n## 前台'), '两段之间要有空行');

  const long = '段'.repeat(3000); // 9KB 左右，必须切段但内容不丢
  const info = store.appendThread(order.orderId, long);
  assert.ok(info.segments > 1, '超长段应切成多段');
  const after = fs.readFileSync(p.threadMd, 'utf8');
  assert.ok(after.includes('段'.repeat(2500)));
  assert.equal(store.appendThread(order.orderId, '   ').segments, 0);
});

test('appendRequirement 追加到【需求】末尾，不污染其它小节', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_md_a', nickname: '客户M' }).order;

  store.appendRequirement(order.orderId, ['要一个能自动接单的机器人']);
  store.appendRequirement(order.orderId, '- 预算 3000 以内\n支持微信');
  store.appendRequirement(order.orderId, '需求三');

  const md = store.readOrderMd(order.orderId);
  const req = sectionOf(md, '需求');
  assert.ok(req.includes('自动接单'));
  assert.ok(req.includes('- 预算 3000 以内'), '已带列表符号的条目不要重复加 -');
  assert.ok(req.includes('支持微信'));
  assert.ok(req.indexOf('自动接单') < req.indexOf('需求三'), '追加顺序应保持');
  assert.ok(!req.includes('待补充'), '首次追加应清掉模板占位');
  assert.ok(!sectionOf(md, '验收').includes('自动接单'));
  assert.ok(!sectionOf(md, '口径').includes('自动接单'));
  assert.ok(md.includes('【验收】') && md.includes('【口径】'), '其它小节标题不能被破坏');

  assert.equal(store.appendRequirement(order.orderId, []), md.replace(/\s+$/, '') + '\n');
});

test('readOrderMd / writeOrderMd 往返', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_md_b' }).order;
  store.writeOrderMd(order.orderId, '# 自定义\n\n## 【需求】\n- 手写需求\n');
  assert.equal(store.readOrderMd(order.orderId), '# 自定义\n\n## 【需求】\n- 手写需求\n');
  store.writeOrderMd(order.orderId, '没有换行结尾');
  assert.ok(fs.readFileSync(store.paths(order.orderId).orderMd, 'utf8').endsWith('\n'));
  // 【需求】小节整体被删掉时追加要报错，不能静默写到错误位置
  store.writeOrderMd(order.orderId, '# 订单\n\n没有任何小节\n');
  assert.throws(() => store.appendRequirement(order.orderId, ['x']), /【需求】/);
});

// ---------- 5. 锁 ----------

test('withOrderLock 并发不交叉、返回值透传、锁文件清理', async () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_lock_a' }).order;
  const log = [];

  const p1 = store.withOrderLock(order.orderId, async () => {
    log.push('a:start');
    await sleep(40);
    log.push('a:end');
    return 'A';
  });
  const p2 = store.withOrderLock(order.orderId, async () => {
    log.push('b:start');
    await sleep(5);
    log.push('b:end');
    return 'B';
  });

  assert.deepEqual(await Promise.all([p1, p2]), ['A', 'B']);
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end'], '两段临界区不能交叉');
  assert.equal(fs.existsSync(store.paths(order.orderId).lock), false, '释放后不该留锁文件');
});

test('withOrderLock 异常也会释放锁', async () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_lock_b' }).order;

  await assert.rejects(store.withOrderLock(order.orderId, () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(fs.existsSync(store.paths(order.orderId).lock), false);
  assert.equal(await store.withOrderLock(order.orderId, () => 'ok'), 'ok');
});

test('withOrderLock 抢占陈旧锁（>30 分钟 / 垃圾内容）', async () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_lock_c' }).order;
  const lock = store.paths(order.orderId).lock;

  // 40 分钟前、pid 还是活的：按时长判定为陈旧
  fs.writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    nonce: 'stale',
  }), 'utf8');
  assert.equal(await store.withOrderLock(order.orderId, () => 'stolen'), 'stolen');
  assert.equal(fs.existsSync(lock), false);

  // 半截锁文件（崩溃在写锁时）也视为无人持有
  fs.writeFileSync(lock, '{"pid":', 'utf8');
  assert.equal(await store.withOrderLock(order.orderId, () => 'ok'), 'ok');
});

test('withOrderLock 活锁时排队等待，超时给可诊断错误', async () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_lock_d' }).order;
  const lock = store.paths(order.orderId).lock;

  fs.writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    nonce: 'other-holder',
  }), 'utf8');

  let called = false;
  await assert.rejects(
    store.withOrderLock(order.orderId, () => { called = true; }, { lockTimeoutMs: 150 }),
    /等待订单锁超时/
  );
  assert.equal(called, false, '拿不到锁时不应执行 fn');
  assert.ok(fs.existsSync(lock), '别人的锁不能被误删');

  fs.unlinkSync(lock);
  assert.equal(await store.withOrderLock(order.orderId, () => 'released'), 'released');
});

// ---------- 6. 路径安全 ----------

test('路径安全：chatId 里的 / : * 不会逃出 root，也不会进路径', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const nasty = ['../../etc/passwd', 'a/b:c*d', '..\\..\\win32', '客户/../x:y', 'x'.repeat(300)];
  const ids = [];
  for (const chatId of nasty) {
    const { order, created } = store.ensureOrder({ chatId });
    assert.equal(created, true);
    assert.equal(order.chatId, chatId, 'chatId 原样保存，便于 #确认 匹配');
    assert.match(order.orderId, /^ord-\d{8}-[0-9a-f]{6}$/);
    ids.push(order.orderId);
  }
  assert.equal(new Set(ids).size, ids.length);

  // 整个状态树里每一条路径都必须在 root 之下，且不出现 chatId 片段
  for (const full of walk(root)) {
    const rel = path.relative(root, full);
    assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), '越界路径：' + rel);
    assert.ok(!rel.includes('etc'), 'chatId 片段混进了路径：' + rel);
  }
  assert.equal(fs.readdirSync(path.join(root, 'orders')).filter((n) => n.startsWith('ord-')).length, nasty.length);
});

test('路径安全：非法 orderId 直接拒绝', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const bad = ['../../etc/passwd', '..', 'ord-20260101-1a2b/../../x', '/etc/passwd', 'ord-2026010-zzzzzz', ''];
  for (const id of bad) {
    assert.throws(() => store.loadOrder(id), TypeError, '应拒绝 ' + id);
    assert.throws(() => store.paths(id), TypeError);
    assert.throws(() => store.updateOrder(id, { title: 'x' }), TypeError);
    assert.throws(() => store.appendEvent(id, { type: 'x' }), TypeError);
  }
  assert.equal(store.loadOrder('ord-20260101-1a2b'), null, '合法但不存在的订单返回 null');
});

test('paths() 形状符合契约', () => {
  const root = freshRoot();
  const store = orders.createOrders({ root });
  const order = store.ensureOrder({ chatId: 'wxid_path_a' }).order;
  const p = store.paths(order.orderId);
  for (const key of ['dir', 'workspace', 'deliverables', 'orderMd', 'threadMd', 'events', 'workerJsonl']) {
    assert.equal(typeof p[key], 'string', 'paths 缺少 ' + key);
    assert.ok(p[key].startsWith(root), key + ' 应在 root 之下');
  }
  assert.equal(p.events, path.join(p.dir, 'events.jsonl'));
  assert.equal(p.workerJsonl, path.join(p.dir, 'worker.jsonl'));
});

// ---------- 运行器 ----------

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('PASS ' + name);
    } catch (err) {
      failed++;
      console.error('FAIL ' + name);
      console.error((err && err.stack) || String(err));
    }
  }
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (err) {
      console.error('CLEANUP FAIL ' + root + ': ' + err.message);
      failed++;
    }
  }
  console.log('');
  console.log(tests.length - failed + '/' + tests.length + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
