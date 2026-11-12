using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace WhaleLauncher;

internal static class SecretRedactor
{
    static readonly object Gate = new();
    static readonly HashSet<string> Secrets = new(StringComparer.Ordinal);
    static readonly Regex Field = new(@"api.?key|token|secret|password|authorization|cookie|^key$|^spell$", RegexOptions.IgnoreCase);
    static readonly Regex Token = new(@"\b(?:sk|brz|oc_sk|ak|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b", RegexOptions.IgnoreCase);
    static readonly Regex Bearer = new("\\bBearer\\s+[^\\s\"'<>},]+", RegexOptions.IgnoreCase);
    static readonly Regex Assignment = new("((?:api[_ -]?key|access[_ -]?token|password|secret|authorization|[?&](?:key|token))\\s*[\"']?\\s*[:=]\\s*[\"']?)[^\\s\"'&,}\\]]+", RegexOptions.IgnoreCase);
    static DateTime nextRefresh;

    public static void Refresh(string root, bool force = false)
    {
        lock (Gate)
        {
            if (!force && DateTime.UtcNow < nextRefresh) return;
            nextRefresh = DateTime.UtcNow.AddSeconds(1);
            foreach (var file in new[] { Path.Combine(root, "config.json"), Path.Combine(root, "data", "settings.json") })
            {
                try { Register(JsonNode.Parse(File.ReadAllText(file))); }
                catch { /* 配置写入期间保留之前已知的密钥。 */ }
            }
            foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
                if (Field.IsMatch(entry.Key.ToString())) Add(entry.Value?.ToString());
        }
    }

    static void Add(string value)
    {
        if (!string.IsNullOrEmpty(value) && value.Length >= 4 && value.Any(c => c != '*')) Secrets.Add(value);
    }

    static void Register(JsonNode node, bool sensitive = false)
    {
        if (node is JsonObject obj)
            foreach (var item in obj) Register(item.Value, sensitive || item.Key.Equals("keys", StringComparison.OrdinalIgnoreCase) || Field.IsMatch(item.Key));
        else if (node is JsonArray arr)
            foreach (var item in arr) Register(item, sensitive);
        else if (sensitive && node is JsonValue value && value.TryGetValue<string>(out var text)) Add(text);
    }

    public static string Redact(string text)
    {
        if (string.IsNullOrEmpty(text)) return text ?? "";
        lock (Gate)
        {
            foreach (var value in Secrets.OrderByDescending(x => x.Length))
            {
                text = text.Replace(value, "***", StringComparison.Ordinal);
                text = text.Replace(Uri.EscapeDataString(value), "***", StringComparison.Ordinal);
            }
        }
        text = Token.Replace(text, "***");
        text = Bearer.Replace(text, "Bearer ***");
        return Assignment.Replace(text, "$1***");
    }
}
