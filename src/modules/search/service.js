'use strict';

const web = require('./websearch');
const weather = require('./providers/weather');
const router = require('./router');
const apiSearch = require('./providers/apiSearch');
const policy = require('./core/policy');
const { resolveSearchConfig } = require('../../infra/config');
const { effectiveMaxAgeDays } = require('./core/quality');
const { result, formatResult } = require('./core/result');
const { remaining, errorInfo, report, searchError } = require('./providers/transport');

/** 本地结果和 API 结果合并：API 在前，按 URL 去重，最多保留 limit 条。 */
function mergeResults(local, api, limit = 4) {
  const items = [];
  const seen = new Set();
  for (const item of [...(api?.items || []), ...(local?.items || [])]) {
    const url = String(item?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push(item);
  }
  const attempts = [...(api?.attempts || []), ...(local?.attempts || [])];
  const failed = local?.status === 'failed' || api?.status === 'failed';
  return result(items.slice(0, Math.max(1, limit)), {
    status: items.length ? 'ok' : failed ? 'failed' : 'empty',
    reason: items.length ? 'available'
      : api?.reason === 'quota_exceeded' ? 'quota_exceeded'
        : local?.reason || api?.reason || 'no_results',
    attempts,
    staleItems: local?.staleItems || [],
    elapsedMs: Math.max(Number(local?.elapsedMs) || 0, Number(api?.elapsedMs) || 0),
  });
}

/** 单轮搜索的唯一入口；只返回证据，不读写会话存储或决定聊天回复。 */
async function search({ text = '', history = [], llm, config = {}, now = new Date(), timeZone = '', signal, trace, force = false, dataDir = 'data' } = {}, deps = {}) {
  if (llm?.config && config.api?.followChat === true) config = resolveSearchConfig({ ...llm.config, websearch: config });
  const providers = deps.providers || web;
  const places = deps.places || weather;
  const routeSearch = deps.route || router.route;
  const started = Date.now();
  const deadline = started + remaining({ timeoutMs: config.timeoutMs ?? 8000 });
  const controller = new AbortController();
  const attempts = [], staleItems = [];
  let completed;
  const say = (stage, data) => report(trace, stage, data);
  const options = () => ({ deadline, timeoutMs: Math.max(0, deadline - Date.now()), signal: controller.signal, trace: say });
  const active = () => !controller.signal.aborted && Date.now() < deadline;
  const finish = value => {
    if (completed) return completed;
    const out = { ...value, attempts: [...attempts, ...(value.attempts || [])], staleItems: [...staleItems, ...(value.staleItems || [])], elapsedMs: Date.now() - started };
    out.text = formatResult(out);
    completed = out;
    say('complete', { status: out.status, reason: out.reason, selected: out.items.length, chars: out.text.length, elapsedMs: out.elapsedMs });
    return out;
  };
  const skipped = reason => {
    say('decision', { decision: 'skip', reason });
    return finish(result([], { status: 'skipped', reason }));
  };
  if (config.enabled === false) return skipped('disabled');
  text = String(text).trim();
  if (!text) return skipped('empty_input');
  if (signal?.aborted) return finish(result([], { status: 'failed', reason: 'aborted' }));

  const remember = value => {
    attempts.push(...(value.attempts || []));
    staleItems.push(...(value.staleItems || []));
  };
  const call = async (provider, fn) => {
    try { return await fn(); } catch (err) {
      const info = errorInfo(err);
      say('failed', { provider, ...info });
      return result([], { status: 'failed', reason: info.code, attempts: [{ provider, status: 'failed', code: info.code, error: info }] });
    }
  };
  const locate = async (provider, fn) => {
    try { return await fn(); } catch (err) {
      const info = errorInfo(err);
      attempts.push({ provider, status: 'failed', code: info.code, error: info });
      say('failed', { provider, ...info });
      return null;
    }
  };
  const run = async () => {
    const gate = policy.gate(text, config.semanticRoute);
    let route = force ? { failed: false, need: true, query: text } : { failed: true, need: false };
    if (!force && gate.route && active()) {
      const routeStarted = Date.now();
      try {
        route = await routeSearch(llm, text, { ...options(), now, timeZone,
          history: typeof history === 'function' ? history() : history,
          timeoutMs: Math.min(2000, options().timeoutMs) });
      } catch (err) { say('route_failed', errorInfo(err)); }
      attempts.push({ provider: 'router', status: route.failed ? 'failed' : 'ok', elapsedMs: Date.now() - routeStarted });
    }
    if (!active()) throw searchError(controller.signal.aborted ? 'aborted' : 'deadline_exceeded');
    if (!route.need && !(route.failed && gate.fallback)) return skipped(route.failed ? 'local_not_needed' : 'router_not_needed');
    say('decision', { decision: 'run', reason: route.need ? 'router_requested' : gate.route ? 'router_failed_keyword_fallback' : 'rules_requested',
      routeFailed: Boolean(route.failed), budgetMs: options().timeoutMs });
    const intent = policy.intent(text, route);
    let q = intent.query;
    const specializedDeadline = Math.min(deadline, Date.now() + Math.floor(options().timeoutMs * 0.6));
    const specializedOptions = () => ({ ...options(), deadline: specializedDeadline,
      timeoutMs: Math.max(0, specializedDeadline - Date.now()) });
    if (intent.kind === 'weather') {
      let city = intent.city;
      let place = null;
      let unresolvedCity = false;
      // 用户本句的地点优先于配置；只有没说地点时才用配置和本机公网 IP。
      if (!city && active()) {
        const candidate = policy.cityCandidate(text);
        if (candidate && candidate.length <= 40) {
          place = await locate('geocode', () => places.geocodeCity(candidate, specializedOptions()));
          if (place) city = place.name;
          else unresolvedCity = true;
        }
      }
      if (!city && !unresolvedCity) city = String(config.city || '').trim();
      if (!city && !unresolvedCity && active()) city = await locate('ip-city', () => places.ipCity(specializedOptions())) || '';
      if (city && active()) {
        const value = await call('open-meteo', () => providers.weatherResult(city, { ...specializedOptions(), ...(place ? { place } : {}) }));
        if (value.status === 'ok') return finish(value);
        remember(value);
      }
      // 补地点时保留“明天/带伞”等原需求，避免天气失败后退化成泛查城市天气。
      if (city && !q.includes(city)) q = city + ' ' + q;
    }
    if (intent.kind === 'hotlist' && active()) {
      const value = await call(intent.site || 'toutiao', () => providers.hotlistResult(intent.site || 'toutiao', { ...specializedOptions(), limit: 10 }));
      if (value.status === 'ok') return finish(value);
      remember(value);
    }
    if (!active()) throw searchError(controller.signal.aborted ? 'aborted' : 'deadline_exceeded');
    if (policy.DOMAINS[intent.site]) q = q.replace(/\bsite:[a-z0-9.-]+/gi, '').trim() + ' site:' + policy.DOMAINS[intent.site];
    // API 搜索开启时先走 API；API 失败或没有结果才回退本地。
    // 这样启用付费/限额 API 后，本地搜索不会和它重复跑一遍。
    const apiOn = config?.api?.enabled === true
      && Array.isArray(config.api.providers) && config.api.providers.length > 0;
    let api = null;
    if (apiOn) {
      // 自动服务可能较慢，给本地兜底保留预算，避免 API 一次耗尽整轮搜索时间。
      const apiDeadline = config.api.followChat === true
        ? Math.min(deadline, Date.now() + Math.floor(options().timeoutMs * 0.6)) : deadline;
      api = await apiSearch.apiSearch({
        query: q, text, websearch: config, dataDir,
        deadline: apiDeadline, signal: controller.signal, timeoutMs: Math.max(0, apiDeadline - Date.now()), trace: say,
      }).catch((err) => {
        const info = errorInfo(err);
        say('api_failed', info);
        return result([], { status: 'failed', reason: info.code });
      });
      if (api?.items?.length) return finish(api);
    }
    const local = await call('web', () => providers.searchResult(q, { ...options(), limit: 4,
      maxAgeDays: effectiveMaxAgeDays(`${text} ${q}`, intent.fresh, intent.timeRange) }));
    return finish(api ? mergeResults(local, api, 4) : local);
  };
  let timer, abort;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        abort = () => { controller.abort(); reject(searchError('aborted')); };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(searchError('deadline_exceeded')); }, Math.max(0, deadline - Date.now()));
      }),
    ]);
  } catch (err) {
    const info = errorInfo(err);
    say('failed', info);
    return finish(result([], { status: 'failed', reason: info.code }));
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

module.exports = { search };
