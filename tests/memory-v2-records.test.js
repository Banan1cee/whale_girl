'use strict';

/**
 * 记忆 v2 的记录模型（record.js）。
 *
 * 这一层的意义是「一条记忆只有一个答案」：层是字段、动作只有提升/降级/淘汰，
 * 跨会话可见性只有 visibleTo 一处实现。测试重点：
 *   1. 层的默认值必须由 kind 决定，不能各模块自己算；
 *   2. id 幂等：同一条消息重复写入命中同一个 id；
 *   3. visibleTo 是隐私红线：私聊的东西不能进群，群的东西不能进别的群；
 *   4. capRecords 只降级不删除，且不改入参。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const record = require('../src/memory/record');
const { chatHash } = require('../src/memory/hash');

const CHAT_A = 'wechat:g:aaa';
const CHAT_B = 'wechat:g:bbb';
const HASH_A = chatHash(CHAT_A);
const HASH_B = chatHash(CHAT_B);

function mk(over = {}) {
  return record.makeRecord({
    kind: 'fact',
    text: '小明不吃香菜',
    ts: 1760000000000,
    subject: 'wxid_x',
    source: { chatId: CHAT_A, messageIds: ['m_1'] },
    ...over,
  });
}

test('层的默认值由 kind 决定，显式 tier 优先', () => {
  assert.equal(mk({ kind: 'message' }).tier, 'S');
  assert.equal(mk({ kind: 'digest' }).tier, 'M');
  assert.equal(mk({ kind: 'event' }).tier, 'M');
  assert.equal(mk({ kind: 'fact' }).tier, 'L');
  assert.equal(mk({ kind: 'relation' }).tier, 'L');
  assert.equal(mk({ kind: 'thread' }).tier, 'L');
  assert.equal(mk({ kind: 'fact', tier: 'M' }).tier, 'M');
  assert.equal(mk({ kind: '不认识的 kind' }).kind, 'fact');
});

test('空文本不产生记录', () => {
  assert.equal(record.makeRecord({ kind: 'fact', text: '   ' }), null);
  assert.equal(record.makeRecord({}), null);
  assert.equal(record.normalizeRecord(null), null);
});

test('id 幂等：同一条消息重复写入命中同一个 id', () => {
  const a = mk();
  const b = mk();
  assert.equal(a.id, b.id);
  const other = mk({ text: '完全不同的内容' });
  assert.notEqual(a.id, other.id);
  // 换消息 id 就是另一条记忆
  const third = mk({ source: { chatId: CHAT_A, messageIds: ['m_2'] } });
  assert.notEqual(a.id, third.id);
});

test('scope 归一化，并按来源 chat 推导默认值', () => {
  assert.equal(mk().scope, `chat:${HASH_A}`);
  assert.equal(record.normalizeScope(`chat:${HASH_A}`), `chat:${HASH_A}`);
  assert.equal(record.normalizeScope('subject:wxid_x'), 'subject:wxid_x');
  assert.equal(record.normalizeScope('shared:wxid_x'), 'shared:wxid_x');
  assert.equal(record.normalizeScope('随便写的'), '');
  assert.equal(record.normalizeScope({ kind: 'chat', hash: HASH_A }), `chat:${HASH_A}`);
  assert.deepEqual(record.parseScope(`chat:${HASH_A}`), { kind: 'chat', hash: HASH_A });
  assert.deepEqual(record.parseScope('shared:wxid_x'), { kind: 'shared', uid: 'wxid_x' });
});

test('visibleTo：本 chat 的只看得到本 chat', () => {
  const r = mk();
  assert.equal(record.visibleTo(r, { chatHash: HASH_A, isGroup: true, uid: 'wxid_y', roster: ['wxid_x'] }), true);
  assert.equal(record.visibleTo(r, { chatHash: HASH_B, isGroup: true, uid: 'wxid_y', roster: ['wxid_x'] }), false);
});

test('visibleTo：私聊产生的记录不进群（隐私红线）', () => {
  const secret = mk({ audience: 'private' });
  assert.equal(record.visibleTo(secret, { chatHash: HASH_A, isGroup: true, uid: 'wxid_x', roster: ['wxid_x'] }), false);
  assert.equal(record.visibleTo(secret, { chatHash: HASH_A, isGroup: false, uid: 'wxid_x' }), true);
  assert.equal(record.visibleTo(secret, { chatHash: HASH_A, isGroup: false, uid: 'wxid_y' }), false);
});

test('visibleTo：跨会话事实要求当事人也在场', () => {
  const shared = mk({ scope: 'subject:wxid_x', audience: 'all' });
  // 群里有小明 → 可以用；群里没有 → 不许出现
  assert.equal(record.visibleTo(shared, { chatHash: HASH_B, isGroup: true, uid: 'wxid_y', roster: ['wxid_x', 'wxid_y'] }), true);
  assert.equal(record.visibleTo(shared, { chatHash: HASH_B, isGroup: true, uid: 'wxid_y', roster: ['wxid_y'] }), false);
  // 私聊里只有和小明本人聊时才可见
  assert.equal(record.visibleTo(shared, { chatHash: HASH_B, isGroup: false, uid: 'wxid_x' }), true);
  assert.equal(record.visibleTo(shared, { chatHash: HASH_B, isGroup: false, uid: 'wxid_y' }), false);
});

test('visibleTo：指定 group 的可见范围只给那一个群', () => {
  const inB = mk({ scope: 'subject:wxid_x', audience: `group:${HASH_B}` });
  assert.equal(record.visibleTo(inB, { chatHash: HASH_B, isGroup: true, uid: 'wxid_y', roster: ['wxid_x'] }), true);
  assert.equal(record.visibleTo(inB, { chatHash: HASH_A, isGroup: true, uid: 'wxid_y', roster: ['wxid_x'] }), false);
  assert.equal(record.visibleTo(inB, { chatHash: HASH_B, isGroup: false, uid: 'wxid_x' }), false);
});

test('visibleTo：归档和删除的记录不参与注入', () => {
  const archived = { ...mk(), state: 'archived' };
  const deleted = { ...mk(), state: 'deleted' };
  assert.equal(record.visibleTo(archived, { chatHash: HASH_A, isGroup: false, uid: 'wxid_x' }), false);
  assert.equal(record.visibleTo(deleted, { chatHash: HASH_A, isGroup: false, uid: 'wxid_x' }), false);
});

test('shouldPromote：只认反复提到 / 高置信 / 高重要 / 明确记住', () => {
  const plain = mk({ tier: 'M', confidence: 0.5 });
  assert.equal(record.shouldPromote(plain), false);
  assert.equal(record.shouldPromote({ ...plain, hits: 2 }), true);
  assert.equal(record.shouldPromote({ ...plain, confidence: 0.82 }), true);
  assert.equal(record.shouldPromote({ ...plain, importance: 0.9 }), true);
  assert.equal(record.shouldPromote({ ...plain, pinned: true }), true);
  // 已经是长期 / 短期的不再提升
  assert.equal(record.shouldPromote({ ...plain, tier: 'L' }), false);
  assert.equal(record.shouldPromote({ ...plain, tier: 'S' }), false);
});

test('evictionScore：置顶最稳，越老越弱，被用过加分', () => {
  const now = 1760000000000;
  const base = mk({ ts: now, confidence: 0.5 });
  const old = mk({ ts: now - 180 * 86400000, confidence: 0.5 });
  assert.ok(record.evictionScore(base, now) > record.evictionScore(old, now));
  assert.ok(record.evictionScore({ ...base, pinned: true }, now) > record.evictionScore(base, now));
  assert.ok(record.evictionScore({ ...base, hits: 5 }, now) > record.evictionScore(base, now));
});

test('capRecords：超限只降级不删除，且不改入参', () => {
  const now = 1760000000000;
  const list = [];
  for (let i = 0; i < 5; i += 1) {
    list.push(mk({ text: `事实${i}`, confidence: 0.9 - i * 0.1, ts: now }));
  }
  const before = JSON.stringify(list);
  const out = record.capRecords(list, { cap: 3, tier: 'L', now });
  assert.equal(out.records.length, 5, '不能删记录');
  assert.equal(out.demoted.length, 2);
  assert.equal(out.records.filter((r) => r.state === 'active').length, 3);
  assert.equal(out.records.filter((r) => r.state === 'archived').length, 2);
  // 被降级的是分数最低的两条
  const archivedTexts = out.records.filter((r) => r.state === 'archived').map((r) => r.text).sort();
  assert.deepEqual(archivedTexts, ['事实3', '事实4']);
  assert.equal(JSON.stringify(list), before, '入参不能被改');
});

test('capRecords：没超限时原样返回', () => {
  const list = [mk()];
  const out = record.capRecords(list, { cap: 30, tier: 'L' });
  assert.equal(out.demoted.length, 0);
  assert.equal(out.records[0].state, 'active');
});

test('capByKind：各 kind 各占各的额度，性格/话题不挤偏好', () => {
  const now = 1760000000000;
  const list = [];
  for (let i = 0; i < 5; i += 1) {
    list.push(mk({ kind: 'preference', text: `偏好${i}`, ts: now, confidence: 0.9 }));
    list.push(mk({ kind: 'trait', text: `性格${i}`, ts: now, confidence: 0.9 }));
    list.push(mk({ kind: 'thread', text: `话题${i}`, ts: now, confidence: 0.9 }));
  }
  const out = record.capByKind(list, { caps: { preference: 3, trait: 2, thread: 1 }, now });
  const count = (kind) => out.filter((r) => r.kind === kind && r.state === 'active').length;
  assert.equal(count('preference'), 3);
  assert.equal(count('trait'), 2);
  assert.equal(count('thread'), 1);
  assert.equal(out.length, list.length, '只降级不删除');
  assert.equal(out.filter((r) => r.state === 'archived').length, 9);
});

test('capByKind：没给上限的 kind 原样保留', () => {
  const now = 1760000000000;
  const list = [mk({ kind: 'relation', text: '同事', ts: now }), mk({ kind: 'thread', text: '话题', ts: now })];
  const out = record.capByKind(list, { caps: { preference: 0 }, now });
  assert.equal(out.find((r) => r.kind === 'relation').state, 'active');
});
