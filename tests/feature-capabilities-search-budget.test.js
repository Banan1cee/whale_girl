'use strict';

/**
 * search.query@1 的预算接线验收。
 *
 * 这个能力同时被插件（host.call）和宿主内部检索调用，所以这里的 timeoutMs
 * 是「本次调用还能借多久网络时间」的唯一决策点。三条规则必须同时成立：
 *   1. 不给 deadline 时保持原有默认 10000ms、输入 clamp 到 500–30000；
 *   2. deadline 是硬边界：剩余不足 500ms 时不能为了凑下限把时间再借回来；
 *   3. 已过期 / 已取消时不启动下层检索，保持 capability_timeout / aborted 语义。
 *
 * 观测方式：用 create(runtime, { search }) 注入假检索，抓它收到的 config.timeoutMs
 * 与 signal；调用一律走真实 UnifiedCapabilityDispatcher.invokeHost，
 * 因为那才是路由、Bot、插件共用的公共 seam。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { createFeatureCapabilities } = require('../src/services/features');

function fixture({ search, limits = {} } = {}) {
  const seen = [];
  const state = { calls: 0 };
  const injected = async input => {
    state.calls++;
    seen.push(input);
    return {
      status: 'ok',
      text: '检索正文',
      items: [{ title: 'T', url: 'https://e.test', snippet: 'S', raw: 'dropped' }],
    };
  };
  const runtime = {
    config: { paths: { dataDir: 'data' }, websearch: {}, env: { timezone: 'Asia/Shanghai' } },
    llm: null,
  };
  const handlers = createFeatureCapabilities(runtime, { search: search || injected });
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true }, ...limits });
  for (const [name, handler] of Object.entries(handlers)) dispatcher.defineHost(name, handler);
  return { dispatcher, handlers, seen, state };
}

test('没有 deadline 时沿用默认 10000ms，并保留输入 clamp 的上下限', async () => {
  const { dispatcher, seen } = fixture();

  await dispatcher.invokeHost('search.query@1', { query: '天气' });
  assert.equal(seen[0].config.timeoutMs, 10000, '缺省输入必须回到 10000ms');

  // 合法的输入值原样保留（schema 已把范围卡在 500–30000）。
  await dispatcher.invokeHost('search.query@1', { query: '天气', timeoutMs: 30000 });
  assert.equal(seen[1].config.timeoutMs, 30000, '输入上限 30000 原样保留');
  await dispatcher.invokeHost('search.query@1', { query: '天气', timeoutMs: 500 });
  assert.equal(seen[2].config.timeoutMs, 500, '输入下限 500 原样保留');
  await dispatcher.invokeHost('search.query@1', { query: '天气', timeoutMs: 9000 });
  assert.equal(seen[3].config.timeoutMs, 9000, '区间内输入不被改写');

  // 远端 deadline 很远时，预算仍是输入/默认值，不因为 deadline 变长。
  await dispatcher.invokeHost('search.query@1', { query: '天气' }, { deadline: Date.now() + 60000 });
  assert.equal(seen[4].config.timeoutMs, 10000, '远 deadline 不能抬高默认预算');
});

test('注册表之外的调用方也走同一个 handler：仍 clamp 到 500–30000', async () => {
  const { handlers, seen } = fixture();
  await handlers['search.query@1']({ query: '天气', timeoutMs: 60000 }, null, {});
  assert.equal(seen[0].config.timeoutMs, 30000);
  await handlers['search.query@1']({ query: '天气', timeoutMs: 100 }, null, {});
  assert.equal(seen[1].config.timeoutMs, 500);
});

test('剩余预算不足 500ms 时被 deadline 压住，不抬高到下限', async () => {
  const { dispatcher, seen } = fixture();
  const deadline = Date.now() + 300;
  await dispatcher.invokeHost('search.query@1', { query: '天气', timeoutMs: 9000 }, { deadline });
  const budget = seen[0].config.timeoutMs;
  assert.ok(budget > 0, `剩余预算必须是正数，实际 ${budget}`);
  assert.ok(budget <= 300, `timeout 不能超过剩余 deadline，实际 ${budget}`);
});

test('短剩余 deadline 也不会抬高预算：结果等于两者较小值', async () => {
  const { dispatcher, seen } = fixture();
  // 输入 800ms 小于默认 10000，deadline 只剩一瞬 → 取剩余。
  const deadline = Date.now() + 400;
  await dispatcher.invokeHost('search.query@1', { query: '天气', timeoutMs: 800 }, { deadline });
  assert.ok(seen[0].config.timeoutMs <= 400);
});

test('已取消的调用不会启动下层检索，保持 capability_aborted', async () => {
  const { dispatcher, state } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    dispatcher.invokeHost('search.query@1', { query: '天气' }, { signal: controller.signal }),
    { code: 'capability_aborted' },
  );
  assert.equal(state.calls, 0, '取消后不得触碰下层检索');
});

test('排队等待期间过期的调用不会启动下层检索，保持 capability_timeout', async () => {
  const calls = [];
  let release;
  const hanging = input => {
    calls.push(input);
    return new Promise(resolve => { release = () => resolve({ status: 'ok', text: '', items: [] }); });
  };
  // 并发 1：第二次调用只能排队，于是它的 deadline 会在队列里耗尽。
  const { dispatcher } = fixture({ search: hanging, limits: { maxHostConcurrent: 1 } });

  const first = dispatcher.invokeHost('search.query@1', { query: '第一' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    dispatcher.invokeHost('search.query@1', { query: '第二' }, { deadline: Date.now() + 40 }),
    { code: 'capability_timeout' },
  );
  assert.equal(calls.length, 1, '过期的那次调用不得进入检索');
  release();
  await first;
});

test('handler 自身兜住「放行后过期」的窗口：不启动检索并报 capability_timeout', async () => {
  const { handlers, state } = fixture();
  await assert.rejects(
    handlers['search.query@1']({ query: '天气' }, null, { deadline: Date.now() - 1 }),
    { code: 'capability_timeout' },
  );
  assert.equal(state.calls, 0);
});

test('取消信号原样送达下层检索，供其提前停止', async () => {
  const { dispatcher, seen } = fixture();
  const controller = new AbortController();
  await dispatcher.invokeHost('search.query@1', { query: '天气' }, { signal: controller.signal });
  assert.equal(seen[0].signal, controller.signal, '必须把同一个 signal 交给 search');
  assert.equal(seen[0].config.enabled, true);
  assert.equal(seen[0].force, true);
});

test('输出投影保持原有形状（多余字段丢弃、缺失时间统一为 null）', async () => {
  const { dispatcher } = fixture();
  const out = await dispatcher.invokeHost('search.query@1', { query: '天气' });
  assert.deepEqual(out, {
    text: '检索正文',
    status: 'ok',
    items: [{ title: 'T', url: 'https://e.test', snippet: 'S', publishedAt: null, fetchedAt: null }],
  });
});
