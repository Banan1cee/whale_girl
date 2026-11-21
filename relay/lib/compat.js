'use strict';

/**
 * relay/lib/compat.js —— 顶替 src/ 内核里「微信桥接会真调用」的那批 HTTP 接口。
 *
 * 为什么需要这一层：bridge/ 是 Python 进程，只认 WHALE_BOT_URL 一个地址。它把内核
 * 既当聊天入口（POST /webhook/wechat），又当控制面（发言范围 / 心跳 / 联系人清单 /
 * 视觉识别 / 主动搭话 / 朋友圈 / 提醒 / 表情包）。本项目换成「前台 + 工人」以后，
 * 业务只剩 webhook 一条，其余接口必须给出「关掉但可用」的回应 —— 缺一个就可能让
 * 桥接静默降级甚至整条链路不可用。逐条调用清单和依据见 relay/docs/bridge-contract.md。
 *
 * 本模块是纯路由：不读文件、不联网、不起定时器。可变的输入只在 handle() 调用时
 * 现读：
 *   - config.owner.paused（人工接管）与 RELAY_PAUSED 环境变量 → 唯一的发送闸门；
 *   - config.bridgeToken → 桥接专用接口的鉴权（留空 = 本地开发不校验）。
 *
 * 返回 { status, json } 表示认领；返回 null 表示「不是内核契约里的路径」，交给
 * server.js 走 404。POST /webhook/wechat 不在这里认领，它由 relay.js 产生回复。
 */

const SERVICE = 'whale-girl';

// 关掉的功能统一回 { ok: true, disabled: true }：桥接对这几个前缀只做 JSON 解析，
// 从不依赖里面的业务字段，但 404/500 会让它反复记失败日志。
const DISABLED_PREFIXES = ['/api/care', '/api/moments', '/api/stickers', '/api/reminders'];

function createCompat({ config } = {}) {
  const resolved = config || {};
  return {
    handle(req) {
      return handleRequest(req || {}, resolved);
    },
  };
}

function handleRequest(req, config) {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    const path = normalizePath(req.path);
    if (!path) return null;

    const query = normalizeQuery(req.query);
    const body = normalizeBody(req.body);
    const headers = req.headers || {};

    const route = ROUTES.find((r) => r.method === method && r.path === path);
    if (route) {
      if (route.bridgeToken && !bridgeTokenOk(headers, query, body, config)) {
        return reply(403, { ok: false, error: '桥接 token 不正确' });
      }
      return reply(200, route.reply({ body, query, config, headers }));
    }

    if (isDisabledPrefix(path)) return reply(200, { ok: true, disabled: true });
    return null;
  } catch (err) {
    // 契约要求关闭的功能绝不 500；走到这里只可能是代码 bug，给一个能看的 JSON。
    return reply(500, { ok: false, error: 'compat 处理失败：' + (err && err.message ? err.message : String(err)) });
  }
}

