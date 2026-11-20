'use strict';

/**
 * 人设预设：一个版本一个文件，导入后立即生效。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const presets = require('../src/persona/presets');

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-presets-'));
  fs.mkdirSync(path.join(dir, 'assets', 'personas'), { recursive: true });
  return dir;
}

function writePreset(dir, name, data) {
  fs.writeFileSync(path.join(dir, 'assets', 'personas', name), JSON.stringify(data, null, 2), 'utf8');
}

test('assets/personas/ 下每个文件都被识别，按版本号排序', () => {
  const root = makeRoot();
  writePreset(root, 'persona-v2.json', { id: 'persona-v2', version: '2.0.0', name: '第二版', customPrompt: 'x' });
  writePreset(root, 'persona-v10.json', { id: 'persona-v10', version: '10.0.0', name: '第十版', customPrompt: 'y' });
  writePreset(root, 'persona-v1.json', { id: 'persona-v1', version: '1.0.0', name: '第一版', customPrompt: 'z' });
  const list = presets.list({ paths: { root } });
  assert.deepEqual(list.map((x) => x.id), ['persona-v1', 'persona-v2', 'persona-v10']);
  assert.equal(list[0].name, '第一版');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('order 决定列表顺序（按攻击力从低到高），没写 order 的排在后面', () => {
  const root = makeRoot();
  writePreset(root, 'persona-v1.json', { id: 'persona-v1', version: '1.0.0', name: '温和', order: 20, customPrompt: 'a' });
  writePreset(root, 'persona-v10.json', { id: 'persona-v10', version: '10.0.0', name: '最凶', order: 10, customPrompt: 'b' });
  writePreset(root, 'persona-v2.json', { id: 'persona-v2', version: '2.0.0', name: '没写 order', customPrompt: 'c' });
  const list = presets.list({ paths: { root } });
  assert.deepEqual(list.map((x) => x.id), ['persona-v10', 'persona-v1', 'persona-v2']);
  assert.equal(list[0].order, 10);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});
test('坏文件和目录不存在时不会崩', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'assets', 'personas', 'broken.json'), '{ not json', 'utf8');
  assert.deepEqual(presets.list({ paths: { root } }), []);
  assert.deepEqual(presets.list({ paths: { root: path.join(root, 'nope') } }), []);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('导入只取白名单字段，带不进乱七八糟的东西', () => {
  const root = makeRoot();
  writePreset(root, 'persona-v1.json', {
    id: 'persona-v1',
    version: '1.0.0',
    name: '鲸鲸',
    customPrompt: '完整人设',
    historyTurns: 90,
    master: { wxids: ['wxid_evil'] },
    apiKey: 'sk-should-not-pass',
    shell: 'rm -rf',
  });
  const preset = presets.load({ paths: { root } }, 'persona-v1');
  const patch = presets.toPatch(preset);
  assert.equal(patch.customPrompt, '完整人设');
  assert.equal(patch.historyTurns, 90);
  assert.equal(patch.master, undefined);
  assert.equal(patch.apiKey, undefined);
  assert.equal(patch.shell, undefined);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('id 里带路径穿越取不到东西', () => {
  const root = makeRoot();
  writePreset(root, 'persona-v1.json', { id: 'persona-v1', customPrompt: 'ok' });
  assert.equal(presets.load({ paths: { root } }, '../config'), null);
  assert.equal(presets.load({ paths: { root } }, '../../etc/passwd'), null);
  assert.equal(presets.load({ paths: { root } }, 'nope'), null);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('仓库自带的人设预设都是通用版：不含微信号、群昵称、Key', () => {
  const root = path.resolve(__dirname, '..');
  const list = presets.list({ paths: { root } });
  assert.ok(list.length >= 1, '至少要有一个人设预设');
  for (const item of list) {
    const preset = presets.load({ paths: { root } }, item.id);
    const text = JSON.stringify(preset);
    assert.doesNotMatch(text, /wxid_gk6o4|wxid_[a-z0-9]{10,}|sk-[A-Za-z0-9]{10}/, item.id + ' 里疑似有隐私');
    assert.doesNotMatch(text, /1[3-9]\d{9}|[\w.+-]+@[\w-]+\.[a-z]{2,}/i, item.id + ' 里疑似有手机号/邮箱');
    assert.ok(String(preset.customPrompt || '').length > 100, item.id + ' 应该有完整提示词');
  }
});

test('启用的人设插件加入预设，禁用后消失且不影响内置预设', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePreset(root, 'standard.json', { id: 'standard', name: '内置', customPrompt: '内置正文' });
  const plugins = path.join(root, 'data', 'plugins');
  fs.mkdirSync(plugins, { recursive: true });
  const config = { paths: { root } };
  const marker = path.join(plugins, 'gentle-chat.persona.json');
  assert.deepEqual(presets.list(config).map(x => x.id), ['standard']);
  fs.writeFileSync(marker, JSON.stringify({
    id: 'standard', name: '温和聊天', version: '1.0.0', customPrompt: '温和自然', personaName: '小鱼'
  }));
  assert.deepEqual(presets.list(config).map(x => x.id), ['standard', 'market-gentle-chat']);
  assert.deepEqual(presets.toPatch(presets.load(config, 'market-gentle-chat')), { name: '小鱼', customPrompt: '温和自然' });
  fs.unlinkSync(marker);
  assert.equal(presets.load(config, 'market-gentle-chat'), null);
});

function userConfig(root, persona = {}, chat = {}) {
  return {
    paths: { root, dataDir: path.join(root, 'data') },
    persona: {
      name: '鲸鲸', age: 23, job: '自由职业', appearance: '外形', personality: '性格',
      background: '背景', customPrompt: '', emojiLevel: '少', ...persona,
    },
    chat: {
      privateMaxChars: 140, groupMaxChars: 70, historyTurns: 120,
      groupHistoryTurns: 100, maxBubbles: 2, ...chat,
    },
  };
}

test('另存为自建预设：写进 data/personas，列表标成 user，导入还原身份与长度', () => {
  const root = makeRoot();
  const config = userConfig(root, { name: '小鱼', personality: '很凶', customPrompt: '完整人设' }, { privateMaxChars: 200 });
  const saved = presets.saveUser(config, { name: '我的小鱼' });
  assert.equal(saved.ok, true);
  assert.match(saved.preset.id, /^user-[a-z0-9-]+$/);
  const file = path.join(root, 'data', 'personas', saved.preset.id + '.json');
  assert.ok(fs.existsSync(file), '预设文件要落在 data/personas');
  const list = presets.list(config);
  assert.equal(list[0].id, saved.preset.id, '自建预设排在最前面');
  assert.equal(list[0].source, 'user');
  const patch = presets.toPatch(presets.load(config, saved.preset.id));
  assert.equal(patch.name, '小鱼');
  assert.equal(patch.personality, '很凶');
  assert.equal(patch.emoji, '少');
  assert.equal(patch.privateMaxChars, 200);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('保存人设会回写来源的当前自建预设，并保留创建时间', () => {
  const root = makeRoot();
  const config = userConfig(root);
  const saved = presets.saveUser(config, { name: '甲' });
  const first = JSON.parse(fs.readFileSync(path.join(root, 'data', 'personas', saved.preset.id + '.json'), 'utf8'));
  config.persona.personality = '改过的性格';
  assert.equal(presets.updateFromConfig(config, saved.preset.id), true);
  const next = JSON.parse(fs.readFileSync(path.join(root, 'data', 'personas', saved.preset.id + '.json'), 'utf8'));
  assert.equal(next.personality, '改过的性格');
  assert.equal(next.createdAt, first.createdAt);
  assert.equal(presets.updateFromConfig(config, 'persona-neutral'), false, '内置预设不回写');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('自建预设物理删除；正在使用的不许删', () => {
  const root = makeRoot();
  const config = userConfig(root);
  const saved = presets.saveUser(config, { name: '乙' });
  const file = path.join(root, 'data', 'personas', saved.preset.id + '.json');
  assert.equal(presets.removePreset(config, saved.preset.id, { currentId: saved.preset.id }).ok, false);
  assert.ok(fs.existsSync(file), '正在使用的预设不能被删掉');
  assert.equal(presets.removePreset(config, saved.preset.id).ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(presets.load(config, saved.preset.id), null);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('内置预设只隐藏不删文件，市场预设重装后自动恢复', () => {
  const root = makeRoot();
  writePreset(root, 'persona-standard.json', { id: 'persona-standard', name: '标准', customPrompt: '正文' });
  const pluginFile = path.join(root, 'data', 'plugins', 'gentle.persona.json');
  fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
  fs.writeFileSync(pluginFile, JSON.stringify({ id: 'gentle', name: '温和', customPrompt: '市场正文' }));
  const config = userConfig(root);
  assert.deepEqual(presets.list(config).map((x) => x.id), ['persona-standard', 'market-gentle']);

  assert.equal(presets.removePreset(config, 'persona-standard').ok, true);
  assert.ok(fs.existsSync(path.join(root, 'assets', 'personas', 'persona-standard.json')), '内置文件不能删');
  assert.deepEqual(presets.list(config).map((x) => x.id), ['market-gentle']);

  assert.equal(presets.removePreset(config, 'market-gentle').ok, true);
  assert.deepEqual(presets.list(config).map((x) => x.id), []);

  // 插件卸载后重装：文件重建、内容也变了 → 隐藏标记自动失效
  fs.writeFileSync(pluginFile, JSON.stringify({ id: 'gentle', name: '温和', customPrompt: '重装后的新正文' }));
  assert.deepEqual(presets.list(config).map((x) => x.id), ['market-gentle']);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('预设 id / 标题不合法时拒绝保存，不允许用标题当路径', () => {
  const root = makeRoot();
  const config = userConfig(root);
  assert.equal(presets.saveUser(config, { name: '   ' }).ok, false);
  assert.equal(presets.saveUser(config, { id: '../evil', name: '坏' }).ok, false);
  assert.equal(presets.removePreset(config, '../../config').ok, false);
  assert.equal(presets.saveUser(config, { name: '正常'.repeat(30) }).ok, true, '标题会截到 40 字');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('自建预设可以只改标题；来源判断区分内置/市场/自建', () => {
  const root = makeRoot();
  writePreset(root, 'persona-standard.json', { id: 'persona-standard', name: '标准', customPrompt: '正文' });
  const config = userConfig(root);
  const saved = presets.saveUser(config, { name: '旧标题' });
  const before = JSON.parse(fs.readFileSync(path.join(root, 'data', 'personas', saved.preset.id + '.json'), 'utf8'));
  assert.equal(presets.sourceOf(config, 'persona-standard'), 'builtin');
  assert.equal(presets.sourceOf(config, saved.preset.id), 'user');
  assert.equal(presets.sourceOf(config, 'nope'), '');
  assert.equal(presets.renamePreset(config, saved.preset.id, '新标题').ok, true);
  const after = JSON.parse(fs.readFileSync(path.join(root, 'data', 'personas', saved.preset.id + '.json'), 'utf8'));
  assert.equal(after.name, '新标题');
  assert.equal(after.customPrompt, before.customPrompt, '改名不能动人设内容');
  assert.equal(presets.renamePreset(config, 'persona-standard', '改名').ok, false, '内置不能改名');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});
