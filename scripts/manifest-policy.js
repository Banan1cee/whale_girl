'use strict';

/**
 * 改 release-manifest.json 的策略字段，并自动把 manifest_version +1。
 *
 * 为什么要 +1：客户端同时读 4 个源，取 manifest_version 最大的那份。
 * 你只改 main 上的文件、不抬序号的话，Release 资产里那份同序号的旧清单
 * 会先被选中——刹车就失效了。这个脚本替你保证这一点。
 *
 * 用法：
 *   npm run brake                          # force=false：只提示，不强制
 *   npm run unbrake                        # force=null ：恢复时间闸
 *   npm run force-now                      # force=true ：立即强制
 *   node scripts/manifest-policy.js --force-from 4.0.8      # 只强制 >= 4.0.8
 *   node scripts/manifest-policy.js --force-from null       # 取消强制范围
 *   node scripts/manifest-policy.js --kill-below 4.0.2     # 熔断
 *   node scripts/manifest-policy.js --kill-below null      # 取消熔断
 *   node scripts/manifest-policy.js --withdraw 4.1.0       # 下架某个版本（精确匹配）
 *   node scripts/manifest-policy.js --withdraw null        # 取消下架
 *   node scripts/manifest-policy.js --force-after-hours 6  # 时间闸改成 6 小时
 *
 * 改完记得 commit + push，客户端 1~5 分钟内生效。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const REPO = 'Banan1cee/whale_girl';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const fileArg = arg('file');
const file = fileArg ? path.resolve(fileArg) : path.join(root, 'release-manifest.json');

const wantHelp = process.argv.includes('--help') || process.argv.length <= 2;

// 客户端只认 Release 资产里那份清单，所以改完本地文件必须显式上传，
// 否则仓库根改了也不生效。--publish 也可以单独跑：只重传，不改内容、不抬序号。
const publishOnly = process.argv.includes('--publish');
const publish = publishOnly;
if (wantHelp) {
  console.log(`改更新策略（会自动把 manifest_version +1）

  npm run brake                          刹车：force=false（只提示，不强制）
  npm run unbrake                        恢复：force=null（按时间闸）
  npm run force-now                      立即强制：force=true
  node scripts/manifest-policy.js --force-from 4.0.8      只强制 >= 4.0.8
  node scripts/manifest-policy.js --force-from null       取消强制范围
  node scripts/manifest-policy.js --kill-below 4.0.2       熔断：低于 4.0.2 不许启动
  node scripts/manifest-policy.js --kill-below null        取消熔断
  node scripts/manifest-policy.js --withdraw 4.1.0         下架 4.1.0（逗号分隔可写多个）
  node scripts/manifest-policy.js --withdraw null          取消全部下架
  node scripts/manifest-policy.js --latest 4.0.8.2         把 latest 指回指定版本
  node scripts/manifest-policy.js --force-after-hours 6    时间闸改成 6 小时

  以上任何一条后面都可以加 --publish，改完立刻传成 Release 资产：
  npm run brake -- --publish         ← 真正的急刹车（客户端只认 Release 资产）
  npm run policy:publish             ← 只重传当前文件，不改内容、不抬序号

  下架一个坏版本，一条命令：
  npm run withdraw -- 4.1.0 --latest 4.0.8.2 --publish

改完记得 git commit + push；客户端 1~5 分钟内生效。`);
  process.exit(0);
}

if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}`);
  process.exit(1);
}

let m;
try {
  m = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error('release-manifest.json 不是合法 JSON：' + e.message);
  process.exit(1);
}

let touched = false;

const forceArg = arg('force');
if (forceArg !== undefined) {
  if (forceArg === 'true') m.force = true;
  else if (forceArg === 'false') m.force = false;
  else if (forceArg === 'null') m.force = null;
  else {
    console.error('--force 只能是 true / false / null');
    process.exit(1);
  }
  touched = true;
}

const killArg = arg('kill-below');
if (killArg !== undefined) {
  m.kill_below = killArg === 'null' || killArg === '' ? null : killArg.replace(/^[vV]/, '');
  touched = true;
}

const forceFromArg = arg('force-from');
if (forceFromArg !== undefined) {
  m.force_from = forceFromArg === 'null' || forceFromArg === '' ? null : forceFromArg.replace(/^[vV]/, '');
  touched = true;
}

// 下架时要把 latest 指回能用的版本，否则老用户还在被推进坏版本。
// 用参数改而不是手改文件，省得改完忘了抬序号。
const latestArg = arg('latest');
if (latestArg !== undefined) {
  const v = String(latestArg).replace(/^[vV]/, '');
  if (!/^\d+\.\d+(\.\d+)?(\.\d+)?$/.test(v)) {
    console.error('--latest 要是版本号，例如 4.0.8.2');
    process.exit(1);
  }
  m.latest = v;
  touched = true;
}

// 下架名单：精确匹配。kill_below 是阈值，表达不了「只停 4.1.0、放行 4.0.8.2」。
const withdrawArg = arg('withdraw');
if (withdrawArg !== undefined) {
  m.withdrawn = withdrawArg === 'null' || withdrawArg === ''
    ? []
    : withdrawArg.split(',').map((s) => s.trim().replace(/^[vV]/, '')).filter(Boolean);
  touched = true;
}

const hoursArg = arg('force-after-hours');
if (hoursArg !== undefined) {
  const n = Number(hoursArg);
  if (!Number.isFinite(n) || n < 0) {
    console.error('--force-after-hours 要是非负数字');
    process.exit(1);
  }
  m.force_after_hours = n;
  touched = true;
}

if (!touched && !publishOnly) {
  console.error('没给任何策略参数，什么也没改。加 --help 看用法。');
  process.exit(1);
}

// 关键一步：抬序号，否则客户端会继续用缓存/旧资产（同序号时先到的赢）
if (touched) m.manifest_version = (Number(m.manifest_version) || 0) + 1;

fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n', 'utf8');

const forceText = m.force === null ? 'null（按时间闸自动）' : String(m.force);
const killText = m.kill_below === null || m.kill_below === undefined ? 'null（不熔断）' : m.kill_below;
const withdrawnList = Array.isArray(m.withdrawn) ? m.withdrawn : [];
const withdrawnText = withdrawnList.length ? withdrawnList.join(', ') : '[]（空：没有下架版本）';

console.log('已更新 ' + path.relative(root, file));
console.log('  manifest_version   ' + m.manifest_version);
console.log('  latest             ' + m.latest);
console.log('  force              ' + forceText);
console.log('  force_from         ' + (m.force_from || 'null'));
console.log('  kill_below         ' + killText);
console.log('  withdrawn          ' + withdrawnText);
console.log('  force_after_hours  ' + m.force_after_hours);

// 只下架、不把 latest 挪回旧版，是最容易犯的错：坏版本被停住了，
// 可老用户还在被推进同一个坏版本，等于一边下架一边推。
const latestNorm = String(m.latest || '').replace(/^[vV]/, '');
if (withdrawnList.length && withdrawnList.includes(latestNorm)) {
  console.log('');
  console.log('⚠ latest 还在下架名单里：老版本用户会被推向这个坏版本。');
  console.log('  用 --latest 一起改，例如：');
  console.log('    npm run withdraw -- ' + latestNorm + ' --latest <能用的版本> --publish');
}

console.log('');

// 客户端只认 Release 资产：不传上去，本地改多少都没用。
if (publish) {
  const tag = 'v' + String(m.latest || '').replace(/^[vV]/, '');
  try {
    execFileSync('gh', ['release', 'upload', tag, file, '--clobber', '--repo', REPO], { stdio: 'inherit' });
    console.log('已上传 Release 资产：' + tag + '/' + path.basename(file) + '（1~5 分钟后全量生效）');
  } catch (err) {
    console.error('上传 Release 资产失败：' + (err && err.message ? err.message : err));
    console.error('手动执行：gh release upload ' + tag + ' ' + path.basename(file) + ' --clobber --repo ' + REPO);
    process.exitCode = 1;
  }
} else {
  console.log('注意：客户端只认 Release 资产，本地改完还没生效。上传：');
  console.log('  npm run policy:publish        # 或给上面的命令加 --publish');
}

console.log('记得 git add release-manifest.json && git commit -m "chore: 更新更新策略" && git push');
