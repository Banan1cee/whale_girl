'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render } = require('../scripts/render-website-releases');

const root = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
const release = (tag, options = {}) => ({
  tag_name: tag,
  name: `鲸鲸 ${tag.replace(/^v/, '')} · 更新`,
  body: '## 修复\n- 修复窗口识别。',
  draft: false,
  prerelease: false,
  published_at: '2026-11-07T18:55:00Z',
  ...options,
});

const latest = release('v4.08.1', {
  name: '鲸鲸 4.08.1 · 微信账号窗口识别修复 <示例>',
  body: '## 修复\n- 修复窗口识别。\n- 保留双开账号校验。\n\n<!-- 内部注释 -->',
});
const stable = [
  release('4.0.5', { published_at: '2026-11-06T10:00:00Z' }),
  release('v4.0.8', { published_at: '2026-11-07T18:52:00Z' }),
  release('v4.0.7', { published_at: '2026-11-06T22:00:00Z' }),
];
const unpublished = [
  release('v4.0.9', { draft: true }),
  release('v4.1.0-rc1', { prerelease: true }),
  release('v4.2.0', { published_at: null }),
];
const html = render(template, latest, [...unpublished, ...stable, latest]);
const versions = [...html.matchAll(/class="release-version">([\d.]+)/g)].map(match => match[1]);
const links = [...html.matchAll(/class="release-row" href="([^"]+)"/g)].map(match => match[1]);

assert.deepEqual(versions, ['4.08.1', '4.0.8', '4.0.7'], '最新正式版在首位，再按发布时间列两条记录');
assert.deepEqual(links.map(link => link.split('/').at(-1)), ['v4.08.1', 'v4.0.8', 'v4.0.7']);
assert.match(html, /探索 4\.08\.1 的新变化/);
assert.match(html, /微信账号窗口识别修复 &lt;示例&gt;/);
assert.match(html, /修复窗口识别。 保留双开账号校验。/);
assert.match(html, /<time datetime="2026-11-08">2026\.11\.08<\/time>/, '日期按北京时间显示');
assert.doesNotMatch(html, /v4\.0\.9|v4\.1\.0-rc1|v4\.2\.0|内部注释|<!-- release:/);
assert.match(html, /<a href="#updates">更新<\/a>/);
assert.throws(() => render(template, unpublished[0], stable), /正式发行数据无效/);

const pages = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
assert.match(pages, /release:\s*types:\s*\[[^\]]*published/);
assert.match(pages, /gh workflow run pages\.yml --ref main/);
assert.match(pages, /releases\/latest/);
assert.match(pages, /render-website-releases\.js/);

console.log('website releases: stable selection, date, escaped HTML and Pages triggers passed');
