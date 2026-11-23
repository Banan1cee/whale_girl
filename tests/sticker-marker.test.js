'use strict';

/**
 * 表情包「模型决定分类」：正文里的 [[sticker:分类名]] 标记。
 *
 * 这里只测两件事：
 *   1. finalize 把标记从正文里剥干净（完整、行内、多个、半截都不能漏给用户）；
 *   2. 分类要一路传到 stickerFor，没有标记就绝不发。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

// task-14 起 finalize 会登记答复租约/幂等状态，原来只给 rng/config/store 的
// 最小 this 替身已经不够（缺 _finalReplies/_replyTurns/_replyQuota）。
// 这里改用真实 Bot + 临时 Store，只把模型调用固定为演示模式；
// 只测标记剥离，不改变任何生产行为。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-marker-'));
const config = structuredClone(DEFAULT_CONFIG);
config.paths = { root, dataDir: root, settingsFile: path.join(root, 'settings.json') };
config.env = { autoDetect: false };
config.websearch = { enabled: false };
config.links.enabled = false;
config.persona = { ...config.persona, name: '测试角色' };
const store = new Store({ file: path.join(root, 'store.json'), limits: config.memory });
const bot = new Bot({
  config, store, llm: { isMock: true, model: 'fixture' }, logger: null, rng: () => 0.5,
  calibration: { trimScale: () => 1, apply: n => ({ scale: 1, calibrated: n, n: 0 }) },
});
after(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

/** 用真实 Bot.finalize 跑一段正文，返回气泡、decision 和拼接后的公开正文 */
function fin(text, decision = {}) {
  const d = {
    action: 'reply',
    key: 'wechat:u:test',
    msg: { platform: 'wechat', chatType: 'private', text: '原消息', cleanText: '原消息' },
    ...decision,
  };
  const bubbles = bot.finalize(d, text);
  return { bubbles, decision: d, joined: bubbles.join('\n') };
}

test('标记在句尾：剥掉、分类记下来', () => {
  const out = fin('好呀，明天见 [[sticker:炸毛]]');
  assert.equal(out.decision.stickerCategory, '炸毛');
  assert.match(out.joined, /明天见/);
  assert.doesNotMatch(out.joined, /\[\[|sticker/);
});

test('标记在句中：剥掉后句子还完整', () => {
  const out = fin('好呀[[sticker:傲娇]]明天见');
  assert.equal(out.decision.stickerCategory, '傲娇');
  assert.equal(out.joined.replace(/\s/g, ''), '好呀明天见');
});

test('标记在开头且没闭合：正文保留，只删标记，不再整条消失', () => {
  const out = fin('[[sticker:炸毛\n明天见，去吃饭了');
  assert.equal(out.decision.stickerCategory, '炸毛');
  assert.equal(out.joined.replace(/\s/g, ''), '明天见去吃饭了');
  assert.doesNotMatch(out.joined, /\[\[|sticker/);
  // 没有分隔符、也没闭合：只删标记本身
  const bare = fin('[[sticker\n后面这句要留着');
  assert.equal(bare.decision.stickerCategory, undefined);
  assert.match(bare.joined, /后面这句要留着/);
});

test('标记在句尾 + 正文：分类取到，正文干净', () => {
  const out = fin('今天风好大，别穿裙子 [[sticker:傲娇]]');
  assert.equal(out.decision.stickerCategory, '傲娇');
  assert.equal(out.joined.replace(/\s/g, ''), '今天风好大别穿裙子');
});

test('多个标记：只取第一个分类，全部删掉，正文不残缺', () => {
  const out = fin('开头 [[sticker:炸毛]] 中间 [[sticker:开心]] 结尾');
  assert.equal(out.decision.stickerCategory, '炸毛');
  assert.equal(out.joined.replace(/\s/g, ''), '开头中间结尾');
  assert.doesNotMatch(out.joined, /\[\[|sticker/);
});

// 旧夹具断言「第 4 个标记原样保留（下一轮再清）」，与当前 replyMarks / T01 规格
// （公开正文不得残留任何控制标记）冲突。按 lead 决定保留当前行为、只记录差异，
// 不为了满足旧断言让生产重新漏出标记。
test('超过三个标记也会全部剥掉，分类取第一个（不无限循环）', () => {
  const out = fin('[[sticker:a]][[sticker:b]][[sticker:c]][[sticker:d]]');
  assert.equal(out.decision.stickerCategory, 'a', '只取第一个可识别分类');
  assert.doesNotMatch(out.joined, /\[\[|sticker/i, '公开正文不允许残留控制标记');
  assert.deepEqual(out.bubbles, [], '整条都是标记时没有可发正文');
});

test('半截标记（没闭合）也不能漏给用户', () => {
  for (const text of ['好呀 [[sticker:', '好呀 [[sticker', '好呀 [[STICKER:炸毛', '好呀 [[sticker：', '好呀 [[ sticker : 炸毛']) {
    const out = fin(text);
    assert.doesNotMatch(out.joined, /\[\[|sticker/i, JSON.stringify(text));
    assert.match(out.joined, /好呀/, JSON.stringify(text));
  }
});

test('全角冒号也认；没有标记就没有分类', () => {
  assert.equal(fin('好呀 [[sticker：傲娇]]').decision.stickerCategory, '傲娇');
  const plain = fin('好呀，明天见');
  assert.equal(plain.decision.stickerCategory, undefined);
  assert.equal(plain.joined.replace(/\s/g, ''), '好呀明天见');
});

test('只有标记没有正文：不发空消息，但分类已经记下', () => {
  const out = fin('[[sticker:炸毛]]');
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
