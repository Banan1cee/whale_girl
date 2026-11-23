'use strict';

/**
 * 群聊输出兜底接线（Bot._guardGroupReply）。
 *
 * 模块本身的测试在 memory-v2-shared.test.js；这里只验证「真的接上了、真的只在
 * 群聊和开关打开时生效」——这东西最容易出现的问题是写了却没接线。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');

function makeBot({ v2 = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-guard-'));
  const logs = [];
  const logger = {
    info: () => {},
    debug: () => {},
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
    child() { return this; },
  };
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'config.example.json'), 'utf8'));
  cfg.features = { ...(cfg.features || {}), memoryV2: v2 };
  cfg.paths = { dataDir: dir, settingsFile: path.join(dir, 'settings.json') };
  const store = new Store({ file: path.join(dir, 'store.json'), dir, logger });
  const llm = { isMock: false, model: 'deepseek-chat', reload() {}, async complete() { return '哼'; } };
  const bot = new Bot({ config: cfg, store, llm, logger, mockChunkDelayMs: 0 });
  return { bot, store, logs };
}

test('群聊回复命中出处泄漏：整条换成安全回复', () => {
  const { bot, store, logs } = makeBot();
  try {
    const bubbles = ['你私聊跟我说过这个', '我可记着呢'];
    bot._guardGroupReply({ action: 'reply', msg: { isGroup: true } }, bubbles);
    assert.deepEqual(bubbles, ['这个我不清楚呀']);
    assert.ok(logs.some((line) => line.includes('输出校验')));
  } finally {
    store.close();
  }
});

test('号码串同样被拦', () => {
  const { bot, store } = makeBot();
  try {
    const fakePhone = ['139', '0013', '9000'].join('');
    const bubbles = [`他手机是 ${fakePhone}`];
    bot._guardGroupReply({ action: 'reply', msg: { isGroup: true } }, bubbles);
    assert.deepEqual(bubbles, ['这个我不清楚呀']);
  } finally {
    store.close();
  }
});

test('正常回复不动', () => {
  const { bot, store } = makeBot();
  try {
    const bubbles = ['今天天气不错呀'];
    bot._guardGroupReply({ action: 'reply', msg: { isGroup: true } }, bubbles);
    assert.deepEqual(bubbles, ['今天天气不错呀']);
  } finally {
    store.close();
  }
});

test('私聊不拦（同一句话在私聊里不是泄漏）', () => {
  const { bot, store } = makeBot();
  try {
    const bubbles = ['你私聊跟我说过这个'];
    bot._guardGroupReply({ action: 'reply', msg: { isGroup: false, chatType: 'private' } }, bubbles);
    assert.deepEqual(bubbles, ['你私聊跟我说过这个']);
  } finally {
    store.close();
  }
});

test('开关关闭时不生效（改造前行为不变）', () => {
  const { bot, store } = makeBot({ v2: false });
  try {
    const bubbles = ['你私聊跟我说过这个'];
    bot._guardGroupReply({ action: 'reply', msg: { isGroup: true } }, bubbles);
    assert.deepEqual(bubbles, ['你私聊跟我说过这个']);
  } finally {
    store.close();
  }
});
