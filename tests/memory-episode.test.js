'use strict';

/**
 * Episode：空闲 30 分钟 / 话题切换 / 6,000 token / 3 小时关闭；L2 幂等；启动补写。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const episode = require('../src/memory/episode');
const personCard = require('../src/memory/personCard');
const { LIMITS } = require('../src/memory/constants');
const { Store } = require('../src/memory/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ep-'));
  const file = path.join(dir, 'data', 'store.json');
  const store = new Store({ file, logger: null });
  return { store, file, dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
}

const fakeLlm = {
  isMock: false,
  async complete() {
    return JSON.stringify({
      summary: '小海在聊加班，说最近很累，周末想休息；还没决定要不要跟老板提。',
      facts: [{ uid: 'u1', text: '最近在加班', confidence: 0.8 }],
      traits: [{ uid: 'u1', text: '压力大时不想被说教', confidence: 0.7, evidence: ['msg_1', 'msg_2'] }],
      events: [{ uid: 'u1', title: '加班很累', summary: '小海说最近天天加班，周末只想躺着，还没想好怎么跟老板说。', keywords: ['加班', '累'], importance: 0.6, confidence: 0.8 }],
      threads: [{ uid: 'u1', text: '还没决定要不要跟老板提休息' }],
    });
  },
};

test('空闲 30 分钟：关闭旧 episode，写一条 L2 + thread', async () => {
  const { store, dir } = tempStore();
  const key = 'wechat:u:a';
  const t0 = Date.now() - 40 * 60000;
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '今天加班好累', ts: t0 });
  store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '那早点休息', ts: t0 + 1000 });
  // 40 分钟后来的新消息 → 上一段空闲关闭
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '我回来了', ts: Date.now() });
  await store.drain();
  store.llm = fakeLlm;
  await store.closeEpisode(key, { llm: fakeLlm, now: Date.now() });
  await store.drain();

  const chat = store.chatStore.chats.get(key);
  assert.ok(chat.meta.closedEpisodes.length >= 1, '应至少关闭一个 episode');
  const card = store.chatStore.getCard(chat, 'u1');
  assert.ok(personCard.activeEvents(card).length >= 1, 'L2 事件要写进当前说话人的卡');
  store.close();
  cleanup(dir);
});

test('连续关闭 episode，摘要段要累积而不是只剩最后一段', async () => {
  const { store, dir } = tempStore();
  const key = 'wechat:u:a';
  try {
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '第一段', ts: Date.now() - 60000 });
    store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '收到', ts: Date.now() - 59000 });
    await store.closeEpisode(key, { llm: fakeLlm, now: Date.now() });
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '第二段', ts: Date.now() });
    store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '好', ts: Date.now() + 1 });
    await store.closeEpisode(key, { llm: fakeLlm, now: Date.now() });
    const chat = store.chatStore.chats.get(key);
    assert.ok((chat.summary.segments || []).length >= 2, '旧 episode 的摘要段不能每轮被清空');
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('L2 幂等：同一个 episode 关两次，事件只写一条', async () => {
  const { store, dir } = tempStore();
  const key = 'wechat:u:a';
  const now = Date.now();
  for (let i = 0; i < 4; i += 1) {
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '加班第' + i + '天，好累', ts: now + i });
  }
  const first = await store.closeEpisode(key, { llm: fakeLlm, now: now + 10, reason: 'manual' });
  assert.equal(first.closed, true);
  const card = store.chatStore.getCard(store.chatStore.chats.get(key), 'u1');
  const eventCount = personCard.activeEvents(card).length;
  assert.equal(eventCount, 1, '一段时间只写一条事件');

  const second = await store.closeEpisode(key, { llm: fakeLlm, now: now + 20, reason: 'manual' });
  assert.equal(second.closed, false);
  assert.equal(second.reason, 'already_closed');
  assert.equal(personCard.activeEvents(card).length, eventCount, '不能重复写');
  store.close();
  cleanup(dir);
});

test('跨午夜关闭 episode 时事件日期沿用最后一条消息的日期', async () => {
  const { store, dir } = tempStore();
  try {
    const key = 'wechat:u:midnight';
    const lastMessageAt = new Date(2026, 10, 16, 23, 55).getTime();
    const closedAt = new Date(2026, 10, 17, 0, 30).getTime();
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '今天加班很累', ts: lastMessageAt - 5 * 60000 });
    store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '辛苦了，早点休息', ts: lastMessageAt });

    const result = await store.closeEpisode(key, { llm: fakeLlm, now: closedAt });
    assert.equal(result.closed, true);
    const chat = store.chatStore.chats.get(key);
    const card = store.chatStore.getCard(chat, 'u1');
    assert.equal(personCard.activeEvents(card)[0].date, episode.dateString(lastMessageAt));
    assert.notEqual(personCard.activeEvents(card)[0].date, episode.dateString(closedAt));
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('片段消息时间无效时事件日期回退到 lastMessageAt', async () => {
  const { store, dir } = tempStore();
  try {
    const key = 'wechat:u:missing-ts';
    const lastMessageAt = new Date(2026, 10, 16, 23, 55).getTime();
    const closedAt = new Date(2026, 10, 17, 0, 30).getTime();
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '今天加班很累', ts: lastMessageAt });
    const chat = store.chatStore.chats.get(key);
    chat.messages[0].ts = Number.NaN;

    await store.closeEpisode(key, { llm: fakeLlm, now: closedAt });
    const card = store.chatStore.getCard(chat, 'u1');
    assert.equal(personCard.activeEvents(card)[0].date, episode.dateString(lastMessageAt));
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('话题切换：聊了 6 条后明确换话题 → 关闭', async () => {
  const { store, dir } = tempStore();
  const key = 'wechat:g:g1';
  const now = Date.now();
  for (let i = 0; i < 7; i += 1) {
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '加班第' + i + '天真的顶不住', ts: now + i });
  }
  store.chatStore.chats.get(key).meta.episode.userMessages = 7;
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '换个话题，说说周末去哪玩', ts: now + 10 });
  await store.drain();
  const chat = store.chatStore.chats.get(key);
  assert.ok(chat.meta.closedEpisodes.length >= 1);
  store.close();
  cleanup(dir);
});

test('累计 6,000 token / 持续 3 小时都会强制关闭', () => {
  const { store, dir } = tempStore();
  const key = 'wechat:u:t';
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '第一句', ts: Date.now() });
  const chat = store.chatStore.chats.get(key);
  chat.meta.episode.tokens = LIMITS.episodeMaxTokens;
  assert.equal(episode.shouldClose(chat, { text: '下一句', now: Date.now() }), 'tokens');

  chat.meta.episode.tokens = 0;
  chat.meta.episode.startedAt = Date.now() - LIMITS.episodeMaxHours * 3600000 - 1;
  assert.equal(episode.shouldClose(chat, { text: '下一句', now: Date.now() }), 'max_hours');

  chat.meta.episode.startedAt = Date.now();
  assert.equal(episode.shouldClose(chat, { text: '正常接着聊', now: Date.now() }), null);
  store.close();
  cleanup(dir);
});

test('parseEpisode：越界 uid / 缺字段都能兜住', () => {
  const extractor = require('../src/memory/extractor');
  const parsed = extractor.parseEpisode(JSON.stringify({
    summary: '在聊加班',
    facts: [{ uid: 'u1', text: '在加班', confidence: 2 }, { text: '' }],
    traits: [{ uid: 'u1', text: '嘴硬心软', confidence: 0.7, evidence: ['m1'] }],
    events: [{ uid: 'u2', title: '加班', summary: '很累', keywords: ['加班'], importance: 9 }],
    threads: [{ uid: 'u1', text: '要不要辞职' }],
  }));
  assert.equal(parsed.facts[0].confidence, 1);
  assert.equal(parsed.events[0].importance, 1);
  assert.equal(parsed.threads[0].text, '要不要辞职');
  assert.equal(extractor.parseEpisode('没有 JSON'), null);
});

test('parseEpisode：结构化事实保留主体、操作、证据与被替换 ID', () => {
  const extractor = require('../src/memory/extractor');
  const parsed = extractor.parseEpisode(JSON.stringify({
    summary: '口味变化',
    facts: [{
      uid: 'u1', subject: 'self', key: 'drink', operation: 'replace',
      text: '现在不喜欢无糖乌龙茶', confidence: 0.95,
      evidence: ['m2'], supersedesIds: ['pf_old'],
    }],
  }));
  assert.deepEqual(parsed.facts[0], {
    uid: 'u1', subject: 'self', key: 'drink', operation: 'replace',
    text: '现在不喜欢无糖乌龙茶', confidence: 0.95,
    evidence: ['m2'], supersedesIds: ['pf_old'], kind: 'fact',
  });
});

test('episode 抽取把当前人物卡事实作为可引用的更新上下文传给模型', async () => {
  const extractor = require('../src/memory/extractor');
  let request;
  const llm = {
    isMock: false,
    async complete(value) {
      request = value;
      return JSON.stringify({ summary: '口味更新', facts: [] });
    },
  };
  await extractor.extractEpisode({
    messages: [{ id: 'm2', role: 'user', uid: 'u1', name: '小海', text: '现在不喜欢无糖乌龙茶了' }],
    speakers: [{ uid: 'u1', name: '小海' }],
    existingFacts: { u1: [{ id: 'pf_old', subject: 'self', key: 'drink', text: '我喜欢无糖乌龙茶' }] },
    llm,
  });
  assert.match(request.turns[0].content, /pf_old/);
  assert.match(request.turns[0].content, /我喜欢无糖乌龙茶/);
});

test('episode 抽取拒绝把一次性行为升级为长期偏好', async () => {
  const extractor = require('../src/memory/extractor');
  const llm = {
    isMock: false,
    async complete() {
      return JSON.stringify({ summary: '喝饮料', facts: [{
        uid: 'u1', subject: 'self', key: 'preference:drink', operation: 'set',
        text: '今天喝的是无糖乌龙茶', confidence: 0.9, evidence: ['m1'],
      }] });
    },
  };
  const out = await extractor.extractEpisode({
    messages: [{ id: 'm1', role: 'user', uid: 'u1', name: '小海', text: '我今天喝了无糖乌龙茶' }],
    speakers: [{ uid: 'u1', name: '小海' }], llm,
  });
  assert.deepEqual(out.facts, []);
});

test('episode 抽取不能用本人事实 ID 撤回第三方事实', async () => {
  const extractor = require('../src/memory/extractor');
  const llm = {
    isMock: false,
    async complete() {
      return JSON.stringify({ summary: '口味变化', facts: [{
        uid: 'u1', subject: 'self', key: 'preference:food', operation: 'retract',
        text: '不喜欢米饼', confidence: 0.95, evidence: ['m1'], supersedesIds: ['pf_partner'],
      }] });
    },
  };
  const out = await extractor.extractEpisode({
    messages: [{ id: 'm1', role: 'user', uid: 'u1', text: '我不喜欢米饼' }],
    speakers: [{ uid: 'u1', name: '小海' }],
    existingFacts: { u1: [{ id: 'pf_partner', subject: 'partner', key: 'preference:food', text: '对象喜欢米饼' }] },
    llm,
  });
  assert.deepEqual(out.facts, []);
});

test('episode 落卡：模型替换会关闭旧偏好，并保留当前否定状态', async () => {
  const { store, dir } = tempStore();
  try {
    const key = 'wechat:u:model-update';
    const t0 = Date.now() - 60000;
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '最近喝茶比较多', ts: t0 });
    const chat = store.chatStore.chats.get(key);
    const card = store.chatStore.ensurePerson(chat, 'u1', '小海');
    const old = personCard.addPreference(card, {
      text: '我喜欢喝无糖乌龙茶', key: 'preference:drink', subject: 'self', kind: 'preference', confidence: 0.9,
    }, { chatId: chat.chatId, now: t0 + 1 });
    store.chatStore.saveCard(chat, card);
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '我之前喝无糖乌龙茶，发现现在不喜欢了', ts: t0 + 1000 });
    const updateMessage = chat.messages[chat.messages.length - 1];
    const llm = {
      isMock: false,
      async complete() {
        return JSON.stringify({ summary: '口味变化', facts: [{
          uid: 'u1', subject: 'self', key: 'preference:drink', operation: 'retract',
          text: '现在不喜欢喝无糖乌龙茶', confidence: 0.95,
          evidence: [updateMessage.id], supersedesIds: [old.id], kind: 'taboo',
        }] });
      },
    };
    await store.closeEpisode(key, { llm, now: t0 + 2000 });
    const active = personCard.activePreferences(store.chatStore.getCard(chat, 'u1'));
    assert.equal(active.length, 1);
    assert.equal(active[0].text, '现在不喜欢喝无糖乌龙茶');
    assert.equal(active[0].kind, 'taboo');
    // 4.3 的当前事实以 records 为准，名册不再承载偏好正文。
    assert.equal(active.some((item) => item.id === old.id), false);
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('episode 落卡：第三方偏好保留 subject，不冒充用户本人', async () => {
  const { store, dir } = tempStore();
  try {
    const key = 'wechat:u:partner-fact';
    const t0 = Date.now() - 60000;
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '我对象喜欢吃米饼', ts: t0 });
    const chat = store.chatStore.chats.get(key);
    const message = chat.messages[chat.messages.length - 1];
    const llm = {
      isMock: false,
      async complete() {
        return JSON.stringify({ summary: '对象的口味', facts: [{
          uid: 'u1', subject: 'partner', key: 'preference:food', operation: 'set',
          text: '对象喜欢吃米饼', confidence: 0.9, evidence: [message.id],
        }] });
      },
    };
    await store.closeEpisode(key, { llm, now: t0 + 1000 });
    const active = personCard.activePreferences(store.chatStore.getCard(chat, 'u1'));
    assert.equal(active.length, 1);
    assert.equal(active[0].subject, 'partner');
    assert.equal(active[0].key, 'preference:food');
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('episode 落卡：同一段内没有旧 ID 时仍只保留最终 replace 状态', async () => {
  const { store, dir } = tempStore();
  try {
    const key = 'wechat:u:partner-replace-same-episode';
    const t0 = Date.now() - 60000;
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '我对象之前喜欢吃米饼', ts: t0 });
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '我对象现在不喜欢吃米饼了', ts: t0 + 1000 });
    const chat = store.chatStore.chats.get(key);
    const updateMessage = chat.messages[chat.messages.length - 1];
    const llm = {
      isMock: false,
      async complete() {
        return JSON.stringify({ summary: '对象口味变化', facts: [{
          uid: 'u1', subject: 'partner', key: 'preference:food', operation: 'replace',
          text: '对象现在不喜欢吃米饼', confidence: 0.9,
          evidence: [updateMessage.id], supersedesIds: [], kind: 'preference',
        }] });
      },
    };
    await store.closeEpisode(key, { llm, now: t0 + 2000 });
    const active = personCard.activePreferences(store.chatStore.getCard(chat, 'u1'));
    assert.equal(active.length, 1);
    assert.equal(active[0].subject, 'partner');
    assert.equal(active[0].text, '对象现在不喜欢吃米饼');
  } finally {
    store.close();
    cleanup(dir);
  }
});

test('启动恢复：关闭 30 分钟以上，重启后补写上一条 episode 的 L2', async () => {
  const { store, file, dir } = tempStore();
  const key = 'wechat:u:a';
  const old = Date.now() - 2 * 3600 * 1000;
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '两小时前聊了换工作', ts: old });
  store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '慢慢想', ts: old + 1000 });
  store.close();

  const store2 = new Store({ file, logger: null });
  store2.llm = fakeLlm;
  const result = await store2.startupRecovery({ llm: fakeLlm });
  assert.ok(result.episodesClosed >= 1, '应补写上一条 episode');
  const chat = store2.chatStore.chats.get(key);
  assert.ok(chat.meta.closedEpisodes.length >= 1);
  store2.close();
  cleanup(dir);
});
