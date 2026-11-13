'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { render } = require('./render-website-releases');
const { describeError } = require('../src/infra/errors');
const APP = 'https://github.com/Banan1cee/whale_girl';
const MARKET = 'https://github.com/Banan1cee/whale-girl-plugins';
const ORIGIN = 'https://bot.zyyc.cc/';
const INDEXES = new Set(['index.json', 'index-v2.json', 'index-v3.json', 'index-v4.json', 'index-personas.json']);
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const date = value => dateFormat.format(new Date(value));
const link = (href, text, className = 'text-link') => `<a class="${className}" href="${e(href)}" target="_blank" rel="noopener noreferrer">${e(text)} <span aria-hidden="true">↗</span></a>`;
const isRelease = item => item && !item.draft && item.tag_name && item.published_at && Number.isFinite(Date.parse(item.published_at));

function releaseSlug(tag) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(tag)) throw new Error('发行版本标识无效');
  return tag;
}

function releaseTitle(item) { return String(item.name || item.tag_name); }
function size(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function withoutComments(text) {
  const fragments = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf('<!--', cursor);
    if (start === -1) { fragments.push(text.slice(cursor)); break; }
    fragments.push(text.slice(cursor, start));
    // 保留边界，避免删除后将两侧碎片重新拼成 HTML 标记；输出仍须逐段转义。
    fragments.push('\n');
    const end = text.indexOf('-->', start + 4);
    if (end === -1) break;
    cursor = end + 3;
  }
  return fragments.join('');
}

function notes(body) {
  // 不执行发行说明中的 HTML，也不将第三方 Markdown 链接变成可执行 URL。
  const lines = withoutComments(String(body || '此版本未提供更新说明，请查看 GitHub 发行页。')).split(/\r?\n/);
  let code = false;
  let list = false;
  const result = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (list) { result.push('</ul>'); list = false; }
      result.push(code ? '</code></pre>' : '<pre><code>'); code = !code; continue;
    }
    if (code) { result.push(e(line) + '\n'); continue; }
    const bullet = /^\s*(?:[-*+]\s+|\d+\.\s+)(.*)$/.exec(line);
    if (bullet) {
      if (!list) { result.push('<ul>'); list = true; }
      result.push(`<li>${e(bullet[1])}</li>`); continue;
    }
    if (list) { result.push('</ul>'); list = false; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) result.push(`<h2>${e(heading[1])}</h2>`);
    else if (/^>/.test(line)) result.push(`<blockquote>${e(line.replace(/^>\s?/, ''))}</blockquote>`);
    else if (line.trim()) result.push(`<p>${e(line)}</p>`);
  }
  if (list) result.push('</ul>');
  if (code) result.push('</code></pre>');
  return result.join('\n');
}

function header(prefix, current) {
  const nav = [['', '首页'], ['downloads/', '下载中心'], ['plugins/', '插件市场'], ['support/', '支持我们'], ['team/', '团队']];
  return `<a class="skip" href="#main">跳转到主要内容</a><header class="header"><nav class="nav wrap" aria-label="主导航">
    <a class="brand" href="${prefix}" aria-label="鲸鲸首页"><img class="brand-icon" src="${prefix}images/launcher-icon.png" alt="" width="256" height="256"><span>鲸鲸 <span class="brand-en">Whale Girl</span></span></a>
    <button class="menu-toggle icon-button" aria-label="打开导航" aria-expanded="false" aria-controls="nav-links"><span></span><span></span></button>
    <div class="nav-links" id="nav-links">${nav.map(([route, text]) => `<a href="${prefix}${route}"${route === current ? ' aria-current="page"' : ''}>${text}</a>`).join('')}</div>
    <div class="nav-actions"><button id="theme-toggle" class="icon-button" aria-label="切换明暗主题"><svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/></svg></button><a class="button small" href="${prefix}downloads/">免费下载 <span aria-hidden="true">↗</span></a></div>
  </nav></header>`;
}

function footer(prefix) {
  return `<footer class="footer wrap"><div class="footer-top"><a class="brand" href="${prefix}"><img class="brand-icon" src="${prefix}images/launcher-icon.png" alt="" width="256" height="256">鲸鲸 <span class="brand-en">Whale Girl</span></a><span>A little whale in your digital world.</span>${link(APP, 'GitHub')}</div><div class="footer-bottom"><span>© <span id="year">2026</span> Whale Girl. 开源，让美好继续发生。</span><div><a href="${prefix}support/transparency/">打赏公示</a>${link(`${APP}/blob/main/docs/PRIVACY.md`, '隐私说明')}${link(`${APP}/blob/main/LICENSE`, '开源许可')}</div></div></footer>`;
}

