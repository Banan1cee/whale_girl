'use strict';

/**
 * 发送能力（message.send@1）的验收。
 *
 * 重点不是「能排进队列」，而是：队列项必须绑定调用方的插件身份与安装包摘要，
 * 返回结构只能表达 queued 且 confirmed 恒为 false，不能暗示已送达。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { createFeatureCapabilities } = require('../src/services/features');

function fixture(enqueueNow) {
  const sent = [];
  const runtime = {
    reminders: {
      enqueueNow(args) {
        sent.push(args);
        return enqueueNow ? enqueueNow(args) : { id: 'rem-1', dueAt: 1, status: 'pending' };
      },
    },
  };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: { isApproved: () => true } });
  for (const [name, handler] of Object.entries(createFeatureCapabilities(runtime))) dispatcher.defineHost(name, handler);
  return { dispatcher, sent };
}

const plugin = id => ({ id, packageHash: `hash-${id}`, epoch: `epoch-${id}`, calls: ['message.send@1'] });

test('message.send@1 排进队列，返回 {id,status:"queued",confirmed:false} 且绑定插件身份', async () => {
  const { dispatcher, sent } = fixture();
  const out = await dispatcher.invokeHost('message.send@1', {
    chatId: 'wxid_fixture', text: '你好，这是插件发的', name: '小助手', chatType: 'group', delivery: 'voice',
  }, { plugin: plugin('sender') });
  assert.deepEqual(out, { id: 'rem-1', status: 'queued', confirmed: false });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    wxid: 'wxid_fixture', name: '小助手', chatType: 'group', text: '你好，这是插件发的',
    kind: 'plugin', pluginId: 'sender', pluginHash: 'hash-sender', delivery: 'voice',
  });
  // 不是送达：没有 delivered / sent 这类字段，confirmed 只能是 false。
  assert.equal(Object.hasOwn(out, 'delivered'), false);
});

test('文本消息默认 delivery=text、chatType=private，安装包摘要取 packageHash', async () => {
  const { dispatcher, sent } = fixture();
  await dispatcher.invokeHost('message.send@1', { chatId: 'wxid_a', text: '在吗' }, { plugin: plugin('plain') });
  assert.equal(sent[0].delivery, 'text');
  assert.equal(sent[0].chatType, 'private');
  assert.equal(sent[0].pluginHash, 'hash-plain');
});

test('没有插件上下文、缺字段或输入不是对象都拒绝，不写队列', async () => {
  const { dispatcher, sent } = fixture();
  await assert.rejects(dispatcher.invokeHost('message.send@1', { chatId: 'c', text: 'x' }),
    { code: 'plugin_required' });
  await assert.rejects(dispatcher.invokeHost('message.send@1', { chatId: 'c' },
    { plugin: plugin('a') }), { code: 'invalid_host_capability_input' });
  await assert.rejects(dispatcher.invokeHost('message.send@1', { text: 'x' },
    { plugin: plugin('a') }), { code: 'invalid_host_capability_input' });
  await assert.rejects(dispatcher.invokeHost('message.send@1', { chatId: 'c', text: '   ' },
    { plugin: plugin('a') }), { code: 'invalid_host_capability_input' });
  await assert.rejects(dispatcher.invokeHost('message.send@1', 'not-an-object',
    { plugin: plugin('a') }), { code: 'invalid_host_capability_input' });
  assert.deepEqual(sent, []);
});

test('插件没声明就不能发；message.submit@1 保持关闭', async () => {
  const { dispatcher } = fixture();
  await assert.rejects(dispatcher.invokeHost('message.send@1', { chatId: 'c', text: 'x' },
    { plugin: { id: 'undeclared', packageHash: 'h', calls: [] } }), { code: 'host_capability_not_declared' });
  await assert.rejects(dispatcher.invokeHost('message.submit@1', { chatId: 'c', text: 'x' },
    { plugin: { id: 'reserved', packageHash: 'h', calls: ['message.submit@1'] } }), { code: 'host_capability_disabled' });
});

test('异常长的队列项 id 会被截断到输出 schema 的 80 字符上限', async () => {
  // 截断而不是报错：队列项已经写进去了，这里再把整个调用判失败只会让插件误以为没排队。
  const { dispatcher } = fixture(() => ({ id: 'x'.repeat(120), status: 'pending' }));
  const out = await dispatcher.invokeHost('message.send@1', { chatId: 'c', text: 'x' }, { plugin: plugin('a') });
  assert.equal(out.id.length, 80);
  assert.equal(out.status, 'queued');
  assert.equal(out.confirmed, false);
});

