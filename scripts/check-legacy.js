#!/usr/bin/env node
'use strict';

/**
 * 防复发静态扫描：记忆层不许再长出「运行时兼容旧格式」的分支。
 *
 * 背景：上一版 src/memory/migrate.js 有 24KB、48 处 legacy 引用，每次启动都
 * 跑一遍导入，还要留只读副本。删掉它的成本远高于当初不写它，所以用一条
 * 能进 CI 的检查把口子焊死：
 *
 *   1. src/ 里不许 require scripts/migrate/*（迁移只能由脚本单向调用）；
 *   2. src/memory/ 里不许出现 migrateIfNeeded；
 *   3. src/memory/migrate.js 不许复活。
 *
 * 用法：node scripts/check-legacy.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/**
 * 唯一白名单：HTTP 的「识别转换旧记忆」接口。
 * 它是用户显式点按钮才走的一次性工具，不在启动/聊天路径上；
 * 其余任何 src 代码都不许碰 scripts/migrate。
 */
const ALLOW = new Set(['src/http/routes/memory.js']);

const RULES = [
  {
    id: 'no-runtime-migrator',
    desc: 'src/ 不许 require scripts/migrate（迁移只能离线跑）',
    test: (rel, text) => !ALLOW.has(rel) && /require\([^)]*scripts\/migrate[^)]*\)/.test(text),
  },
  {
    id: 'no-migrate-if-needed',
    desc: 'src/memory/ 不许出现 migrateIfNeeded（运行时不自动升级格式）',
    only: (rel) => rel.startsWith('src/memory/'),
    test: (rel, text) => /migrateIfNeeded/.test(text),
  },
  {
    id: 'no-migrate-module',
    desc: 'src/memory/migrate.js 不许复活',
    test: (rel) => rel.replace(/\\/g, '/') === 'src/memory/migrate.js',
  },
];

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function check() {
  const problems = [];
  for (const abs of walk(SRC)) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const rule of RULES) {
      if (rule.only && !rule.only(rel)) continue;
      // 只扫代码行：注释里提到历史原因不算违规
      const code = text
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      if (rule.test(rel, code)) problems.push(`${rel}: ${rule.desc}`);
    }
  }
  return problems;
}

if (require.main === module) {
  const problems = check();
  if (problems.length) {
    console.error('发现运行时的旧格式兼容代码（请移到 scripts/ 或删掉）：');
    for (const line of problems) console.error('  - ' + line);
    process.exitCode = 1;
  } else {
    console.log('没有运行时的旧格式兼容代码。');
  }
}

module.exports = { check, RULES };

