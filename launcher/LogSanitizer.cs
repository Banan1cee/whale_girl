using System;
using System.Text.RegularExpressions;

namespace WhaleLauncher
{
    internal static class LogSanitizer
    {
        private const string FailureMarker = "（日志脱敏失败，已省略）";
        private static readonly Regex Wxid = new Regex(@"\bwxid_[A-Za-z0-9_\-]{4,}", RegexOptions.Compiled);
        private static readonly Regex GroupId = new Regex(@"\b\d{9,}@chatroom\b", RegexOptions.Compiled);
        private static readonly Regex Phone = new Regex(@"(?<!\d)1[3-9]\d{9}(?!\d)", RegexOptions.Compiled);
        private static readonly Regex Email = new Regex(@"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", RegexOptions.Compiled);
        private static readonly Regex UserPath = new Regex(@"([A-Za-z]:\\Users\\)[^\\\s""']+", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex UrlSecret = new Regex(@"([?&](?:token|key|secret|signature|password|api_key)=)[^&\s]+",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        internal static string SanitizeLog(string text, Func<string, string> redactRegistered)
            => Apply(text, redactRegistered, false);

        internal static string SanitizeCrash(string text, Func<string, string> redactRegistered)
            => Apply(text, redactRegistered, true);

        private static string Apply(string text, Func<string, string> redactRegistered, bool includePii)
        {
            if (string.IsNullOrEmpty(text)) return text ?? "";
            try
            {
                var safe = redactRegistered(text);
                if (safe == null) return FailureMarker;
                if (!includePii) return safe;
                safe = Wxid.Replace(safe, "wxid_***");
                safe = GroupId.Replace(safe, "***@chatroom");
                safe = Phone.Replace(safe, "1**********");
                safe = Email.Replace(safe, "***@***");
                safe = UserPath.Replace(safe, "$1***");
                safe = UrlSecret.Replace(safe, "$1***");
                return safe;
            }
            catch { return FailureMarker; }
        }
    }
}