function layout(route, title, description, content, current) {
  const depth = route.split('/').filter(Boolean).length;
  const prefix = depth ? '../'.repeat(depth) : './';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#070b13"><meta name="description" content="${e(description)}"><title>${e(title)} — 鲸鲸 Whale Girl</title><link rel="canonical" href="${ORIGIN}${route}"><link rel="icon" href="${prefix}images/launcher-icon.png" type="image/png"><script src="${prefix}theme.js"></script><link rel="stylesheet" href="${prefix}style.css"><link rel="stylesheet" href="${prefix}pages.css"><script src="${prefix}site.js" defer></script></head><body class="content-page">${header(prefix, current)}<main id="main" class="wrap page-main">${content}</main>${footer(prefix)}</body></html>\n`;
}

function intro(kicker, title, description) {
  return `<div class="page-intro"><p class="eyebrow">${e(kicker)}</p><h1>${title}</h1><p class="page-lead">${description}</p></div>`;
}

function searchFilters(label, placeholder, selects = '') {
  return `<div class="filter-bar" data-filters hidden><label class="search-field">${e(label)}<input type="search" placeholder="${e(placeholder)}" autocomplete="off"></label>${selects}</div><p class="filter-status" id="filter-status" role="status" aria-live="polite"></p>`;
}

function selectFilter(label, key, options) {
  return `<label>${e(label)}<select data-key="${key}"><option value="">全部</option>${options.map(([value, text]) => `<option value="${e(value)}">${e(text)}</option>`).join('')}</select></label>`;
}

function teamCards(team, prefix, preview = false) {
  return `<div class="team-grid">${team.members.map(member => `<article class="person-card"><div class="person-heading"><img class="person-avatar" src="${prefix}images/team/${e(member.login)}.png" alt="" width="96" height="96" loading="lazy"><div><h${preview ? '3' : '2'}>${e(member.login)}</h${preview ? '3' : '2'}><p class="person-role">${e(member.role)}</p></div></div>${preview ? '' : `<blockquote>${e(member.message)}</blockquote>`}${link(`https://github.com/${member.login}`, 'GitHub')}</article>`).join('')}</div>`;
}

function downloads(releases, latest) {
  const years = [...new Set(releases.map(item => date(item.published_at).slice(0, 4)))].sort().reverse();
  return intro('EVERY CHAPTER, KEPT.', '每一次成长，<br>都有迹可循。', '下载最新正式版，或回到鲸鲸的某一个历史版本。')
    + `<section class="highlight-panel"><div><span class="tag">最新正式发行</span><h2>${e(releaseTitle(latest))}</h2><p>发布于 ${date(latest.published_at)} · Windows</p></div><a class="button" href="./${releaseSlug(latest.tag_name)}/">查看下载与更新说明 <span aria-hidden="true">↗</span></a></section>`
    + `<section class="page-section" aria-labelledby="history-heading"><div class="section-heading"><div><p class="eyebrow">RELEASE ARCHIVE</p><h2 id="history-heading">下载历史</h2></div>${link(`${APP}/releases`, 'GitHub 发行记录')}</div>`
    + searchFilters('搜索版本', '版本号或更新标题', selectFilter('发布年份', 'year', years.map(year => [year, year])) + selectFilter('发行类型', 'kind', [['stable', '正式版'], ['preview', '预览版']]))
    + `<div class="archive-list">${releases.map(item => `<article class="archive-row" data-filter-item data-search="${e(item.tag_name + ' ' + releaseTitle(item))}" data-year="${date(item.published_at).slice(0, 4)}" data-kind="${item.prerelease ? 'preview' : 'stable'}"><div><span class="tag">${item.prerelease ? '预览版' : item.tag_name === latest.tag_name ? '最新正式版' : '历史正式版'}</span><h3><a href="./${releaseSlug(item.tag_name)}/">${e(releaseTitle(item))}</a></h3><time datetime="${date(item.published_at)}">${date(item.published_at)}</time></div><a class="text-link" href="./${releaseSlug(item.tag_name)}/" aria-label="查看 ${e(item.tag_name)} 下载页面">版本详情 <span aria-hidden="true">↗</span></a></article>`).join('')}</div><p class="empty-state" id="filter-empty" hidden>没有找到符合条件的版本，试试其他关键词。</p></section>`;
}

