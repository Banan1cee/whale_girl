'use strict';

/**
 * 表情包「模型决定分类」：正文里的 [[sticker:分类名]] 标记。
 *
 * 这里只测两件事：
 *   1. finalize 把标记从正文里剥干净（完整、行内、多个、半截都不能漏给用户）；
 *   2. 分类要一路传到 stickerFor，没有标记就绝不发。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

function fin(t, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-marker-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.paths = { root, dataDir: root, settingsFile: path.join(root, 'settings.json') };
  config.env = { autoDetect: false };
  config.persona.name = '测试角色';
  Object.assign(config.chat, { maxBubbles: 2, privateMaxChars: 200, groupMaxChars: 200 });
  const now = () => new Date(0);
  const store = new Store({ file: path.join(root, 'store.json'), limits: config.memory, now: () => now().getTime() });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  });
  const bot = new Bot({ config, store, llm: { isMock: true }, logger: null, now, rng: () => 0.5 });
  const decision = {
    action: 'reply',
    key: 'wechat:u:test',
    msg: { platform: 'wechat', chatType: 'private', text: '原消息', cleanText: '原消息' },
  };
  store.ensureSession(decision.key, decision.msg);
  const bubbles = bot.finalize(decision, text);
  return { bubbles, decision, joined: bubbles.join('\n') };
}

test('标记在句尾：剥掉、分类记下来', t => {
  const out = fin(t, '好呀，明天见 [[sticker:炸毛]]');
  assert.equal(out.decision.stickerCategory, '炸毛');
  assert.match(out.joined, /明天见/);
  assert.doesNotMatch(out.joined, /\[\[|sticker/);
});

test('标记在句中：剥掉后句子还完整', t => {
  const out = fin(t, '好呀[[sticker:傲娇]]明天见');
  assert.equal(out.decision.stickerCategory, '傲娇');
  assert.equal(out.joined.replace(/\s/g, ''), '好呀明天见');
});

test('标记在开头且没闭合：正文保留，只删标记，不再整条消失', t => {
  const out = fin(t, '[[sticker:炸毛\n明天见，去吃饭了');
  assert.equal(out.decision.stickerCategory, '炸毛');
  assert.equal(out.joined.replace(/\s/g, ''), '明天见去吃饭了');
  assert.doesNotMatch(out.joined, /\[\[|sticker/);
  // 没有分隔符、也没闭合：只删标记本身
  const bare = fin(t, '[[sticker\n后面这句要留着');
  assert.equal(bare.decision.stickerCategory, undefined);
  assert.match(bare.joined, /后面这句要留着/);
});

test('标记在句尾 + 正文：分类取到，正文干净', t => {
  const out = fin(t, '今天风好大，别穿裙子 [[sticker:傲娇]]');
  assert.equal(out.decision.stickerCategory, '傲娇');
  assert.equal(out.joined.replace(/\s/g, ''), '今天风好大别穿裙子');
});

test('多个标记：只取第一个分类，全部删掉，正文不残缺', t => {
  const out = fin(t, '开头 [[sticker:炸毛]] 中间 [[sticker:开心]] 结尾');
  assert.equal(out.decision.stickerCategory, '炸毛');
  assert.equal(out.joined.replace(/\s/g, ''), '开头中间结尾');
  assert.doesNotMatch(out.joined, /\[\[|sticker/);
});

test('超过三个标记仍只取首个分类，所有标记均从正文移除', t => {
  const out = fin(t, '[[sticker:a]][[sticker:b]][[sticker:c]][[sticker:d]]');
  assert.equal(out.decision.stickerCategory, 'a');
  assert.doesNotMatch(out.joined, /\[\[|sticker/i);

  const fourthOnly = fin(t, '好呀 [[sticker:]][[sticker:]][[sticker:]][[sticker:d]]');
  assert.equal(fourthOnly.decision.stickerCategory, undefined);
  assert.equal(fourthOnly.joined, '好呀');
});

test('半截标记（没闭合）也不能漏给用户', t => {
  for (const text of ['好呀 [[sticker:', '好呀 [[sticker', '好呀 [[STICKER:炸毛', '好呀 [[sticker：', '好呀 [[ sticker : 炸毛']) {
    const out = fin(t, text);
    assert.doesNotMatch(out.joined, /\[\[|sticker/i, JSON.stringify(text));
    assert.match(out.joined, /好呀/, JSON.stringify(text));
  }
});

test('全角冒号也认；没有标记就没有分类', t => {
  assert.equal(fin(t, '好呀 [[sticker：傲娇]]').decision.stickerCategory, '傲娇');
  const plain = fin(t, '好呀，明天见');
  assert.equal(plain.decision.stickerCategory, undefined);
  assert.equal(plain.joined.replace(/\s/g, ''), '好呀明天见');
});

test('只有标记没有正文：不发空消息，但分类已经记下', t => {
  const out = fin(t, '[[sticker:炸毛]]');
  assert.deepEqual(out.bubbles, []);
  assert.equal(out.decision.stickerCategory, '炸毛');
});

test('stickerFor：有分类才交给服务，没分类一律不发', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-marker-'));
  try {
    fs.mkdirSync(path.join(root, 'data/stickers/傲娇'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/stickers/傲娇/a.gif'), 'x');
    const seen = [];
    const ctx = {
      config: { root, features: { stickers: true }, sticker: { dir: 'data/stickers' } },
      stickerService: { plan: (msg, category) => { seen.push(category); return { category }; } },
    };
    assert.deepEqual(
      Bot.prototype.stickerFor.call(ctx, { msg: { platform: 'wechat', chatId: 'c1' }, stickerCategory: '傲娇' }),
      { category: 'cute' }
    );
    assert.equal(Bot.prototype.stickerFor.call(ctx, { msg: { platform: 'wechat', chatId: 'c1' } }), null);
    assert.deepEqual(seen, ['cute'], '没有标记时不该调用服务');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('stickerFor：总开关关着就直接返回 null', () => {
  const ctx = {
    config: { features: { stickers: false } },
    stickerService: { plan: () => { throw new Error('不该被调用'); } },
  };
  assert.equal(Bot.prototype.stickerFor.call(ctx, { msg: {}, stickerCategory: '傲娇' }), null);
});
