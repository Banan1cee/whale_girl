using System.Collections.Generic;
using System.Globalization;
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
            => TryLong(e, name, out var value) ? value : 0;

        public static bool TryLong(JsonElement e, string name, out long value)
        {
            value = 0;
            var v = Prop(e, name);
            if (v.ValueKind == JsonValueKind.Number) return v.TryGetInt64(out value);
            return v.ValueKind == JsonValueKind.String
                && long.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
        }

        public static int Int(JsonElement e, string name, int fallback)
        {
            return TryLong(e, name, out var n) && n >= int.MinValue && n <= int.MaxValue ? (int)n : fallback;
        }

        public static double Double(JsonElement e, string name, double fallback)
            => DoubleValue(Prop(e, name), fallback);

        public static double DoubleValue(JsonElement v, double fallback)
        {
            double value;
            var valid = v.ValueKind == JsonValueKind.Number ? v.TryGetDouble(out value)
                : double.TryParse(v.ValueKind == JsonValueKind.String ? v.GetString() : null,
                    NumberStyles.Float, CultureInfo.InvariantCulture, out value);
            if (valid && !double.IsNaN(value) && !double.IsInfinity(value)) return value;
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
