'use strict';

const fs = require('node:fs');
const path = require('node:path');

const POPUP_SECTION = /^### 更新弹窗摘要[ \t]*\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/m;

function versionNotes(changelog, version) {
  const escaped = String(version).replace(/^v/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(changelog).match(new RegExp('^##\\s+v?' + escaped + '\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))', 'm'));
  if (!match || !match[1].trim()) throw new Error('没有找到该版本的更新说明');
  return match[1].trim();
}

function releaseNotes(changelog, version) {
  const details = versionNotes(changelog, version).replace(POPUP_SECTION, '').trim();
  if (!details) throw new Error('没有找到该版本的详细更新说明');
  return details;
}

function popupSummary(changelog, version) {
  const summary = versionNotes(changelog, version).match(POPUP_SECTION)?.[1].trim();
  if (!summary) throw new Error('没有找到该版本的更新弹窗摘要');
  const lines = summary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 3 || lines.some((line) => !/^- \S/.test(line) || line.length > 62)) {
    throw new Error('更新弹窗摘要须为 1～3 条，每条最多 60 个字符');
  }
  return lines.join('\n');
}

if (require.main === module) {
  try {
    const [, , version, option] = process.argv;
    const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
    const format = option === '--summary' ? popupSummary : releaseNotes;
    process.stdout.write(format(changelog, version || '') + '\n');
  }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}

module.exports = { releaseNotes, popupSummary };
