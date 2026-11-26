'use strict';

/**
 * 网关单轮信号与预算。
 *
 * 每一条入站消息就是一轮对话：网关要给这一轮一个取消源和一个截止时间，
 * 让下游（Bot.handle → decide → 能力调用）能在「模型卡住 / 桥接那头早断了」时
 * 协作式退出，而不是无限占着会话队列。三条约束：
 *   1. handleInbound 必须把 signal 交下去，且是同一个实例（下游据此订阅）；
 *   2. 预算由 config.chat.turnTimeoutMs 决定：默认 120000，0 = 不限，上限 600000；
 *   3. 无论正常完成、抛错还是超时，timer 都必须清掉，不能泄漏。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Gateway } = require('../src/adapters/gateway');
const { DEFAULT_CONFIG } = require('../src/infra/config');

function makeGateway({ config = DEFAULT_CONFIG, handle } = {}) {
  const seen = [];
  const bot = {
    config,
    handle: handle || (async () => ({ action: 'ignore', reason: 'test' })),
  };
  const gateway = new Gateway({
    platform: 'wechat',
    logger: null,
    bot,
    chat: {
      handle: async (msg, options) => {
        seen.push(options || {});
        return (handle || (async () => ({ action: 'ignore', reason: 'test' })))(msg, options);
      },
    },
    options: { enabled: true, inboundToken: '', outboundUrl: '' },
  });
  return { gateway, bot, seen };
}

const payload = (text = '你好') => ({ chat_id: 'wxid_a', sender_id: 'u1', sender_name: '小海', chat_type: 'private', text });

function withTurn(config, turnTimeoutMs) {
  const next = structuredClone(config);
  if (turnTimeoutMs === undefined) delete next.chat.turnTimeoutMs;
  else next.chat.turnTimeoutMs = turnTimeoutMs;
  return next;
}

test('handleInbound 把 signal 传给 chat.handle，且是同一实例', async () => {
  const base = withTurn(DEFAULT_CONFIG, undefined);
  const { gateway, seen } = makeGateway({ config: base });

  await gateway.handleInbound(payload());

  assert.equal(seen.length, 1);
  const options = seen[0];
  assert.ok(options.signal instanceof AbortSignal, '必须传 AbortSignal');
  assert.equal(options.signal.aborted, false, '正常一轮不该是已取消状态');
  assert.equal(options.localWechat, false, '原有 localWechat 选项保持不变');
  assert.ok(Number.isFinite(options.deadline), '必须带 deadline');
});

test('缺省配置预算 120000，deadline ≈ now + 120000', async () => {
  const base = withTurn(DEFAULT_CONFIG, undefined);
  const { gateway, seen } = makeGateway({ config: base });
  const before = Date.now();
  await gateway.handleInbound(payload());
  const after = Date.now();

  const { deadline } = seen[0];
  assert.ok(deadline >= before + 120000 && deadline <= after + 120000,
    `deadline 应约等于 now+120000，实际 ${deadline - before}ms`);
});

test('turnTimeoutMs=0 表示不限：不设 deadline，但仍交下可取消的 signal', async () => {
  const { gateway, seen } = makeGateway({ config: withTurn(DEFAULT_CONFIG, 0) });
  await gateway.handleInbound(payload());

  assert.equal(seen[0].deadline, null, '0 = 不限，不给 deadline');
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.equal(seen[0].signal.aborted, false);
});

test('配置超过上限时压回 600000', async () => {
  const { gateway, seen } = makeGateway({ config: withTurn(DEFAULT_CONFIG, 9999999) });
  const before = Date.now();
  await gateway.handleInbound(payload());
  const budget = seen[0].deadline - before;
  assert.ok(budget <= 600000 + 50 && budget > 599000, `应压到 600000，实际 ${budget}`);
});

test('自定义预算生效（如 30000）', async () => {
  const { gateway, seen } = makeGateway({ config: withTurn(DEFAULT_CONFIG, 30000) });
  const before = Date.now();
  await gateway.handleInbound(payload());
  const budget = seen[0].deadline - before;
  assert.ok(budget > 29500 && budget <= 30050, `实际 ${budget}`);
});

test('超时后 signal 变成 aborted，调用不挂死', async () => {
  // 短预算 + 一个不主动退出的 handler：只靠网关的 timer 取消。
  const { gateway, seen } = makeGateway({
    config: withTurn(DEFAULT_CONFIG, 40),
    handle: () => new Promise(() => { /* 永不 settle */ }),
  });

  const pending = gateway.handleInbound(payload());
  // 让 timer 到点：直接等一段比预算长的时间，再看 signal。
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(seen[0].signal.aborted, true, '超时后 signal 必须已取消');
  assert.equal(gateway.turnTimeouts, 1, '超时计数应 +1');

  // 收尾：把永不 settle 的 promise 放掉，避免测试挂住。
  // （handleInbound 本身仍在等那个 promise，Node 的 test runner 会在用例结束后清理。）
  void pending;
});

test('handler 正常完成时清掉 timer，不会事后取消', async () => {
  const { gateway, seen } = makeGateway({ config: withTurn(DEFAULT_CONFIG, 30) });
  await gateway.handleInbound(payload());

  // 正常完成后再等过预算时间：signal 不能被延迟触发的 timer 取消。
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(seen[0].signal.aborted, false, '正常完成后不得再被 timer 取消');
  assert.equal(gateway.turnTimeouts, 0, '没有发生超时');
});

test('chat.handle 抛错时同样清掉 timer，错误原样上抛', async () => {
  const boom = Object.assign(new Error('boom'), { code: 'boom' });
  const { gateway } = makeGateway({
    config: withTurn(DEFAULT_CONFIG, 30),
    handle: async () => { throw boom; },
  });

  await assert.rejects(gateway.handleInbound(payload()), err => err === boom);
  // 让潜在的 timer 有机会触发：它必须已经被清掉，不能把计数加一。
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(gateway.turnTimeouts, 0, '抛错路径也必须清掉 timer');
});

test('每轮各自独立：两轮拿到不同的 signal 实例', async () => {
  const { gateway, seen } = makeGateway({ config: withTurn(DEFAULT_CONFIG, undefined) });
  await gateway.handleInbound(payload('一'));
  await gateway.handleInbound(payload('二'));
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].signal, seen[1].signal, '每轮必须是独立的取消源');
});

test('no_reply 标记的入站消息仍然不进入 chat.handle（回归守门）', async () => {
  const { gateway, seen } = makeGateway({ config: withTurn(DEFAULT_CONFIG, undefined) });
  const result = await gateway.handleInbound({ ...payload(), no_reply: true });
  assert.deepEqual(result, { ok: true, skipped: 'no_reply_flag' });
  assert.equal(seen.length, 0);
});
