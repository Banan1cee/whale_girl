'use strict';

function createUsage({ memoryBudget, budgetPricing }) {
  const usage = {
  recordUsage(decision, acc) {
    if (!acc || !acc.calls) return null;
    const budget = decision && decision.budget;
    const promptTokens = Math.max(0, Math.round(Number(acc.promptTokens) || 0));
    const completionTokens = Math.max(0, Math.round(Number(acc.completionTokens) || 0));
    // 命中不可能超过总输入：服务商给的数偶尔对不上，夹一下再算钱
    const cacheHitTokens = Math.min(promptTokens, Math.max(0, Math.round(Number(acc.cacheHitTokens) || 0)));
    const cacheMissTokens = Number(acc.cacheMissTokens) > 0
      ? Math.max(0, Math.round(Number(acc.cacheMissTokens)))
      : Math.max(0, promptTokens - cacheHitTokens);

    const modelInfo = this.modelContext();
    const calibration = this.calibrationEngine();
    let scale = Number(budget && budget.calibrationScale);
    if (!Number.isFinite(scale) || scale <= 0) {
      const raw = Number(
        budget && budget.estimatedPromptTokens != null ? budget.estimatedPromptTokens : (budget && budget.estimatedInputTokens),
      ) || 0;
      scale = calibration.apply(raw, modelInfo).scale;
    }
    // 一轮回复里如果后台摘要/另一个会话也调了模型，acc.calls > 1；
    // 这时不能把总和和「本轮单次估算」比较，否则一定误报超支。
    // 估算值始终要算出来给状态页/日志用；但只有「本轮恰好一次模型调用」时才拿
    // 它和真实 usage 比较、告警和喂校准。后台摘要/并发会话不会污染单次样本。
    const comparable = acc.calls === 1;
    const cmp = budget ? memoryBudget.compareUsage(budget, { promptTokens }, { scale }) : null;
    // 先按旧 scale 比较，再把真实样本喂进去，下一轮用新 scale；顺序反过来会拿刚更新的值自证。
    // 一轮调了多次模型时，总和和单轮估算对不上，喂给校准会学歪，只喂单次调用的轮次。
    const observed = cmp && comparable
      ? calibration.observe({ rawEstimate: cmp.rawEstimatedPromptTokens, actual: cmp.actualPromptTokens, ...modelInfo })
      : null;
    const estimatedPromptTokens = cmp ? cmp.estimatedPromptTokens : 0;
    // 偏差按「估算」做分母：估算 2610、实际 2489 → +4.6%（估算偏高）
    const ratio = estimatedPromptTokens > 0 ? (estimatedPromptTokens - promptTokens) / estimatedPromptTokens : 0;
    const at = Number(acc.at) || Date.now();
    const provider = modelInfo.provider;
    const model = modelInfo.model;
    const pricing = budgetPricing.pricingFor(provider, model, new Date(at));
    const cost = pricing
      ? {
        cny: budgetPricing.costOf(pricing.price, promptTokens, cacheHitTokens, completionTokens),
        band: pricing.band,
        model: pricing.model,
      }
      : { cny: null, band: null, model: model || null };

    this.lastUsage = {
      promptTokens,
      cacheHitTokens,
      cacheMissTokens,
      completionTokens,
      hitRate: promptTokens > 0 ? cacheHitTokens / promptTokens : 0,
      rawEstimatedPromptTokens: cmp ? cmp.rawEstimatedPromptTokens : 0,
      estimatedPromptTokens,
      estimatedInputTokens: estimatedPromptTokens,
      calibrationScale: cmp ? cmp.calibrationScale : scale,
      calibratedScale: observed && observed.scale,
      ratio,
      cost,
      at,
    };
    if (cmp && cmp.warn && comparable && this.logger) {
      this.logger.warn(
        `实际用量超出估算 ${(cmp.errorRatio * 100).toFixed(1)}%`
        + `（实际 ${cmp.actualPromptTokens} / 估算 ${cmp.estimatedPromptTokens}，scale ${cmp.calibrationScale.toFixed(2)}）`
      );
    }
    if (this.logger) this.logger.info(this.describeUsage(this.lastUsage));
    return this.lastUsage;
  },

  /** 启动器「内核日志」里那一行：用量 · 命中 / 输入（命中率）/ 输出 · 估算（偏差）· 花费（有价目表才显示） */
  describeUsage(u) {
    const pct = (x) => (Number(x) * 100).toFixed(1) + '%';
    const ratio = Number(u.ratio) || 0;
    const sign = ratio >= 0 ? '+' : '';
    // 只有 deepseek-flash / deepseek-v4.1-flash 有公开价目表；其它模型不显示金额
    const price = u.cost && u.cost.cny != null
      ? ` · ¥${Number(u.cost.cny).toFixed(5)}（${u.cost.band === 'peak' ? '高峰' : '谷时'} ${u.cost.model}）`
      : '';
    return `用量 · 命中 ${u.cacheHitTokens} / 输入 ${u.promptTokens}（${pct(u.hitRate)}）/ 输出 ${u.completionTokens}`
      + ` · 估算 ${u.estimatedPromptTokens}（${sign}${(ratio * 100).toFixed(1)}%）${price}`;
  },

  /** 新一轮的 usage 累加器（只存计数，不碰正文） */
  _newUsage() {
    return {
      calls: 0,
      promptTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      completionTokens: 0,
      at: 0,
    };
  },

  /** 把一次模型调用的 usage 累加进 acc */
  _addUsage(acc, usage) {
    if (!acc || !usage) return acc;
    acc.calls += 1;
    acc.promptTokens += Number(usage.promptTokens) || 0;
    acc.cacheHitTokens += Number(usage.promptCacheHitTokens) || 0;
    acc.cacheMissTokens += Number(usage.promptCacheMissTokens) || 0;
    acc.completionTokens += Number(usage.completionTokens) || 0;
    acc.at = Math.max(acc.at, Number(usage.at) || 0);
    return acc;
  },

  /** 从 seq 水位之后的所有模型调用累加出这一轮的 usage */
  usageSince(mark, purpose = 'chat') {
    const acc = this._newUsage();
    const events = this.llm && Array.isArray(this.llm.usageEvents) ? this.llm.usageEvents : [];
    const floor = Number(mark) || 0;
    for (const usage of events) {
      if (Number(usage.seq) <= floor) continue;
      // 只统计本轮主回复；后台摘要 / episode / 另一个会话不能算进用户这一轮。
      if (purpose && usage.purpose && usage.purpose !== purpose) continue;
      this._addUsage(acc, usage);
    }
    return acc;
  }
  };
  return usage;
}

module.exports = { createUsage };
