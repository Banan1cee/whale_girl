'use strict';

/**
 * 记忆能力（memory.recall@1 / memory.write@1）的验收。
 *
 * 召回必须复用 src/memory 自己的检索入口：插件看到的「聊到过什么」
 * 和对话管线看到的是同一份索引结果；写入只能追加 assistant 消息或
 * 显式 note，不能伪造用户发言（那会触发宿主的事实抽取与建卡）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/memory/store');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { createFeatureCapabilities } = require('../src/services/features');

const KEY = 'wechat:u:fixture';
const CHAT = { chatId: 'fixture', chatType: 'private' };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-feature-memory-'));
  const store = new Store({ file: path.join(dir, 'store.json'), dir, logger: null });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });
  const runtime = { config: { persona: {} }, store, logger: null };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  for (const [name, handler] of Object.entries(createFeatureCapabilities(runtime))) dispatcher.defineHost(name, handler);
  store.appendMessage(KEY, { role: 'user', uid: 'wxid_a', name: '小海', text: '上个周末去西湖边吃了龙井虾仁', ts: 1760000000000 });
  store.appendMessage(KEY, { role: 'assistant', text: '听起来就很鲜', ts: 1760000001000 });
  return { dispatcher, store };
}

test('memory.recall@1 检索到历史原文，返回 {items:[{text,ts,score}]}', async t => {
  const { dispatcher } = fixture(t);
  const out = await dispatcher.invokeHost('memory.recall@1', { ...CHAT, query: '龙井虾仁' });
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.items) && out.items.length >= 1, JSON.stringify(out));
  const hit = out.items[0];
  assert.match(hit.text, /龙井虾仁/);
  assert.equal(typeof hit.ts, 'number');
  assert.ok(hit.ts > 0);
  assert.equal(typeof hit.score, 'number');
  assert.ok(hit.score > 0);
  // 结果必须可 JSON 化：插件 IPC 只能传 JSON，不能带 Store 内部对象。
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test('memory.recall@1 的输入清洗：缺 chatId / query 或乱传 limit 都不越界', async t => {
  const { dispatcher } = fixture(t);
  await assert.rejects(dispatcher.invokeHost('memory.recall@1', { query: '龙井' }),
    { code: 'invalid_host_capability_input' });
  await assert.rejects(dispatcher.invokeHost('memory.recall@1', { ...CHAT, query: '   ' }),
    { code: 'invalid_host_capability_input' });
  await assert.rejects(dispatcher.invokeHost('memory.recall@1', 'nope'),
    { code: 'invalid_host_capability_input' });
  const out = await dispatcher.invokeHost('memory.recall@1', { ...CHAT, query: '西湖', limit: 999 });
  assert.ok(out.items.length <= 20);
});

test('memory.write@1 默认追加 assistant 消息，进入上下文但不伪造用户发言', async t => {
  const { dispatcher, store } = fixture(t);
  const out = await dispatcher.invokeHost('memory.write@1', { ...CHAT, text: '插件记一条：明天记得带伞', role: 'user' });
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'message');
  assert.equal(out.stored, true);
  assert.match(out.id, /^msg_\d+$/);
  assert.ok(out.ts > 0);
  const rows = store.messages(KEY, 3);
  const last = rows[rows.length - 1];
  assert.equal(last.text, '插件记一条：明天记得带伞');
  assert.equal(last.role, 'assistant', '插件不能把内容伪造成用户消息');
});

test('memory.write@1 note 模式写长期偏好，uid 必填', async t => {
  const { dispatcher, store } = fixture(t);
  const out = await dispatcher.invokeHost('memory.write@1', { ...CHAT, mode: 'note', uid: 'wxid_a', text: '喜欢喝乌龙茶' });
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'note');
  assert.equal(out.remembered, true);
  assert.ok(out.notes.includes('喜欢喝乌龙茶'), JSON.stringify(out.notes));
  const profile = store.profile(KEY, 'wxid_a', '小海');
  assert.ok(profile.notes.some(note => note.text === '喜欢喝乌龙茶'));

  await assert.rejects(dispatcher.invokeHost('memory.write@1', { ...CHAT, mode: 'note', text: '没有 uid' }),
    { code: 'invalid_host_capability_input' });
});

test('memory.write@1 拒绝空正文与非对象输入，且不落任何东西', async t => {
  const { dispatcher, store } = fixture(t);
  const before = store.messages(KEY, 50).length;
  await assert.rejects(dispatcher.invokeHost('memory.write@1', { ...CHAT, text: '   ' }),
    { code: 'invalid_host_capability_input' });
  await assert.rejects(dispatcher.invokeHost('memory.write@1', { text: 'x' }),
    { code: 'invalid_host_capability_input' });
  await assert.rejects(dispatcher.invokeHost('memory.write@1', []),
    { code: 'invalid_host_capability_input' });
  assert.equal(store.messages(KEY, 50).length, before);
});
