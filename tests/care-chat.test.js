'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_CONFIG } = require('../src/infra/config');
const { Store } = require('../src/memory/store');
const { careForChat } = require('../src/services/careChat');

test('搭话生成从本会话历史补取旧开场，且不同会话互相隔离', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-care-chat-'));
  const store = new Store({ file: path.join(dir, 'data', 'store.json'), logger: null });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });

  const firstKey = 'wechat:u:contact-a';
  const secondKey = 'wechat:u:contact-b';
  store.appendMessage(firstKey, { role: 'assistant', msgId: 'care:old-a', text: '忙完了吗？' });
  store.appendMessage(secondKey, { role: 'assistant', msgId: 'care:old-b', text: '午饭吃了吗？' });
  for (let i = 0; i < 16; i += 1) {
    store.appendMessage(firstKey, {
      role: i % 2 ? 'assistant' : 'user',
      text: `普通聊天 ${i}`,
    });
  }
  assert.deepEqual(store.recentCareMessages(firstKey, 5).map((message) => message.text), ['忙完了吗？']);
  assert.deepEqual(store.recentCareMessages(secondKey, 5).map((message) => message.text), ['午饭吃了吗？']);

  const prompts = [];
  const runtime = {
    config: {
      ...DEFAULT_CONFIG,
      persona: { ...DEFAULT_CONFIG.persona, name: '鲸鲸', ownerName: '主人' },
    },
    store,
    llm: {
      isMock: false,
      async complete(input) {
        prompts.push(input.turns[0].content);
        return '最近怎么样？';
      },
    },
    logger: { warn() {} },
  };

  assert.equal(store.messages(firstKey, 12).some((message) => message.text === '忙完了吗？'), false,
    '旧开场应已离开常规近期对话窗口');
  await careForChat(runtime, 'contact-a');
  await careForChat(runtime, 'contact-b');

  assert.match(prompts[0], /忙完了吗/);
  assert.doesNotMatch(prompts[0], /午饭吃了吗/);
  assert.match(prompts[1], /午饭吃了吗/);
  assert.doesNotMatch(prompts[1], /忙完了吗/);
});