function releasePage(item, latest) {
  const slug = releaseSlug(item.tag_name);
  const assets = (item.assets || []).filter(asset => {
    try {
      const url = new URL(asset.browser_download_url);
      return url.protocol === 'https:' && url.origin === 'https://github.com' && !url.username && !url.password
        && url.pathname.startsWith(`/Banan1cee/whale_girl/releases/download/${encodeURIComponent(item.tag_name)}/`)
        && Number.isSafeInteger(asset.size) && asset.size >= 0;
    } catch { return false; }
  });
  return `<a class="back-link" href="../">← 全部发行版本</a>`
    + intro(item.prerelease ? 'PREVIEW RELEASE' : 'WHALE GIRL / RELEASE', e(releaseTitle(item)), `<time datetime="${date(item.published_at)}">${date(item.published_at)}</time> · ${item.prerelease ? '预览版' : '正式版'}`)
    + (item.prerelease ? '<div class="notice">这是预览版本，可能存在不稳定行为。安装前请备份配置与数据。</div>' : item.tag_name !== latest.tag_name ? '<div class="notice">这是历史版本，可能缺少后续修复。回退前请备份配置与数据，并核对版本兼容性。</div>' : '')
    + `<section class="page-section"><p class="eyebrow">DOWNLOAD FILES</p><h2>下载 ${e(slug)}</h2><p>以下文件来自这个版本的官方 GitHub Release。优先选择名称以 <code>-setup.exe</code> 结尾的 Windows 安装包；旧版发行的文件结构可能不同。</p><div class="asset-list">${assets.length ? assets.map(asset => `<article class="asset-row"><div><h3>${e(asset.name)}</h3><p>${size(asset.size)}</p>${/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') ? `<p class="hash">SHA-256 <code>${e(asset.digest.slice(7))}</code></p>` : ''}</div>${link(asset.browser_download_url, '下载文件', 'button secondary')}</article>`).join('') : '<p class="empty-state">此版本未附带可下载文件，请查看原始发行页。</p>'}</div><p>若发行文件中提供了 <code>SHA256SUMS.txt</code>，请一并下载，并按校验指南核对文件。</p><div class="inline-links">${link(`${APP}/releases/tag/${encodeURIComponent(slug)}`, '原始发行页')}${link(`${APP}/blob/main/docs/DOWNLOAD.md`, '下载与校验指南')}</div></section><section class="page-section release-notes"><p class="eyebrow">RELEASE NOTES</p><h2>完整更新说明</h2>${notes(item.body)}</section>`;
}

function pluginKind(item) { return item.Kind === 'persona' ? 'persona' : item.Kind === 'message' || item.Api === 3 ? 'message' : 'tool'; }
const kinds = { persona: '人设预设', message: '消息插件', tool: '功能工具' };

function atLeastVersion(value, minimum) {
  const parts = String(value).replace(/^v/i, '').split('.');
  if (!parts.every(part => /^\d+$/.test(part))) return false;
  const floor = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(parts.length, floor.length); i += 1) {
    const difference = Number(parts[i] || 0) - (floor[i] || 0);
    if (difference) return difference > 0;
  }
  return true;
}

function validatePlugins(plugins, commit) {
  if (!Array.isArray(plugins) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('插件市场快照无效');
  const ids = new Set();
  return plugins.map(item => {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(item.Id) || ids.has(item.Id)) throw new Error('插件 ID 无效或重复');
    ids.add(item.Id);
    if (!INDEXES.has(item.SourceIndex) || ![1, 2, 3, 4].includes(item.Api) || !item.Name || !item.Author
      || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(item.Version) || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(item.MinAppVersion)
      || !/^[a-f0-9]{64}$/i.test(item.Sha256)) throw new Error(`插件清单无效：${item.Id}`);
    const expectedIndex = item.Kind === 'persona' ? 'index-personas.json' : item.Api === 4 ? 'index-v4.json' : item.Api === 3 ? 'index-v3.json' : item.Api === 2 ? 'index-v2.json' : 'index.json';
    if (item.SourceIndex !== expectedIndex || (item.Api === 3 && item.Kind !== 'message')
      || (item.Kind && !['tool', 'message', 'persona'].includes(item.Kind))
      || (item.Kind === 'message' && ![3, 4].includes(item.Api))
      || (item.Kind === 'persona' && item.Api !== 1)
      || (item.Api === 4 && !['tool', 'message'].includes(item.Kind))) throw new Error(`插件类型与目录不符：${item.Id}`);
    if ((item.Hooks && (!Array.isArray(item.Hooks) || item.Hooks.some(value => typeof value !== 'string')))
      || (item.Permissions && (!Array.isArray(item.Permissions) || item.Permissions.some(value => typeof value !== 'string')))) throw new Error(`插件权限格式无效：${item.Id}`);
    if (item.Api === 4 && !atLeastVersion(item.MinAppVersion, '4.1.2')) throw new Error(`JavaScript 插件最低客户端须为 4.1.2 或以上：${item.Id}`);
    if (item.Api === 4 && !item.Permissions?.includes('system.full')) throw new Error(`JavaScript 插件须声明完整系统权限：${item.Id}`);
    const packageName = `${item.Id}-${item.Version}.zip`;
    const validDownloads = [`https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/packages/${packageName}`, `https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/${commit}/packages/${packageName}`];
    if (!validDownloads.includes(item.Download)) throw new Error(`插件下载地址无效：${item.Id}`);
    return { ...item, Download: validDownloads[1] };
  });
}

