'use strict';

/**
 * 提示词「块 + 位置」的回归测试。
 *
 * 背景：DeepSeek 的前缀缓存要求完整匹配一个缓存前缀单元，system 在最前面，
 * 改一个字符后面全部重算。以前 system 里塞了时间、心情、说话人、@名单、字数、梗、
 * 联网资料、动作账本，群里换个人说话 system 就变一次，私聊每分钟也变一次。
 *
 * 这里锁三件事：
 *   1. 同一天内 system 字节稳定（私聊/群聊、换个人说话都不变）；
 *   2. 日期只在 system 里出现一次，每天跟着 now 变；
 *   3. 每轮会变的东西在尾部，时间戳由 ts 确定性推导。
 * 并确保动态状态只进入尾部，不回滚当前设置和人格语义。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const persona = require('../src/persona');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { buildTurns } = require('../src/core/context');
const { assemblePrompt } = require('./support/prompt');

const NOW = new Date(2026, 10, 3, 15, 48, 7); // 2026-11-03 周二（本地时间）

function config(patch = {}) {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  base.persona.newBehavior = false;
  base.root = path.join(os.tmpdir(), 'whale-prompt-layout');
  base.paths = { ...base.paths, root: base.root, dataDir: path.join(base.root, 'data') };
  const cfg = { ...base, ...patch };
  cfg.persona = { ...base.persona, ...(patch.persona || {}) };
  cfg.chat = { ...base.chat, ...(patch.chat || {}) };
  cfg.features = { ...base.features, ...(patch.features || {}) };
  return cfg;
}

const privateMsg = (extra = {}) => ({
  platform: 'wechat', chatType: 'private', senderName: '小海', text: '在吗', ...extra,
});
const groupMsg = (extra = {}) => ({
  platform: 'wechat', chatType: 'group', senderName: '阿螈', chatTitle: '深海鱼塘', text: '在吗', ...extra,
});

test('同一天内 system 字节稳定：私聊换个人说话、隔一分钟都不变', () => {
  const cfg = config();
  const a = persona.buildSystem({ config: cfg, msg: privateMsg({ senderName: '小海', text: '在吗' }), now: new Date(2026, 10, 3, 10, 0, 0) });
  const b = persona.buildSystem({ config: cfg, msg: privateMsg({ senderName: '阿螈', text: '今天好累啊' }), now: new Date(2026, 10, 3, 10, 1, 0) });
  assert.equal(a, b, '私聊里换个说话人/过一分钟，system 必须一字节都不差');

  const c = persona.buildSystem({ config: cfg, msg: groupMsg({ senderName: '阿螈', text: '在吗' }), now: new Date(2026, 10, 3, 10, 0, 0) });
  const d = persona.buildSystem({ config: cfg, msg: groupMsg({ senderName: '小海', text: '谁在' }), now: new Date(2026, 10, 3, 10, 1, 0) });
  assert.equal(c, d, '群里换个人说话，system 必须一字节都不差');
});

test('system 里只有静态块：说话人/字数/@/联网/链接/动作账本在尾部，不注入心情', () => {
  const cfg = config();
  const msg = groupMsg({
    senderName: '阿螈', text: '@鲸鲸 北京天气怎么样',
    groupParticipants: ['阿螈', '小海'], mentionedNames: ['小海'], addressedToBot: true,
    replyToName: '小海', groupStyleText: '这个群平均每句约 12 个字。',
    webText: '【北京 实时天气】现在 10.7°C', linkText: '链接正文：猫猫跳舞',
    discussion: true,
  });
  const events = [{ ts: NOW.getTime(), type: 'sticker', detail: '开心/wave.gif', status: 'confirmed' }];
  const parts = assemblePrompt({ config: cfg, msg, events, now: NOW });

  for (const leaking of ['语气底子', '本条说话者', '最多约', '当前上下文参与者', '刚联网搜到的资料',
    '对方发的链接', '第二条人格', '最近做过的事', '群平均每句', '学这个群说话']) {
    assert.ok(!parts.system.includes(leaking), `system 里不该出现「${leaking}」：那是每轮会变的内容`);
  }
  for (const expected of ['最多约', '当前上下文参与者', '刚联网搜到的资料', '对方发的链接',
    '最近做过的事', '学这个群说话']) {
    assert.ok(parts.tail.includes(expected), `尾部应该带上「${expected}」`);
  }
  assert.ok(!parts.system.includes('阿螈'), 'system 里不该出现这条消息的说话人');
  assert.match(parts.prompt, /阿螈/, '拼装后的提示词里当然要有说话人');
});

test('日期行只在 system 里出现一次，跟着 now 走（不写死年份）', () => {
  const cfg = config();
  const sys1 = persona.buildSystem({ config: cfg, msg: privateMsg(), now: new Date(2026, 10, 3, 23, 59, 0) });
  const sys2 = persona.buildSystem({ config: cfg, msg: privateMsg(), now: new Date(2026, 10, 4, 0, 1, 0) });
  const sys3 = persona.buildSystem({ config: cfg, msg: privateMsg(), now: new Date(2031, 4, 6, 12, 0, 0) });

  assert.match(sys1, /今天是 2026年11月3日 周二/);
  assert.match(sys2, /今天是 2026年11月4日 周三/, '跨天时日期行要跟着变（缓存每天失效一次可以接受）');
  assert.notEqual(sys1, sys2);
  assert.match(sys3, /今天是 2031年5月6日 周[日一二三四五六]/);
  assert.doesNotMatch(sys3, /2026年11月/, '提示词里不许写死日期');

  // 整个 system 只有这一行日期，别的时间信息一个都不许出现
  assert.equal(sys1.split('今天是 ').length - 1, 1);
  assert.equal(sys2.split('今天是 ').length - 1, 1);
  // 「几点」交给消息时间戳，system 里不再给时刻
  assert.doesNotMatch(sys1, /15:48|23:59/, 'system 里不该出现具体时刻');
  // 静态规则要告诉模型时间怎么看
  assert.match(sys1, /时间怎么看/);
  assert.match(sys1, /按下面那行「今天是…」回答/);
});

test('历史与当前消息不注入时间戳，跨天也只保留消息顺序', () => {
  const at = (day, h, m) => new Date(2026, 10, day, h, m, 0).getTime();
  const history = [
    { role: 'user', name: '阿甲', uid: 'a', text: '九点那条', ts: at(3, 9, 0) },
    { role: 'user', name: '阿乙', uid: 'b', text: '一分钟后', ts: at(3, 9, 1) },
    { role: 'user', name: '阿甲', uid: 'a', text: '六分钟后', ts: at(3, 9, 6) },
    { role: 'user', name: '阿乙', uid: 'b', text: '跨天那条', ts: at(4, 0, 10) },
  ];
  const turns = buildTurns({ chatType: 'private', senderName: '小海', text: '现在这条', ts: at(3, 9, 10) }, history, '', '');
  const text = turns.map((t) => t.content).join('\n');

  assert.doesNotMatch(text, /\[\d{2}-\d{2} \d{2}:\d{2}\]/);
  for (const item of history) assert.ok(text.includes(item.text));
  assert.ok(text.endsWith('现在这条'));
});

test('同一条消息当「当前」和当「历史」，时间戳字符串完全一致', () => {
  const ts = new Date(2026, 10, 3, 15, 48, 0).getTime();
  const asCurrent = assemblePrompt({ config: config(), msg: { chatType: 'private', senderName: '小海', text: '同一句话', ts }, now: NOW }).prompt;
  const asHistory = assemblePrompt({
    config: config(),
    msg: { chatType: 'private', senderName: '小海', text: '后来的话', ts: ts + 60000 },
    history: [{ role: 'user', text: '同一句话', ts }],
  }).prompt;

  const stamps = (s) => (s.match(/\[\d{2}-\d{2} \d{2}:\d{2}\]/g) || []);
  assert.deepEqual(stamps(asCurrent), []);
  assert.deepEqual(stamps(asHistory), []);
});

test('当前消息顺序固定：正文 → 记忆块 → 本轮状态', () => {
  const ts = new Date(2026, 10, 3, 15, 48, 0).getTime();
  const parts = assemblePrompt({
    config: config(),
    msg: { chatType: 'private', senderName: '小海', text: '正文在这里', ts },
    profile: { count: 3 },
    notes: ['怕黑'],
    now: NOW,
  }, { memoryBlock: '【记忆块】她记得的旧事' });

  const last = parts.turns[parts.turns.length - 1].content;
  const body = last.indexOf('正文在这里');
  const memory = last.indexOf('【记忆块】');
  const state = last.indexOf('【本轮状态】');
  assert.ok(body >= 0, '正文要在最后一条 user 消息里');
  assert.ok(memory > body, '记忆块要挂在正文后面');
  assert.ok(state > memory, '本轮状态要挂在记忆块后面');
  assert.equal(parts.tail.startsWith('【本轮状态】'), true);
});

test('提示词始终将本轮状态放在尾部 user 消息', () => {
  const parts = persona.buildPromptParts({ config: config(), msg: privateMsg({ text: '在吗' }), now: NOW });
  assert.ok(parts.tail.startsWith('【本轮状态】'));
  assert.doesNotMatch(parts.system, /【本轮状态】/);
});
