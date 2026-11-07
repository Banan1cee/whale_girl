'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../server');
const { careTargets } = require('../src/services/care');

const token = 'test-only-send-policy-token';
const peer = 'wxid_test_policy_peer';
const owner = 'wxid_test_policy_owner';
const group = 'test-policy-group@chatroom';

async function start(root) {
  return startServer({ root, port: 0, env: { WHALE_LOG_FILE: '' } });
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-policy-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    gateway: { wechat: { enabled: true, inboundToken: token } }, watchConfig: false,
    env: { autoDetect: false }, websearch: { enabled: false }, care: { allowGroups: true, allowOthers: true },
    persona: { master: { wxids: [owner] } },
  }));
  fs.writeFileSync(path.join(root, 'data', 'persona.json'), JSON.stringify({ mutedGroups: ['旧静音群'] }));
  const app = await start(root);
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { ...app, root };
}

async function post(app, route, body, headers = {}) {
  const res = await fetch(app.url + route, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const patch = (app, value) => post(app, '/api/config', { patch: value });
const permission = (app, chatId, name = '', auth = token) =>
  post(app, '/api/wechat/send-permission', { chatId, name }, { 'x-bot-token': auth });
const message = (app, chatId, text, extra = {}) => post(app, '/webhook/wechat', {
  chat_id: chatId, chat_type: chatId.endsWith('@chatroom') ? 'group' : 'private',
  chat_title: '测试群', sender_id: chatId.endsWith('@chatroom') ? owner : chatId,
  nickname: '测试', text, at_me: true, ...extra,
}, { 'x-bot-token': token, 'x-whale-bridge': '1' });

test('黑名单按会话 ID 静音群和私聊，保存后立即生效，旧人设不再盖回去', async (t) => {
  const app = await fixture(t);
  assert.deepEqual(app.runtime.config.group.mutedGroups, ['旧静音群']);
  assert.equal((await patch(app, { 'group.mutedGroups': [group, peer] })).status, 200);
  assert.equal((await message(app, group, '闭嘴')).body.reason, 'muted_group');
  assert.equal((await message(app, group, '十点半提醒我开会')).body.reason, 'muted_group');
  assert.equal((await message(app, peer, '在吗')).body.reason, 'muted_chat');
  assert.equal((await permission(app, peer, '改名后的联系人')).body.allowed, false);
  assert.equal((await permission(app, peer, '', 'wrong-token')).status, 403);
  assert.equal((await patch(app, { 'group.mutedGroups': [] })).status, 200);
  const restarted = await start(app.root);
  try {
    assert.deepEqual(restarted.runtime.config.group.mutedGroups, []);
    assert.equal((await permission(restarted, peer)).body.allowed, true);
  } finally { await restarted.close(); }
});

test('白名单开关限制回复和搭话，黑名单优先，清空后不会回退到默认目标', async (t) => {
  const app = await fixture(t);
  const update = async (values) => assert.equal((await patch(app, values)).status, 200);
  await update({ 'care.whitelist': [group, peer], 'group.mutedGroups': [group] });
  assert.equal((await permission(app, owner)).body.allowed, true, '普通回复默认沿用旧行为');
  await update({ 'wechat.whitelistOnly': true });
  assert.equal((await message(app, owner, '在吗')).body.reason, 'not_whitelisted');
  assert.equal((await permission(app, peer)).body.allowed, true);
  assert.equal((await permission(app, group)).body.reason, 'muted_group');
  assert.deepEqual(careTargets(app.runtime.config).map((item) => item.wxid), [peer]);
  await update({ 'care.whitelist': [] });
  assert.equal((await permission(app, peer)).body.allowed, false);
  assert.deepEqual(careTargets(app.runtime.config), []);
  await update({ 'wechat.whitelistOnly': false, 'group.mutedGroups': ['*', group] });
  assert.equal((await message(app, peer, '在吗')).body.reason, 'muted_chat');
  assert.equal((await permission(app, owner)).body.allowed, false);
});
