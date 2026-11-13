'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite, validateTips } = require('../scripts/build-website');
const { collectPages } = require('../scripts/fetch-website-data');

const root = path.join(__dirname, '..');
const release = (tag, extra = {}) => ({
  tag_name: tag, name: `鲸鲸 ${tag} · 更新`, draft: false, prerelease: false,
  published_at: '2026-11-13T08:00:00Z', body: '## 修复\n- 保留所有说明。\n\n<script>alert(1)</script>',
  assets: [{ name: `whale-girl-${tag}-setup.exe`, size: 1024,
    browser_download_url: `https://github.com/Banan1cee/whale_girl/releases/download/${tag}/whale-girl-${tag}-setup.exe` }],
  ...extra,
});

async function main() {
  const pages = [];
  const collected = await collectPages(async page => {
    pages.push(page);
    return page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i })) : [{ id: 100 }];
  });
  assert.equal(collected.length, 101, '完整读取多页，不截断为最近二十条');
  assert.deepEqual(pages, [1, 2]);

  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-website-test-'));
  try {
    const latest = release('v4.1.0');
    const old = release('v3.60');
    const preview = release('v4.2.0-rc.1', { prerelease: true });
    const data = { latest, releases: [latest, old, preview, release('v9.0.0', { draft: true })],
      fetchedAt: '2026-11-13T08:00:00Z', sourceCommit: 'a'.repeat(40), plugins: [{
        Id: 'text-counter', Name: '<测试插件>', Author: 'Banan1cee', Api: 1, Version: '1.0.0',
        MinAppVersion: '4.1.0', Description: '真实目录内容。', Sha256: 'b'.repeat(64),
        Download: 'https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/packages/text-counter-1.0.0.zip',
        SourceIndex: 'index.json',
      }] };
    buildSite({ root, output, data });
    const read = file => fs.readFileSync(path.join(output, file), 'utf8');
    const home = read('index.html');
    const archive = read('downloads/index.html');
    const oldPage = read('downloads/v3.60/index.html');
    assert.match(home, /团队成员/);
    assert.doesNotMatch(home, /作者有话说|待作者确认|网站寄语草稿/);
    assert.match(home, /感谢每一位为鲸鲸贡献代码/);
    assert.match(archive, /\.\/v3\.60\//);
    assert.match(archive, /预览版/);
    assert.doesNotMatch(archive, /v9\.0\.0/);
    assert.match(oldPage, /releases\/download\/v3\.60\/whale-girl-v3\.60-setup\.exe/);
    assert.doesNotMatch(oldPage, /releases\/latest|<script>alert/);
    assert.match(oldPage, /&lt;script&gt;/, '发行说明按文本安全展示');
    assert.match(read('plugins/text-counter/index.html'), /&lt;测试插件&gt;/);
    assert.match(read('plugins/text-counter/index.html'), /从本地安装/);
    assert.match(read('support/index.html'), /https:\/\/afdian\.com\/a\/Banan1ce/);
    assert.match(read('support/index.html'), /团队创作打赏/);
    assert.match(read('support/transparency/index.html'), /<table/);
    assert.match(read('support/transparency/index.html'), /尚未公布打赏记录/);
    assert.doesNotMatch(read('support/transparency/index.html'), /累计打赏[^<]*0/);
    const team = read('team/index.html');
    assert.match(team, /Muzi0336/);
    assert.match(team, /记忆系统开发/);
    const thanks = team.indexOf('致谢与贡献者');
    assert.ok(thanks > 0 && team.indexOf('lx-1203') > thanks);
    assert.doesNotMatch(team.slice(0, thanks), /lx-1203/);

    // 每个生成页的本地资源、导航和详情链接都应可用，包含多层目录。
    function checkLinks(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) checkLinks(file);
        else if (file.endsWith('.html')) {
          for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:href|src)="([^"#]+)"/g)) {
            const url = match[1].split('#')[0];
            if (/^(?:https?:|mailto:)/.test(url)) continue;
            const target = path.resolve(path.dirname(file), url);
            assert.ok(fs.existsSync(target), `${path.relative(output, file)}: 本地链接失效 ${url}`);
          }
        }
      }
    }
    checkLinks(output);
    buildSite({ root, output, data, tips: { updatedAt: '2026-11-13', entries: [
      { id: 'tip-example-a', date: '2026-11-12', amountMinor: 10, currency: 'CNY', consent: false },
      { id: 'tip-example-b', date: '2026-10-12', amountMinor: 20, currency: 'CNY', consent: true, name: '<示意昵称>', message: '<script>不可执行</script>' },
    ] } });
    const populatedTips = read('support/transparency/index.html');
    assert.match(populatedTips, /¥0\.30/, '按整数分汇总，不产生浮点尾数');
    assert.match(populatedTips, /匿名支持者/);
    assert.match(populatedTips, /data-month="10"/);
    assert.match(populatedTips, /&lt;示意昵称&gt;/);
    assert.doesNotMatch(populatedTips, /<script>不可执行/);
    assert.throws(() => buildSite({ root, output, data: { ...data, plugins: [{ ...data.plugins[0], Id: '../escape' }] } }), /插件/);
    assert.throws(() => buildSite({ root, output, data: { ...data, plugins: [{ ...data.plugins[0], Download: 'javascript:alert(1)' }] } }), /下载/);
    assert.throws(() => buildSite({ root, output, data: { ...data, releases: [release('../escape')] } }), /版本/);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
  assert.throws(() => validateTips({ updatedAt: null, entries: [{ amountMinor: 100 }] }), /公示/);
  assert.throws(() => validateTips({ updatedAt: '2026-11-13', entries: [
    { id: 'tip-1', date: '2026-11-12', amountMinor: 100, currency: 'CNY', name: '未同意的昵称', consent: false },
  ] }), /匿名/);
  assert.throws(() => validateTips({ updatedAt: '2026-11-13', entries: [
    { id: 'tip-1', date: '2026-11-12', amountMinor: 1.5, currency: 'CNY', consent: false },
  ] }), /金额/);
  assert.throws(() => validateTips({ updatedAt: '2026-13-01', entries: [] }), /公示/);
  assert.throws(() => validateTips({ updatedAt: '2026-11-13', entries: [
    { id: 'tip-example', date: '2026-11-12', amountMinor: 100, currency: 'CNY', consent: false, orderId: 'must-not-be-public' },
  ] }), /非公开/);
  console.log('website hub: pagination, native pages, exact downloads, escaping, team, tips and links passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
