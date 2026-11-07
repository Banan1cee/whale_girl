'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseNotes, popupSummary } = require('../scripts/release-notes');

test('更新说明只来自指定版本，不混入未发布或其他版本', () => {
  const changelog = '# 更新记录\n\n## 未发布\n\n尚未发布\n\n## 4.0.6\n\n### 修复\n\n- 修复编码切换。\n- 支持私聊记忆清理。\n\n## 4.0.5\n\n旧版内容\n';
  const notes = releaseNotes(changelog, 'v4.0.6');
  assert.match(notes, /修复编码切换/);
  assert.match(notes, /私聊记忆清理/);
  assert.doesNotMatch(notes, /尚未发布|旧版内容/);
});

test('最后一个版本支持 CRLF 和没有结尾换行；缺失版本不能伪造说明', () => {
  assert.equal(releaseNotes('## 4.0.5\r\n\r\n- 修复安装问题。', '4.0.5'), '- 修复安装问题。');
  assert.throws(() => releaseNotes('## 4.0.5\n\n- 旧版本', '4.0.6'), /没有找到/);
});

test('弹窗只取指定版本的短摘要，完整发版说明保留技术细节', () => {
  const changelog = '## 4.0.9\n\n### 更新弹窗摘要\n\n- 下个版本\n\n'
    + '## 4.0.8\r\n\r\n### 更新弹窗摘要\r\n\r\n- 新增预设表情包。\r\n- 修复微信回复乱码。\r\n'
    + '\r\n### 详细修复\r\n\r\n- 修正输入框回读判断。\r\n';
  assert.equal(popupSummary(changelog, 'v4.0.8'), '- 新增预设表情包。\n- 修复微信回复乱码。');
  assert.equal(releaseNotes(changelog, '4.0.8'), '### 详细修复\r\n\r\n- 修正输入框回读判断。');
});

test('弹窗摘要缺失或过长时不把完整版塞进更新清单', () => {
  const heading = '## 4.0.8\n\n### 更新弹窗摘要\n\n';
  assert.throws(() => popupSummary('## 4.0.8\n\n- 只有详细说明', '4.0.8'), /没有找到/);
  assert.throws(() => popupSummary(heading + '- 一\n- 二\n- 三\n- 四', '4.0.8'), /1～3 条/);
  assert.throws(() => popupSummary(heading + '- ' + '字'.repeat(61), '4.0.8'), /60 个字符/);
  assert.equal(popupSummary(heading + '- ' + '字'.repeat(60), '4.0.8').length, 62);
});
