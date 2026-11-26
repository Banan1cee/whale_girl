'use strict';

/**
 * /api/status 的 hostDispatch 字段。
 *
 * 这一条的边界是「透出但不能漏」：
 *   - 要有按能力的准入计数，运维才看得出是谁把名额占满了；
 *   - 不能有输入、会话、插件或正文 —— 快照是给状态页看的，不是任务明细。
 *   - 没有分发器时必须还是空对象，接口形状不能因为裁剪装配而变。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { statusPayload } = require('../src/services/status');

/** 最小 runtime：只补 statusPayload 真正读到的字段，其余留空。 */
function runtime(extra = {}) {
  return {
    config: {
      persona: { name: '鲸鲸' },
      group: { requireAt: false, freeChat: false, freeChatChance: 0, cooldownSec: 0, maxRepliesPerMinute: 0 },
    },
    llm: {
      apiKey: '', isMock: true, provider: 'deepseek', providerLabel: 'DeepSeek',
      needsKey: false, model: 'deepseek-flash', baseUrl: '', temperature: 0.9,
    },
    gateways: new Map(),
    store: { summary: () => ({ sessions: 0, messages: 0, notes: 0, totalMessages: 0, totalReplies: 0 }) },
    bot: { lastUsage: null, lastBudget: null },
    scheduler: { list: () => [] },
    startedAt: Date.now(),
    version: '0.0.0-test',
    ...extra,
  };
}

test('没有分发器时 hostDispatch 是空对象（接口形状稳定）', () => {
  const out = statusPayload(runtime());
  assert.deepEqual(out.hostDispatch, {});
  // 空对象而不是 undefined/null：启动器读 out.hostDispatch.xxx 不会炸。
  assert.equal(typeof out.hostDispatch, 'object');
  assert.notEqual(out.hostDispatch, null);
});

test('分发器没有 hostStats 方法时也回退成空对象', () => {
  // 裁剪装配 / 老夹具可能只有一个精简 capabilities 对象。
  const out = statusPayload(runtime({ capabilities: {} }));
  assert.deepEqual(out.hostDispatch, {});
});

test('hostDispatch 原样透出分发器的按能力准入快照', () => {
  const stats = {
    'message.send@1': {
      active: 2, waiting: 1, granted: 9, queueFull: 1,
      nestedRefused: 0, queueTimeout: 0, queueAborted: 0, completed: 7, failed: 1,
    },
  };
  const out = statusPayload(runtime({ capabilities: { hostStats: () => stats } }));
  assert.deepEqual(out.hostDispatch, stats);
  assert.deepEqual(
    Object.keys(out.hostDispatch['message.send@1']).sort(),
    ['active', 'completed', 'failed', 'granted', 'nestedRefused', 'queueAborted', 'queueFull', 'queueTimeout', 'waiting'].sort()
  );
});

test('hostStats 返回 null/undefined 时不把 undefined 漏进接口', () => {
  for (const value of [null, undefined]) {
    const out = statusPayload(runtime({ capabilities: { hostStats: () => value } }));
    assert.deepEqual(out.hostDispatch, {});
  }
});

test('hostStats 每次调用都取新快照，不缓存上一次的结果', () => {
  let active = 0;
  const out = runtime({ capabilities: { hostStats: () => ({ 'a@1': { active } }) } });
  assert.equal(statusPayload(out).hostDispatch['a@1'].active, 0);
  active = 3;
  // 状态页会反复拉：拿到过期数字比拿不到更误导。
  assert.equal(statusPayload(out).hostDispatch['a@1'].active, 3);
});

test('hostDispatch 只有计数，不带输入、插件或正文', () => {
  const out = statusPayload(runtime({
    capabilities: { hostStats: () => ({ 'message.send@1': { active: 1, waiting: 0 } }) },
  }));
  const serialized = JSON.stringify(out.hostDispatch);
  // 快照里不应出现任何任务内容；这里用几个最容易漏的键名做守门断言。
  for (const forbidden of ['input', 'text', 'chatId', 'plugin', 'senderName', 'result']) {
    assert.ok(!serialized.includes(forbidden), `hostDispatch 不应包含 ${forbidden}`);
  }
});

test('新增 hostDispatch 不改变其余状态字段', () => {
  const out = statusPayload(runtime({ capabilities: { hostStats: () => ({ 'a@1': { active: 0 } }) } }));
  // 逐项确认原有契约仍然在（加字段不能顺手改形状）。
  assert.equal(out.ok, true);
  assert.equal(out.name, '鲸鲸');
  assert.equal(out.version, '0.0.0-test');
  assert.equal(out.mock, true);
  assert.equal(out.provider, 'deepseek');
  assert.equal(typeof out.uptimeSec, 'number');
  assert.deepEqual(out.memory, { sessions: 0, messages: 0, notes: 0, totalMessages: 0, totalReplies: 0 });
  assert.deepEqual(out.scheduler, []);
  assert.deepEqual(out.gateways, []);
  assert.deepEqual(out.webhookPaths, []);
  assert.equal(out.keyMasked, '');
  assert.equal(out.hasKey, false);
});
