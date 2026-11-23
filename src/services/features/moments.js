'use strict';

/**
 * 朋友圈能力。读取快照、发起/执行互动、发表。
 *
 * 宿主内部（HTTP 路由、桥接取件）和插件 host.call 共用这一份实现：
 * 字段清洗放在这里，路由只负责传输层（回环校验、token、状态码）。
 *
 * 桥接侧的领取与回执（moments.claim@1 / moments.complete@1）只登记给宿主：
 * 它们不在 levels.4.calls 里，插件清单写不进去，避免第三方借道替桥接领任务。
 */

const { error, text, oneOf } = require('./helpers');

/**
 * 桥接在线且账号已确认时返回账号。
 * 发表必须绑定这个账号：插件传入的 account 一律忽略，否则可以指定别的微信账号发。
 */
function accountReady(runtime) {
  const gateway = runtime.gateways?.get?.('wechat');
  if (!gateway || typeof gateway.bridgeStatus !== 'function') return '';
  return gateway.bridgeStatus().online && gateway.bridge?.accountOk === true ? gateway.bridge.account : '';
}

function bodyOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('invalid_host_capability_input');
  return input;
}

/** 插件不能点名桥接账号：任务必须由宿主当前确认的账号领取。 */
function withoutAccount(body) {
  const out = { ...body };
  delete out.account;
  return out;
}

function create(runtime) {
  const publisher = () => {
    if (!runtime.momentsPublisher) throw error('moments_publisher_unavailable');
    return runtime.momentsPublisher;
  };

  return {
    'moments.latest@1': () => ({ latest: runtime.moments.loadLatest() || null }),

    // 内存里的最近一次读取结果：与「重新读盘」区分开，路由的 /latest 要的是这个。
    'moments.snapshot@1': () => ({ snapshot: runtime.moments.snapshot() }),

    'moments.request@1': (input, plugin) => runtime.moments.request(plugin ? withoutAccount(bodyOf(input)) : input),

    'moments.action@1': (input, plugin) => runtime.moments.action(plugin ? withoutAccount(bodyOf(input)) : input),

    'moments.result@1': input => runtime.moments.result(text(bodyOf(input).id, 64)),

    'moments.settings@1': () => {
      const moments = runtime.config.moments || {};
      const pub = runtime.momentsPublisher;
      return {
        ok: true,
        settings: {
          autoLike: moments.autoLike === true,
          autoLikeMaxPerDay: Number(moments.autoLikeMaxPerDay) || 0,
          autoReadEveryHours: Number(moments.autoReadEveryHours) || 0,
        },
        // 只读投影：发表开关与当前状态分开给，路由可以原样拼回旧响应。
        publish: pub ? pub.settings() : null,
        status: pub ? pub.status() : null,
      };
    },

    /**
     * 发表：action='test' 让宿主生成一条草稿并排队，action='gate' 只回答
     * 「这条任务是否允许由当前账号执行」（桥接领取前的二次确认）。
     * 返回 ok 只代表任务已开始/允许，不代表已经发到微信。
     * gate 是桥接的内部闸门：插件只能要求发表，不能探测某个任务 id 的状态。
     */
    'moments.publish@1': (input, plugin) => {
      const body = bodyOf(input);
      const pub = publisher();
      const action = oneOf(body.action, ['test', 'gate'], 'test');
      if (action === 'gate') {
        if (plugin) throw error('invalid_host_capability_input');
        const account = text(body.account, 120);
        return { ok: true, allowed: Boolean(account && account === accountReady(runtime)
          && pub.allowed(text(body.id, 64), account)) };
      }
      const code = pub.queueTest(accountReady(runtime), body.withImage === true);
      return code ? { ok: false, code } : { ok: true, status: 'generating', confirmed: false };
    },

    'moments.claim@1': input => {
      const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
      const account = text(body.account, 120);
      if (!account) return { ok: true, job: null };
      const job = runtime.moments.claim(account)
        || (account === accountReady(runtime) ? runtime.momentsPublisher?.claim(account) : null);
      return { ok: true, job: job || null };
    },

    'moments.complete@1': input => {
      const body = bodyOf(input);
      if (body.publishStatus) return { ok: publisher().complete(body) };
      return runtime.moments.complete(body);
    },
  };
}

module.exports = { create };
