using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace WhaleLauncher
{
    /// <summary>
    /// 启动器主题包：一份纯 JSON 数据，不扩展插件包协议，也没有任何执行体。
    ///
    /// 为什么单独做一份、而不是塞进插件清单：
    /// 插件清单里有 provider / call / dataAccess / settingsSchema，每一项都要走宿主授权；
    /// 主题只影响配色和尺寸，既不该拿插件等级，也不该获得任何调用能力。单独成文件后，
    /// 解析路径里只有 JSON 和字符串校验，不存在 XAML、脚本或程序集加载。
    ///
    /// 边界是「有界语义 token」：颜色只认 7 个语义名，字体只认内置白名单，
    /// 圆角 / 间距是带范围的标量。未知字段直接整包拒绝，避免以后悄悄扩权。
    /// </summary>
    internal sealed class LauncherTheme
    {
        internal int Schema { get; set; } = LauncherThemes.SchemaVersion;
        internal string Id { get; set; } = "";
        internal string Name { get; set; } = "";
        internal string Author { get; set; } = "";
        internal string Version { get; set; } = "";

        /// <summary>语义色名 → 规范化的 #AARRGGBB。没写的语义沿用内置配色。</summary>
        internal Dictionary<string, string> Colors { get; } = new Dictionary<string, string>(StringComparer.Ordinal);

        /// <summary>字体族白名单里的一个名字；空 = 沿用内置。</summary>
        internal string FontFamily { get; set; } = "";

        /// <summary>字号缩放（0.85–1.15）。</summary>
        internal double FontScale { get; set; } = 1.0;

        /// <summary>卡片圆角基准（0–24），其余控件按比例联动；-1 = 沿用内置。</summary>
        internal int Corner { get; set; } = -1;

        /// <summary>间距缩放（0.85–1.15），只作用于宿主控件的内边距与普通弹窗的行距。</summary>
        internal double Spacing { get; set; } = 1.0;

        /// <summary>普通弹窗底色 / 描边；安全、授权、更新确认不使用这两项。</summary>
        internal string DialogSurface { get; set; } = "";
        internal string DialogBorder { get; set; } = "";

        /// <summary>普通弹窗圆角（0–24）；-1 = 沿用内置。</summary>
        internal int DialogCorner { get; set; } = -1;

        internal bool HasColor(string token) => Colors.ContainsKey(token);

        internal string ColorOr(string token, string fallback)
            => Colors.TryGetValue(token, out var value) ? value : fallback;
    }

    /// <summary>主题包的结构校验、持久化和对比度计算。这里不碰 WPF，方便单独编译测试。</summary>
    internal static class LauncherThemes
    {
        internal const int SchemaVersion = 1;

        /// <summary>64 KiB 足够写一份完整配色；再大就没必要替用户读进来了。</summary>
        internal const int MaxBytes = 64 * 1024;

        internal const string FileName = "launcher-theme.json";

        /// <summary>允许主题改的语义色。Ok / Warn / Bad 这类安全信号不在此列，永不被主题改写。</summary>
        internal static readonly string[] ColorTokens =
        {
            "accent", "background", "surface", "text", "muted", "border", "field",
        };

        /// <summary>字体白名单：只用系统自带中文字体族，避免任意族名触发字体解析。</summary>
        internal static readonly string[] FontFamilies =
        {
            "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", "SimSun",
        };

        internal static readonly string[] TopKeys =
        {
            "schema", "id", "name", "author", "version", "colors", "font", "metrics", "dialog",
        };

        internal static readonly string[] FontKeys = { "family", "scale" };
        internal static readonly string[] MetricKeys = { "corner", "spacing" };
        internal static readonly string[] DialogKeys = { "surface", "border", "corner" };

        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        // 允许的标量范围。圆角上限 24：再大就不是这个界面了，卡片会圆成胶囊。
        internal const double MinScale = 0.85;
        internal const double MaxScale = 1.15;
        internal const int MinCorner = 0;
        internal const int MaxCorner = 24;

        // 对比度门槛：正文 4.5，强调色 3.0（大字号 / 图形元素的常用下限）。
        internal const double TextContrast = 4.5;
        internal const double AccentContrast = 3.0;

        /// <summary>
        /// 解析并校验一份主题包。任何不合格都抛 InvalidDataException，异常消息可以直接给用户看。
        /// 整个过程只读字节，不写文件、不改当前外观。
        /// </summary>
        internal static LauncherTheme Parse(byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0) throw new InvalidDataException("主题包是空文件。");
            if (bytes.Length > MaxBytes) throw new InvalidDataException("主题包超过 64 KiB 上限。");

            string text;
            try { text = StrictUtf8.GetString(bytes); }
            catch (DecoderFallbackException) { throw new InvalidDataException("主题包必须是无 BOM 的 UTF-8 文本。"); }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 8 });
            }
            catch (JsonException) { throw new InvalidDataException("主题包不是有效的 JSON。"); }

            using (document)
            {
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("主题包最外层必须是 JSON 对象。");
                RejectUnknown(root, TopKeys, "主题包");

                var theme = new LauncherTheme
                {
                    Schema = Int(root, "schema", "schema"),
                    Id = Str(root, "id", "id"),
                    Name = Str(root, "name", "name"),
                    Author = OptionalStr(root, "author", "author") ?? "",
                    Version = OptionalStr(root, "version", "version") ?? "",
                };

                if (theme.Schema != SchemaVersion) throw new InvalidDataException("主题包 schema 必须是 1。");
                if (!IsValidId(theme.Id)) throw new InvalidDataException("主题包 id 必须是 1–48 位小写字母、数字或短横线，且以字母开头。");
                theme.Name = SafeLabel(theme.Name, 40, "name", required: true);
                theme.Author = SafeLabel(theme.Author, 40, "author", required: false);
                theme.Version = SafeLabel(theme.Version, 20, "version", required: false);
                if (theme.Version.Length > 0 && !IsVersion(theme.Version))
                    throw new InvalidDataException("version 只能是像 1.0.0 这样的数字版本号。");

                if (root.TryGetProperty("colors", out var colors))
                {
                    if (colors.ValueKind != JsonValueKind.Object) throw new InvalidDataException("colors 必须是对象。");
                    RejectUnknown(colors, ColorTokens, "colors");
                    foreach (var field in colors.EnumerateObject())
                    {
                        if (field.Value.ValueKind != JsonValueKind.String)
                            throw new InvalidDataException("colors." + field.Name + " 必须是颜色字符串。");
                        theme.Colors[field.Name] = NormalizeHex(field.Value.GetString(), "colors." + field.Name);
                    }
                }

                if (root.TryGetProperty("font", out var font))
                {
                    if (font.ValueKind != JsonValueKind.Object) throw new InvalidDataException("font 必须是对象。");
                    RejectUnknown(font, FontKeys, "font");
                    if (font.TryGetProperty("family", out var family))
                    {
                        var raw = family.ValueKind == JsonValueKind.String ? family.GetString() : null;
                        theme.FontFamily = CanonicalFont(raw);
                        if (theme.FontFamily.Length == 0) throw new InvalidDataException("font.family 不在内置字体白名单里。");
                    }
                    if (font.TryGetProperty("scale", out var scale))
                        theme.FontScale = Scale(scale, "font.scale");
                }

                if (root.TryGetProperty("metrics", out var metrics))
                {
                    if (metrics.ValueKind != JsonValueKind.Object) throw new InvalidDataException("metrics 必须是对象。");
                    RejectUnknown(metrics, MetricKeys, "metrics");
                    if (metrics.TryGetProperty("corner", out var corner))
                        theme.Corner = CornerValue(corner, "metrics.corner");
                    if (metrics.TryGetProperty("spacing", out var spacing))
                        theme.Spacing = Scale(spacing, "metrics.spacing");
                }

                if (root.TryGetProperty("dialog", out var dialog))
                {
                    if (dialog.ValueKind != JsonValueKind.Object) throw new InvalidDataException("dialog 必须是对象。");
                    RejectUnknown(dialog, DialogKeys, "dialog");
                    if (dialog.TryGetProperty("surface", out var surface))
                        theme.DialogSurface = HexString(surface, "dialog.surface");
                    if (dialog.TryGetProperty("border", out var border))
                        theme.DialogBorder = HexString(border, "dialog.border");
                    if (dialog.TryGetProperty("corner", out var dialogCorner))
                        theme.DialogCorner = CornerValue(dialogCorner, "dialog.corner");
                }

                if (theme.Colors.Count == 0 && theme.FontFamily.Length == 0 && theme.Corner < 0
                    && theme.DialogSurface.Length == 0 && theme.DialogBorder.Length == 0 && theme.DialogCorner < 0
                    && Math.Abs(theme.FontScale - 1) < 0.001 && Math.Abs(theme.Spacing - 1) < 0.001)
                    throw new InvalidDataException("主题包没有声明任何可生效的 token。");

                var contrast = ContrastProblem(theme);
                if (contrast.Length > 0) throw new InvalidDataException(contrast);
                return theme;
            }
        }

        /// <summary>读取一个 .json 文件并校验。失败只返回错误文本，不动任何现有状态。</summary>
        internal static bool TryLoadFile(string path, out LauncherTheme theme, out string error)
        {
            theme = null;
            error = "";
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                {
                    error = "找不到这个主题包文件。";
                    return false;
                }
                var info = new FileInfo(path);
                if (info.Length > MaxBytes)
                {
                    error = "主题包超过 64 KiB 上限。";
                    return false;
                }
                var bytes = File.ReadAllBytes(path);
                theme = Parse(bytes);
                return true;
            }
            catch (Exception ex) when (ex is InvalidDataException or IOException or UnauthorizedAccessException)
            {
                error = DescribeThemeError(ex);
                return false;
            }
            catch (Exception ex) when (ex is NotSupportedException or System.Security.SecurityException)
            {
                error = "这个文件读不了：" + ex.Message;
                return false;
            }
        }

        /// <summary>启动时读回上次保存的主题。文件被改坏就直接当没有，绝不影响内置外观。</summary>
        internal static LauncherTheme LoadActive(string path)
        {
            try
            {
                if (!File.Exists(path)) return null;
                if (new FileInfo(path).Length > MaxBytes) return null;
                return Parse(File.ReadAllBytes(path));
            }
            catch
            {
                return null;
            }
        }

        /// <summary>原子写入规范化后的主题；写失败只是这次没记住，不影响已经生效的外观。</summary>
        internal static bool Save(string path, LauncherTheme theme)
        {
            if (theme == null) return false;
            string staging = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path) ?? AppContext.BaseDirectory);
                File.WriteAllBytes(staging, ToJsonBytes(theme));
                File.Move(staging, path, true);
                return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
            {
                return false;
            }
            finally
            {
                try { if (File.Exists(staging)) File.Delete(staging); } catch { }
            }
        }

        internal static bool Remove(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
                return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return false;
            }
        }

        /// <summary>规范形式：字段固定顺序、颜色统一 #AARRGGBB，方便用户直接改文件。</summary>
        internal static byte[] ToJsonBytes(LauncherTheme theme)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true }))
            {
                writer.WriteStartObject();
                writer.WriteNumber("schema", SchemaVersion);
                writer.WriteString("id", theme.Id);
                writer.WriteString("name", theme.Name);
                if (theme.Author.Length > 0) writer.WriteString("author", theme.Author);
                if (theme.Version.Length > 0) writer.WriteString("version", theme.Version);
                if (theme.Colors.Count > 0)
                {
                    writer.WriteStartObject("colors");
                    foreach (var token in ColorTokens)
                        if (theme.Colors.TryGetValue(token, out var value)) writer.WriteString(token, value);
                    writer.WriteEndObject();
                }
                if (theme.FontFamily.Length > 0 || Math.Abs(theme.FontScale - 1) > 0.001)
                {
                    writer.WriteStartObject("font");
                    if (theme.FontFamily.Length > 0) writer.WriteString("family", theme.FontFamily);
                    if (Math.Abs(theme.FontScale - 1) > 0.001) writer.WriteNumber("scale", Math.Round(theme.FontScale, 3));
                    writer.WriteEndObject();
                }
                if (theme.Corner >= 0 || Math.Abs(theme.Spacing - 1) > 0.001)
                {
                    writer.WriteStartObject("metrics");
                    if (theme.Corner >= 0) writer.WriteNumber("corner", theme.Corner);
                    if (Math.Abs(theme.Spacing - 1) > 0.001) writer.WriteNumber("spacing", Math.Round(theme.Spacing, 3));
                    writer.WriteEndObject();
                }
                if (theme.DialogSurface.Length > 0 || theme.DialogBorder.Length > 0 || theme.DialogCorner >= 0)
                {
                    writer.WriteStartObject("dialog");
                    if (theme.DialogSurface.Length > 0) writer.WriteString("surface", theme.DialogSurface);
                    if (theme.DialogBorder.Length > 0) writer.WriteString("border", theme.DialogBorder);
                    if (theme.DialogCorner >= 0) writer.WriteNumber("corner", theme.DialogCorner);
                    writer.WriteEndObject();
                }
                writer.WriteEndObject();
            }
            return stream.ToArray();
        }

        /// <summary>
        /// 只校验主题自己声明的颜色对：正文/底色 ≥ 4.5，强调色/底色 ≥ 3，
        /// 弹窗底色对正文也要够。没声明的 token 沿用内置配色，本身已经过对比度。
        /// </summary>
        internal static string ContrastProblem(LauncherTheme theme)
        {
            if (theme == null) return "";
            if (theme.HasColor("text") && theme.HasColor("background")
                && Ratio(theme.Colors["text"], theme.Colors["background"]) < TextContrast)
                return "正文色和底色对比度不足（需要 4.5 以上）。";
            if (theme.HasColor("accent") && theme.HasColor("background")
                && Ratio(theme.Colors["accent"], theme.Colors["background"]) < AccentContrast)
                return "主题色和底色对比度不足（需要 3 以上）。";
            if (theme.HasColor("text") && theme.HasColor("surface")
                && Ratio(theme.Colors["text"], theme.Colors["surface"]) < TextContrast)
                return "正文色和卡片底色对比度不足（需要 4.5 以上）。";
            if (theme.HasColor("text") && theme.DialogSurface.Length > 0
                && Ratio(theme.Colors["text"], theme.DialogSurface) < TextContrast)
                return "正文色和弹窗底色对比度不足（需要 4.5 以上）。";
            return "";
        }

        // ── 对比度 / 颜色 ─────────────────────────────────────────

        /// <summary>WCAG 相对亮度对比度。Alpha 不参与：透明度由宿主的玻璃层决定。</summary>
        internal static double Ratio(string first, string second)
        {
            if (!TryParseHex(first, out var a) || !TryParseHex(second, out var b)) return 0;
            return Ratio(a, b);
        }

        internal static double Ratio(uint argb1, uint argb2)
        {
            var l1 = Luminance(argb1);
            var l2 = Luminance(argb2);
            var light = Math.Max(l1, l2);
            var dark = Math.Min(l1, l2);
            return (light + 0.05) / (dark + 0.05);
        }

        internal static double Luminance(uint argb)
        {
            var r = Channel((argb >> 16) & 0xFF);
            var g = Channel((argb >> 8) & 0xFF);
            var b = Channel(argb & 0xFF);
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }

        private static double Channel(uint value)
        {
            var v = value / 255.0;
            return v <= 0.04045 ? v / 12.92 : Math.Pow((v + 0.055) / 1.055, 2.4);
        }

        /// <summary>接受 #RRGGBB / #AARRGGBB，统一成大写 #AARRGGBB。</summary>
        internal static string NormalizeHex(string value, string field)
        {
            if (!TryParseHex(value, out var argb))
                throw new InvalidDataException(field + " 必须是 #RRGGBB 或 #AARRGGBB 颜色。");
            return "#" + argb.ToString("X8", CultureInfo.InvariantCulture);
        }

        internal static bool TryParseHex(string value, out uint argb)
        {
            argb = 0;
            if (string.IsNullOrWhiteSpace(value)) return false;
            var text = value.Trim();
            if (text.StartsWith('#')) text = text.Substring(1);
            if (text.Length != 6 && text.Length != 8) return false;
            if (text.Any(ch => !Uri.IsHexDigit(ch))) return false;
            if (!uint.TryParse(text.Length == 6 ? "FF" + text : text, NumberStyles.HexNumber,
                CultureInfo.InvariantCulture, out argb)) return false;
            return true;
        }

        // ── 字段校验 ───────────────────────────────────────────────

        private static void RejectUnknown(JsonElement element, string[] allowed, string where)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in element.EnumerateObject())
            {
                if (!allowed.Contains(field.Name, StringComparer.Ordinal))
                    throw new InvalidDataException(where + " 含不支持的字段：" + SafeLabel(field.Name, 24, where, required: false));
                if (!seen.Add(field.Name)) throw new InvalidDataException(where + " 含重复字段：" + field.Name);
            }
        }

        private static int Int(JsonElement root, string name, string field)
        {
            if (!root.TryGetProperty(name, out var value)) throw new InvalidDataException("主题包缺少 " + field + "。");
            if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var result))
                throw new InvalidDataException(field + " 必须是整数。");
            return result;
        }

        private static string Str(JsonElement root, string name, string field)
        {
            var value = OptionalStr(root, name, field);
            if (value == null) throw new InvalidDataException("主题包缺少 " + field + "。");
            return value;
        }

        private static string OptionalStr(JsonElement root, string name, string field)
        {
            if (!root.TryGetProperty(name, out var value)) return null;
            if (value.ValueKind != JsonValueKind.String) throw new InvalidDataException(field + " 必须是字符串。");
            return value.GetString() ?? "";
        }

        private static string SafeLabel(string value, int max, string field, bool required)
        {
            var builder = new StringBuilder();
            foreach (var ch in (value ?? "").Trim())
            {
                if (char.IsControl(ch) || ch is '\u061C' or '\u200E' or '\u200F'
                    || ch is >= '\u202A' and <= '\u202E' || ch is >= '\u2066' and <= '\u2069') continue;
                builder.Append(ch);
            }
            var text = builder.ToString().Trim();
            if (text.Length > max) throw new InvalidDataException(field + " 太长（最多 " + max + " 个字符）。");
            if (required && text.Length == 0) throw new InvalidDataException(field + " 不能为空。");
            return text;
        }

        private static bool IsValidId(string id)
        {
            if (string.IsNullOrEmpty(id) || id.Length > 48) return false;
            if (id[0] < 'a' || id[0] > 'z') return false;
            foreach (var ch in id)
                if (!(ch >= 'a' && ch <= 'z') && !(ch >= '0' && ch <= '9') && ch != '-') return false;
            return true;
        }

        private static bool IsVersion(string value)
        {
            var parts = value.Split('.');
            if (parts.Length is < 1 or > 4) return false;
            return parts.All(part => part.Length > 0 && part.Length <= 5 && part.All(ch => ch >= '0' && ch <= '9'));
        }

        private static string CanonicalFont(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return "";
            var trimmed = raw.Trim();
            foreach (var family in FontFamilies)
                if (string.Equals(family, trimmed, StringComparison.OrdinalIgnoreCase)) return family;
            return "";
        }

        private static string HexString(JsonElement value, string field)
        {
            if (value.ValueKind != JsonValueKind.String)
                throw new InvalidDataException(field + " 必须是颜色字符串。");
            return NormalizeHex(value.GetString(), field);
        }

        private static double Scale(JsonElement value, string field)
        {
            if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number)
                || double.IsNaN(number) || double.IsInfinity(number)
                || number < MinScale || number > MaxScale)
                throw new InvalidDataException(field + " 必须在 " + MinScale + " 到 " + MaxScale + " 之间。");
            return Math.Round(number, 3);
        }

        private static int CornerValue(JsonElement value, string field)
        {
            if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var number)
                || number < MinCorner || number > MaxCorner)
                throw new InvalidDataException(field + " 必须是 " + MinCorner + " 到 " + MaxCorner + " 的整数。");
            return number;
        }

        private static string DescribeThemeError(Exception ex)
        {
            if (ex is InvalidDataException && ex.Message.Length > 0) return ex.Message;
            return "主题包读取失败：" + ex.Message;
        }
    }
}