// 逐条对齐 bridge/ 的真实调用点。bridgeToken 表示「桥接会带 x-bot-token」的接口，
// 和内核 src/http/routes/*.js 里的鉴权范围一致。
const ROUTES = [
  {
    // bridge/config.py wait_for_server：只认这一个 GET，body 必须同时含 ok/up/service。
    method: 'GET',
    path: '/healthz',
    bridgeToken: false,
    reply: () => ({ ok: true, up: true, service: SERVICE }),
  },
  {
    // sender_mixin.py send_policy_allows：每次发送前都问，3 秒超时；返回非 ok 会直接停发。
    method: 'POST',
    path: '/api/wechat/send-permission',
    bridgeToken: true,
    reply: ({ config }) => {
      if (pausedNow(config)) return { ok: true, allowed: false, reason: 'paused' };
      return { ok: true, allowed: true };
    },
  },
  {
    // loop_mixin.py bridge_heartbeat：只要 2xx；body 不解析，但保留内核的形状方便排查。
    method: 'POST',
    path: '/api/bridge/heartbeat',
    bridgeToken: true,
    reply: () => ({ ok: true, online: true, serverTime: Date.now() }),
  },
  {
    // loop_mixin.py contacts_sync_once：只按 HTTP 200 判成败；count 仅用于日志/启动器。
    method: 'POST',
    path: '/api/wechat/contacts/sync',
    bridgeToken: true,
    reply: ({ body }) => {
      const items = Array.isArray(body.items) ? body.items : [];
      const at = Number(body.at);
      return {
        ok: true,
        count: items.length,
        account: typeof body.account === 'string' ? body.account : '',
        updatedAt: Number.isFinite(at) && at > 0 ? at : Date.now(),
      };
    },
  },
  {
    // receiver_mixin.py describe_image / describe_emoji：桥接不带 token，只读 text/ok。
    // 本项目没有视觉能力：必须 200 + JSON，返回 404/500 会让识图异常（虽然会降级成占位文本）。
    method: 'POST',
    path: '/api/vision',
    bridgeToken: false,
    reply: () => ({ ok: false, error: 'vision disabled' }),
  },
  {
    // loop_mixin.py care_watch：桥接只读 due/reason/target；不带 token。
    method: 'GET',
    path: '/api/care/due',
    bridgeToken: false,
    reply: () => ({
      ok: true, due: false, reason: 'disabled', target: null,
      windows: [], gapMinutes: null, waitMinutes: null, sentToday: 0, maxPerDay: 0, now: '',
    }),
  },
  {
    // loop_mixin.py care_watch：只读 text；空文本 = 这轮不搭话。
    method: 'GET',
    path: '/api/care',
    bridgeToken: false,
    reply: () => ({ ok: true, text: '', mock: false }),
  },
  {
    // loop_mixin.py care_watch 的回传：checked by .ok；重复 id 由内核去重，这里不用管。
    method: 'POST',
    path: '/api/care/sent',
    bridgeToken: true,
    reply: () => ({ ok: true }),
  },
  {
    // reminder_watch.py ReminderRunner：桥接读 items/nextDueAt；nextDueAt=0 表示没有下一条。
    method: 'GET',
    path: '/api/reminders/due',
    bridgeToken: true,
    reply: () => ({ ok: true, items: [], nextDueAt: 0, now: Date.now() }),
  },
  {
    // reminder_watch.py ack：response.ok 为 false 会触发有界重试簿记；这里恒成功。
    method: 'POST',
    path: '/api/reminders/ack',
    bridgeToken: true,
    reply: () => ({ ok: true, item: null }),
  },
  {
    // reminder_watch.py 插件提醒的额外授权：ok=true 才允许发；本项目不发插件提醒。
    method: 'POST',
    path: '/api/reminders/permission',
    bridgeToken: true,
    reply: () => ({ ok: false }),
  },
  {
    // moments.py MomentsReader.tick：每 5 秒领一次任务；job=null 表示没有任务。
    method: 'POST',
    path: '/api/moments/claim',
    bridgeToken: true,
    reply: () => ({ ok: true, job: null }),
  },
  {
    // moments.py 发表闸门：桥接读 allowed is True，false 即取消。
    method: 'POST',
    path: '/api/moments/publish-gate',
    bridgeToken: true,
    reply: () => ({ ok: true, allowed: false }),
  },
  {
    // moments.py 结果回传：只按 HTTP 200 判成败。
    method: 'POST',
    path: '/api/moments/complete',
    bridgeToken: true,
    reply: () => ({ ok: true }),
  },
  {
    // sticker_mixin.py sticker_gate：要求 ok/enabled/generation/jobs 齐全；enabled=false 即关闭。
    method: 'GET',
    path: '/api/stickers/gate',
    bridgeToken: true,
    reply: () => ({ ok: true, enabled: false, generation: 'disabled', jobs: [] }),
  },
  {
    // sticker_mixin.py sticker_test_loop：items=[] 表示没有待发任务。
    method: 'GET',
    path: '/api/stickers/pending',
    bridgeToken: true,
    reply: () => ({ ok: true, items: [] }),
  },
  {
    method: 'POST',
    path: '/api/stickers/claim',
    bridgeToken: true,
    reply: () => ({ ok: true, item: null }),
  },
  {
    method: 'POST',
    path: '/api/stickers/ack',
    bridgeToken: true,
    reply: () => ({ ok: true, item: null }),
  },
  {
    method: 'POST',
    path: '/api/stickers/cancel',
    bridgeToken: true,
    reply: () => ({ ok: true, item: null }),
  },
];

function reply(status, json) {
  return { status, json };
}

function normalizePath(path) {
  let text = String(path || '').split('?')[0];
  if (!text.startsWith('/')) text = '/' + text;
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1);
  return text;
}

// server.js 传的是 Object.fromEntries(URLSearchParams)；测试里也可能直接给 URLSearchParams。
function normalizeQuery(query) {
  if (!query) return Object.create(null);
  if (typeof query.get === 'function') {
    const out = Object.create(null);
    try {
      for (const [key, value] of query.entries()) out[key] = value;
    } catch (err) {
      return Object.create(null);
    }
    return out;
  }
  if (typeof query === 'object') return query;
  return Object.create(null);
}

// 兼容桥接可能发来的「已经解析好的对象」和「原始 JSON 字符串」两种形态。
function normalizeBody(body) {
  if (body == null) return Object.create(null);
  if (typeof body === 'string') {
    if (!body.trim()) return Object.create(null);
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : Object.create(null);
    } catch (err) {
      return Object.create(null);
    }
  }
  if (typeof body === 'object' && !Array.isArray(body)) return body;
  return Object.create(null);
}

function isDisabledPrefix(path) {
  return DISABLED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}

// 与内核 gateway.verifyToken 一致：头 / 查询参数 / 请求体三处任一命中即可。
function bridgeTokenOk(headers, query, body, config) {
  const expected = String((config && config.bridgeToken) || '').trim();
  if (!expected) return true;
  const fromHeader = headerValue(headers, 'x-bot-token') || headerValue(headers, 'x-bot-signature');
  const candidates = [fromHeader, query && query.token, body && body.token,
    body && body.verify_token, body && body.signature];
  return candidates.some((value) => String(value == null ? '' : value) === expected);
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const direct = headers[name];
  if (direct != null) return Array.isArray(direct) ? direct[0] : String(direct);
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      return Array.isArray(value) ? value[0] : String(value == null ? '' : value);
    }
  }
  return '';
}

// 人工接管开关：config.owner.paused 或 RELAY_PAUSED=1/true。每次 handle 都现读，
// 让老板在微信里 #接管 / #恢复（或改 config）后下一轮发送立刻生效，不用重启 relay。
function pausedNow(config) {
  try {
    if (config && config.owner && pausedValue(config.owner.paused)) return true;
  } catch (err) {
    // 坏配置不影响发送默认行为
  }
  const raw = String(process.env.RELAY_PAUSED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

// 配置文件是手写的，可能出现 "true"/"1" 这种字符串；但 "false" 必须真的是 false。
function pausedValue(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes' || text === 'on';
  }
  return false;
}

module.exports = { createCompat };
