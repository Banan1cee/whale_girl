'use strict';

/**
 * v5 目录解析 / 展示元数据回归。
 * 1) 静态守卫：唯一裸 raw 根前缀、V5 常量、display 清洗与安装比较忽略 Display；
 * 2) 真行为：生成临时 C# 工程，直接引用 launcher 源码跑 ParseV5 / Afdian / ValidCatalog /
 *    SameListing / Fetch 错误结构。沙箱禁止子进程时跳过（CI 会真跑）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const catalogSource = fs.readFileSync(path.join(root, 'launcher', 'PluginCatalog.cs'), 'utf8');
const marketSource = fs.readFileSync(path.join(root, 'launcher', 'PluginMarket.cs'), 'utf8');

test('Catalog：V5 常量、根前缀推导、唯一裸 raw 链接与失败回退', () => {
  assert.match(catalogSource, /V5CatalogUrl = "https:\/\/raw\.githubusercontent\.com\/Banan1cee\/whale-girl-plugins\/main\/index-v5\.json"/);
  assert.match(catalogSource, /MarketRoot = V5CatalogUrl\[\.\.\(V5CatalogUrl\.LastIndexOf\('\/'\) \+ 1\)\]/);
  assert.match(catalogSource, /PersonaCatalogUrl = MarketRoot \+ "index-personas\.json"/);
  const rawLinks = catalogSource.match(/raw\.githubusercontent\.com\/Banan1cee\/whale-girl-plugins/g) || [];
  assert.equal(rawLinks.length, 1, '只允许 V5CatalogUrl 这一条裸 raw 链接');
  assert.match(catalogSource, /try\s*\{[\s\S]*?LoadV5Async\(\)[\s\S]*?catch \(Exception ex\) when \(ex is HttpRequestException or InvalidDataException[\s\S]*?return personas;/);
});

test('Catalog：ParseV5 映射与 display/包定位清洗', () => {
  assert.match(catalogSource, /internal static PluginInfo\[\] ParseV5\(byte\[\] bytes\)/);
  assert.match(catalogSource, /path != \$"packages\/\{info\.Id\}-\{info\.Version\}\.zip"/);
  assert.match(catalogSource, /download != MarketRoot \+ path/);
  assert.match(catalogSource, /PluginMarket\.ParseUnified\(manifest\)/);
  assert.match(catalogSource, /info with \{ Download = download, Sha256 = sha, Display = ParseDisplay\(item\) \}/);
  assert.match(catalogSource, /ParseDisplay\(JsonElement entry\)/);
  assert.match(catalogSource, /ValidDisplayAsset|ValidDisplayImage|AfdianPersonalPage/);
  assert.match(catalogSource, /FetchReadmeAsync\(PluginInfo info\)/);
  assert.match(catalogSource, /FetchImageAsync\(PluginInfo info, string source\)/);
  assert.match(catalogSource, /未在展示元数据中声明/);
  assert.match(catalogSource, /SHA256\.HashData\(raw\)/);
});

test('Market：Display 记录、Afdian 严格校验、ValidCatalog 与安装比较', () => {
  assert.match(marketSource, /record PluginDisplayInfo\(/);
  assert.match(marketSource, /record PluginDisplayAsset\(/);
  assert.match(marketSource, /record PluginDisplayImage\(/);
  assert.match(marketSource, /record PluginDisplayDonation\(/);
  assert.match(marketSource, /PluginDisplayInfo Display = null/);
  assert.match(marketSource, /internal static string AfdianPersonalPage\(string value\)/);
  assert.match(marketSource, /uri\.Host != "afdian\.com"/);
  assert.match(marketSource, /\\A\/a\/\[A-Za-z0-9_-\]\{1,64\}\/\?\\z/);
  assert.match(marketSource, /internal static bool ValidCatalog\(PluginInfo info\)/);
  assert.match(marketSource, /internal static bool SameListing\(PluginInfo listing, PluginInfo info\)/);
  assert.match(marketSource, /Display = null/);
});

/* ------------------------------------------------------------------ */
/* 真行为：临时 C# 工程。                                               */
/* ------------------------------------------------------------------ */