function pluginCards(plugins, prefix = './') {
  return `<div class="plugin-grid">${plugins.map(item => `<article class="plugin-card" data-filter-item data-kind="${pluginKind(item)}" data-search="${e([item.Name, item.Id, item.Author, item.Description].join(' '))}"><div class="card-top"><span class="tag">${kinds[pluginKind(item)]}</span><span class="plugin-api">API ${item.Api}</span></div><h${prefix === './' ? '2' : '3'}><a href="${prefix}${item.Id}/">${e(item.Name)}</a></h${prefix === './' ? '2' : '3'}><p class="plugin-id">${e(item.Id)}</p><p class="plugin-description">${e(item.Description)}</p><dl class="plugin-meta"><div><dt>作者</dt><dd>${e(item.Author)}</dd></div><div><dt>版本</dt><dd>${e(item.Version)}</dd></div><div><dt>最低客户端</dt><dd>${e(item.MinAppVersion)}</dd></div></dl><a class="text-link" href="${prefix}${item.Id}/">了解与下载 <span aria-hidden="true">↗</span></a></article>`).join('')}</div>`;
}

function pluginsPage(plugins, data) {
  return intro('MORE WAYS TO BE HERSELF.', '给鲸鲸，<br>更多可能。', '发现社区创作的人设、工具与消息插件。先了解用途、来源和权限，再决定安装。')
    + `<div class="catalog-summary"><span><strong>${plugins.length}</strong> 个已收录插件</span><span>来源可追溯</span><span>客户端内安装管理</span></div>`
    + searchFilters('搜索插件', '名称、用途、作者或插件 ID', selectFilter('插件类型', 'kind', Object.entries(kinds)))
    + (plugins.length ? pluginCards(plugins) : '<p class="empty-state">暂时没有已收录插件，欢迎提交你的作品。</p>')
    + '<p class="empty-state" id="filter-empty" hidden>没有找到符合条件的插件，试试其他关键词或类型。</p>'
    + `<section class="page-section split-panel"><div><p class="eyebrow">HOW IT WORKS</p><h2>先看清，再安装。</h2><ol class="steps"><li>打开插件详情，核对功能、权限和所需客户端版本。</li><li>在鲸鲸桌面启动器的「插件市场」安装；也可下载 ZIP，选择「从本地安装」。</li><li>在插件卡片中启用，并在「设置」内配置和使用。安装不等于授权。</li></ol></div><div class="info-panel"><h3>你的创意，也可以在这里。</h3><p>人设 ZIP 可以直接分享，无需 GitHub 账号。公开投稿通过市场仓库提交；没有账号也可请协作者代交。</p>${link(`${MARKET}/blob/main/README.md`, '阅读投稿指南')}${link(`${MARKET}/pulls`, '前往市场仓库')}</div></section>`
    + `<section class="page-section prose"><h2>收录不是安全保证。</h2><p>校验、模拟测试和 GitHub 签署不代表无毒保证，也不是现实实名认证。安装前请核对来源、权限与版本，备份数据并谨慎启用。</p><p>新安全门禁须先合并市场检测流程并设为必需检查后才生效，具体版本以 Actions 报告为准。客户端尚未自动验证 GitHub 签署证明或远程撤回名单。</p><p>API 3 Wasm 消息插件适用于 4.1.0 起的兼容客户端，不提供 Node.js、文件、网络或定时能力。JavaScript API 4 从 4.1.2 起支持，发布前仅供开发测试，以 GitHub Releases 为准；它不是沙箱，具有完整系统权限，实验总开关默认关闭，必须逐个确认后启用。更新后需要重新授权。</p><div class="inline-links">${link(`${MARKET}/tree/${data.sourceCommit}`, '查看本次目录快照')}${link(`${MARKET}/actions`, '检测记录')}${link(`${APP}/blob/main/docs/插件免责声明.md`, '第三方插件风险说明')}${link(`${APP}/blob/main/docs/插件JavaScriptApi4.md`, 'JavaScript 插件说明')}</div><p>目录同步时间：${date(data.fetchedAt)}</p></section>`;
}

