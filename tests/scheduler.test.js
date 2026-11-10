'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Scheduler } = require('../src/infra/scheduler');
const { DiaryService } = require('../src/services/diary');

/** 可控时钟：测试不真的等 15 秒/6 小时。 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    pending: () => timers.size,
    timers: {
      setTimeout(fn, ms) {
        const timer = { id: ++seq, at: now + Math.max(0, Number(ms) || 0), fn, unref() { return timer; } };
        timers.set(timer.id, timer);
        return timer;
      },
      clearTimeout(timer) {
        if (timer) timers.delete(timer.id);
      },
    },
    async advance(ms) {
      const end = now + Math.max(0, Number(ms) || 0);
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.fn();
        // 让 async fn 的 finally 跑完，下一轮才能看到 running=false
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = end;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return clock;
}

test('定时器：周期任务按间隔执行，list 能看到下一次时间', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers });
  const calls = [];
  s.every('demo.tick', 100, () => calls.push(clock.now()));

  await clock.advance(99);
  assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.deepEqual(calls, [100]);
  await clock.advance(200);
  assert.deepEqual(calls, [100, 200, 300]);

  const [job] = s.list();
  assert.equal(job.name, 'demo.tick');
  assert.equal(job.intervalMs, 100);
  assert.equal(job.runs, 3);
  assert.equal(job.nextAt, 400);
  assert.equal(job.lastError, '');
});

test('定时器日志：注册/取消/跳过/慢任务都带 name 和状态', async () => {
  const clock = fakeClock();
  const lines = [];
  const logger = {
    debug: (s) => lines.push(s),
    warn: (s) => lines.push(s),
  };
  const s = new Scheduler({ now: clock.now, timers: clock.timers, logger });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  s.every('slow.job', 100, async () => { await gate; });
  await clock.advance(100);
  await clock.advance(200);          // 上一轮没结束：skip
  assert.ok(lines.some((x) => x.includes('scheduler.add name=slow.job') && x.includes('intervalMs=100')));
  assert.ok(lines.some((x) => x.includes('scheduler.skip name=slow.job') && x.includes('reason=running')));
  release();
  await clock.advance(100);
  s.cancel('slow.job');
  assert.ok(lines.some((x) => x.includes('scheduler.cancel name=slow.job')));
});

test('定时器：同一任务上一轮没跑完时默认跳过，不会重入', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  s.every('slow', 100, async () => {
    calls += 1;
    await gate;
  });

  await clock.advance(100);
  assert.equal(calls, 1);
  await clock.advance(200);
  assert.equal(calls, 1, '上一轮还卡着，不能再进来');
  assert.ok(s.list()[0].skipped >= 2);

  release();
  await clock.advance(0);
  await clock.advance(100);
  assert.equal(calls, 2);
});

test('定时器：取消后不再执行，stopAll 清空全部任务', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers });
  let a = 0;
  let b = 0;
  s.every('a', 50, () => { a += 1; });
  s.every('b', 50, () => { b += 1; });
  assert.equal(s.cancel('a'), true);
  assert.equal(s.cancel('a'), false);

  await clock.advance(100);
  assert.equal(a, 0);
  assert.equal(b, 2);

  assert.equal(s.stopAll(), 1);
  await clock.advance(200);
  assert.equal(b, 2);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(s.list(), []);
});

test('定时器：一次性任务到点执行一次，然后自动移除', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers });
  let calls = 0;
  s.at('once', 50, () => { calls += 1; });

  await clock.advance(49);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);
  await clock.advance(100);
  assert.equal(calls, 1);
  assert.deepEqual(s.list(), []);
});

test('定时器：单个任务抛异常只记录，不会拖垮其它任务', async () => {
  const clock = fakeClock();
  const logs = [];
  const logger = { warn: (line) => logs.push(line) };
  const s = new Scheduler({ now: clock.now, timers: clock.timers, logger });
  let healthy = 0;
  s.every('bad', 100, () => { throw Object.assign(new Error('boom'), { code: 'E_BOOM' }); });
  s.every('good', 100, () => { healthy += 1; });

  await clock.advance(100);
  assert.equal(healthy, 1);
  const bad = s.list().find((j) => j.name === 'bad');
  assert.match(bad.lastError, /E_BOOM/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /name=bad/);

  await clock.advance(100);
  assert.equal(healthy, 2, '另一个任务不受影响');
  assert.equal(s.list().find((j) => j.name === 'bad').runs, 2);
});

test('定时器：睡眠恢复后只接下一轮，不连续追补', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers });
  let calls = 0;
  s.every('hourly', 3600_000, () => { calls += 1; });
  await clock.advance(3600_000);
  assert.equal(calls, 1);
  // 模拟休眠 5 小时：不应该立刻补跑 5 次
  await clock.advance(5 * 3600_000);
  assert.equal(calls, 6, '每过一小时一次，总共 6 次，不是补跑');
  const job = s.list()[0];
  assert.ok(job.nextAt > clock.now(), '下一次必须落在未来');
});

test('状态快照带 scheduler：只有时间/状态，不含业务正文', () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers });
  s.every('demo.job', 1000, () => {});
  const { statusPayload } = require('../src/services/status');
  const runtime = {
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
    scheduler: s,
    startedAt: Date.now(),
    version: '0.0.0-test',
  };
  const out = statusPayload(runtime);
  assert.equal(out.scheduler.length, 1);
  assert.deepEqual(
    Object.keys(out.scheduler[0]).sort(),
    ['intervalMs', 'kind', 'lastError', 'lastRunAt', 'name', 'nextAt', 'running', 'runs', 'skipped'].sort()
  );
  assert.equal(out.scheduler[0].name, 'demo.job');
  assert.equal(out.scheduler[0].kind, 'every');
  assert.equal(out.scheduler[0].intervalMs, 1000);
});

test('日记 tick 接到统一调度：到点才跑，stop 后不再跑', async () => {
  const clock = fakeClock();
  const s = new Scheduler({ now: clock.now, timers: clock.timers });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sched-diary-'));
  try {
    const service = new DiaryService({
      paths: { dataDir: dir },
      diary: { enabled: false, time: '23:00' },
    }, {
      store: { sessions: new Map() },
      llm: {},
      logger: null,
      scheduler: s,
      now: clock.now,
    });
    let calls = 0;
    service.tick = () => { calls += 1; };
    service.start();
    await clock.advance(14999);
    assert.equal(calls, 0);
    await clock.advance(1);
    assert.equal(calls, 1, '15 秒后应该 tick 一次');
    service.stop();
    await clock.advance(60_000);
    assert.equal(calls, 1, 'stop 后不能再 tick');
    assert.deepEqual(s.list(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});
