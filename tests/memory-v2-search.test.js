'use strict';

/**
 * 长期档案检索（search.js）+ 召回接线（memory.recall 的 recallArchive）。
 *
 * 补的是最致命的那个缺口：原文从来不参与检索，掉出 recent 窗口就永久失联。
 * 重点：
 *   1. 分块是对的（有重叠、有边界、有发言人）；
 *   2. BM25 能把「很久以前说过的那句」捞回来；
 *   3. 已经在 recent 里的块不会再出现一次；
 *   4. 默认关闭时输出与改造前逐字一致（no-op）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const search = require('../src/memory/search');
const memory = require('../src/memory');
const { Store } = require('../src/memory/store');
const { estimateBudgetTokens } = require('../src/memory/tokens');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-search-'));
  return new Store({ file: path.join(dir, 'store.json'), dir, logger: null });
}

function seedLongHistory(store, key, count = 30) {
  for (let i = 1; i <= count; i += 1) {
    // 每条约 300 字：保证 recent 窗口（3,200 token）装不下全部 30 条
    store.appendMessage(key, {
      role: 'user',
      uid: 'u1',
      name: '小海',
      text: `第${i}句话：` + '今天在公司加班到很晚，回家路上还在想那件事，越想越觉得不能再拖了。'.repeat(10),
      ts: 1760000000000 + i * 1000,
    });
  }
  return store;
}

test('buildChunks：6 条一块、重叠 1 条，最后一块也保留', () => {
  const messages = [];
  for (let i = 1; i <= 12; i += 1) {
    messages.push({ seq: i, role: i % 5 === 0 ? 'assistant' : 'user', name: i % 5 === 0 ? '' : '小海', text: `消息${i}`, ts: 1760000000000 + i, id: `m_${i}` });
  }
  const chunks = search.buildChunks(messages, { chatId: 'wechat:g:1' });
  assert.equal(chunks.length, 3, '12 条 / 步进 5 = 3 块');
  assert.equal(chunks[0].seqFrom, 1);
  assert.equal(chunks[0].seqTo, 6);
  assert.equal(chunks[1].seqFrom, 6, '重叠一条');
  assert.match(chunks[0].text, /小海：消息1/);
  assert.equal(chunks[2].seqTo, 12);
  assert.ok(chunks[0].messageIds.includes('m_1'));
});

test('buildChunks：空消息与错误消息不进块', () => {
  const chunks = search.buildChunks([
    { seq: 1, role: 'user', text: '正常' },
    { seq: 2, role: 'user', text: '' },
    { seq: 3, role: 'user', text: '报错', error: true },
  ]);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /正常/);
  assert.doesNotMatch(chunks[0].text, /报错/);
});

test('BM25：关键词命中的块排第一，空 query 返回空', () => {
  const chunks = [
    { id: 'a', seqFrom: 1, seqTo: 2, ts: 1, text: '小海：我不吃香菜，闻到就想吐' },
    { id: 'b', seqFrom: 3, seqTo: 4, ts: 2, text: '小海：今天股票又跌了，烦' },
    { id: 'c', seqFrom: 5, seqTo: 6, ts: 3, text: '鲸鲸：那就别看了' },
  ];
  const index = search.buildIndex(chunks);
  const hits = search.search(index, '香菜', { topK: 2 });
  assert.equal(hits.length >= 1, true);
  assert.equal(hits[0].chunk.id, 'a');
  assert.deepEqual(search.search(index, '', { topK: 2 }), []);
  // 中文按单字 + bigram 索引，只要共用一个常用字就算弱命中（BM25 会给低分）；
  // 这里用一个字面完全不共用的词验证「真的没命中」是空数组。
  assert.deepEqual(search.search(index, '比特币', { topK: 2 }), []);
});

test('filterFresh：和 recent 区间有交集的块整块丢掉', () => {
  const hits = [
    { chunk: { seqFrom: 1, seqTo: 6, text: 'old' } },
    { chunk: { seqFrom: 11, seqTo: 16, text: 'new' } },
  ];
  const kept = search.filterFresh(hits, [12, 13, 14]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].chunk.text, 'old');
});

test('searchArchive：能捞回掉出 recent 窗口的旧话', () => {
  const store = makeStore();
  try {
    seedLongHistory(store, 'wechat:p:u1');
    const hits = store.searchArchive('wechat:p:u1', '第2句话', { topK: 3 });
    assert.ok(hits.length >= 1);
    assert.match(hits[0].chunk.text, /第2句话/);
  } finally {
    store.close();
  }
});

test('searchArchive：索引会随新消息自动失效，不会搜到旧快照', () => {
  const store = makeStore();
  try {
    store.appendMessage('wechat:p:u2', { role: 'user', uid: 'u2', name: '小海', text: '今天天气不错', ts: Date.now() });
    assert.equal(store.searchArchive('wechat:p:u2', '西瓜').length, 0);
    store.appendMessage('wechat:p:u2', { role: 'user', uid: 'u2', name: '小海', text: '刚买了个西瓜，特别甜', ts: Date.now() + 1 });
    const hits = store.searchArchive('wechat:p:u2', '西瓜');
    assert.ok(hits.length >= 1, '新消息必须能立刻被搜到');
  } finally {
    store.close();
  }
});

test('recall：默认不召回（与改造前逐字一致）', () => {
  const store = makeStore();
  try {
    seedLongHistory(store, 'wechat:p:u1', 12);
    const mem = memory.recall(store, { key: 'wechat:p:u1', uid: 'u1', name: '小海', query: '第2句话', isGroup: false });
    assert.equal(mem.recall, undefined);
    assert.equal(mem.parts.recall, 0);
    assert.doesNotMatch(String(mem.block || ''), /相关回忆/);
  } finally {
    store.close();
  }
});

test('recall：开启召回时追加【相关回忆】段，并计入 parts.recall', () => {
  const store = makeStore();
  try {
    seedLongHistory(store, 'wechat:p:u1');
    const mem = memory.recall(store, {
      key: 'wechat:p:u1', uid: 'u1', name: '小海', query: '第2句话', isGroup: false, recallArchive: true,
    });
    assert.ok(mem.block.includes('【相关回忆】'));
    assert.match(mem.block, /第2句话/);
    assert.ok(mem.parts.recall > 0);
    assert.ok(Array.isArray(mem.recall) && mem.recall.length >= 1);
    // 召回的内容不能和 recent 重复
    const seqs = new Set((mem.recent || []).map((m) => m.seq));
    for (const chunk of mem.recall) {
      for (let s = chunk.seqFrom; s <= chunk.seqTo; s += 1) {
        assert.equal(seqs.has(s), false, '召回了已经在 recent 里的块');
      }
    }
  } finally {
    store.close();
  }
});

test('renderRecall：超预算时从最旧的一条开始丢，不硬塞', () => {
  const hits = [1, 2, 3].map((i) => ({
    chunk: { seqFrom: i, seqTo: i, ts: 1760000000000 + i, text: '很长的回忆内容'.repeat(40) },
  }));
  const section = memory.renderRecall(hits, { budget: 200 });
  assert.ok(section.tokens <= 260, `预算没守住：${section.tokens}`);
  assert.ok(section.text.startsWith('【相关回忆】'));
});

test('renderRecall：没有命中就不产生空段', () => {
  assert.deepEqual(memory.renderRecall([], { budget: 700 }), { text: '', tokens: 0 });
});