function pluginDetail(item, data) {
  const kind = pluginKind(item);
  const permissions = [...new Set([...(item.Permissions || []), ...(item.HostAction ? [item.HostAction] : [])])];
  const descriptions = { 'chat.history': '读取最近 12 条会话消息', 'model.prompt': '读取与替换本轮系统提示词', 'chat.summary': '按次确认后，由宿主调用模型汇总选定日期的消息；云端模型会收到参与汇总的片段，可能产生费用', 'system.full': '完整系统权限，可访问文件、网络、系统命令、聊天、记忆及主程序全部 API；不是沙箱，只启用信任的代码' };
  const activation = item.Api === 4 ? '打开「启用 JavaScript 插件（实验性）」总开关，再逐个确认完整系统权限并启用。总开关默认关闭；更新后需重新授权。'
    : kind === 'persona' ? '启用后，在插件卡片「设置」预览人设，并确认应用。'
    : kind === 'message' ? '启用时确认持续参与消息处理；停用即撤销授权，更新后需重新启用。'
      : '启用后，点击同一张插件卡片的「设置」使用工具。';
  const fields = [
    ['ID', item.Id], ['作者', item.Author], ['版本', item.Version], ['类型', kinds[kind]],
    ['接口', `API ${item.Api}`], ['最低客户端', item.MinAppVersion], ['许可证', item.License || '目录未声明'],
  ];
  return '<a class="back-link" href="../">← 浏览全部插件</a>'
    + intro(kinds[kind], e(item.Name), e(item.Description))
    + (item.Api === 4 ? `<div class="notice"><strong>JavaScript 插件不是沙箱。</strong>代码以当前系统用户权限执行，可访问文件、网络和主程序全部 API。只启用信任的作者；停用或卸载不能撤销已经完成的操作。${atLeastVersion(data.latest.tag_name, item.MinAppVersion) ? '' : '所需客户端功能尚未正式发布，当前仅供开发测试；以 GitHub Releases 实际版本为准。'}</div>` : '')
    + `<div class="detail-grid"><div>
      <section class="info-panel"><h2>安装与使用</h2><ol class="steps">
        <li>核对客户端构建支持此插件所需的 API 与权限；最低声明版本是 ${e(item.MinAppVersion)}${item.MaxAppVersion ? `，最高声明版本是 ${e(item.MaxAppVersion)}` : ''}。</li>
        <li>下载 ZIP，在鲸鲸「插件市场 → 从本地安装」选择文件，不需要解压。</li>
        <li>${activation}</li></ol>${link(item.Download, '下载插件 ZIP', 'button')}
        <p class="notice">网页仅提供浏览和下载，不会连接你的本机程序。消息插件须核对具体客户端构建；开发版能力不等于旧客户端已支持。</p>
      </section>
      <section class="page-section"><h2>权限与数据</h2>
        ${kind === 'message' ? '<p>启用后持续读取当前消息和上一条机器人回复，并可保存按插件、会话隔离的状态。</p>' : ''}
        ${permissions.length ? `<ul>${permissions.map(permission => `<li><code>${e(permission)}</code>：${e(descriptions[permission] || '清单声明的附加权限，请阅读源码和客户端授权提示。')}</li>`).join('')}</ul>` : '<p>目录未声明附加权限。仍需核对插件类型和客户端提示，这不等于插件不处理任何数据。</p>'}
        ${item.Hooks?.length ? `<h3>消息扩展点</h3><ul>${item.Hooks.map(hook => `<li><code>${e(hook)}</code></li>`).join('')}</ul>` : ''}
      </section>
      <section class="page-section"><h2>版本记录</h2><p>${e(item.Version)} · 当前目录收录版本</p>
        <p>当前展示市场收录的版本，更多源码与变更请查看市场仓库。</p>${link(`${MARKET}/commits/main/plugins/${item.Id}`, '源码与变更历史')}
      </section>
    </div><aside class="info-panel metadata-panel"><h2>插件信息</h2>
      <dl class="plugin-meta">${fields.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>
      <h3>包校验值</h3><p class="hash"><code>${e(item.Sha256)}</code></p>
      <div class="stack-links">${link(`${MARKET}/tree/${data.sourceCommit}/plugins/${item.Id}`, '查看源码')}${link(`${MARKET}/blob/${data.sourceCommit}/${item.SourceIndex}`, '目录原文')}${link(`${MARKET}/actions`, '检测记录')}${link(`${MARKET}/issues`, '反馈问题')}</div>
      <p>SHA-256 用于核对文件，不代表安全保证。检测结果请以对应版本的市场 Actions 报告为准。</p>
    </aside></div>`;
}

