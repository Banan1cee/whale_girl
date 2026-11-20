'use strict';

/**
 * 搜索模块的公开入口。
 *
 * `search` 是聊天链路用的结构化入口（旧 services 搜索入口的原实现）；
 * `websearch` 保留定位服务需要的旧接口（ipCity/geocodeCity 等）。
 * provider 只在这里聚合并按名字转出，apiProbe 之类的调用方不要深 import。
 */
const service = require('./service');
const websearch = require('./websearch');

const providers = {
  apiSearch: require('./providers/apiSearch'),
  bing: require('./providers/bing'),
  cache: require('./providers/cache'),
  deepseek: require('./providers/deepseek'),
  hotlists: require('./providers/hotlists'),
  providerResult: require('./providers/providerResult'),
  quota: require('./providers/quota'),
  qwen: require('./providers/qwen'),
  so360: require('./providers/so360'),
  transport: require('./providers/transport'),
  weather: require('./providers/weather'),
  web: require('./providers/web'),
  zhihu: require('./providers/zhihu'),
};

// 顺序很重要：websearch 也有同名 `search`（返回扁平行），聊天入口必须覆盖它。
module.exports = {
  ...websearch,
  ...service,
  websearch,
  providers,
  deepseek: providers.deepseek,
  zhihu: providers.zhihu,
};
