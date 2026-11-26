'use strict';

/**
 * durableStore：持久任务存储。
 *
 * 这一层的价值不是「能存」，而是「坏了还能起来」：
 *   - 文件不存在 / 半截 / 某一行是垃圾 —— 都不能让内核起不来；
 *   - 到上限必须明确拒绝，不能悄悄丢掉最老的任务；
 *   - 只落任务描述，不落结果（结果里有正文，落盘就绕过了隐私边界）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDurableStore, MAX_ENTRIES } = require('../src/services/durableStore');

function tempFile(name = 'tasks.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-durable-'));
  return {
    dir,
    file: path.join(dir, name),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }),
  };
}

/** 收集告警：用来断言「坏了要告警」而不是「坏了但一声不响」。 */
function recorder() {
  const warnings = [];
  return { warnings, logger: { warn: message => warnings.push(String(message)) } };
}

test('文件不存在时 load 返回空数组且不告警（首次运行是正常状态）', () => {
  const { file, cleanup } = tempFile();
  const { warnings, logger } = recorder();
  try {
    const store = createDurableStore({ file, logger });
    assert.deepEqual(store.load(), []);
    assert.equal(store.size(), 0);
    // ENOENT 不是故障：新装用户第一次启动不该看到任何警告。
    assert.deepEqual(warnings, []);
  } finally { cleanup(); }
});

test('append 只落 name/input/key/at，不落结果与额外字段', () => {
  const { file, cleanup } = tempFile();
  try {
    const store = createDurableStore({ file, now: () => 1700000000000 });
    const out = store.append({
      name: 'message.send@1',
      input: { chatId: 'c1', text: 'hi' },
      key: 'k1',
      // 下面这些都不该进磁盘：结果可能带正文，其它字段没有契约。
      result: { reply: '不该落盘' },
      secret: 'sk-should-not-land',
      at: 0,
    });
    assert.deepEqual(out, { ok: true, size: 1 });

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('sk-should-not-land'), '未知字段不能写进文件');
    assert.ok(!raw.includes('不该落盘'), '结果不能写进文件');

    const [entry] = store.load();
    assert.deepEqual(entry, { name: 'message.send@1', input: { chatId: 'c1', text: 'hi' }, key: 'k1', at: 1700000000000 });
  } finally { cleanup(); }
});

test('append 用临时文件 + rename，不留下半截文件', () => {
  const { dir, file, cleanup } = tempFile();
  try {
    const store = createDurableStore({ file });
    store.append({ name: 'a@1', key: 'k1' });
    store.append({ name: 'b@1', key: 'k2' });
    // 目录里只该剩下正式文件：临时文件必须被 rename 吃掉，不能堆在 data 目录里。
    const left = fs.readdirSync(dir);
    assert.deepEqual(left, ['tasks.jsonl']);
    // 文件内容是可逐行解析的 JSONL，没有空行残留。
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  } finally { cleanup(); }
});

test('新实例重新 load 能读回已有任务（跨进程可见）', () => {
  const { file, cleanup } = tempFile();
  try {
    const writer = createDurableStore({ file });
    writer.append({ name: 'reminders.create@1', input: { chatId: 'c1' }, key: 'k1' });
    writer.append({ name: 'message.send@1', input: { chatId: 'c2' }, key: 'k2' });

    // 不带任何进程内缓存：新实例只能靠文件本身。
    const reader = createDurableStore({ file });
    const loaded = reader.load();
    assert.equal(loaded.length, 2);
    assert.deepEqual(loaded.map(item => item.key), ['k1', 'k2']);
    assert.equal(reader.size(), 2);
  } finally { cleanup(); }
});

test('remove 按 key 删除并落盘，未命中返回 durable_missing', () => {
  const { file, cleanup } = tempFile();
  try {
    const store = createDurableStore({ file });
    store.append({ name: 'a@1', key: 'k1' });
    store.append({ name: 'b@1', key: 'k2' });

    assert.deepEqual(store.remove('k1'), { ok: true, size: 1 });
    // 删除必须立刻落盘：重启后不能又冒出来。
    assert.deepEqual(createDurableStore({ file }).load().map(item => item.key), ['k2']);

    assert.deepEqual(store.remove('k1'), { ok: false, code: 'durable_missing' });
    assert.deepEqual(store.remove(''), { ok: false, code: 'durable_missing' });
  } finally { cleanup(); }
});

test('clear 清空并留一个空文件，size 归零且可继续追加', () => {
  const { file, cleanup } = tempFile();
  try {
    const store = createDurableStore({ file });
    store.append({ name: 'a@1', key: 'k1' });
    store.append({ name: 'b@1', key: 'k2' });

    assert.deepEqual(store.clear(), { ok: true, size: 0 });
    assert.equal(store.size(), 0);
    assert.deepEqual(store.load(), []);
    // 清空后写入要能正常工作，不能被上一次的空文件卡住。
    assert.deepEqual(store.append({ name: 'c@1', key: 'k3' }), { ok: true, size: 1 });
  } finally { cleanup(); }
});

