'use strict';

/**
 * 记录的文件层（recordStore）+ 旧结构转换器（convert）。
 *
 * 重点：
 *   1. timeline 只追加、坏行跳过（崩溃留下的半行不能干掉整段历史）；
 *   2. subjects 原子写（.tmp + rename），不会留下半份档案；
 *   3. 转换必须保信息（标题不丢）、保 id（重复迁移幂等）、保 chat 隔离。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const recordStore = require('../src/memory/recordStore');
const convert = require('../src/memory/convert');
const record = require('../src/memory/record');
const { chatHash } = require('../src/memory/hash');

function tmpDir(prefix = 'whale-rs-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sampleRecord(over = {}) {
  return record.makeRecord({
    kind: 'digest',
    text: '这段在聊换工作',
    ts: 1760000000000,
    source: { chatId: 'wechat:g:111', messageIds: ['m_1'] },
    ...over,
  });
}

test('timeline：追加 + 读回，顺序稳定', () => {
  const dir = tmpDir();
  const n = recordStore.appendTimeline(dir, [sampleRecord(), sampleRecord({ text: '第二段', ts: 1760000001000 })]);
  assert.equal(n, 2);
  const back = recordStore.readTimeline(dir);
  assert.equal(back.length, 2);
  assert.equal(back[1].text, '第二段');
  assert.equal(back[0].tier, 'M');
  assert.ok(recordStore.timelinePath(dir).endsWith('timeline.jsonl'));
});

test('timeline：坏行跳过，好行保留', () => {
  const dir = tmpDir();
  recordStore.appendTimeline(dir, [sampleRecord()]);
  fs.appendFileSync(recordStore.timelinePath(dir), '{"这不是完整 JSON\n');
  recordStore.appendTimeline(dir, [sampleRecord({ text: '崩溃后的下一段' })]);
  const back = recordStore.readTimeline(dir);
  assert.equal(back.length, 2);
  assert.equal(back[1].text, '崩溃后的下一段');
});

test('timeline：空记录不写盘', () => {
  const dir = tmpDir();
  assert.equal(recordStore.appendTimeline(dir, [null, { kind: 'digest', text: '   ' }]), 0);
  assert.equal(recordStore.readTimeline(dir).length, 0);
});

test('subjects：整份原子重写', () => {
  const dir = tmpDir();
  const a = sampleRecord({ kind: 'preference', text: '不吃香菜', subject: 'wxid_a', tier: 'L' });
  const b = sampleRecord({ kind: 'trait', text: '嘴硬心软', subject: 'wxid_a', tier: 'L' });
  assert.equal(recordStore.writeSubjects(dir, 'wxid_a', [a, b]), 2);
  assert.equal(recordStore.readSubjects(dir, 'wxid_a').length, 2);
  // 覆盖写：只剩一条
  recordStore.writeSubjects(dir, 'wxid_a', [a]);
  const back = recordStore.readSubjects(dir, 'wxid_a');
  assert.equal(back.length, 1);
  assert.equal(back[0].text, '不吃香菜');
  // 不同的人各一份，不互相覆盖
  assert.equal(recordStore.readSubjects(dir, 'wxid_b').length, 0);
  // 不留 .tmp
  assert.equal(fs.readdirSync(path.join(dir, recordStore.SUBJECT_DIR)).filter((n) => n.endsWith('.tmp')).length, 0);
});

test('subjects：uid 为空直接拒绝，不允许写出「匿名档案」', () => {
  assert.throws(() => recordStore.subjectPath(tmpDir(), ''), /uid/);
});

test('convert：一张卡翻成 fact / trait / thread / event，层和 scope 正确', () => {
  const chatId = 'wechat:g:111';
  const now = 1760000000000;
  const chat = {
    chatId,
    hash: chatHash(chatId),
    people: new Map([['wxid_a', {
      uid: 'wxid_a',
      name: '小海',
      preferences: [{
        id: 'pf_1', text: '不吃香菜', key: 'pref:香菜', kind: 'taboo',
        confidence: 0.9, source: 'm_2', mentions: 3, createdAt: now, lastMentionedAt: now, explicit: true,
      }],
      traits: [{ id: 'tr_1', text: '嘴硬心软', confidence: 0.7, evidence: ['m_3'], createdAt: now }],
      threads: [{ id: 'th_1', text: '还在犹豫要不要辞职', status: 'open', createdAt: now, lastMentionedAt: now }],
      events: [{
        id: 'evt_1', date: '2026-10-28', title: '面试前的紧张', summary: '准备了三天，最后没敢问结果。',
        keywords: ['面试', '紧张'], participants: ['wxid_a'], importance: 0.6, confidence: 0.8,
        source: { chatId, messageIds: ['m_4'] },
      }],
    }]]),
    meta: { relations: [{ a: 'wxid_a', b: 'wxid_b', text: '同事', confidence: 0.8, createdAt: now, source: { messageIds: ['m_5'] } }] },
    summary: { text: '', segments: [{ text: '这段在聊换工作', fromSeq: 1, toSeq: 8, at: now }], coveredThroughSeq: 8, updatedAt: now },
  };

  const list = convert.fromChat(chat, { now });
  const byKind = (kind) => list.filter((r) => r.kind === kind);
  assert.equal(byKind('preference').length, 1);
  assert.equal(byKind('trait').length, 1);
  assert.equal(byKind('thread').length, 1);
  assert.equal(byKind('event').length, 1);
  assert.equal(byKind('relation').length, 1);
  assert.equal(byKind('digest').length, 1);

  const pref = byKind('preference')[0];
  assert.equal(pref.tier, 'L');
  assert.equal(pref.scope, `chat:${chatHash(chatId)}`);
  assert.equal(pref.subject, 'wxid_a');
  assert.equal(pref.hits, 3);
  assert.equal(pref.meta.tag, 'taboo');
  assert.equal(pref.id, 'pf_1', '旧 id 必须保留，否则重复迁移会重复写');

  const event = byKind('event')[0];
  assert.equal(event.tier, 'M');
  assert.match(event.text, /面试前的紧张/, '标题不能丢，检索要靠它');
  assert.equal(event.pinned, false);

  assert.equal(byKind('thread')[0].open, true);
  assert.equal(byKind('relation')[0].meta.b, 'wxid_b');
  assert.ok(byKind('digest')[0].ts > 0);
});

test('convert：删掉的旧条目翻成 state=deleted，不会重新变活', () => {
  const chat = {
    chatId: 'wechat:g:222',
    people: new Map([['wxid_a', {
      uid: 'wxid_a',
      preferences: [{ id: 'pf_1', text: '旧的错事', deleted: true, confidence: 0.5 }],
      traits: [], threads: [], events: [],
    }]]),
    meta: { relations: [] },
    summary: { segments: [] },
  };
  const list = convert.fromChat(chat);
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'deleted');
  assert.equal(record.visibleTo(list[0], { chatHash: chatHash('wechat:g:222'), isGroup: true }), false);
});

test('convert：两次转换 id 一致（迁移幂等）', () => {
  const chat = {
    chatId: 'wechat:g:333',
    people: new Map([['wxid_a', {
      uid: 'wxid_a',
      preferences: [{ id: 'pf_9', text: '喜欢猫', confidence: 0.9 }],
      traits: [], threads: [], events: [],
    }]]),
    meta: { relations: [] },
    summary: { segments: [] },
  };
  const a = convert.fromChat(chat).map((r) => r.id);
  const b = convert.fromChat(chat).map((r) => r.id);
  assert.deepEqual(a, b);
});

test('convert：不同 chat 的记录 scope 不同（物理隔离的基础）', () => {
  const make = (chatId) => ({
    chatId,
    people: new Map([['wxid_a', { uid: 'wxid_a', preferences: [{ id: 'pf_1', text: '同一条话' }], traits: [], threads: [], events: [] }]]),
    meta: { relations: [] },
    summary: { segments: [] },
  });
  const a = convert.fromChat(make('wechat:p:a'))[0];
  const b = convert.fromChat(make('wechat:p:b'))[0];
  assert.notEqual(a.scope, b.scope);
  assert.equal(record.visibleTo(a, { chatHash: chatHash('wechat:p:b'), isGroup: false, uid: 'wxid_a' }), false);
});

test('convert：长期记录都带 subject，中期记录不带（写 subjects 时靠它分流）', () => {
  const chat = {
    chatId: 'wechat:g:444',
    people: new Map([['wxid_a', {
      uid: 'wxid_a',
      preferences: [{ id: 'pf_1', text: '事实' }],
      traits: [], threads: [],
      events: [{ id: 'evt_1', date: '2026-10-28', title: '事件', summary: '正文', source: {} }],
    }]]),
    meta: { relations: [] },
    summary: { segments: [{ text: '摘要', at: 1 }] },
  };
  const all = convert.fromChat(chat);
  assert.ok(all.filter((r) => r.tier === 'L').every((r) => Boolean(r.subject)));
  assert.ok(all.filter((r) => r.tier === 'M').every((r) => r.kind === 'event' || r.kind === 'digest'));
});

