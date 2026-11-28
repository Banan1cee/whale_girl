using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace WhaleLauncher;

internal static class AgentDiagnosticReport
{
    private const int MaxEvents = 240;
    private const string Marker = "[agent_diag] ";
    private static readonly Regex LogPath = new(
        @"^logs/(?:current|run-\d{8}-\d{6})/(?:bridge|kernel|wechat-bridge-4x)\.log(?:\.1)?$",
        RegexOptions.CultureInvariant);
    private static readonly Regex Id = new("^[0-9a-f]{32}$", RegexOptions.CultureInvariant);
    private static readonly Regex Clock = new(@"^(?:\[[0-9-]+\s+)?\[?(?<clock>\d{2}:\d{2}:\d{2})",
        RegexOptions.CultureInvariant);
    private static readonly Regex VersionText = new(@"^\d{1,6}(?:\.\d{1,6}){1,3}$", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    internal sealed record Evidence(string Path, int Line);
    internal sealed record Event(string EventId, string FlowId, DateTimeOffset? At, string ClockLocal,
        string Component, string Subject, string Stage, string Status, string Code, int? DurationMs,
        string CausedBy, Evidence Evidence);
    internal sealed record VoiceConfig(string ReadStatus, bool? Enabled = null, bool? PrivateChats = null,
        bool? Groups = null, double? Probability = null, string Provider = null,
        bool? KeyConfigured = null, bool? PlaybackDeviceReady = null);
    internal sealed record Package(string Report, string Events, string Summary);

    private static readonly Dictionary<string, string> Messages = new(StringComparer.Ordinal)
    {
        ["VOICE_ENABLED"] = "桥接读取到语音发送已开启。",
        ["VOICE_DISABLED"] = "桥接读取到语音发送已关闭。",
        ["VOICE_CONFIG_MISSING"] = "桥接没有找到语音发送配置。",
        ["VOICE_CONFIG_UNREADABLE"] = "桥接无法读取或解析语音发送配置。",
        ["VOICE_CONFIG_INVALID"] = "语音发送开关缺失或类型无效。",
        ["VOICE_SEND_DISABLED_LEGACY"] = "旧日志只记录了语音被跳过，需核对发送开关和配置读取结果。",
        ["VOICE_CHAT_TYPE_DISABLED"] = "语音设置关闭了该会话类型。",
        ["VOICE_USER_REQUESTED_TEXT"] = "这轮按请求使用文字回复。",
        ["VOICE_EXPLICIT_VOICE_REQUEST"] = "检测到明确的语音回复请求。",
        ["VOICE_INVALID_PROBABILITY"] = "自动语音概率的格式无效。",
        ["VOICE_PROBABILITY_DISABLED_OR_INVALID"] = "自动语音概率为零或超出范围。",
        ["VOICE_PROBABILITY_HIT"] = "本轮命中自动语音概率。",
        ["VOICE_PROBABILITY_MISS"] = "本轮没有命中自动语音概率。",
        ["VOICE_PROVIDER_COOLDOWN"] = "语音服务处于冷却期，本次没有合成。",
        ["VOICE_AUDIO_READY"] = "语音合成完成，音频已就绪。",
        ["VOICE_ACCOUNT_OR_CHAT_NOT_READY"] = "语音发送前未能确认微信账号或会话。",
        ["VOICE_TARGET_NOT_VERIFIED"] = "语音录制前未能确认目标会话。",
        ["VOICE_WORKER_RESULT"] = "已取得语音工作进程的结果。",
        ["VOICE_WORKER_RESULT_MISSING"] = "没有取得语音工作进程结果。",
        ["VOICE_TIMEOUT"] = "语音流程在记录的阶段超时。",
        ["VOICE_OPERATION_FAILED"] = "语音流程在记录的阶段异常结束。",
        ["KERNEL_HTTP_ERROR"] = "桥接请求内核时收到了 HTTP 错误。",
        ["KERNEL_REPLY_ERROR"] = "内核生成回复时报告错误。",
        ["KERNEL_REPLY_READY"] = "内核返回了可交给桥接处理的回复。",
        ["KERNEL_NO_TEXT_REPLY"] = "内核本次没有返回文字回复。",
        ["TEXT_SEND_FAILED"] = "桥接未完成本次文字发送。",
        ["UIA_TREE_NOT_READY"] = "微信控件树尚未就绪，后台发送失败。",
        ["STICKER_RESERVATION_CANCELLED"] = "旧日志显示已取消表情包预留；无法确认触发取消的是哪一步。",
        ["STICKER_STOPPED_AFTER_TEXT_FAILURE"] = "前序文字失败，桥接停止本轮表情包发送。",
        ["STICKER_ACCOUNT_NOT_VERIFIED"] = "发送前未能确认目标微信账号窗口。",
        ["WECHAT_NOT_FOREGROUND"] = "表情包操作前未能确认微信处于前台。",
        ["STICKER_TARGET_NOT_VERIFIED"] = "已绑定窗口中未能确认目标会话。",
        ["UIA_TARGET_UNAVAILABLE"] = "无法通过 UIA 核对表情包目标。",
        ["STICKER_RESULT"] = "已记录表情包任务结果。",
        ["WECHAT_SELECTED_ACCOUNT_NOT_FOUND"] = "启动时找不到选定的微信账号，桥接无法继续。",
    };

    private static string Pick(string value, params string[] allowed) => allowed.Contains(value, StringComparer.Ordinal) ? value : null;
    internal static string Version(string value) => value != null && VersionText.IsMatch(value) ? value : null;
    private static string Text(JsonElement obj, string key) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(key, out var value) &&
        value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static bool? Bool(JsonElement obj, string key) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(key, out var value) &&
        value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : null;

    internal static VoiceConfig ReadVoice(string dataDir, Func<string, bool?> hasKey, Func<string, bool?> playbackReady)
    {
        try
        {
            using var stream = new FileStream(Path.Combine(dataDir, "voice-send.json"), FileMode.Open,
                FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (stream.Length > 1024 * 1024) return new("too_large");
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            using var json = JsonDocument.Parse(reader.ReadToEnd());
            var root = json.RootElement;
            var enabled = Bool(root, "Enabled");
            if (enabled is null) return new("invalid");
            var provider = Pick(Text(root, "Provider"), "breezeblue", "minimax", "siliconflow", "deepseek");
            var device = Text(root, "Device");
            double? probability = root.TryGetProperty("Probability", out var p) && p.ValueKind == JsonValueKind.Number
                && p.TryGetDouble(out var number) && number >= 0 && number <= 100 ? number : null;
            return new("loaded", enabled, Bool(root, "Private"), Bool(root, "Groups"), probability, provider,
                provider == null ? null : hasKey(provider),
                string.IsNullOrWhiteSpace(device) ? null : playbackReady(device));
        }
        catch (FileNotFoundException) { return new("missing"); }
        catch (DirectoryNotFoundException) { return new("missing"); }
        catch (JsonException) { return new("invalid"); }
        catch (IOException) { return new("read_failed"); }
        catch (UnauthorizedAccessException) { return new("read_failed"); }
    }

    private static Event Structured(string text, Evidence evidence)
    {
        try
        {
            using var json = JsonDocument.Parse(text);
            var obj = json.RootElement;
            var id = Text(obj, "eventId");
            var flow = Text(obj, "flowId");
            var code = Text(obj, "code");
            var component = Pick(Text(obj, "component"), "bridge", "kernel");
            var subject = Pick(Text(obj, "subject"), "voice", "text", "sticker", "wechat", "reply");
            var stage = Pick(Text(obj, "stage"), "startup", "configuration", "generate", "webhook", "dispatch",
                "synthesis", "recording", "resolve_target", "prepare", "decision");
            var status = Pick(Text(obj, "status"), "failed", "ready", "skipped", "confirmed", "unconfirmed", "cancelled");
            if (!Id.IsMatch(id ?? "") || !Id.IsMatch(flow ?? "") || code == null || !Messages.ContainsKey(code)
                || component == null || subject == null || stage == null || status == null
                || !DateTimeOffset.TryParse(Text(obj, "at"), CultureInfo.InvariantCulture, DateTimeStyles.None, out var at))
                return null;
            var cause = Text(obj, "causedBy");
            int? duration = obj.TryGetProperty("durationMs", out var dt) && dt.ValueKind == JsonValueKind.Number
                && dt.TryGetInt32(out var ms) && ms >= 0 ? ms : null;
            return new(id, flow, at.ToUniversalTime(), null, component, subject, stage, status, code, duration,
                Id.IsMatch(cause ?? "") ? cause : null, evidence);
        }
        catch (JsonException) { return null; }
    }

    private static Event Legacy(string line, Evidence evidence)
    {
        var clock = Clock.Match(line).Groups["clock"].Value;
        if (clock.Length == 0) return null;
        (string subject, string stage, string status, string code) =
            line.Contains("[voice] stage=decision result=skip reason=disabled", StringComparison.Ordinal)
                ? ("voice", "configuration", "skipped", "VOICE_SEND_DISABLED_LEGACY")
            : line.Contains("[delivery] stage=background result=failed reason=tree_not_ready", StringComparison.Ordinal)
                ? ("text", "resolve_target", "failed", "UIA_TREE_NOT_READY")
            : line.Contains("[delivery] stage=text result=failed reason=send_failed", StringComparison.Ordinal)
                ? ("text", "dispatch", "failed", "TEXT_SEND_FAILED")
            : line.Contains("[sticker] stage=cancel result=cancelled", StringComparison.Ordinal) &&
                line.Contains("reason=reply_delivery_stopped", StringComparison.Ordinal)
                ? ("sticker", "dispatch", "cancelled", "STICKER_RESERVATION_CANCELLED")
            : line.Contains("[sticker] stage=ack result=failed", StringComparison.Ordinal) &&
                line.Contains("reason=account_not_verified", StringComparison.Ordinal)
                ? ("sticker", "dispatch", "failed", "STICKER_ACCOUNT_NOT_VERIFIED")
            : line.Contains("✗ 找不到微信账号", StringComparison.Ordinal)
                ? ("wechat", "startup", "failed", "WECHAT_SELECTED_ACCOUNT_NOT_FOUND")
            : (null, null, null, null);
        if (code == null) return null;
        // 旧日志没有流程编号，时间邻近不能作为因果证据。
        return new(null, null, null, clock, evidence.Path.EndsWith("/kernel.log", StringComparison.Ordinal)
            ? "kernel" : "bridge", subject, stage, status, code, null, null, evidence);
    }

    internal static Package Build(DateTimeOffset capturedAt, object snapshot,
        IEnumerable<(string Entry, string Text)> logs)
    {
        var candidates = new List<Event>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (entry, log) in logs)
        {
            if (!LogPath.IsMatch(entry)) continue;
            using var reader = new StringReader(log);
            var tail = new Queue<Event>();
            int number = 0;
            while (reader.ReadLine() is string line)
            {
                number++;
                var offset = line.IndexOf(Marker, StringComparison.Ordinal);
                var evidence = new Evidence(entry, number);
                var row = offset >= 0 && line.Length - offset <= 2048
                    ? Structured(line[(offset + Marker.Length)..], evidence) : Legacy(line, evidence);
                if (row == null) continue;
                tail.Enqueue(row);
                if (tail.Count > MaxEvents) tail.Dequeue();
            }
            candidates.AddRange(tail.Where(row => row.EventId == null || seen.Add(row.EventId)));
        }
        var rows = candidates.Where(e => e.At == null || e.At >= capturedAt.AddHours(-24))
            .OrderBy(e => e.At ?? DateTimeOffset.MinValue).TakeLast(MaxEvents).ToArray();
        var exported = rows.Where(x => x.EventId != null).ToDictionary(x => x.EventId);
        rows = rows.Select(e => e.CausedBy != null &&
            (!exported.TryGetValue(e.CausedBy, out var cause) || cause.FlowId != e.FlowId)
            ? e with { CausedBy = null } : e).ToArray();

        var findings = rows.Where(e => e.Status is "failed" or "cancelled" or "unconfirmed" ||
                e.Stage is "configuration" or "decision" && e.Status == "skipped")
            .Reverse().DistinctBy(e => (e.FlowId, e.Code)).Take(24)
            .Select(e => new { e.Code, e.Subject, e.Stage, e.Status, e.At, e.ClockLocal, e.FlowId, e.EventId,
                e.CausedBy, certainty = e.EventId == null ? "legacy_observation" : "observed",
                message = Messages[e.Code], e.Evidence,
                missingEvidence = e.Code switch
                {
                    "VOICE_SEND_DISABLED_LEGACY" => "voice_send_settings_at_failure",
                    "TEXT_SEND_FAILED" => "specific_text_transport_failure",
                    "STICKER_RESERVATION_CANCELLED" => "cancellation_trigger",
                    _ => null,
                } }).ToArray();
        var report = new
        {
            schemaVersion = 1, capturedAt,
            snapshot, findings,
            eventCoverage = new { limit = MaxEvents, exported = rows.Length,
                structuredSince = rows.Where(e => e.At != null).Select(e => e.At).FirstOrDefault(),
                hasLegacyObservations = rows.Any(e => e.EventId == null) },
            eventsPath = "events.jsonl",
            interpretation = "证据引用仅指向 ZIP 内文件；没有记录的阶段是未知。临近的旧日志不能推断因果。未确认表示不能证明微信送达。",
        };
        var summary = new StringBuilder("鲸鲸诊断摘要\nAgent 请先读 agent-report.json，再沿证据定位到 events.jsonl 或 ZIP 内日志。\n");
        foreach (var item in findings.Take(8))
            summary.AppendLine($"- {item.message} [{item.Status}] {item.Evidence.Path}:{item.Evidence.Line}");
        if (findings.Length == 0) summary.AppendLine("本次导出的范围内没有可归类的失败；缺少记录不代表功能正常。");
        return new(JsonSerializer.Serialize(report, new JsonSerializerOptions(Json) { WriteIndented = true }) + "\n",
            string.Concat(rows.Select(e => JsonSerializer.Serialize(e, Json) + "\n")), summary.ToString());
    }
}
