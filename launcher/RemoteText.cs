using System;
using System.Text;

namespace WhaleLauncher
{
    /// <summary>
    /// 远端文本清洗：插件目录、公告和工具结果都来自网络，展示前必须压掉换行、控制字符和
    /// 双向文本标记，否则可以用不可见字符伪造对话框，或把说明文字倒着显示。
    ///
    /// 单独成文件是为了让启动器检查工程（tests/launcher/UpdateChecks）只引用这一小块，
    /// 不必把整个插件市场一起编进去；市场的 SafeText / SafeMultiline 转发到这里，
    /// 两处只保留一份实现。
    /// </summary>
    internal static class RemoteText
    {
        /// <summary>单行展示：换行、控制字符和双向文本标记压成空格，避免用清单字段伪造对话框。</summary>
        internal static string SafeText(string value, int max = 600)
        {
            if (string.IsNullOrEmpty(value)) return "";
            var text = new StringBuilder(value.Length);
            var pendingSpace = false;
            foreach (var ch in value)
            {
                if (char.IsControl(ch) || ch is '\u061C' or '\u200E' or '\u200F'
                    || ch is >= '\u202A' and <= '\u202E' || ch is >= '\u2066' and <= '\u2069')
                {
                    pendingSpace = text.Length > 0;
                    continue;
                }
                if (pendingSpace && (ch == ' ' || ch == '\t'))
                {
                    text.Append(' ');
                    pendingSpace = false;
                    continue;
                }
                if (pendingSpace)
                {
                    text.Append(' ');
                    pendingSpace = false;
                }
                text.Append(ch);
            }
            var result = text.ToString().Trim();
            return result.Length > max ? result[..max] : result;
        }

        /// <summary>多行展示：保留换行，仍清掉控制字符和双向文本标记。</summary>
        internal static string SafeMultiline(string value, int max = 65536)
        {
            if (string.IsNullOrEmpty(value)) return "";
            var text = new StringBuilder(value.Length);
            foreach (var ch in value)
            {
                if (ch is '\n' or '\r' or '\t') { text.Append(ch); continue; }
                if (char.IsControl(ch) || ch is '\u061C' or '\u200E' or '\u200F'
                    || ch is >= '\u202A' and <= '\u202E' || ch is >= '\u2066' and <= '\u2069') continue;
                text.Append(ch);
            }
            var result = text.ToString();
            return result.Length > max ? result[..max] : result;
        }
    }
}
