'use strict';

/**
 * 表情包能力的插件归属验收。
 *
 * 为什么单独测：表情包任务不是「调用完就结束」，它进队列等桥接来领。
 * 如果队列项不记插件归属，插件被撤回授权后那条任务还会照发 —— 这是旁路。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stickers = require('../src/adapters/stickers');
const { StickerService } = require('../src/services/stickerService');
const { loadConfig } = require('../src/infra/config');
const { createFeatureCapabilities } = require('../src/services/features');

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const HASH = 'a'.repeat(64);
const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sticker-plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const config = loadConfig({ root, env: {} });
  config.root = root;
  config.features.stickers = true;
  config.sticker.chances = { other: 1 };
  stickers.upload(config, root, 'other', [{ name: 'a.gif', data: GIF.toString('base64') }]);
  const service = new StickerService(config, { logger: silentLogger });
  let approved = true;
  service.pluginAllowed = item => approved && item.pluginHash === HASH;
  const runtime = { config, stickerService: service, plugins: { isApprovedIdHash: () => approved } };
  const handlers = createFeatureCapabilities(runtime);
  return { service, handlers, revoke: () => { approved = false; } };
}

test('插件排队时写入 id 与安装包摘要', t => {
  const { handlers } = setup(t);
  const out = handlers['stickers.enqueue@1']({ emotion: 'other', chat: '文件传输助手' },
    { id: 'demo-plugin', packageHash: HASH });
  assert.equal(out.queued.pluginId, 'demo-plugin');
  assert.equal(out.queued.pluginHash, HASH);
});

test('宿主内部排队不带归属，不被插件撤权影响', t => {
  const { handlers, service, revoke } = setup(t);
  const out = handlers['stickers.enqueue@1']({ emotion: 'other', chat: '文件传输助手' }, null);
  assert.equal(out.queued.pluginId, undefined);
  revoke();
  service.reconcile();
  assert.equal(service.pending().length, 1, '宿主自己的任务不该被插件撤权作废');
});

test('插件撤权后，队列里未发出的任务被作废', t => {
  const { handlers, service, revoke } = setup(t);
  handlers['stickers.enqueue@1']({ emotion: 'other', chat: '文件传输助手' },
    { id: 'demo-plugin', packageHash: HASH });
  assert.equal(service.pending().length, 1);
  revoke();
  service.reconcile();
  assert.equal(service.pending().length, 0, '撤权后不应再留可领取的任务');
});

test('不同插件的同名目标不会互相去重吞掉', t => {
  const { handlers, service } = setup(t);
  const one = handlers['stickers.enqueue@1']({ emotion: 'other', chat: '文件传输助手' },
    { id: 'alpha', packageHash: HASH });
  const two = handlers['stickers.enqueue@1']({ emotion: 'other', chat: '文件传输助手' },
    { id: 'beta', packageHash: HASH });
  assert.notEqual(one.queued.id, two.queued.id);
  assert.equal(service.pending().length, 2);
});
