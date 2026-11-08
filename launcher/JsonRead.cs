using System.Collections.Generic;
using System.Text.Json;

namespace WhaleLauncher
{
    /// <summary>
    /// JsonElement 读取的公共实现。启动器里很多地方要兼容「数字有时是字符串」，
    /// 各页面各写一份迟早出现一边认、一边不认；统一放这里。
    /// </summary>
    public static class JsonRead
    {
        public static JsonElement Prop(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;

        public static string Str(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? (v.GetString() ?? "") : "";

        public static bool Bool(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

        public static long Long(JsonElement e, string name)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return 0;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) return n;
            if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var s)) return s;
            return 0;
        }

        public static int Int(JsonElement e, string name, int fallback)
        {
            var n = Long(e, name);
            return n >= int.MinValue && n <= int.MaxValue ? (int)n : fallback;
        }

        public static double Double(JsonElement e, string name, double fallback)
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return fallback;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var n)) return n;
            if (v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), out var s)) return s;
            return fallback;
        }

        public static string StrValue(JsonElement v)
            => v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        /// <summary>字符串数组 → 去空、去首尾空格。启动器里「一行一个」的配置都走这里。</summary>
        public static List<string> Strings(JsonElement e, string name)
        {
            var list = new List<string>();
            var v = Prop(e, name);
            if (v.ValueKind != JsonValueKind.Array) return list;
            foreach (var item in v.EnumerateArray())
            {
                var value = StrValue(item).Trim();
                if (value.Length > 0) list.Add(value);
            }
            return list;
        }

        /// <summary>字符串数组 → 多行文本，给「一行一个」的文本框回填。</summary>
        public static string Lines(JsonElement e, string name)
            => string.Join("\n", Strings(e, name));
    }
}
