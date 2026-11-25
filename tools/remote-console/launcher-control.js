'use strict';

const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { createConnection } = require('node:net');
const path = require('node:path');

const parent = path.resolve(__dirname, '..');
const appRoot = path.basename(parent) === 'tools' && existsSync(path.join(parent, '..', 'launcher', 'WhaleLauncher.csproj'))
  ? path.dirname(parent) : parent;

// host-* 是手机端「主机」卡片用的本机状态与电源动作；不登记就会被 launcherControl 拦成「未知操作」。
const actions = new Set(['start', 'stop', 'restart', 'restart-bridge', 'restart-wechat', 'diagnostics',
  'host-state', 'host-keep-awake', 'host-wake-display', 'host-config']);
const configurationActions = new Set(['configuration-read', 'configuration-save']);
const featureActions = new Set(['voice-read', 'voice-toggle', 'voice-save', 'voice-check-key', 'voice-catalog',
  'voice-test', 'voice-test-status', 'voice-install-driver', 'sticker-open', 'sticker-open-collected', 'moments-open-pictures',
  'appearance-read', 'appearance-save',
  'market-read', 'market-install', 'market-enabled', 'market-remove']);

async function launcherControl(action, payload) {
  if (!actions.has(action) && !configurationActions.has(action) && !featureActions.has(action)) throw new Error('未知操作。');
  const root = appRoot.toUpperCase();
  const id = createHash('sha256').update(root).digest('hex').toUpperCase();
  const file = path.join(process.env.LOCALAPPDATA, 'WhaleGirlRemoteConsole', 'launcher-' + id + '.json');
  let target;
  try {
    target = JSON.parse(await readFile(file, 'utf8'));
    if (!/^[A-F0-9]{64}$/.test(target.key) || !Number.isInteger(target.port) ||
        target.port <= 0 || target.port > 65535) throw new Error();
  } catch {
    throw new Error('请在电脑上打开新版鲸鲸启动器。');
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: target.port });
    const chunks = [];
    let size = 0;
    const timeout = setTimeout(() => socket.destroy(new Error('启动器操作超时，请刷新诊断。')), 40000);
    socket.on('connect', () => socket.write(target.key + ' ' + JSON.stringify({ action, payload }) + '\n'));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > 512 * 1024) socket.destroy(new Error('启动器返回内容过长。'));
      else chunks.push(chunk);
    });
    socket.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('启动器返回的结果无法读取。')); }
    });
    socket.on('error', error => reject(error.code
      ? new Error('无法连接电脑上的鲸鲸启动器，请确认它已打开。') : error));
    socket.on('close', () => clearTimeout(timeout));
  });
}

module.exports = { actions, appRoot, launcherControl };
