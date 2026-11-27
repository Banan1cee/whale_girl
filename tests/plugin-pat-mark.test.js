'use strict';
// 纯内存：不落盘、不删文件。覆盖 [[pat]] 标记在 finalize 里的开关语义。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { createFinalizer } = require(path.join(ROOT, 'src/pipeline/finalize'));
const features = require(path.join(ROOT, 'src/infra/features'));

function mk(config, { chatType = 'private' } = {}) {
  const calls = [];
  const f = createFinalizer({
    persona: { splitBubbles: (t) => [t], emojiChanceFor: () => 0, kaomojiPick: () => '', MASTER_ROAST_LINES: [] },
    LIMITS: { maxOutputHard: 4000, maxOutputNormal: 100, maxOutputDiscussion: 400 },
    isEcho: () => false, stripInternalTimestamps: (t) => t,
    stripSilenceMark: (t) => ({ text: t, minutes: 0 }),
    stripStickerMarks: (t) => ({ text: t, category: '' }),
    stripPatMark: (t) => { const m = String(t).match(/\[\[pat\]\]/); return { text: String(t).replace('[[pat]]', '').trim(), pat: Boolean(m) }; },
    isFeatureOn: features.isOn,
    textMeta: () => '', describeError: () => '',
  });
  const bot = {
    config, rng: () => 0.5, logger: { warn() {} },
    store: { appendMessage: () => ({ seq: 1 }), checkpoint() {} },
    now: () => new Date(0), nativeLinkHistory: new Map(), nativeLinkTag: Symbol('nl'),
    _finalReplies: new Map(), _replyTurns: new Map(),
    activateReply: () => true, releaseReply() {},
    _guardGroupReply: (d, b) => b, expandDiaryMark: (d, t) => t,
    reservePat: (msg) => { calls.push(msg.chatId); return 'pat-1'; },
  };
  const decision = { action: 'reply', key: 'k', msg: { chatType, text: '' }, requestSystem: '' };
  const bubbles = f.finalize.call({ ...bot, ...f }, decision, '好啊 [[pat]]');
  return { decision, bubbles, calls };
}

const base = { chat: { maxBubbles: 2, privateMaxChars: 100, groupMaxChars: 100 }, persona: { name: '鲸鲸' } };

test('pat 开启（缺字段走默认 true）：剥标记并占额度', () => {
  const { decision, calls } = mk({ ...base });
  assert.strictEqual(decision.pat, true);
  assert.deepStrictEqual(calls, [undefined]);
});

test('features.pat = false：不执行，但标记仍被剥掉', () => {
  const { decision, bubbles, calls } = mk({ ...base, features: { pat: false } });
  assert.strictEqual(decision.pat, undefined);
  assert.deepStrictEqual(calls, []);
  assert.ok(!bubbles.join('').includes('[[pat]]'), '标记不能漏给用户');
});

test('features.pat = 字符串 "false"：按关闭处理（isOn 统一解析）', () => {
  const { decision } = mk({ ...base, features: { pat: 'false' } });
  assert.strictEqual(decision.pat, undefined);
});

test('群聊带 [[pat]]：只剥标记，不执行（群里拍不准人）', () => {
  const { decision, calls } = mk({ ...base }, { chatType: 'group' });
  assert.strictEqual(decision.pat, undefined);
  assert.deepStrictEqual(calls, []);
});
