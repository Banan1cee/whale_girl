'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bot } = require('../src/pipeline/bot');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t01-marks-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.paths = { root, dataDir: root, settingsFile: path.join(root, 'settings.json') };
  config.env = { autoDetect: false };
  const store = new Store({ file: path.join(root, 'store.json'), limits: config.memory });
  const bot = new Bot({ config, store, llm: { isMock: true }, logger: null, rng: () => 0.99 });
  let index = 0;
  t.after(() => { store.close(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return (raw, extra = {}) => {
    const key = 'fixture-' + (++index); store.ensureSession(key, {});
    const decision = { action: 'reply', key, msg: { chatType: 'group', ...extra } };
    const bubbles = bot.finalize(decision, raw);
    return { text: decision.finalText || '', bubbles, category: decision.stickerCategory || '', state: store.getState(key) };
  };
}
for (const newline of ['\n', '\r\n', '\r']) {
  test('unclosed sticker stops at its own line: ' + JSON.stringify(newline), t => {
    const finalize = fixture(t);
    const result = finalize('prefix[[sticker:开心' + newline + 'normal body' + newline + '[[sticker:炸毛]]suffix');
    assert.ok(result.text.includes('normal body'));
    assert.equal(result.category, '开心');
    assert.doesNotMatch(result.bubbles.join(''), /sticker/i);
  });
}
test('all known marker fragments are hidden without adding more sticker actions', t => {
  const finalize = fixture(t);
  const result = finalize('a[[sticker:开心]]b[[sticker:炸毛]]c[[sticker:傲娇]]d[[sticker:炸毛]]e');
  assert.equal(result.text, 'abcde'); assert.equal(result.category, '开心');
});
test('unclosed sticker without a separator preserves same-line prose', t => {
  const result = fixture(t)('答复 [[sticker 后半句照常发');
  assert.equal(result.text, '答复 后半句照常发');
  assert.equal(result.category, '');
});
test('unknown names and ordinary literal bracket expressions survive', t => {
  const finalize = fixture(t);
  for (const raw of ['a[[unknown:fixture]]b', 'a[[stickers:fixture]]b', 'a((silences:3))b', 'a(b)c[d]']) assert.equal(finalize(raw).text, raw);
});
test('sticker case/spaces/fullwidth colon and malformed tails keep adjacent paragraphs', t => {
  const finalize = fixture(t);
  assert.equal(finalize('a[[ STICKER ： 开心 ]]b').category, '开心');
  assert.equal(finalize('a[[sticker]]b').text, 'ab');
  assert.ok(finalize('a[[sticker:' + 'x'.repeat(100) + '\nnext body').text.includes('next body'));
  assert.equal(finalize('a[[sticker:' + 'x'.repeat(41) + ']]b').category, '');
});
test('silence remains bounded and authorized only for explicitly addressed groups', t => {
  const finalize = fixture(t);
  const unaddressed = finalize('prefix((silence:5\nnormal body\n((silence:2))suffix');
  assert.ok(unaddressed.text.includes('normal body')); assert.equal(Number(unaddressed.state.silentUntil) || 0, 0);
  const addressed = finalize('prefix((silence:999))suffix', { atMe: true });
  const minutes = (addressed.state.silentUntil - Date.now()) / 60000;
  assert.ok(minutes > 59 && minutes <= 60.1); assert.doesNotMatch(addressed.text, /silence/);
});
test('sticker category called silence does not execute a silence action', t => {
  const result = fixture(t)('prefix[[sticker:silence]]suffix');
  assert.equal(Number(result.state.silentUntil) || 0, 0); assert.equal(result.category, 'silence');
});
