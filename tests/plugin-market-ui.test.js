'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

test('插件入口固定在市场，设置卡片内管理统一协议插件与人设', () => {
  const main = read('launcher/MainWindow.xaml.cs');
  const page = read('launcher/Views/PluginMarketPage.xaml.cs');
  assert.match(main, /case "插件市场": return new PluginMarketPage/);
  assert.doesNotMatch(main, /RefreshPluginNav|StartsWith\("plugin:"/);
  assert.match(page, /Content = "设置"/);
  assert.match(page, /ShowMessageSettings\(info\)/);
  assert.match(page, /await ShowPersonaSettings\(info\)/);
  assert.match(page, /AppDialog\.Confirm\(Window\.GetWindow\(this\), "将这份人设应用到当前鲸鲸？"/);
  // 旧 Page 类型的工具运行页已经下线，新协议只在插件卡片设置里手动运行 tool.run@1。
  assert.doesNotMatch(page, /new PluginToolPage/);
});

test('市场右侧可打开随启动器打包的规范', () => {
  assert.match(read('launcher/Views/PluginMarketPage.xaml'), /Content="插件市场规范".*Click="OnRulesGuide"/);
  assert.match(read('launcher/WhaleLauncher.csproj'), /LogicalName="WhaleLauncher\.PluginRulesGuide\.md"/);
  const rules = read('docs/插件市场规范.md');
  assert.match(rules, /whale-plugin\/1/);
  assert.match(rules, /完整系统权限/);
});

test('本地安装提示来源和替换版本，启用须确认完整权限', () => {
  const market = read('launcher/Views/PluginMarketPage.xaml.cs');
  const persona = read('launcher/Views/PersonaPage.xaml.cs');
  assert.match(market, /AppFilePicker\.Open\([^)]*\)[\s\S]*InstallLocal\(file,[\s\S]*ConfirmLocalInstall\(info, current\)/);
  assert.match(market, /本地 ZIP 未经鲸鲸插件市场审核或签名/);
  assert.match(market, /将替换已安装/);
  assert.match(market, /作者已变化/);
  assert.match(market, /作者与已安装版本不一致，请先卸载旧版本再安装/);
  assert.match(market, /统一协议插件/);
  assert.match(market, /确认完整系统权限并启用/);
  assert.match(persona, /StartsWith\("market-", StringComparison\.Ordinal\)[\s\S]*AppDialog\.Confirm\([\s\S]*\) return;\s+var res/);
});

test('启用确认列出即将写入授权记录的聊天数据和付费宿主调用', () => {
  const page = read('launcher/Views/PluginMarketPage.xaml.cs');
  const market = read('launcher/PluginMarket.cs');
  // 页面接线用源码断言；C# 市场回归单独检查真实授权记录。
  assert.match(page, /AppDialog\.Confirm\([\s\S]*?\+ CapabilityDetails\(info\), "授权 4 级插件"/);
  assert.match(page, /AppDialog\.Confirm\([\s\S]*?\+ CapabilityDetails\(info\), "授权 3 级插件"/);
  assert.match(page, /"chat\.history"\s*=>\s*"[^"\r\n]*最近 12 条聊天记录/);
  assert.match(page, /"model\.prompt"\s*=>\s*"[^"\r\n]*本轮系统提示词/);
  assert.match(page, /"search\.query@1"\s*=>\s*"[^"\r\n]*费用/);
  assert.match(page, /"model\.complete@1"\s*=>\s*"[^"\r\n]*计费/);
  assert.match(page, /info\.DataAccess/);
  assert.match(market, /approvedDataAccess = package\.Info\.DataAccess/);
  assert.match(market, /approvedCalls = package\.Info\.Calls\.Where\(HostCallEnabled\)/);
});

test('市场签名暂时隐藏，验签代码、公钥和签名工具保留', () => {
  const market = read('launcher/PluginMarket.cs');
  const catalog = read('launcher/PluginCatalog.cs');
  const trust = read('launcher/PluginTrust.cs');
  const page = read('launcher/Views/PluginMarketPage.xaml.cs');
  assert.match(market, /MarketSignatureEnabled = false/);
  assert.match(catalog, /MarketSignatureEnabled/);
  assert.match(catalog, /url \+ "\.sig"/);
  assert.match(catalog, /Freeze|StopOnNotFound|DownloadMissingException/);
  assert.match(catalog, /ParseSignedCatalog/);
  assert.match(trust, /ECDsa/);
  assert.match(trust, /ImportSubjectPublicKeyInfo/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'plugin-market-sign.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', '插件市场签名.md')));
  assert.doesNotMatch(page, /来源：市场目录（已签名）|来源：未签名目录/);
});

test('市场目录下载与解析独立于本地安装生命周期，旧可执行目录不再分发', () => {
  const catalog = read('launcher/PluginCatalog.cs');
  const market = read('launcher/PluginMarket.cs');
  assert.match(catalog, /PersonaCatalogUrl/);
  assert.match(catalog, /index-personas\.json/);
  assert.match(catalog, /ParseSignedCatalog/);
  assert.match(catalog, /DownloadCandidates/);
  // 新协议还没有远端 index-v5；不读取旧 Api 1-4 可执行目录，避免误装旧插件。
  assert.doesNotMatch(catalog, /index-v4\.json/);
  assert.doesNotMatch(catalog, /index-v3\.json/);
  assert.match(market, /PluginCatalog\.DownloadAsync/);
  assert.doesNotMatch(market, /CatalogAsync|FeedbackAsync|DownloadCandidates|ParseSignedCatalog/);
});

test('开发者入口链接官方材料并提供只读 ZIP 校验', () => {
  const xaml = read('launcher/Views/PluginMarketPage.xaml');
  const page = read('launcher/Views/PluginMarketPage.xaml.cs');
  const links = read('launcher/PluginDeveloperLinks.cs');
  assert.match(xaml, /Content="开发者"/);
  assert.match(xaml, /校验本地 ZIP/);
  assert.match(xaml, /市场 README \/ 投稿说明/);
  assert.match(page, /PluginMarket\.ValidateLocal/);
  assert.match(page, /PluginDeveloperLinks\.Submit/);
  assert.match(page, /未安装、启用或写入插件数据/);
  assert.match(links, /https:\/\/github\.com\/Banan1cee\/whale-girl-plugins/);
  assert.match(links, /\/pulls/);
});
