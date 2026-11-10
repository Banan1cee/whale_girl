'use strict';

/**
 * 主动搭话（care）接口。
 *
 * 判定只在这里做一次：该不该发（时间窗 / 频率 / 每日上限）、发给谁（白名单 + 三个开关）。
 * 桥接只负责「按点问一次 → 发 → 记账」，不再自己维护一套选项判断
 * （以前两套逻辑并存且不一致，用户改了开关看着没反应）。
 */

const care = require('../../services/care');
const { careForChat } = require('../../services/careChat');
const { json } = require('../util');
const { describeError } = require('../../infra/errors');

module.exports = function register(router) {
  // 桥接定时来问「现在该发吗、发给谁」
  router.get('/api/care/due', (runtime, req, res, info) => {
    const q = info.url;
    const last = Number(q.searchParams.get('last') || 0);
    const sentToday = Number(q.searchParams.get('sentToday') || 0);
    const active = String(q.searchParams.get('active') || '')
      .split(/[\n,;，；\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const out = care.careDecide(runtime.config, {
      contacts: runtime.contacts || null,
      lastSentTs: Number.isFinite(last) && last > 0 ? last : 0,
      sentToday: Number.isFinite(sentToday) ? sentToday : 0,
      activeWxids: active,
    });
    runtime.logger?.debug?.(`[care] due=${Boolean(out.due)} reason=${out.reason || '-'} ` +
      `target=${out.target ? (out.target.kind || 'unknown') : 'none'} windows=${(out.windows || []).length} ` +
      `gap=${out.gapMinutes ?? '-'} sent=${out.sentToday ?? 0}/${out.maxPerDay ?? 0}`);
    return json(res, 200, {
      ok: true,
      due: Boolean(out.due),
      reason: out.reason,
      target: out.target || null,
      windows: out.windows || [],
      gapMinutes: out.gapMinutes || null,
      waitMinutes: out.waitMinutes || null,
      sentToday: out.sentToday,
      maxPerDay: out.maxPerDay,
      now: out.now || '',
    });
  });

  // 生成那句关心的话（带最近聊天上下文，避免每次同一句）
  router.get('/api/care', async (runtime, req, res, info) => {
    try {
      const out = await careForChat(runtime, info.url.searchParams.get('chat') || '');
      runtime.logger?.debug?.(`[care] generate mock=${Boolean(out.mock)} fallback=${Boolean(out.fallback)} len=${String(out.text || '').length}`);
      return json(res, 200, out);
    } catch (err) {
      runtime.logger.warn('生成搭话失败：' + describeError(err));
      return json(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  });
};
