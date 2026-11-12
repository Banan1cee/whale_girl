using System;
using System.Reflection;
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
Check(UpdateManifestService.Decide("4.0.8", hotfix, now) == UpdatePolicy.Force, "紧急热修只强制上一个发布版本");
Check(UpdateManifestService.Decide("4.0.7", hotfix, now) == UpdatePolicy.Warn, "更老版本不被热修强制");
Check(UpdateManifestService.Decide("4.0.8.1", hotfix, now) == UpdatePolicy.Ok, "已是最新版本不再强制");

// 下架名单：唯一能让「已经是最新版」的用户也停下来的分支。
var pulled = (UpdateManifest)parse.Invoke(null, new object[] { "{\"latest\":\"4.0.8.2\",\"withdrawn\":[\"4.1.0\"]}" });
Check(UpdateManifestService.Decide("4.1.0", pulled, now) == UpdatePolicy.Withdrawn, "下架版本且没有更高版本时停下，引导去下载页");
Check(UpdateManifestService.Decide("4.0.8.2", pulled, now) == UpdatePolicy.Ok, "下架不影响名单外的版本");
Check(UpdateManifestService.Decide("4.0.8", pulled, now) == UpdatePolicy.Warn, "更老的版本仍然只提示");
Check(UpdateManifestService.Decide("4.1.0.1", pulled, now) == UpdatePolicy.Ok, "比下架版本更新的版本不会被误伤");
Check(pulled.Withdrawn.Count == 1 && pulled.Withdrawn[0] == "4.1.0", "下架名单解析正确");

var pulledWithFix = (UpdateManifest)parse.Invoke(null, new object[] { "{\"latest\":\"4.1.0.1\",\"withdrawn\":[\"4.1.0\"]}" });
Check(UpdateManifestService.Decide("4.1.0", pulledWithFix, now) == UpdatePolicy.Force, "下架且已有修复版时直接推去升级");
Check(UpdateManifestService.Decide("4.1.0.1", pulledWithFix, now) == UpdatePolicy.Ok, "装上修复版后不再被拦");

var withdrawnAsString = (UpdateManifest)parse.Invoke(null, new object[] { "{\"latest\":\"4.0.8.2\",\"withdrawn\":\"4.1.0\"}" });
Check(UpdateManifestService.Decide("4.1.0", withdrawnAsString, now) == UpdatePolicy.Withdrawn, "下架名单写成字符串也认");
var badWithdrawn = (UpdateManifest)parse.Invoke(null, new object[] { "{\"latest\":\"4.0.8.2\",\"withdrawn\":[123,null]}" });
Check(UpdateManifestService.Decide("4.1.0", badWithdrawn, now) == UpdatePolicy.Ok, "名单写坏时按放行处理，不能锁死用户");
Check(UpdateManifestService.IsWithdrawn("v4.1.0", new[] { "4.1.0" }), "下架匹配忽略开头的 v");
Check(UpdateManifestService.IsWithdrawn("4.1", new[] { "4.1.0" }), "补零写法（4.1 / 4.1.0）视为同一版本");
Check(!UpdateManifestService.IsWithdrawn("4.10.0", new[] { "4.1.0" }), "按数值逐段比较，4.10.0 不等于 4.1.0");
