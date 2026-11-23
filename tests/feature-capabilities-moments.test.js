'use strict';

/**
 * 朋友圈能力的验收。
 *
 * 覆盖读取任务链（request → claim → complete → result/snapshot/latest）、
 * 互动任务、发表（排队/闸门）与只读设置。桥接账号只能由宿主绑定：
 * 插件传 account 会被丢掉，否则可以指定别的微信账号领任务。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registry = require('../src/services/pluginProtocolRegistry.json');
const { MomentsService } = require('../src/services/moments');
const { MomentsPublisher } = require('../src/services/momentsPublisher');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { createFeatureCapabilities } = require('../src/services/features');

const CALLER = { id: 'moments-plugin', packageHash: 'hash', epoch: 'epoch',
  calls: ['moments.request@1', 'moments.action@1', 'moments.result@1', 'moments.publish@1', 'moments.settings@1'] };

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-feature-moments-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  const config = {
    paths: { dataDir: dir },
    moments: {
      autoLike: true, autoLikeMaxPerDay: 3, autoReadEveryHours: 6,
      publishFeatureEnabled: true, publishEnabled: false, publishIntervalHours: 6, publishMaxPerDay: 1,
      ...overrides,
    },
  };
  const bridge = { accountOk: true, account: 'acc' };
  const gateway = { bridge, verifyToken: () => true, bridgeStatus: () => ({ online: true }) };
  const moments = new MomentsService({ dir: path.join(dir, 'moments'), logger, config });
  const publisher = new MomentsPublisher({
    config, logger,
    store: { sessions: new Map(), messages: () => [] },
    llm: { isMock: false, complete: async () => null },
  });
  const runtime = { config, logger, moments, momentsPublisher: publisher,
    gateways: new Map([['wechat', gateway]]), store: { sessions: new Map(), messages: () => [] } };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  for (const [name, handler] of Object.entries(createFeatureCapabilities(runtime))) dispatcher.defineHost(name, handler);
  return { dispatcher, runtime, moments, publisher, bridge };
}

const sleep = () => new Promise(resolve => setImmediate(resolve));

test('读取任务链：request → claim → complete → result/snapshot/latest 全部走能力', async t => {
  const { dispatcher } = fixture(t);
  const job = await dispatcher.invokeHost('moments.request@1', { limit: 2 });
  assert.equal(job.status, 'queued');
  assert.ok(job.id);

  const claimed = await dispatcher.invokeHost('moments.claim@1', { account: 'acc' });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.job.id, job.id);
  assert.equal(claimed.job.action, 'read');

  const done = await dispatcher.invokeHost('moments.complete@1', {
    id: job.id, account: 'acc', items: [{ nickname: 'Peer', text: '春天来了', create_time: 1700000000 }],
  });
  assert.equal(done.status, 'done');
  assert.equal(done.items[0].text, '春天来了');

  assert.equal((await dispatcher.invokeHost('moments.result@1', { id: job.id })).status, 'done');
  const snapshot = await dispatcher.invokeHost('moments.snapshot@1', {});
  assert.equal(snapshot.snapshot.items[0].text, '春天来了');
  const latest = await dispatcher.invokeHost('moments.latest@1', {});
  assert.equal(latest.latest.items[0].text, '春天来了');
});

test('插件不能点名桥接账号，宿主内部调用可以绑定', async t => {
  const { dispatcher, moments } = fixture(t);
  // 插件路径：account 被丢掉，任务不带账号绑定。
  await dispatcher.invokeHost('moments.request@1', { limit: 1, account: 'evil' }, { plugin: CALLER });
  assert.equal(moments.job.expectedAccount, '');
  assert.equal((await dispatcher.invokeHost('moments.claim@1', { account: 'acc' })).job.id, moments.job.id);

  // 宿主路径（启动器指定账号）：绑定保留，其他账号领不走。
  moments.job = null;
  await dispatcher.invokeHost('moments.request@1', { limit: 1, account: 'acc' });
  assert.equal(moments.job.expectedAccount, 'acc');
});

test('互动任务：非法操作原样报错，合法操作排进队列并由桥接领取', async t => {
  const { dispatcher } = fixture(t);
  await assert.rejects(dispatcher.invokeHost('moments.action@1', { action: 'poke', publisher: 'A', keyword: 'x' }),
    (error) => error.statusCode === 400 && /不支持的朋友圈操作/.test(error.message));
  const job = await dispatcher.invokeHost('moments.action@1', {
    action: 'like', publisher: 'Peer', keyword: '春天来了',
  });
  assert.equal(job.status, 'queued');
  const claimed = await dispatcher.invokeHost('moments.claim@1', { account: 'acc' });
  assert.equal(claimed.job.action, 'like');
  const done = await dispatcher.invokeHost('moments.complete@1',
    { id: job.id, account: 'acc', performed: true });
  assert.equal(done.status, 'unconfirmed', '界面操作未核验时只能报 unconfirmed');
});

test('发表：触发排队返回 ok 但 confirmed 恒为 false；没有确认账号时报 account_not_verified', async t => {
  const { dispatcher, publisher } = fixture(t);
  const queued = await dispatcher.invokeHost('moments.publish@1', { action: 'test', withImage: false });
  assert.deepEqual(queued, { ok: true, status: 'generating', confirmed: false });
  await sleep();
  assert.equal(publisher.dailyCount(), 0, '手动发表不占每日额度');

  // 桥接没有确认账号时不能开始：不能把「已排队」当「已发表」。
  const offline = fixture(t, { publishFeatureEnabled: true });
  offline.bridge.accountOk = false;
  const refused = await offline.dispatcher.invokeHost('moments.publish@1', { action: 'test' });
  assert.deepEqual(refused, { ok: false, code: 'account_not_verified' });

  const disabled = fixture(t, { publishFeatureEnabled: false });
  const feature = await disabled.dispatcher.invokeHost('moments.publish@1', { action: 'test' });
  assert.deepEqual(feature, { ok: false, code: 'feature_disabled' });
});

test('发表闸门只认「当前账号 + 在途任务」，给布尔值不给内部细节', async t => {
  const { dispatcher, publisher } = fixture(t);
  const before = await dispatcher.invokeHost('moments.publish@1',
    { action: 'gate', id: 'job-1', account: 'acc' });
  assert.deepEqual(before, { ok: true, allowed: false });

  publisher.job = { id: 'job-1', at: Date.now(), claimedAt: Date.now(), account: 'acc',
    status: 'sending', revision: publisher.settingsRevision };
  assert.deepEqual(await dispatcher.invokeHost('moments.publish@1',
    { action: 'gate', id: 'job-1', account: 'acc' }), { ok: true, allowed: true });
  // 账号不符或任务不符一律 false。
  assert.equal((await dispatcher.invokeHost('moments.publish@1',
    { action: 'gate', id: 'job-1', account: 'other' })).allowed, false);
  assert.equal((await dispatcher.invokeHost('moments.publish@1',
    { action: 'gate', id: 'job-2', account: 'acc' })).allowed, false);
});

test('moments.settings@1 只读返回设置、发表配置与状态', async t => {
  const { dispatcher } = fixture(t);
  const out = await dispatcher.invokeHost('moments.settings@1', {});
  assert.equal(out.ok, true);
  assert.deepEqual(out.settings, { autoLike: true, autoLikeMaxPerDay: 3, autoReadEveryHours: 6 });
  assert.equal(out.publish.featureEnabled, true);
  assert.equal(out.publish.maxPerDay, 1);
  assert.equal(typeof out.status.status, 'string');
  assert.equal(typeof out.status.count, 'number');
  // 只是读：不产生任务。
  assert.equal(out.status.nextCheckAt, null);
});

test('桥接领取/回执不出现在 4 级 calls 白名单里', () => {
  for (const name of ['moments.claim@1', 'moments.complete@1']) {
    assert.ok(Object.hasOwn(registry.calls, name), name);
    assert.equal(registry.levels['4'].calls.includes(name), false, name);
  }
});