test('文件损坏时 load 跳过坏行、保留好行并告警', () => {
  const { file, cleanup } = tempFile();
  try {
    fs.writeFileSync(file, [
      JSON.stringify({ name: 'a@1', input: {}, key: 'k1', at: 1 }),
      '{ 这不是 JSON',
      '',
      JSON.stringify({ name: 'b@1', input: {}, key: 'k2', at: 2 }),
      // 缺 name 的行按坏行处理（name 是任务的唯一语义标识）
      JSON.stringify({ input: {}, key: 'k3', at: 3 }),
    ].join('\n'), 'utf8');

    const { warnings, logger } = recorder();
    const store = createDurableStore({ file, logger });
    assert.deepEqual(store.load().map(item => item.key), ['k1', 'k2']);
    assert.equal(warnings.length, 1);
    // 告警只带行数，不带坏行内容（内容不可信，可能是半截正文）。
    assert.match(warnings[0], /2 行无法解析/);
    assert.ok(!warnings[0].includes('这不是'), '告警不能回显坏行内容');
  } finally { cleanup(); }
});

test('整份文件都是垃圾时 load 返回空数组、告警、之后仍可追加', () => {
  const { file, cleanup } = tempFile();
  try {
    fs.writeFileSync(file, '\u0000\u0001 完全不是 JSONL', 'utf8');
    const { warnings, logger } = recorder();
    const store = createDurableStore({ file, logger });

    assert.deepEqual(store.load(), []);
    assert.equal(warnings.length, 1);
    // 重要：坏文件不能把存储锁死，append 要能覆盖成一份干净的文件。
    assert.deepEqual(store.append({ name: 'a@1', key: 'k1' }), { ok: true, size: 1 });
    assert.deepEqual(createDurableStore({ file }).load().map(item => item.key), ['k1']);
  } finally { cleanup(); }
});

test('BOM 开头不影响第一行解析', () => {
  const { file, cleanup } = tempFile();
  try {
    // Windows 记事本另存会加 BOM，JSON.parse 遇到它会直接失败。
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ name: 'a@1', input: {}, key: 'k1', at: 1 }) + '\n', 'utf8');
    const store = createDurableStore({ file });
    assert.deepEqual(store.load().map(item => item.key), ['k1']);
  } finally { cleanup(); }
});

test('达到 500 条上限后 append 返回 durable_full 且不丢已有任务', () => {
  const { file, cleanup } = tempFile();
  try {
    const store = createDurableStore({ file });
    for (let i = 0; i < MAX_ENTRIES; i++) {
      const out = store.append({ name: 'a@1', key: 'k' + i });
      assert.equal(out.ok, true);
      assert.equal(out.size, i + 1);
    }
    assert.equal(store.size(), MAX_ENTRIES);

    assert.deepEqual(store.append({ name: 'a@1', key: 'overflow' }), { ok: false, code: 'durable_full' });
    // 拒绝追加不能顺手删掉最老的那条：丢任务比拒绝更糟。
    const loaded = store.load();
    assert.equal(loaded.length, MAX_ENTRIES);
    assert.equal(loaded[0].key, 'k0');
    assert.ok(!loaded.some(item => item.key === 'overflow'));
  } finally { cleanup(); }
});

test('删除一条后腾出的名额可以继续追加', () => {
  const { file, cleanup } = tempFile();
  try {
    const store = createDurableStore({ file });
    for (let i = 0; i < MAX_ENTRIES; i++) store.append({ name: 'a@1', key: 'k' + i });
    assert.equal(store.append({ name: 'a@1', key: 'x' }).ok, false);

    assert.equal(store.remove('k0').ok, true);
    assert.deepEqual(store.append({ name: 'a@1', key: 'x' }), { ok: true, size: MAX_ENTRIES });
  } finally { cleanup(); }
});

test('非法条目被拒绝而不是写进去', () => {
  const { file, cleanup } = tempFile();
  try {
    const store = createDurableStore({ file });
    assert.deepEqual(store.append(null), { ok: false, code: 'durable_invalid' });
    assert.deepEqual(store.append({ key: 'only-key' }), { ok: false, code: 'durable_invalid' });
    assert.deepEqual(store.append({ name: '   ' }), { ok: false, code: 'durable_invalid' });
    assert.equal(store.size(), 0);
  } finally { cleanup(); }
});

test('没有 file 时是 no-op：不建文件也不抛错', () => {
  const { warnings, logger } = recorder();
  const store = createDurableStore({ file: '', logger });
  assert.deepEqual(store.load(), []);
  assert.equal(store.size(), 0);
  assert.deepEqual(store.append({ name: 'a@1', key: 'k1' }), { ok: false, code: 'durable_no_file' });
  assert.deepEqual(store.clear(), { ok: false, code: 'durable_no_file' });
  // 裁剪装配下不进盘是正常路径，不该刷告警。
  assert.deepEqual(warnings, []);
});

test('logger 抛错不影响存储可用性', () => {
  const { file, cleanup } = tempFile();
  try {
    // 坏日志器（测试桩）不能让 append/load 失败：告警是旁路，不是主路径。
    const store = createDurableStore({ file, logger: { warn: () => { throw new Error('logger broke'); } } });
    fs.writeFileSync(file, 'garbage\n', 'utf8');
    assert.deepEqual(store.load(), []);
    assert.deepEqual(store.append({ name: 'a@1', key: 'k1' }), { ok: true, size: 1 });
  } finally { cleanup(); }
});
