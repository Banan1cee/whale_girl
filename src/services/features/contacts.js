'use strict';

/**
 * 通讯录能力。数据来自桥接推送的联系人缓存，只读。
 *
 * search / list 的区别是历史包袱：search 的 type 是启动器选择器用的
 * all/friend/group（friend 实际回退成 all），不能动；list 用接口真实的
 * all/user/group，并支持分页，插件按后者取全量更清楚。
 */

const { error, text, oneOf } = require('./helpers');

function bodyOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('invalid_host_capability_input');
  return input;
}

function page(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function create(runtime) {
  const cache = () => (runtime.contacts ? runtime.contacts : null);

  return {
    'contacts.search@1': input => runtime.contacts.payload({
      q: text(input.q, 80), type: oneOf(input.type, ['all', 'friend', 'group'], 'all'),
    }),

    // 桥接定期把 wxid 清单推上来：写的是缓存，属于通讯录域，跟读接口放一起。
    'contacts.sync@1': input => {
      const contacts = cache();
      if (!contacts) throw error('contacts_unavailable');
      const body = bodyOf(input);
      const out = contacts.sync({
        account: text(body.account, 120) || '',
        items: Array.isArray(body.items) ? body.items : [],
        at: Number(body.at) || Date.now(),
      });
      return { ok: true, ...out };
    },

    'contacts.get@1': input => {
      const body = bodyOf(input);
      const wxid = text(body.wxid ?? body.id, 120).trim();
      if (!wxid) throw error('invalid_host_capability_input');
      return { ok: true, contact: runtime.contacts?.get(wxid) || null };
    },

    'contacts.list@1': input => {
      const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
      const contacts = cache();
      if (!contacts) return { ok: true, account: '', updatedAt: 0, total: 0, items: [] };
      const payload = contacts.payload({
        q: text(body.q, 40), type: oneOf(body.type, ['all', 'user', 'group'], 'all'),
      });
      // limit=0 表示不截断：路由的旧响应就是全量。
      const limit = Math.min(2000, page(body.limit));
      const offset = Math.min(2000, page(body.offset));
      const items = (limit ? payload.items.slice(offset, offset + limit) : payload.items.slice(offset))
        .map(item => ({ ...item }));
      return { ok: true, account: payload.account, updatedAt: payload.updatedAt, total: payload.total, items };
    },
  };
}

module.exports = { create };
