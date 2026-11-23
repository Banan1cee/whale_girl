'use strict';

/**
 * 记忆模块的唯一入口（memory/index.js）的契约。
 *
 * 这个测试锁的是「pipeline 只认这一个门面」：recall 的返回字段必须覆盖
 * 对话流程用到的全部键，parts 里的各层占用必须能对上。改造后如果换了内部实现，
 * 只要这组字段不变，pipeline 就不用动。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memory = require('../src/memory');
const { Store } = require('../src/memory/store');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mm-'));
  return new Store({ file: path.join(dir, 'store.json'), dir, logger: null });
}

test('recall 返回 pipeline 需要的全部字段，并附带 schema / parts', () => {
  const store = makeStore();
  try {
    store.appendMessage('wechat:p:u1', {
      role: 'user', uid: 'u1', name: '小海', text: '你好呀', ts: Date.now(),
    });
    const mem = memory.recall(store, {
      key: 'wechat:p:u1', uid: 'u1', name: '小海', query: '你好呀', isGroup: false,
    });
    for (const key of ['block', 'recent', 'notes', 'relationsBlock', 'relationsTokens', 'memoryTokens', 'summaryTokens', 'recentTokens']) {
      assert.ok(key in mem, `缺少字段 ${key}`);
    }
    assert.equal(mem.schema, 'memory-v2');
    assert.ok(Array.isArray(mem.recent));
    assert.equal(typeof mem.parts, 'object');
    for (const key of ['working', 'mid', 'long', 'recall', 'relations']) {
      assert.equal(typeof mem.parts[key], 'number', `parts.${key} 必须是数字`);
    }
  } finally {
    store.close();
  }
});

test('recall 缺 store 时立刻报错，不要静默返回空记忆', () => {
  assert.throws(() => memory.recall(null, {}), /Store/);
});

test('ingest 转发到 appendMessage，不额外调模型', () => {
  const store = makeStore();
  try {
    const entry = memory.ingest(store, 'wechat:p:u1', {
      role: 'user', uid: 'u1', name: '小海', text: '晚上吃啥', ts: Date.now(), msgId: 'm_9',
    });
    assert.equal(entry.text, '晚上吃啥');
    const recent = store.messages('wechat:p:u1', 5);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].text, '晚上吃啥');
  } finally {
    store.close();
  }
});

test('consolidate / forget 在接线前显式跳过，不假装成功', () => {
  assert.equal(memory.consolidate().skipped, true);
  assert.equal(memory.forget().skipped, true);
});
