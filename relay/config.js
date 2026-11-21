'use strict';
// relay 的配置只做一件事：把「谁是前台、谁是工人、能花多久、状态放哪」变成可改的值，
// 业务代码一律不读环境变量，也不自己拼路径。

const fs = require('fs');
const os = require('os');
const path = require('path');

const RELAY_DIR = __dirname;
const EXAMPLE = path.join(RELAY_DIR, 'config.example.json');
const LOCAL = path.join(RELAY_DIR, 'config.json');

const DEFAULTS = {
  port: 8790,
  // 留空 = 放到用户目录（%LOCALAPPDATA%\wc-auto-accept-orders\state）。
  // 原因见 server.js 的沙箱自检：DSH 的 Windows 沙箱只能在用户目录下写工作区的 ACL，
  // 放到仓库所在的 D: 盘上会让 workspace-write 直接不可用（沙箱里 shell 全报 Win32 5）。
  stateRoot: '',
  bridgeToken: '',
  dsh: {
    command: '',
    electronPath: 'D:/DeepSeek Harness/DeepSeek Harness.exe',
    binPath: 'D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
    sdkProfile: 'relay-sdk',
    env: {},
  },
  // 前台用快模型（下单前必须回得快），工人用能扛活的模型。
  // 权限是会话级 preset（会话里发 /permission <preset> 设置）；DSH 的 Windows 沙箱只在用户目录下能落地，
  // 所以 stateRoot 不在用户目录时 server.js 会把 worker 自动切到 fallbackPermissionMode。
  desk: { timeoutMs: 120000, permissionMode: 'read-only', model: 'deepseek-flash' },
  worker: {
    timeoutMs: 600000,
    permissionMode: 'workspace-write',
    fallbackPermissionMode: 'danger-full-access',
    evalPermissionMode: 'read-only',
    // 下单前的可行性判断必须快：要的是两三句话的结论，不是完整方案，所以卡 45 秒。
    evalTimeoutMs: 45000,
    model: 'deepseek-v4-pro',
    idleWatchMs: 1800000,
  },
  orders: { confirmMode: 'frontdesk', maxReplyChars: 1200, bubbleChars: 180 },
  owner: { chatId: '', paused: false },
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error('配置文件不是合法 JSON：' + file + '（' + err.message + '）');
  }
}

function pick(base, patch) {
  const out = Object.assign({}, base);
  for (const key of Object.keys(patch || {})) {
    const v = patch[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[key] && typeof base[key] === 'object') {
      out[key] = pick(base[key], v);
    } else if (v !== undefined) {
      out[key] = v;
    }
  }
  return out;
}

function loadConfig(file) {
  const wanted = file || process.env.RELAY_CONFIG || LOCAL;
  const merged = pick(DEFAULTS, readJson(wanted) || {});
  if (process.env.RELAY_PORT) merged.port = Number(process.env.RELAY_PORT) || merged.port;
  if (process.env.RELAY_STATE) merged.stateRoot = process.env.RELAY_STATE;
  if (process.env.RELAY_PAUSED === '1' || process.env.RELAY_PAUSED === 'true') merged.owner.paused = true;

  const rawState = String(merged.stateRoot || '').trim();
  const stateRoot = rawState
    ? (path.isAbsolute(rawState) ? rawState : path.resolve(RELAY_DIR, rawState))
    : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'wc-auto-accept-orders', 'state');

  return {
    file: wanted,
    exists: fs.existsSync(wanted),
    port: merged.port,
    stateRoot,
    bridgeToken: merged.bridgeToken,
    dsh: merged.dsh,
    desk: merged.desk,
    worker: merged.worker,
    orders: merged.orders,
    owner: merged.owner,
    // 前台只有一个 session 池，工人一单一区，两个目录决定 GUI 里看到的工作区分组
    deskCwd: path.join(stateRoot, 'desk'),
    ordersRoot: path.join(stateRoot, 'orders'),
    logPath: path.join(stateRoot, 'relay.log'),
  };
}

module.exports = { loadConfig, DEFAULTS, EXAMPLE, LOCAL, RELAY_DIR };
