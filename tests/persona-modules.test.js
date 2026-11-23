'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const persona = require('../src/persona');
const prompt = require('../src/persona/prompt');
const profile = require('../src/persona/profile');
const expression = require('../src/persona/expression');
const text = require('../src/persona/messageText');
const demo = require('../src/persona/demo');
const { DEFAULT_CONFIG } = require('../src/infra/config');

test('原入口保留导出引用，提示词不依赖演示台词或消息清洗', () => {
  for (const key of ['buildSystem', 'buildPromptParts', 'buildBlocks', 'buildTurnState', 'stickerCapability']) assert.equal(persona[key], prompt[key]);
  assert.equal(persona.mockReply, demo.mockReply);
  assert.equal(persona.cleanIncomingForPersona, text.cleanIncomingForPersona);
  assert.equal(persona.splitBubbles, text.splitBubbles);
  assert.equal(persona.emojiChanceFor, expression.emojiChanceFor);
  const source = fs.readFileSync(path.join(__dirname, '../src/persona/prompt.js'), 'utf8');
  assert.doesNotMatch(source, /MOCK_RULES|require\('\.\/demo'\)|require\('\.\/store'\)|const ROAST_MODE|const IDENTITY_FIX/);
});

test('人设字段共享校验，补充提示词不截断也不吞显式清空', () => {
  const patch = profile.identityPatch({ name: '  小鱼  ', age: 999, job: '', appearance: '蓝'.repeat(450), customPrompt: '鲸'.repeat(18000) });
  assert.equal(patch.name, '小鱼');
  assert.equal(patch.age, 120);
  assert.equal(patch.job, '');
  assert.equal(patch.appearance.length, 400);
  assert.equal(patch.customPrompt.length, 18000);
  assert.deepEqual(profile.identityPatch({ customPrompt: '' }), { customPrompt: '' });
  assert.deepEqual(profile.identityPatch({}), {});
});

test('兼容构造入口不回到旧人格并保留静态提示词/尾部', () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(config.persona, { masterRoast: true, customPrompt: '温和的图书管理员' });
  const ctx = { config, msg: { chatType: 'private', isMaster: true, text: '在吗' }, now: new Date(2026, 10, 15, 12) };
  const parts = persona.buildPromptParts(ctx);
  assert.ok(parts.tail.startsWith('【本轮状态】'));
  assert.doesNotMatch(parts.system, /语气底子|现在这条消息主人在骂你/);
});