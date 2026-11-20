'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

test('插件入口固定在市场，设置在卡片内打开工具或人设', () => {
  const main = read('launcher/MainWindow.xaml.cs');
  const page = read('launcher/Views/PluginMarketPage.xaml.cs');
  assert.match(main, /case "插件市场": return new PluginMarketPage/);
  assert.doesNotMatch(main, /RefreshPluginNav|StartsWith\("plugin:"/);
  assert.match(page, /Content = "设置"/);
  assert.match(page, /ShowDetail\(new PluginToolPage/);
  assert.match(page, /await ShowPersonaSettings\(info\)/);
  assert.match(page, /AppDialog\.Confirm\(Window\.GetWindow\(this\), "将这份人设应用到当前角色？"/);
});

test('市场文档从右上角展开，可打开随启动器打包的规范', () => {
  const xaml = read('launcher/Views/PluginMarketPage.xaml');
  assert.match(xaml, /x:Name="DocumentsToggle" DockPanel\.Dock="Right" Content="文档（必看）/);
  assert.match(xaml, /x:Name="DocumentsPanel"[^>]*Visibility="Collapsed"/);
  assert.match(xaml, /Content="插件市场规范".*Click="OnRulesGuide"/);
  assert.match(read('launcher/WhaleLauncher.csproj'), /LogicalName="WhaleLauncher\.PluginRulesGuide\.md"/);
  const rules = read('docs/插件市场规范.md');
  assert.match(rules, /权限确认.*插件卡片「设置」/);
  assert.match(rules, /相应操作入口按次确认/);
});

test('插件卡片每行三张，分类同时匹配当前列表和搜索词', () => {
  const xaml = read('launcher/Views/PluginMarketPage.xaml');
  const page = read('launcher/Views/PluginMarketPage.xaml.cs');
  const columns = xaml.match(/<Grid x:Name="Cards">\s*<Grid\.ColumnDefinitions>([\s\S]*?)<\/Grid\.ColumnDefinitions>/);
  assert.equal(columns?.[1].match(/<ColumnDefinition Width="\*"\s*\/>/g)?.length, 3);
  for (const kind of ['persona', 'message', 'tool']) {
    assert.match(xaml, new RegExp(`Tag="${kind}"[^>]*Click="OnCategory"`));
  }
  assert.match(page, /_showInstalled \? local\.Values\.AsEnumerable\(\) : _catalog\.AsEnumerable\(\)/);
  assert.match(page, /p\.Kind == _category\)\s*&&[^\n]*\.Contains\(query,/);
  assert.match(page, /Grid\.SetRow\(card, index \/ columns\)/);
  assert.match(page, /Grid\.SetColumn\(card, column\)/);
});

test('本地安装提示来源和替换版本，人设页应用市场预设须确认', () => {
  const market = read('launcher/Views/PluginMarketPage.xaml.cs');
  const persona = read('launcher/Views/PersonaPage.xaml.cs');
  // 文件选择已收进主窗口弹层（AppFilePicker），安装入口仍要保持确认回调。
  assert.match(market, /AppFilePicker\.Open\([^)]*\)[\s\S]*InstallLocal\(file,[\s\S]*ConfirmLocalInstall\(info, current\)/);
  assert.match(market, /本地 ZIP 未经插件市场审核或签名/);
  assert.match(market, /将替换已安装/);
  assert.match(market, /作者已变化/);
  assert.match(market, /作者与已安装版本不一致，请先卸载旧版本再安装/);
  assert.match(market, /消息插件（启用后自动参与聊天）/);
  assert.match(market, /ShowMessageSettings\(info\)/);
  assert.match(persona, /StartsWith\("market-", StringComparison\.Ordinal\)[\s\S]*AppDialog\.Confirm\([\s\S]*\) return;\s+var res/);
});

test('市场签名暂时隐藏，验签代码、公钥和签名工具保留', () => {
  const market = read('launcher/PluginMarket.cs');
  const trust = read('launcher/PluginTrust.cs');
  const page = read('launcher/Views/PluginMarketPage.xaml.cs');
  // 隐藏开关是唯一入口：恢复时改 true 并重发 EXE，不需要重新接入。
  assert.match(market, /MarketSignatureEnabled = false/);
  // 隐藏期间目录不拉 .sig、插件包不验 Signature，两处都必须先看开关，避免偷偷恢复验签。
  assert.match(market, /if \(!MarketSignatureEnabled\) return ParseCatalog\(bytes, expectedApi, expectedKind\)/);
  assert.match(market,
    /MarketSignatureEnabled && !string\.IsNullOrWhiteSpace\(listing\.Signature\)[\s\S]*?PluginTrust\.Verify\(bytes, listing\.Signature\)/);
  assert.match(market, /url \+ "\.sig"/);
  // 回归：目录没有 .sig 时整份拒绝的话，未签名市场永远打不开。
  assert.match(market, /DownloadMissingException/);
  assert.doesNotMatch(market, /目录缺少 \.sig 签名，已拒绝加载/);
  assert.doesNotMatch(market, /!string\.IsNullOrWhiteSpace\(i\.Signature\)/);
  // 验签能力本身不能删：目录验签、内置公钥和签名工具都要留着。
  assert.match(market, /ParseSignedCatalog/);
  assert.match(trust, /ECDsa/);
  assert.match(trust, /ImportSubjectPublicKeyInfo/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'plugin-market-sign.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', '插件市场签名.md')));
  // 隐藏后卡片不再展示已签名 / 未签名状态。
  assert.doesNotMatch(page, /来源：市场目录（已签名）|来源：未签名目录/);
});

test('插件市场下载带 GitHub 直连 / jsDelivr / 反代回退', () => {
  const market = read('launcher/PluginMarket.cs');
  assert.match(market, /DownloadCandidates/);
  assert.match(market, /cdn\.jsdelivr\.net/);
  assert.match(market, /gh-proxy\.com/);
  assert.match(market, /ghfast\.top/);
  assert.match(market, /DownloadOnce/);
});
