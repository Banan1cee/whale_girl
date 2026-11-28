using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using WhaleLauncher;

namespace WhaleLauncher.Checks;

internal static class AgentDiagnosticChecks
{
    public static void Run(string root, Action<bool, string> check)
    {
        var folder = Path.Combine(root, "diagnostic-fixture");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "voice-send.json");
        check(AgentDiagnosticReport.ReadVoice(folder, _ => null, _ => null).ReadStatus == "missing",
            "诊断区分语音配置文件缺失");
        File.WriteAllText(path, "{");
        check(AgentDiagnosticReport.ReadVoice(folder, _ => null, _ => null).ReadStatus == "invalid",
            "诊断区分语音配置损坏");
        File.WriteAllText(path, """{"Enabled":false,"Provider":"minimax","Device":"private-device","apiKey":"private-secret"}""");
        var snapshot = AgentDiagnosticReport.ReadVoice(folder, _ => true, _ => false);
        check(snapshot.Enabled == false && snapshot.ReadStatus == "loaded" && snapshot.PlaybackDeviceReady == false,
            "语音开关事实与声卡状态独立");

        var now = DateTimeOffset.UtcNow;
        var flow = new string('c', 32);
        var faultId = new string('a', 32);
        var cancelledId = new string('b', 32);
        string Record(string id, string component, string subject, string state, string code, string cause = null) =>
            "[agent_diag] " + JsonSerializer.Serialize(new
            {
                at = now, eventId = id, flowId = flow, component, subject, stage = "dispatch", status = state, code,
                causedBy = cause, extra = "private-secret",
            });
        var failed = Record(faultId, "bridge", "text", "failed", "TEXT_SEND_FAILED");
        var cancelled = Record(cancelledId, "bridge", "sticker", "cancelled", "STICKER_STOPPED_AFTER_TEXT_FAILURE", faultId);
        var pack = AgentDiagnosticReport.Build(now, new { bridgeOnline = false, voiceSend = snapshot }, new[]
        {
            ("logs/current/bridge.log", "首行\n" + failed + "\n" + cancelled),
            ("logs/current/wechat-bridge-4x.log", failed + "\n" + cancelled),
            ("logs/current/kernel.log", "12:34:56 [sticker] stage=cancel result=cancelled reason=reply_delivery_stopped"),
            ("trace/raw/private.json", Record(new string('d', 32), "bridge", "text", "failed", "TEXT_SEND_FAILED")),
        });
        using var json = JsonDocument.Parse(pack.Report);
        var findings = json.RootElement.GetProperty("findings").EnumerateArray().ToArray();
        check(findings.Length == 3, "归档可离线分析、去重并排除原文目录");
        var item = findings.Single(x => x.TryGetProperty("causedBy", out _));
        check(item.GetProperty("causedBy").GetString() == faultId && item.GetProperty("flowId").GetString() == flow &&
              item.GetProperty("evidence").GetProperty("line").GetInt32() == 3, "取消准确引用同轮前置失败和导出行号");
        check(!pack.Report.Contains("private-secret") && !pack.Report.Contains("private-device") &&
              !pack.Events.Contains("private-secret"), "诊断不带配置和事件中的任意字符串");

        var missingCause = AgentDiagnosticReport.Build(now, new { }, new[] { ("logs/current/bridge.log", cancelled) });
        check(!missingCause.Report.Contains("causedBy") && !missingCause.Events.Contains("causedBy"),
            "证据不在包内时不能输出失效的因果链接");
    }
}
