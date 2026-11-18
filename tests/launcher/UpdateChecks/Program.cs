using System;
using System.Reflection;
using System.IO;
using WhaleLauncher;

void Check(bool ok, string message) { if (!ok) throw new Exception(message); Console.WriteLine("PASS: " + message); }
var parse = typeof(UpdateManifestService).GetMethod("Parse", BindingFlags.Static | BindingFlags.NonPublic);
var manifest = (UpdateManifest)parse.Invoke(null, new object[] { "{\"latest\":\"4.0.6\",\"message\":\"新版发布\",\"release_notes\":\"### 修复\\n- 修复编码切换。\\n  - 内部实现细节\\n- 支持私聊记忆清理。\"}" });
var summary = UpdateManifestService.ReleaseSummary(manifest);
Check(summary.Contains("修复编码切换") && summary.Contains("私聊记忆清理"), "新版摘要直接包含更新与修复内容");
Check(!summary.Contains("内部实现细节") && !summary.Contains("###"), "摘要省略展开细节和 Markdown 标记");
Check(UpdateManifestService.ReleaseSummary(new UpdateManifest { Message = "旧清单说明" }) == "旧清单说明", "旧清单没有 release_notes 时兼容 message");
Check(UpdateManifestService.ReleaseSummary(null).Contains("暂未提供"), "缺少说明时明确提示，不能编造修复内容");
Check(UpdateManifestService.ReleaseSummary(new UpdateManifest { ReleaseNotes = new string('测', 3000) }).Length <= 62, "旧清单的长说明默认简短显示");
Check(UpdateManifestService.ReleaseDetails(manifest).Contains("内部实现细节"), "旧清单仍可展开原来的完整说明");
Check(UpdateManifestService.ReleaseDetails(new UpdateManifest { Message = "旧清单说明" }) == "", "只有提示语时没有详情可展开");
var current = (UpdateManifest)parse.Invoke(null, new object[] { "{\"latest\":\"4.0.8\",\"release_notes\":\"- 新增自带表情包。\\n- 微信回复更稳定。\",\"release_details\":\"### 详细说明\\n- 按账号数据库归属绑定窗口。\"}" });
Check(UpdateManifestService.ReleaseSummary(current) == "• 新增自带表情包。\n• 微信回复更稳定。", "新清单直接使用白话摘要");
Check(UpdateManifestService.ReleaseDetails(current) == "详细说明\n• 按账号数据库归属绑定窗口。", "新清单独立读取完整详细说明");
var longNotes = new UpdateManifest { ReleaseNotes = "- 一\n- 二\n- 三\n- 四\n- 五\n- 六", ReleaseDetails = new string('详', 3000) };
Check(!UpdateManifestService.ReleaseSummary(longNotes).Contains("六"), "摘要最多显示五条");
Check(UpdateManifestService.ReleaseSummary(longNotes).Contains("五"), "第五行保留");
Check(UpdateManifestService.ReleaseDetails(longNotes).Length == 3000, "展开后保留完整详情");
var hotfix = (UpdateManifest)parse.Invoke(null, new object[] { "{\"latest\":\"4.0.8.1\",\"force\":true,\"force_from\":\"4.0.8\"}" });
var now = DateTimeOffset.UtcNow;
var optionalBridge = (UpdateManifest)parse.Invoke(null, new object[] { "{\"latest\":\"4.1.1\",\"force\":false,\"update_warning_version\":\"4.1.1\",\"update_warning\":\"微信桥接正常的用户不要更新，仅建议微信桥接有问题的用户更新。\"}" });
Check(UpdateManifestService.ReleaseWarning(optionalBridge).Contains("正常的用户不要更新"), "桥接专用版本显示明确更新范围");
Check(UpdateManifestService.Decide("4.1.0", optionalBridge, now.AddDays(365)) == UpdatePolicy.Warn, "可选桥接补丁长期不变成强制更新");
optionalBridge.Latest = "4.1.2";
Check(UpdateManifestService.ReleaseWarning(optionalBridge) == "", "下一版不继承上一版专用警告");
Check(UpdateManifestService.ReleaseWarning(new UpdateManifest { Latest = "4.1.1", UpdateWarning = "旧警告" }) == "", "未绑定版本的警告不显示");
Check(UpdateManifestService.ReleaseWarning(null) == "", "无清单时没有警告");
Check(UpdateManifestService.Decide("4.0.8", hotfix, now) == UpdatePolicy.Force, "旧协议下界内的落后版本要求更新");
Check(UpdateManifestService.Decide("4.0.7", hotfix, now) == UpdatePolicy.Warn, "更老版本不被热修强制");
Check(UpdateManifestService.Decide("4.0.8.1", hotfix, now) == UpdatePolicy.Ok, "已是最新版本不再强制");
var dual = (UpdateManifest)parse.Invoke(null, new object[] { "{\"latest\":\"4.1.6.1\",\"epoch\":2,\"brand_latest\":\"1.0.0\",\"target\":\"1.0.0\",\"force\":false}" });
Check(UpdateManifestService.HasUpdate("4.1.6", 0, dual), "旧轨道继续使用 latest");
Check(UpdateManifestService.Resolve("4.1.6", 0, dual).Latest == "4.1.6.1", "旧客户端忽略新字段");
Check(UpdateManifestService.HasUpdate("4.1.6.1", 1, dual), "跨代允许数字版本降低");
Check(UpdateManifestService.Resolve("4.1.6.1", 1, dual).Latest == "1.0.0", "跨代展示与下载选择正式版");
Check(!UpdateManifestService.HasUpdate("1.0.0", 2, dual), "同代正式版不被旧 latest 拉回");
Check(UpdateManifestService.HasUpdate("0.9.0", 2, dual), "同代比较正式版本");
Check(!UpdateManifestService.HasUpdate("1.0.1", 2, dual), "同代不降级");
Check(!UpdateManifestService.HasUpdate("1.0.0", 3, dual), "拒绝旧代清单");
Check(dual.Latest == "4.1.6.1", "选择轨道不污染原始缓存");
Check(!UpdateManifestService.HasUpdate("1.0.0", 2, hotfix), "正式版拒绝不带代次的旧缓存");
dual.Target = "1.0.1";
Check(!UpdateManifestService.HasUpdate("4.1.6.1", 1, dual), "目标与展示版本冲突时不安装");

