'use strict';

/**
 * 一个改动 = 一个版本号：把「改版本号 + 写 CHANGELOG」合成一条命令。
 *
 * 用法：
 *   node scripts/bump-version.js "修好了 XXX"              # 补丁号 +1（默认）
 *   node scripts/bump-version.js "新增 XXX" --level=minor  # 次版本（只给新功能）
 *   node scripts/bump-version.js "紧急修 XXX" --level=hotfix # 第四位热修
 *   node scripts/bump-version.js "重构 XXX" --level=major  # 主版本
 *   npm run bump -- "修好了 XXX"
 *
 * 它会：
 *   1. package.json 版本 +1
 *   2. 在 docs/CHANGELOG.md 最上面插一条对应版本（内容就是你给的说明）
 *   3. 打印新旧版本号
 *
 * 已经存在同名版本会直接报错退出，避免同一个版本号改两次。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const levelArg = argv.find((a) => a.startsWith('--level='));
const level = levelArg ? levelArg.split('=')[1] : 'patch';
const desc = argv.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!desc) {
  console.error('用法：node scripts/bump-version.js "这次改了什么" [--level=patch|minor|hotfix|major]');
  process.exit(1);
}
if (!['patch', 'minor', 'hotfix', 'major'].includes(level)) {
  console.error('--level 只能是 patch / minor / hotfix / major');
  process.exit(1);
}

const pkgPath = path.join(root, 'package.json');
const clPath = path.join(root, 'docs', 'CHANGELOG.md');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
// 版本号允许两段（3.60）或三段（3.55.1）：两段式加补丁就补成三段，别凭空造怪号。
const parts = String(pkg.version).split('.').map((n) => Number(n) || 0);
const maj = parts[0];
const min = parts[1] || 0;
const threePart = parts.length >= 3;
const pat = threePart ? parts[2] : 0;
const hot = parts.length >= 4 ? parts[3] : 0;
const next = level === 'major' ? `${maj + 1}.0.0`
  : level === 'minor' ? (threePart ? `${maj}.${min + 1}.0` : `${maj}.${min + 1}`)
    : level === 'hotfix' ? (threePart ? `${maj}.${min}.${pat}.${hot + 1}` : `${maj}.${min}.1`)
      : (threePart ? `${maj}.${min}.${pat + 1}` : `${maj}.${min}.1`);

let cl = fs.readFileSync(clPath, 'utf8');
// 版本号要放进正则：不只转义点，反斜杠和所有正则元字符都要转义，
// 否则特殊字符会被当成语法而不是字面量。
const escaped = String(next).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dupRe = new RegExp('^##\\s*' + escaped + '\\b', 'm');
if (dupRe.test(cl)) {
  console.error(`CHANGELOG 里已经有 ${next} 了：一个版本号只能对应一次改动，先确认再改。`);
  process.exit(1);
}

const entry = `## ${next}\n\n${desc}\n\n`;
const idx = cl.search(/^## /m);
cl = idx >= 0 ? cl.slice(0, idx) + entry + cl.slice(idx) : cl.trimEnd() + '\n\n' + entry;
fs.writeFileSync(clPath, cl, 'utf8');

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n', 'utf8');

console.log(`版本：${pkg.version === next ? '旧 -> 新' : ''}  ${next}（${level}）`);
console.log(`CHANGELOG 已加一条：${desc}`);
console.log('下一步：npm test && npm run release-check，然后 deploy + 出包。');
