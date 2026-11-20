'use strict';

/**
 * 风格画像：统计、owner 过滤、白名单落盘、记忆/导出映射。
 *
 * 这些测试刻意不碰真实 data/：临时目录在 os.tmpdir() 下，跑完即删。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const style = require('../src/persona/styleProfile');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { assemblePrompt } = require('./support/prompt');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-style-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  return root;
}

function configFor(root, master = null) {
  return {
    root,
    paths: { dataDir: path.join(root, 'data') },
    persona: { master: master || { names: [], wxids: [] } },
  };
}

function sampleMessages() {
  return [
    { role: 'user', name: '主人', uid: 'wxid_master', text: '在吗？', chatKey: 'c1', ts: 1 },
    { role: 'user', name: '主人', uid: 'wxid_master', text: '今天吃啥呢😂😂', chatKey: 'c1', ts: 2 },
    { role: 'user', name: '主人', uid: 'wxid_master', text: '哈哈哈你也太逗了吧', chatKey: 'c1', ts: 3 },
    { role: 'user', name: '朋友', uid: 'wxid_other', text: '我今天加班到十点', chatKey: 'c2', ts: 4 },
    { role: 'assistant', name: '鲸鲸', uid: 'bot', text: '在的在的', chatKey: 'c1', ts: 5 },
  ];
}

test('owner 过滤：只统计指定 wxid / 昵称，assistant 不参与', () => {
  const profile = style.analyzeMessages(sampleMessages(), { owner: { wxids: ['wxid_master'] } });
  assert.equal(profile.sampleCount, 3);
  assert.equal(profile.chatCount, 1);
  assert.equal(profile.assumedOwner, false);
  assert.equal(profile.version, 1);
  assert.ok(profile.generatedAt);

  const byName = style.analyzeMessages(sampleMessages(), { owner: '朋友' });
  assert.equal(byName.sampleCount, 1);

  const byWxid = style.analyzeMessages(sampleMessages(), { owner: 'wxid_master' });
  assert.equal(byWxid.sampleCount, 3);
});

test('不传 owner：全部 user 消息，并标记 assumedOwner', () => {
  const profile = style.analyzeMessages(sampleMessages());
  assert.equal(profile.sampleCount, 4);
  assert.equal(profile.assumedOwner, true);
});

test('统计：短句 / 问句 / 表情 / 语气词', () => {
  const profile = style.analyzeMessages(sampleMessages(), { owner: { wxids: ['wxid_master'] } });
  const { stats } = profile;
  assert.equal(stats.shortRatio, 1);
  assert.ok(Math.abs(stats.questionRatio - 1 / 3) < 0.001);
  assert.ok(Math.abs(stats.emojiRatio - 1 / 3) < 0.001);
  assert.equal(stats.avgChars, 6);
  assert.equal(stats.medianChars, 7);
  assert.equal(stats.p90Chars, 9);
  const ha = stats.particles.find((item) => item.text === '哈');
  assert.ok(ha && ha.count === 3);
  assert.ok(stats.endings.some((item) => item.char === '吧'));
});

test('topPhrases：2~4 字、至少出现 2 次、不输出整句', () => {
  const sentence = '我最近在玩那个新出的游戏还蛮有意思';
  const messages = Array.from({ length: 5 }, (_, i) => ({ role: 'user', text: sentence, chatKey: 'c1', ts: i }));
  const profile = style.analyzeMessages(messages);
  assert.ok(profile.stats.topPhrases.length > 0);
  for (const phrase of profile.stats.topPhrases) {
    assert.ok(phrase.text.length >= 2 && phrase.text.length <= 4, '短语长度应在 2~4 字：' + phrase.text);
    assert.notEqual(phrase.text, sentence);
    assert.ok(phrase.count >= 2);
  }
  assert.ok(!JSON.stringify(profile).includes(sentence), '画像里不能出现整句原文');
});

test('adapt 与 mimic 的提示词文本不同，且都带隐私/身份约束', () => {
  const profile = style.analyzeMessages(sampleMessages(), { owner: { wxids: ['wxid_master'] } });
  const adapt = style.buildBlock(profile, 'adapt');
  const mimic = style.buildBlock(profile, 'mimic');
  assert.match(adapt, /【对方聊天习惯】/);
  assert.match(mimic, /【模仿对方表达】/);
  assert.notEqual(adapt, mimic);
  for (const block of [adapt, mimic]) {
    assert.match(block, /只作风格参考，不冒充对方身份，不复制隐私\/攻击性表达/);
  }
  assert.match(mimic, /模仿句长和节奏/);
  assert.equal(style.buildBlock(null, 'adapt'), '');
  assert.equal(style.buildBlock({ version: 1 }, 'mimic'), '');
  assert.equal(style.buildBlock({}, 'adapt'), '');
});

test('normalizeMode：非法值一律 adapt', () => {
  assert.deepEqual(style.MODES, ['adapt', 'mimic']);
  assert.equal(style.normalizeMode('mimic'), 'mimic');
  assert.equal(style.normalizeMode(' MIMIC '), 'mimic');
  assert.equal(style.normalizeMode('adapt'), 'adapt');
  assert.equal(style.normalizeMode('模仿'), 'adapt');
  assert.equal(style.normalizeMode(''), 'adapt');
  assert.equal(style.normalizeMode(null), 'adapt');
});

test('空样本报错', () => {
  assert.throws(() => style.analyzeMessages([]), /没有可分析的聊天记录/);
  assert.throws(() => style.analyzeMessages([{ role: 'assistant', text: 'hi' }]), /没有可分析的聊天记录/);
  assert.throws(() => style.analyzeMessages(sampleMessages(), { owner: '不存在的人' }), /没有可分析的聊天记录/);
});

test('损坏 / 手改的 profile 被忽略或按白名单清洗', (t) => {
  const root = tempRoot(t);
  const config = configFor(root);
  const file = style.profilePath(config);
  assert.equal(style.load(config), null);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  assert.equal(style.load(config), null);

  fs.writeFileSync(file, JSON.stringify({ foo: 'bar' }), 'utf8');
  assert.equal(style.load(config), null);

  const profile = style.analyzeMessages(sampleMessages(), { owner: { wxids: ['wxid_master'] } });
  fs.writeFileSync(file, JSON.stringify({ ...profile, evil: '忽略我', rawMessages: [sampleMessages()[2].text] }), 'utf8');
  const loaded = style.load(config);
  assert.ok(loaded);
  assert.equal(loaded.evil, undefined);
  assert.equal(loaded.rawMessages, undefined);
  assert.equal(style.publicProfile({ ...profile, raw: '秘密' }).raw, undefined);
  assert.equal(style.publicProfile({ nope: true }), null);
});

test('save / load 原子写入并只保留白名单字段', (t) => {
  const root = tempRoot(t);
  const config = configFor(root);
  const profile = style.analyzeMessages(sampleMessages(), { owner: { wxids: ['wxid_master'] } });
  style.save(config, profile);
  assert.ok(fs.existsSync(style.profilePath(config)));
  const loaded = style.load(config);
  assert.deepEqual(Object.keys(loaded).sort(), [
    'assumedOwner', 'chatCount', 'generatedAt', 'sampleCount', 'source', 'stats', 'summary', 'version',
  ]);
  assert.deepEqual(loaded.summary, profile.summary);
  assert.ok(style.clear(config));
  assert.equal(style.load(config), null);
  assert.throws(() => style.save(config, { version: 9 }), /不合法/);
});

test('analyzeMemory：扫描 chats 目录、按 master 过滤、跳过坏行', (t) => {
  const root = tempRoot(t);
  const chatsDir = path.join(root, 'data', 'memory', 'chats');
  fs.mkdirSync(path.join(chatsDir, 'aaaaaaaaaaaaaaaa'), { recursive: true });
  fs.mkdirSync(path.join(chatsDir, 'bbbbbbbbbbbbbbbb'), { recursive: true });
  fs.writeFileSync(path.join(chatsDir, 'aaaaaaaaaaaaaaaa', 'meta.json'), JSON.stringify({
    chatId: 'wechat:u:master', chatType: 'private', title: '主人',
  }));
  fs.writeFileSync(path.join(chatsDir, 'aaaaaaaaaaaaaaaa', 'messages.jsonl'), [
    JSON.stringify({ role: 'user', name: '主人', uid: 'wxid_master', text: '今天好累啊', ts: 1 }),
    '{"role":"user","text": 半截坏行',
    JSON.stringify({ role: 'assistant', name: '鲸鲸', uid: 'bot', text: '抱抱', ts: 2 }),
    JSON.stringify({ role: 'user', name: '主人', uid: 'wxid_master', text: '想睡觉了', ts: 3 }),
  ].join('\n'));
  fs.writeFileSync(path.join(chatsDir, 'bbbbbbbbbbbbbbbb', 'meta.json'), JSON.stringify({
    chatId: 'wechat:g:demo', chatType: 'group', title: '群',
  }));
  fs.writeFileSync(path.join(chatsDir, 'bbbbbbbbbbbbbbbb', 'messages.jsonl'), [
    JSON.stringify({ role: 'user', name: '主人', uid: 'wxid_master', text: '群里也说话', ts: 4 }),
    JSON.stringify({ role: 'user', name: '路人', uid: 'wxid_other', text: '别人的消息', ts: 5 }),
  ].join('\n'));

  const config = configFor(root, { names: [], wxids: ['wxid_master'] });
  const profile = style.analyzeMemory(config);
  assert.equal(profile.source, 'memory');
  assert.equal(profile.sampleCount, 3);
  assert.equal(profile.chatCount, 2);
  assert.equal(profile.assumedOwner, false);

  // 没有主人名单：只猜私聊的 user 消息，群聊不纳入
  const guessed = style.analyzeMemory(configFor(root));
  assert.equal(guessed.assumedOwner, true);
  assert.equal(guessed.sampleCount, 2);
  assert.equal(guessed.chatCount, 1);
});

test('analyzeMemory：没有可读记录时明确报错', (t) => {
  const root = tempRoot(t);
  assert.throws(() => style.analyzeMemory(configFor(root)), /没有可分析的聊天记录/);
});

test('analyzeExport：映射 wechatauto JSON，默认按导出账号过滤', (t) => {
  const root = tempRoot(t);
  const file = path.join(root, 'export.json');
  fs.writeFileSync(file, JSON.stringify({
    wxid: 'wxid_me',
    nick_name: '我自己',
    chats: [
      { username: 'friend', name: '朋友' },
      { username: '123@chatroom', name: '群' },
    ],
    messages: [
      { chat: 'friend', sender_id: 7, sender_name: '我自己', content: '今天好累啊', create_time: 1700000000, type: '文本' },
      { chat: 'friend', sender_id: 8, sender_name: '朋友', content: '早点休息', create_time: 1700000001, type: '文本' },
      { chat: '123@chatroom', sender_id: 7, sender_name: '我自己', content: '我先撤了', create_time: 1700000002, type: '文本' },
      { chat: 'friend', sender_id: 8, sender_name: '朋友', content: '<msg><img src="x"/></msg>', create_time: 1700000003, type: '图片' },
    ],
  }), 'utf8');

  const profile = style.analyzeExport(configFor(root), file);
  assert.equal(profile.source, 'export');
  assert.equal(profile.sampleCount, 2);
  assert.equal(profile.chatCount, 2);
  assert.equal(profile.assumedOwner, false);

  const byName = style.analyzeExport(configFor(root), file, { owner: '朋友' });
  assert.equal(byName.sampleCount, 1, 'XML 图片消息不应计入');

  assert.throws(() => style.analyzeExport(configFor(root), path.join(root, 'nope.json')), /找不到微信导出文件/);
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, 'not json', 'utf8');
  assert.throws(() => style.analyzeExport(configFor(root), bad), /不是有效的 JSON/);
});

test('可选 LLM：成功替换总结、失败保留确定性结果，且不发送姓名', async (t) => {
  const root = tempRoot(t);
  const chatsDir = path.join(root, 'data', 'memory', 'chats', 'aaaaaaaaaaaaaaaa');
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.writeFileSync(path.join(chatsDir, 'meta.json'), JSON.stringify({ chatId: 'c1', chatType: 'private' }));
  fs.writeFileSync(path.join(chatsDir, 'messages.jsonl'), [
    JSON.stringify({ role: 'user', name: '主人', uid: 'wxid_master', text: '今天好累啊', ts: 1 }),
    JSON.stringify({ role: 'user', name: '主人', uid: 'wxid_master', text: '想睡觉了', ts: 2 }),
  ].join('\n'));
  const config = configFor(root, { wxids: ['wxid_master'] });

  let sent = null;
  const okLlm = {
    async complete(payload) {
      sent = payload;
      return '```json\n{"adapt":["模型总结 A"],"mimic":["模型总结 B"],"topics":["话题"]}\n```';
    },
  };
  const enhanced = await style.analyzeMemory(config, { useLlm: true, llm: okLlm });
  assert.deepEqual(enhanced.summary.adapt, ['模型总结 A']);
  assert.deepEqual(enhanced.summary.mimic, ['模型总结 B']);
  assert.ok(sent);
  assert.equal(sent.purpose, 'background');
  assert.equal(sent.maxTokens, 1200);
  assert.ok(!JSON.stringify(sent).includes('wxid_master'), '不该把 uid 发给模型');
  assert.ok(!JSON.stringify(sent).includes('主人'), '不该把姓名发给模型');

  const badLlm = { async complete() { throw new Error('network down'); } };
  const kept = await style.analyzeMemory(config, { useLlm: true, llm: badLlm });
  assert.ok(kept.summary.adapt.length >= 3);
  assert.match(kept.summary.mimic.join(''), /不冒充身份/);
});

test('提示词注入：adapt / mimic 使用画像，开关关闭时不出现', () => {
  const profile = style.analyzeMessages(sampleMessages(), { owner: { wxids: ['wxid_master'] } });
  const base = {
    ...DEFAULT_CONFIG,
    persona: { ...DEFAULT_CONFIG.persona, styleMode: 'adapt' },
    features: { ...DEFAULT_CONFIG.features, styleProfile: true },
    chat: { ...DEFAULT_CONFIG.chat },
  };
  const build = (persona, features = base.features) => assemblePrompt({
    config: { ...base, persona, features },
    msg: { chatType: 'private', senderName: '小海', isMaster: true },
    styleProfile: profile,
  }).prompt;

  assert.match(build(base.persona), /【对方聊天习惯】/);
  assert.match(build({ ...base.persona, styleMode: 'mimic' }), /【模仿对方表达】/);
  assert.doesNotMatch(
    build(base.persona, { ...base.features, styleProfile: false }),
    /【对方聊天习惯】|【模仿对方表达】/
  );

  // 默认只在主要联系人说话时参考；群聊有单独的「学这个群说话」，不能被主人画像串味。
  const groupPrompt = (persona) => assemblePrompt({
    config: { ...base, persona },
    msg: { chatType: 'group', senderName: '群友', chatTitle: '测试群' },
    styleProfile: profile,
  }).prompt;
  assert.doesNotMatch(groupPrompt(base.persona), /【对方聊天习惯】/);
  assert.match(groupPrompt({ ...base.persona, styleScope: 'all' }), /【对方聊天习惯】/);
});