UpdateManifest ReadManifest(string json) => (UpdateManifest)parse.Invoke(null, new object[] { json });
var exact = ReadManifest("{\"latest\":\"4.1.8\",\"force\":true,\"force_from\":\"4.1.6\",\"force_versions\":[\"4.1.6\"]}");
Check(UpdateManifestService.Decide("4.1.7", exact, now) == UpdatePolicy.Warn, "4.1.8 继承旧 force 时，不会再次强制已修复的 4.1.7");
Check(UpdateManifestService.Decide("4.1.6", exact, now) == UpdatePolicy.Force, "精确名单仍要求问题版本更新");
Check(UpdateManifestService.Decide("4.1.6.1", exact, now) == UpdatePolicy.Warn, "预留迁移版本不被三段版本名单误伤");
Check(UpdateManifestService.Decide("4.1.5", exact, now) == UpdatePolicy.Warn, "未列入名单的更早版本只提示");
Check(UpdateManifestService.Decide("4.1.8", exact, now) == UpdatePolicy.Ok, "已是最新版本正常运行");
Check(UpdateManifestService.Decide("4.1.6.0", exact, now) == UpdatePolicy.Force, "三段版本与补零后的四段版本相同");
exact.Force = false;
Check(UpdateManifestService.Decide("4.1.6", exact, now) == UpdatePolicy.Force, "新名单不依赖旧 force=true");
exact.ForceFrom = "4.1.7";
Check(UpdateManifestService.Decide("4.1.6", exact, now) == UpdatePolicy.Force, "新名单不受旧 force_from 过滤");

foreach (var value in new[] { "[]", "null", "true", "\"4.1.6\"", "[\"bad\"]", "[\"4.1.6\",null]", "[\"4.1.6\",\"4.1\"]", "[\"4.1.6\",\"4.2147483648.0\"]" })
{
    var safe = ReadManifest("{\"latest\":\"4.1.8\",\"force\":true,\"force_from\":\"4.1.6\",\"force_versions\":" + value + "}");
    Check(UpdateManifestService.Decide("4.1.6", safe, now) == UpdatePolicy.Warn, "空名单或非法新规则不回落旧强制：" + value);
}
var noTimer = ReadManifest("{\"latest\":\"4.1.8\",\"released_at\":\"2020-01-01T00:00:00Z\",\"force_after_hours\":0,\"force_versions\":[]}");
Check(UpdateManifestService.Decide("4.1.7", noTimer, now) == UpdatePolicy.Warn, "空名单不回落旧时间闸");
var legacy = ReadManifest("{\"latest\":\"4.1.8\",\"force\":true,\"force_from\":\"4.1.6\"}");
Check(UpdateManifestService.Decide("4.1.7", legacy, now) == UpdatePolicy.Force, "字段缺失时兼容旧协议");
var discrete = ReadManifest("{\"latest\":\"4.1.8\",\"force_versions\":[\"v4.1.2\",\"4.1.6\"]}");
Check(UpdateManifestService.Decide("4.1.2", discrete, now) == UpdatePolicy.Force, "支持多个离散版本及 v 前缀");
Check(UpdateManifestService.Decide("4.1.5", discrete, now) == UpdatePolicy.Warn, "离散名单中间的版本不强制");
var safetyFloor = ReadManifest("{\"latest\":\"4.1.8\",\"kill_below\":\"4.1.7\",\"force_versions\":[]}");
Check(UpdateManifestService.Decide("4.1.6", safetyFloor, now) == UpdatePolicy.Kill, "明确的熔断线仍独立于精确更新名单");

