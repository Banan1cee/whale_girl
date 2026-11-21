'use strict';
// HTTP 层只做三件事：接住桥接的 webhook、把内核契约的那几个 /api/* 交给 compat、把日志写下来。
// 业务顺序全在 lib/relay.js，方便用假 dsh 离线测。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { createOrders } = require('./lib/orders');
const { createCompat } = require('./lib/compat');
const { createRelay, createLogger } = require('./lib/relay');
const dsh = require('./lib/dsh');

const MAX_BODY = 32 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload == null ? {} : payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function parseJson(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function createServer(config, deps) {
  const injected = deps || {};
  const log = injected.logger || createLogger(config.logPath);
  const orders = injected.orders || createOrders({ root: config.stateRoot });
  const compat = injected.compat || createCompat({ config });
  const relay = createRelay({ config, orders, dsh: injected.dsh || dsh, logger: log });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = String(req.method || 'GET').toUpperCase();
    const path = url.pathname;
    try {
      if (method === 'POST' && path === '/webhook/wechat') {
        const raw = await readBody(req);
        const body = parseJson(raw);
        if (body === null) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
        if (config.bridgeToken) {
          const given = String(req.headers['x-bot-token'] || body.token || url.searchParams.get('token') || '');
          if (given !== config.bridgeToken) {
            log.warn('webhook token 不匹配', { given: given ? 'set' : 'empty' });
            sendJson(res, 403, { ok: false, error: 'token 不匹配' });
            return;
          }
        }
        const started = Date.now();
        const result = await relay.handleIncoming(body);
        log.info('webhook 完成', {
          action: result && result.action,
          replyChars: result && result.reply ? result.reply.length : 0,
          durationMs: Date.now() - started,
        });
        sendJson(res, 200, result);
        return;
      }

      let body = {};
      if (method !== 'GET' && method !== 'HEAD') {
        const raw = await readBody(req);
        body = parseJson(raw) || {};
      }
      const handled = compat.handle({
        method,
        path,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
        headers: req.headers,
      });
      if (handled) { sendJson(res, handled.status || 200, handled.json); return; }
      sendJson(res, 404, { ok: false, error: 'not found', path });
    } catch (err) {
      log.error('请求处理失败', { method, path, error: err && err.message });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
    }
  });
  return { server, relay, orders, compat, log };
}

// DSH 的 Windows 沙箱要给工作区目录写 ACL + 低完整性标签，实测只在用户目录（C:\Users\<你>\...）下成功：
// 盘根目录、D: 盘上的目录都会以 SetNamedSecurityInfoW Win32 5 失败，沙箱里连 echo 都跑不了。
// 与其让 worker 每轮静默失去 shell，不如在启动时判定并说明清楚。
function sandboxSupported(stateRoot) {
  const home = path.resolve(require('os').homedir()).toLowerCase();
  const target = path.resolve(stateRoot).toLowerCase();
  return target === home || target.startsWith(home + path.sep);
}

function main() {
  const config = loadConfig();
  fs.mkdirSync(config.deskCwd, { recursive: true });
  fs.mkdirSync(config.ordersRoot, { recursive: true });

  const sandboxOk = sandboxSupported(config.stateRoot);
  if (!sandboxOk && config.worker.permissionMode === 'workspace-write' && config.worker.fallbackPermissionMode) {
    console.warn('[relay] stateRoot 不在用户目录下，DSH 的 Windows 沙箱无法在此落地 ACL；');
    console.warn('        worker 改用 ' + config.worker.fallbackPermissionMode + '（没有文件沙箱）。');
    console.warn('        想恢复沙箱：把 config.json 的 stateRoot 设成 "" 或放到 ' + require('os').homedir() + ' 下面。');
    config.worker.permissionMode = config.worker.fallbackPermissionMode;
  }

  const built = createServer(config);
  let dshInfo;
  try { dshInfo = dsh.resolveDsh(config.dsh); } catch (err) { dshInfo = { source: 'unresolved', error: err.message }; }

  built.server.listen(config.port, '127.0.0.1', () => {
    console.log('relay 已启动');
    console.log('  监听      http://127.0.0.1:' + config.port);
    console.log('  状态目录  ' + config.stateRoot);
    console.log('  前台工作区 ' + config.deskCwd);
    console.log('  配置      ' + config.file + (config.exists ? '' : '（不存在，用默认值）'));
    console.log('  DSH 入口  ' + dshInfo.source + (dshInfo.error ? '（' + dshInfo.error + '）' : ''));
    console.log('  确认模式  ' + config.orders.confirmMode + (config.owner.chatId ? '（老板会话已配）' : '（未配老板会话，指令不可用）'));
    console.log('把桥接的 WHALE_BOT_URL 指到 http://127.0.0.1:' + config.port + '/webhook/wechat 即可接管。');
  });

  const shutdown = () => {
    built.log.info('relay 收到退出信号');
    built.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createServer, main, sandboxSupported };
