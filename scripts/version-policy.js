'use strict';

function parseVersion(value) {
  const text = String(value).trim().replace(/^[vV]/, '');
  if (!/^\d+\.\d+(?:\.\d+){0,2}$/.test(text)) throw new Error('版本须为2/3/4段数字');
  const parts = text.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 65535)) throw new Error('版本数字超出FileVersion范围');
  const padded = [...parts]; while (padded.length < 4) padded.push(0);
  return { version: parts.join('.'), parts, padded, fileVersion: padded.join('.'), hotfix: parts.length === 4 };
}
function compareVersions(a, b) {
  const left = parseVersion(a).padded, right = parseVersion(b).padded;
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function versionMetadata(value, { tag } = {}) {
  const parsed = parseVersion(value), version = parsed.version;
  if (tag !== undefined && parseVersion(tag).version !== version) throw new Error('tag版本与package版本不一致');
  return { version, productVersion: version, fileVersion: parsed.fileVersion,
    sourceName: `whale-girl-${version}.zip`, fullName: `whale-girl-${version}-full.zip`,
    setupName: `whale-girl-${version}-setup.exe` };
}
function bumpVersion(value, level) {
  const { parts, padded: [major, minor, patch, hotfix] } = parseVersion(value);
  const next = level === 'major' ? `${major + 1}.0.0`
    : level === 'minor' ? parts.length === 2 ? `${major}.${minor + 1}` : `${major}.${minor + 1}.0`
      : level === 'patch' ? `${major}.${minor}.${patch + 1}`
        : level === 'hotfix' ? `${major}.${minor}.${patch}.${hotfix + 1}` : null;
  if (!next) throw new Error('未知版本升级类型');
  return parseVersion(next).version;
}
module.exports = { parseVersion, compareVersions, versionMetadata, bumpVersion };
if (require.main === module) {
  try {
    const [version, ...args] = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--tag')) throw new Error('用法：version-policy.js version [--tag tag]');
    console.log(JSON.stringify(versionMetadata(version, { tag: args[1] })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
