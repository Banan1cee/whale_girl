'use strict';

/**
 * 人物卡：偏好/性格/事件/threads 的合并、纠正、容量和忘记。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const personCard = require('../src/memory/personCard');
const { LIMITS } = require('../src/memory/constants');
const { Store } = require('../src/memory/store');
const record = require('../src/memory/record');
const recordStore = require('../src/memory/recordStore');

/** 把记录写进 chat 的时间线 / 各人的 subjects（4.3 起的唯一事实源） */
function sharedWrite(store, chat, records) {
  for (const item of records) {
    if (!item) continue;
    if (item.tier === 'M') {
      recordStore.appendTimeline(chat.dir, [item]);
      continue;
    }
    const existing = recordStore.readSubjects(store.memoryDir, item.subject);
    const map = new Map(existing.map((r) => [r.id, r]));
    map.set(item.id, item);
    recordStore.writeSubjects(store.memoryDir, item.subject, [...map.values()]);
  }
}

const NOW = 1_700_000_000_000;
const DAY = 86400000;

function newCard(chatId = 'wechat:u:a', uid = 'u1') {
  return personCard.newCard({ chatId, uid, name: '小海', now: NOW });
}

test('偏好：重复不叠加，近似合并', () => {
  const card = newCard();
  personCard.addPreference(card, { text: '喜欢猫', confidence: 0.8, source: 'm1' }, { chatId: card.chatId, now: NOW });
  personCard.addPreference(card, { text: '喜欢猫', confidence: 0.9, source: 'm2' }, { chatId: card.chatId, now: NOW });
  personCard.addPreference(card, { text: '喜欢猫的', confidence: 0.8, source: 'm3' }, { chatId: card.chatId, now: NOW });
  assert.equal(personCard.activePreferences(card).length, 1);
  assert.equal(personCard.activePreferences(card)[0].confidence, 0.9);
});

test('纠正：旧值 superseded，新值置信度 1.0', () => {
  const card = newCard();
  personCard.addPreference(card, { text: '住在杭州', key: 'city', confidence: 0.8, source: 'm1' }, { chatId: card.chatId, now: NOW });
  personCard.addPreference(card, {
    text: '住在上海', key: 'city', confidence: 1, source: 'm2', explicit: true, supersedes: ['杭州'],
  }, { chatId: card.chatId, now: NOW });
  const active = personCard.activePreferences(card);
  assert.equal(active.length, 1);
  assert.equal(active[0].text, '住在上海');
  assert.equal(active[0].confidence, 1);
});

test('跨聊天写卡直接拒绝', () => {
  const card = newCard('wechat:u:a');
  assert.throws(
    () => personCard.addPreference(card, { text: '喜欢猫' }, { chatId: 'wechat:g:g1', now: NOW }),
    /跨聊天/,
  );
  assert.throws(
    () => personCard.addEvent(card, {
      title: 'x', summary: 'y', source: { chatId: 'wechat:g:g1', messageIds: [] },
    }, { chatId: 'wechat:g:g1', now: NOW }),
    /跨聊天/,
  );
});

test('性格：少于 2 条证据不写；单次情绪不进卡', () => {
  const card = newCard();
  assert.equal(personCard.addTrait(card, { text: '压力大时不想被说教', confidence: 0.8, evidence: ['m1'] }, { chatId: card.chatId, now: NOW }), null);
  const added = personCard.addTrait(card, {
    text: '压力大时不想被说教', confidence: 0.8, evidence: ['m1', 'm2'],
  }, { chatId: card.chatId, now: NOW });
  assert.ok(added);
  assert.equal(personCard.activeTraits(card).length, 1);
});

test('性格上限 12 条，按置信度淘汰', () => {
  const card = newCard();
  for (let i = 0; i < 15; i += 1) {
    personCard.addTrait(card, {
      text: '标签' + i, confidence: 0.66 + i * 0.01, evidence: ['a' + i, 'b' + i],
    }, { chatId: card.chatId, now: NOW });
  }
  assert.ok(personCard.activeTraits(card).length <= LIMITS.maxTraitsPerPerson);
  assert.ok(personCard.activeTraits(card).some((t) => t.text === '标签14'));
});

test('threads：开/关，上限 10，最久没提的先关', () => {
  const card = newCard();
  for (let i = 0; i < 12; i += 1) {
    personCard.addThread(card, { text: '未完成话题' + i }, { chatId: card.chatId, now: NOW + i });
  }
  assert.ok(personCard.openThreads(card).length <= LIMITS.maxThreadsPerPerson);
  assert.ok(personCard.openThreads(card).some((t) => t.text === '未完成话题11'));
  personCard.closeThread(card, '未完成话题11', NOW + 100);
  assert.ok(!personCard.openThreads(card).some((t) => t.text === '未完成话题11'));
});

test('忘记：软删除 fact/event/thread，不物理删文件', () => {
  const card = newCard();
  personCard.addPreference(card, { text: '怕黑', confidence: 0.8 }, { chatId: card.chatId, now: NOW });
  personCard.addEvent(card, {
    title: '体检', summary: '明天去体检', participants: ['u1'], source: { chatId: card.chatId, messageIds: ['m1'] },
  }, { chatId: card.chatId, now: NOW });
  const removed = personCard.forget(card, '体检', NOW);
  assert.equal(removed, 1);
  assert.equal(personCard.activeEvents(card).length, 0);
  assert.ok(card.events[0].deleted, '软删除标记还在，方便审计');
});

test('Store：事件过期只淘汰 365 天前的，thread 60 天没提自动关', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-forget-v2-'));
  const store = new Store({ file: path.join(dir, 'data', 'store.json'), logger: null });
  store.appendMessage('wechat:u:a', { role: 'user', name: '小海', uid: 'u1', text: '在吗', ts: NOW });
  const chat = store.chatStore.chats.get('wechat:u:a');
  const scope = `chat:${chat.hash}`;
  // 4.3 起记忆在记录里：老的卡只当名册，这里直接写记录
  sharedWrite(store, chat, [
    record.makeRecord({
      kind: 'event', tier: 'M', text: '很老的事：两年前的旧事', ts: NOW - 500 * DAY, scope,
      subject: 'u1', confidence: 0.8, importance: 0.4,
      meta: { date: '2021-01-01', title: '很老的事', summary: '两年前的旧事', participants: ['u1'] },
    }),
    record.makeRecord({
      kind: 'thread', tier: 'L', text: '很久没提的坑', ts: NOW - 100 * DAY, scope,
      subject: 'u1', confidence: 0.7, open: true,
      meta: { status: 'open', lastMentionedAt: NOW - 100 * DAY },
    }),
  ]);

  const out = store.sweep(NOW);
  assert.ok(out.evicted >= 1);
  const records = store.chatStore.recordsOf(chat);
  assert.equal(records.filter((r) => r.kind === 'event' && r.state === 'active').length, 0, '365 天前的事件要过期');
  assert.equal(records.filter((r) => r.kind === 'thread' && r.open).length, 0, '60 天没提的 thread 要关掉');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('Store：removeNote 只影响这个 chat 的这个人', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-forget-s-'));
  const store = new Store({ file: path.join(dir, 'data', 'store.json'), logger: null });
  store.addNote('wechat:u:a', 'u1', '怕黑');
  store.addNote('wechat:u:b', 'u1', '怕黑');
  const r = store.removeNote('wechat:u:a', 'u1', '怕黑');
  assert.equal(r.removed, 1);
  assert.equal(store.listNotes('wechat:u:a').length, 0);
  assert.equal(store.listNotes('wechat:u:b').length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});
