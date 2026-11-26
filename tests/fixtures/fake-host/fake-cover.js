#!/usr/bin/env node
'use strict';

/**
 * 翻唱插件的假 cover CLI（只读本机 JSON、不出网、不写文件）。
 *
 * 市场插件通过 `execFile(process.execPath, [cli, ...args, '--json'])` 调它，
 * 所以这里就是一条普通 Node 脚本：从 argv 判断子命令，把结果打到 stdout。
 * 队列内容由环境变量 WHALE_FAKE_COVER_ORDERS 指向的 JSON 文件提供，
 * 用例只在自己进程里设置/还原这个变量，不污染其它测试。
 */

const fs = require('node:fs');

const argv = process.argv.slice(2);
const flag = name => {
  const index = argv.indexOf('--' + name);
  return index >= 0 ? argv[index + 1] : undefined;
};

function orders() {
  const file = process.env.WHALE_FAKE_COVER_ORDERS;
  if (!file) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const command = argv[0];
let payload;

if (command === 'list') {
  payload = { ok: true, orders: orders() };
} else if (command === 'order') {
  const groupId = flag('group-id') || '';
  payload = {
    ok: true,
    position: 1,
    order: {
      id: 'fake-order-1',
      song: flag('song') || '',
      artist: flag('artist') || '',
      status: 'pending',
      engine: flag('engine') || 'seedvc',
      createdAt: '2026-01-01T00:00:00.000Z',
      group: { id: groupId, name: flag('group-name') || groupId },
    },
  };
} else if (command === 'cancel' || command === 'render') {
  payload = { ok: true };
} else {
  payload = { ok: false, error: `unknown_command:${String(command)}` };
}

process.stdout.write(JSON.stringify(payload));
