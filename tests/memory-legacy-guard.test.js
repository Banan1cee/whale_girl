'use strict';

/**
 * 防复发扫描（scripts/check-legacy.js）。
 *
 * 它守的是「运行时不再长出旧格式兼容」这条线；这里用合成文本验证规则本身，
 * 不依赖 src 里当前恰好没有违规代码。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { check, RULES } = require('../scripts/check-legacy');

test('规则覆盖三件事：不许 require 迁移脚本、memory 里不许 migrateIfNeeded、migrate.js 不许复活', () => {
  const ids = RULES.map((r) => r.id);
  assert.deepEqual(ids, ['no-runtime-migrator', 'no-migrate-if-needed', 'no-migrate-module']);
});

test('no-runtime-migrator：普通 src 文件引用迁移脚本即违规', () => {
  const rule = RULES.find((r) => r.id === 'no-runtime-migrator');
  const code = "const m = require('../../../scripts/migrate/import-4.0');";
  assert.equal(rule.test('src/memory/store.js', code), true);
  // 唯一的白名单是显式导入接口
  assert.equal(rule.test('src/http/routes/memory.js', code), false);
});

test('no-migrate-if-needed：只在 memory 层生效', () => {
  const rule = RULES.find((r) => r.id === 'no-migrate-if-needed');
  assert.equal(rule.only('src/memory/store.js'), true);
  assert.equal(rule.only('src/http/routes/memory.js'), false);
  assert.equal(rule.test('src/memory/store.js', 'migrateIfNeeded({})'), true);
});

test('当前 src 没有运行时旧格式兼容代码', () => {
  assert.deepEqual(check(), []);
});
