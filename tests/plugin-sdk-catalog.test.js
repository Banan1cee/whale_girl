'use strict';

/**
 * pluginSdk 目录的验收。
 *
 * 目录只从 pluginProtocolRegistry.json 派生，不允许另抄一份能力表：
 * 这里逐条比对注册表，确保 pluginVisible / enabled / implemented 不会被手写错。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/services/pluginProtocolRegistry.json');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { createFeatureCapabilities } = require('../src/services/features');
const { CAPABILITIES, createSdkCatalog, assertCatalogueComplete, missingHosts } = require('../src/services/pluginSdk');

const names = () => Object.keys(registry.calls).sort();

function dispatcherWith(list) {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  for (const name of list) {
    // 只关心「有没有登记」，返回值不参与这里的分发。
    dispatcher.defineHost(name, async () => ({}));
  }
  return dispatcher;
}

test('CAPABILITIES 与注册表逐条一致，且不含手写增量', () => {
  assert.deepEqual(CAPABILITIES.map(row => row.name), names());
  for (const row of CAPABILITIES) {
    const spec = registry.calls[row.name];
    assert.equal(row.sideEffect, spec.sideEffect, row.name);
    assert.equal(row.requiresConsent, spec.requiresConsent === true, row.name);
    assert.equal(row.enabled, spec.enabled !== false, row.name);
    assert.equal(row.pluginVisible, registry.levels['4'].calls.includes(row.name), row.name);
    // 静态清单不该假装知道实现状态。
    assert.equal(row.implemented, null, row.name);
  }
});

test('保留能力 message.submit@1 仍是「插件可见但未开放」，发送走 message.send@1', () => {
  const submit = CAPABILITIES.find(row => row.name === 'message.submit@1');
  assert.deepEqual(submit, {
    name: 'message.submit@1', sideEffect: 'external-message', requiresConsent: true,
    enabled: false, pluginVisible: true, implemented: null,
  });
  const send = createSdkCatalog({ capabilities: dispatcherWith([]) }).find(row => row.name === 'message.send@1');
  assert.equal(send.enabled, true);
  assert.equal(send.pluginVisible, true);
  assert.equal(send.requiresConsent, true);
});

test('createSdkCatalog 用运行期 hostContracts 判断 implemented', () => {
  const runtime = { capabilities: dispatcherWith(['status.read@1', 'memory.recall@1']) };
  const catalog = createSdkCatalog(runtime);
  assert.deepEqual(catalog.map(row => row.name), names());
  const byName = new Map(catalog.map(row => [row.name, row]));
  assert.equal(byName.get('status.read@1').implemented, true);
  assert.equal(byName.get('memory.recall@1').implemented, true);
  assert.equal(byName.get('moments.publish@1').implemented, false);
  // 未装配能力的目录一律 false，而不是 undefined。
  assert.ok(createSdkCatalog({}).every(row => row.implemented === false));
});

test('assertCatalogueComplete 在全部已启用能力都有实现时返回 true', () => {
  const enabled = names().filter(name => registry.calls[name].enabled !== false);
  assert.equal(assertCatalogueComplete({ capabilities: dispatcherWith(enabled) }), true);
});

test('缺实现时抛 capability_catalogue_incomplete 并列出能力名', () => {
  const runtime = { capabilities: dispatcherWith(['status.read@1']) };
  const missing = missingHosts(runtime);
  assert.ok(missing.includes('memory.recall@1'));
  assert.ok(!missing.includes('message.submit@1'), '未开放的保留能力不算缺口');
  assert.throws(() => assertCatalogueComplete(runtime), (error) => {
    assert.equal(error.code, 'capability_catalogue_incomplete');
    assert.ok(error.missing.includes('memory.recall@1'));
    assert.match(error.message, /memory\.recall@1/);
    return true;
  });
});

test('真实功能模块覆盖注册表里全部已启用能力（启动自检口径）', () => {
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  for (const [name, handler] of Object.entries(createFeatureCapabilities({}))) {
    dispatcher.defineHost(name, handler);
  }
  const runtime = { capabilities: dispatcher };
  assert.deepEqual(missingHosts(runtime), [], '注册表新增能力后必须同时补 features/*.js 的实现');
  assert.equal(assertCatalogueComplete(runtime), true);
});