function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validateTips(tips) {
  if (!tips || !Array.isArray(tips.entries) || (tips.updatedAt !== null && !validDay(tips.updatedAt))
    || (tips.entries.length && !tips.updatedAt) || Object.keys(tips).some(key => !['updatedAt', 'entries'].includes(key))) throw new Error('打赏公示日期或记录无效');
  const ids = new Set();
  for (const item of tips.entries) {
    if (!/^tip-[a-z0-9-]+$/.test(item.id) || ids.has(item.id) || !validDay(item.date) || item.date > tips.updatedAt
      || typeof item.consent !== 'boolean') throw new Error('打赏公示记录 ID 或日期无效');
    ids.add(item.id);
    if (!Number.isSafeInteger(item.amountMinor) || item.amountMinor <= 0 || item.currency !== 'CNY') throw new Error('打赏金额须为人民币整数分');
    if (item.consent !== true && (item.name || item.message)) throw new Error('未获同意的记录必须匿名且不含留言');
    const allowed = new Set(['id', 'date', 'amountMinor', 'currency', 'name', 'message', 'consent']);
    if (Object.keys(item).some(key => !allowed.has(key))) throw new Error('打赏公示含非公开字段');
    if ((item.name && typeof item.name !== 'string') || (item.message && typeof item.message !== 'string')) throw new Error('打赏公示名称或留言格式无效');
  }
  if (!Number.isSafeInteger(tips.entries.reduce((sum, item) => sum + item.amountMinor, 0))) throw new Error('打赏金额汇总超出范围');
  return tips;
}

function supportPage() {
  return intro('A LITTLE ENCOURAGEMENT.', '给鲸鲸，<br>也给创造她的人，<br>一点鼓励。', '鲸鲸由我们三人共同开发和维护。如果她给你的日常带来了快乐，欢迎通过爱发电支持我们的创作。')
    + `<section class="support-panel"><div><span class="tag">团队创作打赏</span><h2>谢谢你，让创作继续。</h2><p>这份支持，是对团队投入时间、精力与创意的鼓励。量力而行，喜欢和使用鲸鲸，本身就已经是一份支持。</p><div class="inline-links">${link('https://afdian.com/a/Banan1ce', '通过爱发电支持团队', 'button')}<a class="text-link" href="./transparency/">查看打赏公示 <span aria-hidden="true">↗</span></a></div></div><div class="support-art" aria-hidden="true"><img src="../whale.svg" alt="" width="640" height="420"><span>A LITTLE SUPPORT.<br>A LONGER STORY.</span></div></section>`
    + `<section class="page-section prose"><p class="eyebrow">A FEW THINGS TO KNOW</p><h2>关于这份支持</h2><details open><summary>打赏会用于哪里？</summary><p>这是团队创作打赏，用于支持成员持续投入创作与维护，不是限定用途的项目经费，也不承诺全部用于服务器或其他指定支出。</p></details><details><summary>打赏会获得额外权益吗？</summary><p>本页的打赏不是软件购买、功能订单或专属技术支持承诺；不影响你正常下载和使用开源项目。具体爱发电方案如另有约定，请先阅读其页面说明。</p></details><details><summary>为什么官网没有支付表单？</summary><p>付款在爱发电完成，官网不接收支付信息，也不自动获取到账记录。支付、取消或退款问题请通过爱发电订单与团队沟通，具体以平台规则及适用要求为准。</p></details><details><summary>会公开我的信息吗？</summary><p>公示记录由团队核对后更新。只有取得同意后才公开昵称与留言；否则匿名展示。不公开真实支付账号、完整订单号或原始付款截图。</p></details></section><section class="page-section info-panel"><h2>不止一种支持方式。</h2><p>分享使用体验、反馈问题、参与测试、完善文档，或提交你自己的插件，也能让鲸鲸变得更好。</p><div class="inline-links">${link(`${APP}/issues`, '反馈问题')}${link(`${APP}/blob/main/CONTRIBUTING.md`, '参与贡献')}<a class="text-link" href="../plugins/">探索插件市场 ↗</a></div></section>`;
}

