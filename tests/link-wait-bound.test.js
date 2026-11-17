'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Bot } = require('../src/pipeline/chat');
test('链接读取器不返回时限时释放，失败被记录而不是伪装已读', async () => {
  const events = [];
  const ctx = { config: { links: { timeoutMs: 100 } }, linkReader: () => new Promise(() => {}),
    store: { appendEvent: (_, value) => events.push(value) } };
  const text = await Bot.prototype.readLink.call(ctx, 'https://b23.tv/test', 'chat');
  assert.equal(events[0].status, 'failed');
  assert.ok(text);
});