const program = String.raw`
using System;
using System.Text;
using WhaleLauncher;

void Check(bool ok, string name) { if (!ok) throw new Exception(name); }

const string Root = "https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/";
string Sha = new string('a', 64);

string ValidV5(string level4Manifest, string entryExtra) => """
[
  {
    "manifest": __MANIFEST__,
    "manifestSha256": "__SHA__",
    "package": {"path": "packages/demo-1.0.0.zip", "download": "__ROOT__packages/demo-1.0.0.zip", "sha256": "__SHA__", "bytes": 123},
    "display": {"readme": {"path": "plugins/demo/README.md", "sha256": "__SHA__", "bytes": 100},
      "images": [{"path": "plugins/demo/a.png", "sha256": "__SHA__", "bytes": 200, "media": "image/png"}],
      "donation": {"afdian": "https://afdian.com/a/Test"},
      "updatedAt": "2026-11-25T01:00:00+08:00"}
  }
]
""".Replace("__MANIFEST__", level4Manifest).Replace("__SHA__", Sha).Replace("__ROOT__", Root);

const string pluginManifest = """
{"format":"whale-plugin/1","level":4,"id":"demo","name":"演示","author":"测试","version":"1.0.0",
 "minAppVersion":"4.3.0","description":"d","entry":"plugin.js","runtime":"node-full",
 "provides":{"tool.run@1":{"mode":"tool","scope":"manual"}},"calls":[]}
""";
var infos = PluginCatalog.ParseV5(Encoding.UTF8.GetBytes(ValidV5(pluginManifest, "")));
Check(infos.Length == 1, "v5 条目应解析出一条");
var info = infos[0];
Check(info.Api == 5 && info.Kind == "plugin" && info.Level == 4, "v5 映射 Api/Kind/Level");
Check(info.Download == Root + "packages/demo-1.0.0.zip" && info.Sha256 == Sha, "包定位映射");
Check(info.Display != null && info.Display.Readme?.Path == "plugins/demo/README.md", "readme 映射");
Check(info.Display.Images?.Length == 1 && info.Display.Images[0].Media == "image/png", "图片映射");
Check(info.Display.Donation?.Afdian == "https://afdian.com/a/Test", "爱发电映射");
Check(info.Display.UpdatedAt == "2026-11-25", "updatedAt 归一化");
Check(PluginMarket.ValidCatalog(info), "合法 v5 条目应通过 ValidCatalog");

var badDisplay = Encoding.UTF8.GetString(Encoding.UTF8.GetBytes(ValidV5(pluginManifest, "")))
    .Replace("plugins/demo/README.md", "plugins/../evil.md")
    .Replace("plugins/demo/a.png", "plugins/demo/a.txt")
    .Replace("https://afdian.com/a/Test", "http://afdian.com/a/Test")
    .Replace("2026-11-25T01:00:00+08:00", "not-a-date");
var badInfos = PluginCatalog.ParseV5(Encoding.UTF8.GetBytes(badDisplay));
Check(badInfos.Length == 1 && badInfos[0].Display == null, "全非法 display 应丢弃但不丢条目");

var themeManifest = """
{"format":"whale-plugin/1","level":0,"id":"demo","name":"主题","author":"测试","version":"1.0.0",
 "minAppVersion":"4.3.0","description":"d","entry":"theme.json","runtime":"theme-data","provides":{},"calls":[]}
""";
var themeJson = ValidV5(themeManifest, "").Replace("packages/demo-1.0.0.zip", "packages/demo-1.0.0.zip");
var themes = PluginCatalog.ParseV5(Encoding.UTF8.GetBytes(themeJson));
Check(themes.Length == 1 && themes[0].Kind == "theme" && themes[0].IsTheme, "0 级主题 Kind");
Check(PluginMarket.ValidCatalog(themes[0]), "主题 ValidCatalog");

Check(!PluginMarket.ValidCatalog(info with { Sha256 = "xyz" }), "非法 SHA 拒绝");
Check(!PluginMarket.ValidCatalog(info with { Download = "" }), "空下载地址拒绝");
Check(!PluginMarket.ValidCatalog(themes[0] with { Provides = info.Provides }), "主题带 provides 拒绝");

Check(PluginMarket.AfdianPersonalPage("https://afdian.com/a/Banan1cee") == "https://afdian.com/a/Banan1cee", "爱发电裸域");
Check(PluginMarket.AfdianPersonalPage("https://afdian.com/a/Banan1cee/") == "https://afdian.com/a/Banan1cee", "尾斜杠规范化");
foreach (var rejected in new[] {
    "http://afdian.com/a/Banan1cee", "https://afdian.com.evil/a/Banan1cee",
    "https://user" + "@" + "afdian.com/a/Banan1cee", "https://afdian.com:8443/a/Banan1cee",
    "https://afdian.com/a/Banan1cee?x=1", "https://afdian.com/a/Banan1cee#x",
    "https://afdian.com/a/x/y", "", "https://afdian.com/a/", "https://afdian.com/"
})
    Check(PluginMarket.AfdianPersonalPage(rejected) == null, "应拒绝：" + rejected);

Check(PluginMarket.SameListing(info, info with { Display = null }), "安装比较忽略 Display");
Check(!PluginMarket.SameListing(info with { Version = "1.0.1" }, info with { Display = null }), "版本不一致仍拒绝");

var bare = info with { Display = null };
var readmeResult = await PluginCatalog.FetchReadmeAsync(bare);
Check(readmeResult.Bytes == null && readmeResult.Error != null, "无 README 返回结构化错误");
var imageResult = await PluginCatalog.FetchImageAsync(info, "https://evil.example/a.png");
Check(imageResult.Bytes == null && imageResult.Error != null, "未声明图片拒绝");

Console.WriteLine("ALL OK");
`;

