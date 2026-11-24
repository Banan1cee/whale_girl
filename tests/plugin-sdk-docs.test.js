'use strict';

/**
 * SDK 文档与注册表的一致性验收。
 *
 * 能力表是插件作者看到的东西；它和 registry 一旦分叉，作者就会照着一份错的表写清单。
 * 这里不做「文档像不像」，只校验三件可判定的事：
 *   1. 注册表里每一项能力在文档里都有一个表格行；
 *   2. 文档里没有注册表已经不存在的行；
 *   3. 「插件可调」这一列必须等于 levels.4.calls 的白名单判定。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../src/services/pluginProtocolRegistry.json');

const fullDoc = fs.readFileSync(path.join(__dirname, '..', 'docs', '插件协议.md'), 'utf8');
// 只取「宿主能力全表」一节，避免把协议里的扩展点摘要表当成能力表。
const tableStart = fullDoc.indexOf('## 4.1 宿主能力全表');
const tableEnd = tableStart >= 0 ? fullDoc.indexOf('\n## 5. ', tableStart) : -1;
const doc = tableStart >= 0 ? fullDoc.slice(tableStart, tableEnd > tableStart ? tableEnd : undefined) : fullDoc;

function tableRows() {
  const rows = new Map();
  for (const line of doc.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| `')) continue;
    const cells = trimmed.split('|').map(cell => cell.trim());
    // 首尾各有一个空串：| a | b | -> ['', 'a', 'b', '']
    const name = cells[1].replace(/`/g, '');
    if (!/^[a-z][a-z0-9-]*\.[a-zA-Z0-9]+@1$/.test(name)) continue;
    rows.set(name, cells[cells.length - 2]);
  }
  return rows;
}

test('每项注册表能力都有文档表格行', () => {
  const rows = tableRows();
  const missing = Object.keys(registry.calls).filter(name => !rows.has(name));
  assert.deepEqual(missing, [], '文档缺少这些能力的表格行：' + missing.join(', '));
});

test('文档里没有注册表已删除的能力', () => {
  const rows = tableRows();
  const unknown = [...rows.keys()].filter(name => !Object.hasOwn(registry.calls, name));
  assert.deepEqual(unknown, [], '文档仍在介绍已删除的能力：' + unknown.join(', '));
});

test('「插件可调」列与 4 级白名单一致', () => {
  const rows = tableRows();
  const allowed = new Set(registry.levels['4'].calls);
  const wrong = [];
  for (const [name, cell] of rows) {
    const documented = cell.startsWith('是');
    const expected = allowed.has(name) && registry.calls[name]?.enabled !== false;
    if (documented !== expected) wrong.push(`${name}: 文档=${documented} 注册表=${expected}`);
  }
  assert.deepEqual(wrong, [], '插件可见性文档与注册表不一致：\n' + wrong.join('\n'));
});

test('文档失败的失败码覆盖代码里实际会抛的码', () => {
  // 这些码是本轮分发层/能力实现真的会产生的；文档缺一个，作者就无从判断该重试还是改清单。
  const codes = ['host_capability_unknown', 'host_capability_disabled', 'host_capability_not_declared',
    'host_capability_unavailable', 'grant_revoked', 'invalid_host_capability_input',
    'invalid_host_capability_output', 'capability_timeout', 'capability_aborted', 'plugin_required'];
  for (const code of codes) assert.match(doc, new RegExp(code), '文档缺少失败码 ' + code);
});

test('启动器授权提示覆盖每一个插件可见能力', () => {
  // 漏一条，用户在确认框里看到的就是裸能力名（"memory.write@1"），
  // 等于在最需要说清楚的地方给了个看不懂的词。
  const launcher = fs.readFileSync(
    path.join(__dirname, '..', 'launcher', 'Views', 'PluginMarketPage.xaml.cs'), 'utf8');
  const visible = registry.levels['4'].calls.filter(name => registry.calls[name]?.enabled !== false);
  const missing = visible.filter(name => !launcher.includes(`"${name}" =>`));
  assert.deepEqual(missing, [], '启动器缺少这些能力的授权提示：' + missing.join(', '));
});
