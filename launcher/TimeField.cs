using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher
{
    public enum TimeFieldMode
    {
        /// <summary>单个时刻，例如 23:00。</summary>
        Clock,
        /// <summary>时间段列表，每行一个，例如 09:00-12:00。</summary>
        Ranges,
    }

    /// <summary>
    /// 统一的时间输入框。
    ///
    /// 以前日记用裸 TextBox + 页面里一段正则，主动搭话用另一段多行解析，
    /// 两边的宽容度、报错和落库格式都不一样。这里把「解析 / 规范化 / 错误文案」
    /// 收成一处：9:00 → 09:00，09:00～12:00 → 09:00-12:00。
    /// 校验失败时不偷偷改成默认值，由页面显示 ErrorText。
    /// </summary>
    public sealed class TimeField : TextBox
    {
        public TimeField()
        {
            // 显式引用全局 TextBox 样式；隐式样式对派生控件不保证生效。
            SetResourceReference(StyleProperty, typeof(TextBox));
        }

        public TimeFieldMode Mode { get; set; } = TimeFieldMode.Clock;

        /// <summary>留空是否合法。日记时间不允许空；搭话时间段允许空（= 全天）。</summary>
        public bool AllowEmpty { get; set; } = true;

        public string Label { get; set; } = "";

        public string ErrorText => Mode == TimeFieldMode.Ranges
            ? (string.IsNullOrWhiteSpace(Label) ? "时间" : Label) + " 要填 24 小时制时间段，如 09:00-12:00；每行一个"
            : (string.IsNullOrWhiteSpace(Label) ? "时间" : Label) + " 要填 24 小时制时间，如 23:00";

        public bool TryRead(out string value)
        {
            var text = (Text ?? "").Trim();
            if (text.Length == 0)
            {
                value = "";
                return AllowEmpty;
            }
            if (Mode == TimeFieldMode.Ranges) return TryNormalizeRanges(text, out value);
            return TryNormalizeClock(text, out value);
        }

        public static bool TryNormalizeClock(string text, out string value)
        {
            value = "";
            var raw = (text ?? "").Trim();
            var m = Regex.Match(raw, @"^(\d{1,2})[:：](\d{2})$");
            if (!m.Success) return false;
            if (!int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var hour)
                || !int.TryParse(m.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var minute))
                return false;
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
            value = hour.ToString("00") + ":" + minute.ToString("00");
            return true;
        }

        public static bool TryNormalizeRanges(string text, out string value)
        {
            value = "";
            var lines = (text ?? "").Split(new[] { '\r', '\n', '，', ',', ';', '；' }, StringSplitOptions.RemoveEmptyEntries);
            var normalized = new List<string>();
            foreach (var line in lines)
            {
                var raw = (line ?? "").Trim();
                if (raw.Length == 0) continue;
                raw = Regex.Replace(raw, "[~～—–－到至]", "-");
                raw = Regex.Replace(raw, @"\s+", "");
                var m = Regex.Match(raw, @"^(.+?)-(.+)$");
                if (!m.Success) return false;
                if (!TryNormalizeClock(m.Groups[1].Value, out var start)) return false;
                if (!TryNormalizeEnd(m.Groups[2].Value, out var end)) return false;
                normalized.Add(start + "-" + end);
            }
            value = string.Join("\n", normalized);
            return true;
        }

        public static string NormalizeClockOrEmpty(string text)
            => TryNormalizeClock(text, out var value) ? value : (text ?? "").Trim();

        public static string NormalizeRangesOrEmpty(string text)
            => TryNormalizeRanges(text, out var value) ? value : (text ?? "").Trim();

        /// <summary>时间段结束点允许 24:00（当天结束）；开始点不允许。</summary>
        private static bool TryNormalizeEnd(string text, out string value)
        {
            value = "";
            var raw = (text ?? "").Trim().Replace('：', ':');
            if (raw == "24:00")
            {
                value = "24:00";
                return true;
            }
            return TryNormalizeClock(raw, out value);
        }
    }
}