var serialize = typeof(UpdateManifestService).GetMethod("SerializeCache", BindingFlags.Static | BindingFlags.NonPublic);
UpdateManifest Cached(UpdateManifest value) => ReadManifest((string)serialize.Invoke(null, new object[] { value }));
Check(UpdateManifestService.Decide("4.1.7", Cached(exact), now) == UpdatePolicy.Warn, "缓存保留精确规则，未命中不回落旧强制");
Check(UpdateManifestService.Decide("4.1.6", Cached(exact), now) == UpdatePolicy.Force, "离线缓存保留命中规则");
Check(UpdateManifestService.Decide("4.1.7", Cached(legacy), now) == UpdatePolicy.Force, "缓存保留字段缺失，不擅自改成空名单");
Check(UpdateManifestService.Decide("4.1.7", Cached(noTimer), now) == UpdatePolicy.Warn, "缓存保留显式空名单");
var newGeneration = ReadManifest("{\"latest\":\"4.1.7\",\"epoch\":2,\"brand_latest\":\"1.0.0\",\"target\":\"1.0.0\",\"force\":true,\"force_versions\":[\"0.0.0\",\"4.1.7\"]}");
Check(UpdateManifestService.Decide("0.0.0", UpdateManifestService.Resolve("4.1.7", 1, newGeneration), now) == UpdatePolicy.Warn, "同代名单不跨代套用，也不恢复旧布尔强制");
Check(newGeneration.ForceVersions.Length == 2 && newGeneration.Latest == "4.1.7", "轨道解析不污染原始清单或名单");
var choose = typeof(UpdateManifestService).GetMethod("SelectNewest", BindingFlags.Static | BindingFlags.NonPublic);
var cachedPolicy = ReadManifest("{\"latest\":\"4.1.8\",\"manifest_version\":20,\"force_versions\":[]}");
var stalePolicy = ReadManifest("{\"latest\":\"4.1.8\",\"manifest_version\":19,\"force\":true}");
Check(ReferenceEquals(choose.Invoke(null, new object[] { new[] { stalePolicy }, cachedPolicy }), cachedPolicy), "旧在线清单不能覆盖新名单缓存而重新强制正常版本");
stalePolicy.ManifestVersion = 21;
Check(ReferenceEquals(choose.Invoke(null, new object[] { new[] { stalePolicy }, cachedPolicy }), stalePolicy), "更高序号在线策略仍可更新缓存");
var versionDir = Path.Combine(Path.GetTempPath(), "whale-t22-version-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(versionDir);
try
{
    var versionFile = Path.Combine(versionDir, "package.json");
    File.WriteAllText(versionFile, "{\"version\":\"4.1.6.1\"}");
    Check(UpdateManifestService.LocalVersion(versionDir) == "4.1.6.1", "T22 LocalVersion release");
    File.WriteAllText(versionFile, "{\"version\":\"4.2.0-alpha\"}");
    Check(UpdateManifestService.LocalVersion(versionDir) == "4.2.0-alpha", "T22 LocalVersion development");
    var assembly = typeof(UpdateManifestService).Assembly.GetName().Version;
    var fallback = assembly.Major + "." + assembly.Minor + "." + assembly.Build;
    File.WriteAllText(versionFile, "{broken");
    Check(UpdateManifestService.LocalVersion(versionDir) == fallback, "T22 LocalVersion corrupt fallback");
    File.Delete(versionFile);
    Check(UpdateManifestService.LocalVersion(versionDir) == fallback, "T22 LocalVersion missing fallback");
}
finally { Directory.Delete(versionDir, true); }
