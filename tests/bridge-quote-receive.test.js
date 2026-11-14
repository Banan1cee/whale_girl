'use strict';

/**
 * 接收侧引用回复的接入顺序。
 *
 * 解析本身在 tests/test_receive_quote.py 里跑；这里守的是它被放在正确的位置：
 * 必须排在 type 49（文件/链接/卡片）分支之前，否则引用消息又会因为没有
 * <url> 被整条丢掉；同时文本分支不能把解析结果覆盖回原始 XML。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RECV = fs.readFileSync(path.join(ROOT, 'bridge/receiver_mixin.py'), 'utf8');

test('引用消息：解析在类型分支之前，文本重写不会覆盖解析结果', () => {
  const parseAt = RECV.indexOf('_quote_text = quote_content_text(content)');
  const cardAt = RECV.indexOf('if not _quote_parsed and mtype not in');
  const textAt = RECV.indexOf("if mtype == '文本' and not _quote_parsed:");
  assert.ok(parseAt >= 0, '缺少引用解析调用');
  assert.ok(cardAt > parseAt, '引用解析必须排在 type 49 卡片分支之前');
  assert.ok(textAt > cardAt, '文本分支要放在卡片分支之后');
  assert.doesNotMatch(RECV, /\n\s+if mtype == '文本':\s*\n\s+content = G\.fix_garbled/,
    '文本分支不能无条件重写 content，否则引用解析结果会被原始 XML 盖掉');
});

test('引用消息：解析成功后跳过卡片分支，但不跳过群/白名单等后续检查', () => {
  assert.match(RECV, /if not _quote_parsed and mtype not in \('文本', '语音', '图片', '表情', '动画表情'\):/);
  // 只跳过卡片分支，ONLY_CHATS / 系统通知 / 重复消息等闸门仍在解析之后原样执行
  assert.ok(RECV.indexOf('if G.ONLY_CHATS:') > RECV.indexOf('_quote_text = quote_content_text(content)'));
  assert.ok(RECV.indexOf('G.is_system_notice(') > RECV.indexOf('_quote_text = quote_content_text(content)'));
});
