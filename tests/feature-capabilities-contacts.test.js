'use strict';

/**
 * 通讯录能力（contacts.get@1 / contacts.list@1，并保证 contacts.search@1 行为不变）的验收。
 *
 * 数据只来自桥接推送的缓存，所以这里直接构造真实 ContactsCache，验证
 * 字段清洗、类型过滤、分页，以及旧 search 的 type=friend（历史上等同 all）不被改坏。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ContactsCache } = require('../src/services/contacts');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { createFeatureCapabilities } = require('../src/services/features');

const ITEMS = [
  { wxid: 'wxid_alice', name: '爱丽丝', remark: '同事' },
  { wxid: 'wxid_bob', name: '鲍勃' },
  { wxid: '123@chatroom', name: '深海鱼塘群' },
];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-feature-contacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const config = { paths: { dataDir: dir } };
  const contacts = new ContactsCache(config, { logger: null });
  contacts.sync({ account: 'acc', items: ITEMS, at: 1760000000000 });
  const runtime = { config, contacts };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  for (const [name, handler] of Object.entries(createFeatureCapabilities(runtime))) dispatcher.defineHost(name, handler);
  return { dispatcher, contacts, runtime };
}

test('contacts.list@1 默认返回与旧 payload 完全一致的字段', async t => {
  const { dispatcher, contacts } = fixture(t);
  const out = await dispatcher.invokeHost('contacts.list@1', {});
  assert.deepEqual(out, contacts.payload({ q: '', type: 'all' }));
  assert.equal(out.total, 3);
  assert.equal(out.account, 'acc');
  assert.equal(out.updatedAt, 1760000000000);
});

test('contacts.list@1 支持类型过滤、关键词与分页', async t => {
  const { dispatcher } = fixture(t);
  const users = await dispatcher.invokeHost('contacts.list@1', { type: 'user' });
  assert.equal(users.items.length, 2);
  assert.equal(users.total, 3, 'total 仍是缓存总量');

  const groups = await dispatcher.invokeHost('contacts.list@1', { type: 'group' });
  assert.deepEqual(groups.items.map(item => item.wxid), ['123@chatroom']);

  const keyword = await dispatcher.invokeHost('contacts.list@1', { q: '爱丽' });
  assert.deepEqual(keyword.items.map(item => item.wxid), ['wxid_alice']);

  const page = await dispatcher.invokeHost('contacts.list@1', { limit: 1, offset: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].wxid, 'wxid_bob');

  const tail = await dispatcher.invokeHost('contacts.list@1', { offset: 99 });
  assert.deepEqual(tail.items, []);
});

test('contacts.list@1 在缓存缺失时返回空结构而不是抛错', async t => {
  const { dispatcher } = fixture(t);
  const empty = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  for (const [name, handler] of Object.entries(createFeatureCapabilities({ config: {}, contacts: null }))) {
    empty.defineHost(name, handler);
  }
  assert.deepEqual(await empty.invokeHost('contacts.list@1', {}),
    { ok: true, account: '', updatedAt: 0, total: 0, items: [] });
  // 非对象输入按「没传参数」处理：读操作返回全量，不该让调用方拿异常。
  assert.deepEqual(await dispatcher.invokeHost('contacts.list@1', 'not-an-object'),
    await dispatcher.invokeHost('contacts.list@1', {}));
});

test('contacts.get@1 精确匹配 wxid、兼容账号目录名后缀，缺参报错', async t => {
  const { dispatcher } = fixture(t);
  assert.equal((await dispatcher.invokeHost('contacts.get@1', { wxid: 'wxid_alice' })).contact.remark, '同事');
  // 启动器里看到的是账号目录名（wxid_alice_c248），缓存里是真 wxid：仍要查到。
  assert.equal((await dispatcher.invokeHost('contacts.get@1', { wxid: 'wxid_alice_c248' })).contact.name, '爱丽丝');
  assert.equal((await dispatcher.invokeHost('contacts.get@1', { wxid: 'wxid_nobody' })).contact, null);
  await assert.rejects(dispatcher.invokeHost('contacts.get@1', { wxid: '   ' }),
    { code: 'invalid_host_capability_input' });
  await assert.rejects(dispatcher.invokeHost('contacts.get@1', {}),
    { code: 'invalid_host_capability_input' });
});

test('contacts.search@1 行为保持不变：type=friend 仍等同 all', async t => {
  const { dispatcher, contacts } = fixture(t);
  assert.deepEqual(await dispatcher.invokeHost('contacts.search@1', { q: '', type: 'friend' }),
    contacts.payload({ q: '', type: 'friend' }));
  const all = await dispatcher.invokeHost('contacts.search@1', {});
  assert.equal(all.items.length, 3);
  const groups = await dispatcher.invokeHost('contacts.search@1', { type: 'group' });
  assert.equal(groups.items.length, 1);
});
