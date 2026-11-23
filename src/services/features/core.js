'use strict';

/**
 * 基础能力：状态、设置、开关、主动搭话、微信/桥接状态、插件摘要、检索、模型。
 *
 * 这些能力都是「问宿主现状」或「借宿主通道」，不含领域数据读写，
 * 所以统一放在 core，由宿主内部和插件共用同一条口子。
 */

const registry = require('../pluginProtocolRegistry.json');
const searchService = require('../search');
const time = require('../../infra/time');
const features = require('../../infra/features');
const settings = require('../settings');
const careService = require('../care');
const { error, text, list } = require('./helpers');

function create(runtime, { search = searchService.search } = {}) {
  return {
    'status.read@1': () => ({ version: String(runtime.version || ''), running: true, pluginProtocol: registry.format }),

    'settings.read@1': () => settings.getSettings(runtime),

    'features.read@1': () => ({ features: features.list().map(item => ({
      key: item.key, label: text(item.label, 80), value: features.isOn(runtime.config, item.key),
    })) }),

    // 判定投影给两拨调用方：桥接要 windows/gap/wait 这些排期字段，
    // 插件只需要 due/reason/target；返回一份完整结果，避免两边各算一遍。
    'care.decide@1': input => {
      const result = careService.careDecide(runtime.config, {
        contacts: runtime.contacts || null,
        lastSentTs: Number(input.lastSentTs) || 0,
        sentToday: Number(input.sentToday) || 0,
        activeWxids: list(input.activeWxids, 200).map(item => text(item, 120)),
      });
      return {
        due: Boolean(result.due), reason: text(result.reason, 80), target: result.target || null,
        windows: list(result.windows, 20).map(item => text(item, 40)),
        gapMinutes: Number.isFinite(result.gapMinutes) ? result.gapMinutes : null,
        waitMinutes: Number.isFinite(result.waitMinutes) ? result.waitMinutes : null,
        sentToday: Number(result.sentToday) || 0,
        maxPerDay: Number(result.maxPerDay) || 0,
        now: text(result.now, 40),
      };
    },

    'wechat.status@1': () => {
      const gateway = runtime.gateways?.get?.('wechat');
      if (!gateway) throw error('wechat_gateway_unavailable');
      return gateway.status();
    },

    'bridge.status@1': () => {
      const gateway = runtime.gateways?.get?.('wechat');
      if (!gateway) throw error('wechat_gateway_unavailable');
      return gateway.bridgeStatus();
    },

    'plugins.status@1': () => ({
      enabled: Boolean(runtime.plugins.enabled()),
      active: runtime.plugins.active,
      items: runtime.plugins.installed().map(({ id, level, version }) => ({ id, level, version })),
    }),

    'search.query@1': async (input, _plugin, { signal, deadline }) => {
      const timeoutMs = Math.max(500, Math.min(30000, Number(input.timeoutMs) || 10000,
        Number.isFinite(deadline) ? deadline - Date.now() : 30000));
      const result = await search({
        text: input.query, force: true, llm: runtime.llm,
        config: { ...(runtime.config.websearch || {}), enabled: true, timeoutMs },
        dataDir: runtime.config.paths?.dataDir || 'data',
        now: new Date(), timeZone: time.resolveTimeZone(runtime.config), signal,
      });
      return {
        text: text(result?.text, 32000),
        status: ['ok', 'empty', 'failed'].includes(result?.status) ? result.status : 'failed',
        items: list(result?.items, 30).map(item => ({
          title: text(item.title, 500), url: text(item.url, 4096), snippet: text(item.snippet || item.text, 12000),
          publishedAt: item.publishedAt || null, fetchedAt: item.fetchedAt || null,
        })),
      };
    },

    'model.complete@1': async (input, _plugin, { signal }) => ({
      text: text(await runtime.llm.complete({
        system: text(input.system, 64000), turns: input.turns,
        maxTokens: Math.max(1, Math.min(32000, Number(input.maxTokens) || 2000)), purpose: 'plugin', signal,
      }), 64000),
    }),
  };
}

module.exports = { create };
