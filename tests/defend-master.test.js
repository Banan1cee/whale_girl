'use strict';
const { promptOf } = require('./support/prompt');

/**
 * 旧版「有人骂主人就自动开战、锁定靶子」已删除。
 * 这里锁住新语义：骂人不再产生对喷状态或攻击提示，仍按普通对话处理。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

function makeBot({ reply = '你算什么东西', rng = () => 0.99 } = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.newBehavior = false;
  config.persona.master = { names: ['Master'], wxids: ['wxid_boss'] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-defend-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const llm = { isMock: false, model: 'deepseek-chat', reload() {}, async complete() { return reply; } };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0, rng });
  return { bot, config, store, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } };
}

const g = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1', chatType: 'group',
  senderId: 'wxid_other', senderName: '测试群友', text, chatTitle: '示例群', ...extra,
});
const boss = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1', chatType: 'group',
  senderId: 'wxid_boss', senderName: 'Master', text, chatTitle: '示例群', atMe: false, ...extra,
});

test('「你个臭机器人还挑衅上我了」不再写入对喷状态', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(g('你个臭机器人还挑衅上我了'));
  assert.notEqual(r.msg.fight, true, '不应再进入火力模式');
  cleanup();
});

test('主人说「有人骂我」不再锁定靶子或注入攻击指令', async () => {
  const { bot, cleanup } = makeBot();
  await bot.decide(g('你个臭机器人还挑衅上我了', { msgId: 'm1' }));
  const r = await bot.decide(boss('有人骂我'));
  assert.notEqual(r.msg.fight, true, '不应再开战');
  assert.equal(r.msg.fightTarget, undefined, '不应再生成靶子');
  assert.doesNotMatch(promptOf(r), /直接冲|开炮|往死里骂/, '不应注入攻击指令');
  cleanup();
});

test('没人骂主人时不会凭空生成靶子', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(boss('有人骂我吗'));
  assert.equal(r.msg.fightTarget, undefined);
  cleanup();
});

test('普通对话里出现「机器人」不产生对喷状态', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(g('这个机器人挺好用的'));
  assert.notEqual(r.msg.fight, true);
  cleanup();
});