function tipsPage(tips) {
  const rows = [...tips.entries].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const years = [...new Set(rows.map(item => item.date.slice(0, 4)))];
  const months = Array.from({ length: 12 }, (_, i) => [String(i + 1).padStart(2, '0'), `${i + 1} 月`]);
  const total = rows.reduce((sum, item) => sum + item.amountMinor, 0);
  const money = value => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(value / 100);
  return '<a class="back-link" href="../">← 支持我们</a>'
    + intro('EVERY KINDNESS, REMEMBERED.', '打赏公示', '记录通过爱发电给予团队的创作支持。谢谢每一份鼓励。')
    + `<div class="stats-grid"><div><span>已公示金额</span><strong>${rows.length ? money(total) : '暂未公布'}</strong></div><div><span>已公示记录</span><strong>${rows.length ? `${rows.length} 笔` : '暂未公布'}</strong></div><div><span>最近更新</span><strong>${tips.updatedAt || '尚未公布'}</strong></div></div><p class="notice">公示仅包含已核对、已发布的记录，不代表爱发电实时余额或全部到账金额。金额按平台记录的打赏金额展示，未扣除平台手续费。这是团队创作打赏，不是限定用途的项目收支账本。</p>`
    + searchFilters('查找支持者', '公开昵称或留言', selectFilter('年份', 'year', years.map(year => [year, year])) + selectFilter('月份', 'month', months))
    + (rows.length ? `<p>当前筛选合计：<strong id="filtered-amount">${money(total)}</strong></p>` : '')
    + `<div class="table-scroll" role="region" aria-label="打赏记录表，可横向滚动" tabindex="0"><table class="tips-table"><caption>爱发电 · 团队创作打赏记录（人民币）</caption><thead><tr><th scope="col">日期</th><th scope="col">支持者</th><th scope="col" class="number-cell">打赏金额</th><th scope="col">留言</th></tr></thead><tbody>${rows.length ? rows.map(item => `<tr data-filter-item data-year="${item.date.slice(0, 4)}" data-month="${item.date.slice(5, 7)}" data-search="${e((item.name || '匿名支持者') + ' ' + (item.message || ''))}" data-amount="${item.amountMinor}"><td><time datetime="${item.date}">${item.date}</time></td><td>${e(item.name || '匿名支持者')}</td><td class="number-cell">${money(item.amountMinor)}</td><td>${e(item.message || '—')}</td></tr>`).join('') : '<tr><td colspan="4" class="empty-state">尚未公布打赏记录。团队核对并更新后，会在这里展示。</td></tr>'}</tbody></table></div><p id="filter-empty" class="empty-state" hidden>没有找到符合条件的打赏记录。</p><section class="page-section prose"><h2>公开、克制，也尊重隐私。</h2><p>昵称和留言仅在获得同意后公开，其余记录匿名展示。不会公开支付账号、完整订单号或未脱敏凭证。如需更正、匿名或移除留言，请通过爱发电联系团队。</p>${link('https://afdian.com/a/Banan1ce', '在爱发电联系团队')}</section>`;
}

function teamPage(team) {
  return intro('THE PEOPLE BEHIND THE WHALE.', '一起，让鲸鲸<br>慢慢长大。', '不同的分工，同一个心愿：让陪伴更自然，让使用更自在。')
    + `<section aria-labelledby="team-heading"><h2 class="section-title" id="team-heading">团队成员</h2>${teamCards(team, '../')}</section>`
    + `<section class="page-section" aria-labelledby="thanks-heading"><p class="eyebrow">WITH THANKS</p><h2 id="thanks-heading">致谢与贡献者</h2><div class="credits-grid">${team.contributors.map(member => `<article class="credit-card"><img class="person-avatar" src="../images/team/${e(member.login)}.png" alt="" width="64" height="64" loading="lazy"><h3>${e(member.login)}</h3><p>${e(member.contribution)}</p>${link(`https://github.com/${member.login}`, 'GitHub')}</article>`).join('')}<article class="credit-card"><h3>上善无形</h3><p>图标原创角色作者，本项目图标为二创作品。</p>${link(`${APP}/blob/main/docs/NOTICE.md`, '素材署名与使用说明')}</article><article class="credit-card"><h3>上游开源项目</h3><p>感谢 wechatauto-replica、wxauto 及项目使用的开源工具。</p>${link(`${APP}#acknowledgements`, '查看完整致谢')}</article></div><p class="thanks-line">${e(team.thanks)}</p></section>`;
}

