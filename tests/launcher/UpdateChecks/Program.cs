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
var longNotes = new UpdateManifest { ReleaseNotes = "- 一\n- 二\n- 三\n- 四", ReleaseDetails = new string('详', 3000) };
Check(!UpdateManifestService.ReleaseSummary(longNotes).Contains("四"), "摘要最多显示三条");
Check(UpdateManifestService.ReleaseDetails(longNotes).Length == 3000, "展开后保留完整详情");
