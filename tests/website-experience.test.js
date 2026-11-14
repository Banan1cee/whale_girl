'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../scripts/build-website');
const { validateSupport } = require('../scripts/website-support');

const root = path.resolve(__dirname, '..');
const support = JSON.parse(fs.readFileSync(path.join(root, 'website/content/support.json'), 'utf8'));
const latest = { tag_name: 'v4.1.0', name: '正式版本', published_at: '2026-11-12T00:00:00Z', draft: false, prerelease: false, body: '## 改进\n- 示例发行说明', assets: [] };
const data = { latest, releases: [latest], sourceCommit: 'a'.repeat(40), fetchedAt: '2026-11-14T00:00:00Z', plugins: [] };
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-experience-'));
try {
  validateSupport(support, path.join(root, 'website'));
  const extra = { id: 'example-support', name: '示例渠道', type: 'link', url: 'https://example.com/support', description: '测试配置，不发布', button: '前往支持', enabled: true, order: 1 };
  const configured = { ...support, channels: [...support.channels, extra] };
  buildSite({ root, output, data, support: configured, tips: { updatedAt: '2026-11-14', entries: [
    { id: 'tip-demo', date: '2026-11-13', amountMinor: 100, currency: 'CNY', consent: false, channel: extra.id },
  ] } });
  const read = name => fs.readFileSync(path.join(output, name), 'utf8');
  assert.match(read('support/index.html'), /示例渠道/);
  assert.match(read('support/index.html'), /https:\/\/example\.com\/support/);
  assert.ok(read('support/index.html').indexOf('data-channel="example-support"') < read('support/index.html').indexOf('data-channel="afdian"'), '按配置排序');
  assert.match(read('support/transparency/index.html'), /data-channel="example-support"/);
  assert.match(read('support/transparency/index.html'), /示例渠道/);
  assert.doesNotMatch(read('support/transparency/index.html'), /爱发电 · 团队创作打赏记录/);
  for (const page of ['index.html', 'downloads/index.html', 'plugins/index.html', 'support/index.html', 'support/transparency/index.html', 'team/index.html']) {
    assert.match(read(page), /site-motion\.js/, `${page} 加载公共动效`);
    assert.match(read(page), /data-motion-toggle/, `${page} 可以暂停动态效果`);
  }
  assert.match(read('plugins/index.html'), /catalog-sidebar/);
  assert.match(read('downloads/v4.1.0/index.html'), /release-layout/);
  assert.match(read('support/index.html'), /support-layout/);
  buildSite({ root, output, data, support: { ...configured, channels: configured.channels.map(item => ({ ...item, enabled: false })) } });
  assert.doesNotMatch(read('support/index.html'), /data-channel="example-support"/);
  assert.match(read('support/index.html'), /暂未开放打赏渠道/);
  assert.throws(() => validateSupport({ ...support, channels: [...support.channels, { ...extra, url: 'javascript:alert(1)' }] }, path.join(root, 'website')), /链接/);
  assert.throws(() => validateSupport({ ...support, channels: [...support.channels, { ...extra, type: 'qrcode', image: '../private.png' }] }, path.join(root, 'website')), /二维码/);
  assert.throws(() => validateSupport({ ...support, channels: [...support.channels, { ...extra, type: 'qrcode', image: 'images/support/missing.png' }] }, path.join(root, 'website')), /二维码/);
  assert.throws(() => validateSupport({ ...support, channels: [...support.channels, { ...extra, id: 'afdian' }] }, path.join(root, 'website')), /重复/);
  assert.throws(() => buildSite({ root, output, data, support, tips: { updatedAt: '2026-11-14', entries: [
    { id: 'tip-demo', date: '2026-11-13', amountMinor: 100, currency: 'CNY', consent: false, channel: 'unknown-channel' },
  ] } }), /渠道/);
  const fixtureRoot = path.join(output, 'fixture');
  fs.cpSync(path.join(root, 'website'), path.join(fixtureRoot, 'website'), { recursive: true });
  const imageFolder = path.join(fixtureRoot, 'website/images/support');
  fs.mkdirSync(imageFolder, { recursive: true });
  // 测试图片仅验证渲染与展开入口，不是实际收款码，也不进入官网源码。
  fs.copyFileSync(path.join(root, 'website/images/launcher-icon.png'), path.join(imageFolder, 'test-code.png'));
  const qrSupport = { ...support, channels: [...support.channels,
    { ...extra, id: 'qr-example', type: 'qrcode', image: 'images/support/test-code.png', url: undefined, button: '展开测试图片' },
  ] };
  const qrOutput = path.join(output, 'qr-preview');
  buildSite({ root: fixtureRoot, output: qrOutput, data, support: qrSupport });
  const qrPage = fs.readFileSync(path.join(qrOutput, 'support/index.html'), 'utf8');
  assert.match(qrPage, /<details class="qr-details">/);
  assert.match(qrPage, /src="\.\.\/images\/support\/test-code\.png"/);
  const withCodeHeading = { ...latest, body: '## 正文标题\n```sh\n# 这不是目录\n```\n## 另一个标题' };
  buildSite({ root, output, data: { ...data, latest: withCodeHeading } });
  const versionPage = read('downloads/v4.1.0/index.html');
  assert.equal((versionPage.match(/href="#note-/g) || []).length, 2);
  assert.match(versionPage, /id="note-1"/);
  console.log('website experience: configurable channels, visibility, sorting, channel ledger, motion and desktop structures passed');
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
