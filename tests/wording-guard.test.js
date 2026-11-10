'use strict';

/**
 * 措辞守卫：限流口径统一写「每分钟」，别再出现每小时上限的旧说法。
 *
 * 原文件 dead-config-comments.test.js 里的「已删除功能别回来」用例已按用户要求移除，
 * 只保留这条仍然对当前代码有约束力的检查。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');

test('限流口径统一写「每分钟」，别再有每小时上限的旧说法', () => {
  const files = ['src/pipeline/chat.js', 'src/pipeline/trigger.js'];
  for (const rel of files) {
    let text;
    try {
      text = read(rel);
    } catch {
      continue;
    }
    const bad = text
      .split(/\r?\n/)
      .map((line, i) => ({ line, no: i + 1 }))
      .filter((x) => /每小时上限|每小时最多/.test(x.line));
    assert.deepEqual(bad.map((x) => `${rel}:${x.no}`), [], `${rel} 还有每小时上限的旧说法`);
  }
});