function buildSite({ root = path.resolve(__dirname, '..'), output, data, tips: suppliedTips }) {
  const site = path.join(root, 'website');
  const target = path.resolve(output);
  if (target === root || target === site || root.startsWith(target + path.sep) || target.startsWith(site + path.sep)) throw new Error('官网输出目录不能覆盖源码');
  if (!isRelease(data.latest) || data.latest.prerelease || !Array.isArray(data.releases) || !Number.isFinite(Date.parse(data.fetchedAt))) throw new Error('官网发行数据无效');
  const tags = new Set();
  const releases = [data.latest, ...data.releases].filter(isRelease).filter(item => {
    releaseSlug(item.tag_name);
    if (tags.has(item.tag_name)) return false;
    tags.add(item.tag_name); return true;
  }).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  const plugins = validatePlugins(data.plugins, data.sourceCommit);
  const tips = validateTips(suppliedTips || JSON.parse(fs.readFileSync(path.join(site, 'content/tips.json'), 'utf8')));
  const team = JSON.parse(fs.readFileSync(path.join(site, 'content/team.json'), 'utf8'));
  let home = render(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), data.latest, releases, { localLinks: true });
  const fill = (name, content) => {
    const slot = new RegExp(`<!-- hub:${name} -->[\\s\\S]*?<!-- /hub:${name} -->`);
    if (!slot.test(home)) throw new Error(`官网模板缺少内容槽：${name}`);
    home = home.replace(slot, () => content);
  };
  fill('team', teamCards(team, './', true));
  fill('plugins', plugins.length ? pluginCards(plugins.slice(0, 3), './plugins/') : '<p>社区创作正在生长，欢迎提交你的插件。</p>');
  fill('thanks', `<p class="thanks-line wrap">${e(team.thanks)}</p>`);
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(site, target, { recursive: true });
  function write(route, title, description, content, current) {
    const folder = path.join(target, route);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.html'), layout(route, title, description, content, current));
  }
  fs.writeFileSync(path.join(target, 'index.html'), home);
  write('downloads/', '下载中心与历史版本', '鲸鲸 Windows 下载与完整发行历史，每个版本都有独立下载页。', downloads(releases, data.latest), 'downloads/');
  for (const item of releases) write(`downloads/${releaseSlug(item.tag_name)}/`, releaseTitle(item), '查看这个版本的更新说明与官方发行文件。', releasePage(item, data.latest), 'downloads/');
  write('plugins/', '插件市场', '浏览鲸鲸社区插件，了解来源、权限与兼容范围。', pluginsPage(plugins, data), 'plugins/');
  for (const item of plugins) write(`plugins/${item.Id}/`, item.Name, item.Description, pluginDetail(item, data), 'plugins/');
  write('support/', '支持团队创作', '通过爱发电支持鲸鲸团队的创作。', supportPage(), 'support/');
  write('support/transparency/', '打赏公示', '查看鲸鲸团队已核对发布的爱发电打赏记录。', tipsPage(tips), 'support/');
  write('team/', '团队成员与致谢', '认识鲸鲸背后的三位开发者与贡献者。', teamPage(team), 'team/');
  const routes = ['', 'downloads/', 'plugins/', 'support/', 'support/transparency/', 'team/', ...releases.map(item => `downloads/${releaseSlug(item.tag_name)}/`), ...plugins.map(item => `plugins/${item.Id}/`)];
  fs.writeFileSync(path.join(target, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map(route => `<url><loc>${e(ORIGIN + route)}</loc></url>`).join('')}</urlset>\n`);
  fs.writeFileSync(path.join(target, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}sitemap.xml\n`);
  return { releases: releases.length, plugins: plugins.length, pages: routes.length };
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('用法：node scripts/build-website.js <数据 JSON> <输出目录>');
  try { console.log(buildSite({ output, data: JSON.parse(fs.readFileSync(input, 'utf8')) })); }
  catch (error) { console.error(describeError(error)); process.exitCode = 1; }
}

module.exports = { buildSite, validateTips };
