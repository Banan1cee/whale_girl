'use strict';

const { describeError } = require('./errors');

// Node 的 setTimeout 超过这个值会被当成 1ms，必须切段；这里只做单次最大延迟保护。
const MAX_DELAY = 0x7fffffff;

/**
 * 进程内定时任务调度器（只负责「什么时候跑」，不碰业务）。
 *
 * 以前日记、记忆快照、朋友圈各自 `setInterval`：关服务要逐个 clear，
 * 配置改了要记得重排，出错也各记各的。这里统一生命周期和可观测性，
 * 但**不接管**请求超时、桥接轮询、去抖/刷盘这些不同语义的计时。
 */
class Scheduler {
  constructor({ now = Date.now, logger = null, timers = null } = {}) {
    this.now = typeof now === 'function' ? now : Date.now;
    this.logger = logger;
    this.timers = timers || {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    this.jobs = new Map();
  }

  _delay(at) {
    return Math.max(0, Math.min(MAX_DELAY, Number(at) - this.now()));
  }

  _schedule(job, at) {
    const delay = this._delay(at);
    job.timer = this.timers.setTimeout(() => this._fire(job), delay);
    if (job.timer && typeof job.timer.unref === 'function') job.timer.unref();
    job.nextAt = this.now() + delay;
  }

  _register(name, kind, fn, opts) {
    if (!name || typeof fn !== 'function') throw new Error('定时任务需要 name 和函数');
    this.cancel(name);
    const job = {
      name,
      kind,
      fn,
      opts,
      timer: null,
      nextAt: 0,
      lastRunAt: 0,
      lastError: '',
      running: false,
      runs: 0,
      skipped: 0,
    };
    this.jobs.set(name, job);
    return job;
  }

  /** 固定周期任务；上一轮没跑完默认跳过，避免朋友圈读取/日记生成重入。 */
  every(name, intervalMs, fn, opts = {}) {
    const ms = Math.floor(Number(intervalMs));
    if (!Number.isFinite(ms) || ms <= 0) throw new Error('定时间隔必须大于 0');
    const job = this._register(name, 'every', fn, { ...opts, intervalMs: ms });
    this._schedule(job, opts.immediate ? this.now() : this.now() + ms);
    this.logger?.debug?.(`scheduler.add name=${name} kind=every intervalMs=${ms} nextAt=${job.nextAt}`);
    return this;
  }

  /** 一次性任务；到点执行后自动从任务表移除。 */
  at(name, when, fn, opts = {}) {
    const at = when instanceof Date ? when.getTime() : Number(when);
    if (!Number.isFinite(at)) throw new Error('定时时刻无效');
    const job = this._register(name, 'at', fn, opts);
    this._schedule(job, at);
    this.logger?.debug?.(`scheduler.add name=${name} kind=at nextAt=${job.nextAt}`);
    return this;
  }

  cancel(name) {
    const job = this.jobs.get(name);
    if (!job) return false;
    if (job.timer) this.timers.clearTimeout(job.timer);
    job.timer = null;
    this.jobs.delete(name);
    this.logger?.debug?.(`scheduler.cancel name=${job.name} kind=${job.kind} runs=${job.runs} skipped=${job.skipped}`);
    return true;
  }

  cancelAll(prefix = '') {
    const p = String(prefix || '');
    let count = 0;
    for (const name of [...this.jobs.keys()]) {
      if (!p || name.startsWith(p)) {
        if (this.cancel(name)) count += 1;
      }
    }
    return count;
  }

  /** 手动触发一次（诊断/测试）；不会移除周期任务。 */
  trigger(name) {
    const job = this.jobs.get(name);
    if (!job) return false;
    void this._run(job);
    return true;
  }

  _fire(job) {
    if (this.jobs.get(job.name) !== job) return;
    job.timer = null;
    if (job.running) {
      // 上一轮还没跑完（模型/IO 慢）：跳过这一轮，绝不重入。
      job.skipped += 1;
      this.logger?.debug?.(`scheduler.skip name=${job.name} reason=running runs=${job.runs} skipped=${job.skipped}`);
      this._reschedule(job);
      return;
    }
    // 先排下一轮再执行：函数跑很久也不会把周期拖成「执行时间 + 间隔」。
    if (job.kind === 'every') this._reschedule(job);
    void this._run(job);
  }

  _reschedule(job) {
    if (job.kind !== 'every' || this.jobs.get(job.name) !== job) return;
    const interval = job.opts.intervalMs;
    let next = (job.nextAt || this.now()) + interval;
    const now = this.now();
    // 睡眠/断线恢复后只接上下一轮，不连续追补历史周期。
    if (next <= now) next += (Math.floor((now - next) / interval) + 1) * interval;
    this._schedule(job, next);
  }

  async _run(job) {
    if (this.jobs.get(job.name) !== job) return;
    job.running = true;
    job.runs += 1;
    job.lastRunAt = this.now();
    const startedAt = job.lastRunAt;
    try {
      await job.fn();
      job.lastError = '';
      const ms = this.now() - startedAt;
      // 正常周期任务（尤其 diary.tick）多数几十毫秒内结束，不逐条刷日志；
      // 超过 50ms 或一次性任务才留一条，排查「定时器有没有跑、跑了多久」。
      if (job.kind === 'at' || ms >= 50) {
        this.logger?.debug?.(`scheduler.done name=${job.name} kind=${job.kind} ms=${ms} runs=${job.runs}`);
      }
    } catch (err) {
      job.lastError = describeError(err);
      this.logger?.warn?.(`定时任务失败 name=${job.name} runs=${job.runs} ${job.lastError}`);
    } finally {
      job.running = false;
      if (job.kind === 'at') this.cancel(job.name);
    }
  }

  /** 给状态接口/诊断页看的快照；只有时间和状态，不含任务正文。 */
  list() {
    return [...this.jobs.values()].map((job) => ({
      name: job.name,
      kind: job.kind,
      intervalMs: job.kind === 'every' ? job.opts.intervalMs : 0,
      nextAt: job.nextAt,
      lastRunAt: job.lastRunAt,
      lastError: job.lastError,
      running: job.running,
      runs: job.runs,
      skipped: job.skipped,
    }));
  }

  stopAll() {
    const count = this.cancelAll('');
    if (count) this.logger?.debug?.(`scheduler.stopAll count=${count}`);
    return count;
  }
}

module.exports = { Scheduler };