function csproj() {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>
  <ItemGroup>
    <Compile Include="${path.join(root, 'launcher', 'PluginMarket.cs')}" Link="PluginMarket.cs" />
    <Compile Include="${path.join(root, 'launcher', 'PluginCatalog.cs')}" Link="PluginCatalog.cs" />
    <Compile Include="${path.join(root, 'launcher', 'PluginTrust.cs')}" Link="PluginTrust.cs" />
    <Compile Include="${path.join(root, 'launcher', 'PersonaPackage.cs')}" Link="PersonaPackage.cs" />
    <EmbeddedResource Include="${path.join(root, 'src', 'services', 'pluginProtocolRegistry.json')}" LogicalName="WhaleLauncher.PluginProtocolRegistry.json" />
  </ItemGroup>
</Project>`;
}

test('C# 行为：ParseV5 / 非法 display / 爱发电矩阵 / ValidCatalog / SameListing', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-catalog-v5-'));
  fs.writeFileSync(path.join(dir, 'Checks.csproj'), csproj());
  fs.writeFileSync(path.join(dir, 'Program.cs'), `${program}
namespace WhaleLauncher {
  internal static class UpdateManifestService {
    internal static string LocalVersion(string _) => "4.3.0";
    internal static int LocalEpoch(string _) => 1;
  }
}
`);
  const result = spawnSync('dotnet', ['run', '--project', path.join(dir, 'Checks.csproj'), '-c', 'Debug', '--nologo'],
    { encoding: 'utf8', timeout: 240000 });
  if (result.error && (result.error.code === 'EPERM' || result.error.code === 'ENOENT')) {
    t.skip('沙箱禁止子进程或缺少 dotnet；CI 会真跑');
    return;
  }
  assert.equal(result.status, 0, `${result.stdout || ''}\n${result.stderr || ''}`);
  assert.match(result.stdout || '', /ALL OK/);
});
