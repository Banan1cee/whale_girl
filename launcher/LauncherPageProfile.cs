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
    /// 页级样式配置（P1）：一份纯数据 JSON，只描述每个宿主页面自己的密度与字号缩放。
    ///
    /// 为什么单独一份、字段这么少：
    /// 页面样式只该动"看起来多密、字多大"，因此这里刻意不提供颜色、圆角、资源键名或任何
    /// 控件/布局描述——没有资源键，就不可能覆盖警告色、主按钮色、顶栏这类保护资源；
    /// 没有 XAML/脚本，就没有执行面。字段白名单之外的任何内容整包拒绝，后续要加区块级
    /// 能力（P2/P3）时再升 schema 版本，不在 v1 里悄悄放宽。
    /// </summary>
    internal sealed class LauncherPageProfile
    {
        internal int Schema { get; set; } = LauncherPageProfiles.SchemaVersion;

        /// <summary>稳定页面 ID → 该页样式。ID 是英文常量，不是界面显示名称。</summary>
        internal Dictionary<string, LauncherPageStyle> Pages { get; } = new Dictionary<string, LauncherPageStyle>(StringComparer.Ordinal);
    }

    /// <summary>单个页面的有界样式：1.0 = 跟随全局。只记录显式声明的字段。</summary>
    internal sealed class LauncherPageStyle
    {
        internal bool HasDensity { get; set; }
        internal double Density { get; set; } = 1.0;

        internal bool HasFontScale { get; set; }
        internal double FontScale { get; set; } = 1.0;

        /// <summary>区块顺序 / 显隐（schema 2）。为空 = 不改区块。</summary>
        internal List<LauncherPageSection> Sections { get; } = new List<LauncherPageSection>();

        internal bool HasSections => Sections.Count > 0;
    }

    /// <summary>单个区块的配置：稳定 ID + 显隐 + 目标位置。ID 由宿主页面声明，配置只引用。</summary>
    internal sealed class LauncherPageSection
    {
        internal string Id { get; set; } = "";

        /// <summary>是否显示；默认 true。被宿主标记为不可隐藏的区块会忽略 false。</summary>
        internal bool Visible { get; set; } = true;

        /// <summary>目标位置（0 起）；null = 保持默认相对顺序。</summary>
        internal int? Order { get; set; }
    }

    /// <summary>
    /// 宿主页面声明的区块元数据（纯数据，页面自己持有）。Title 只用于预览/诊断，
    /// 身份永远是 Id；CanHide/CanMove 决定配置能不能动这一块。
    /// </summary>
    internal sealed class PageSectionDescriptor
    {
        internal PageSectionDescriptor(string id, string title, bool canHide = true, bool canMove = true)
        {
            Id = id ?? "";
            Title = title ?? id ?? "";
            CanHide = canHide;
            CanMove = canMove;
        }

        internal string Id { get; }
        internal string Title { get; }
        internal bool CanHide { get; }
        internal bool CanMove { get; }
    }

    /// <summary>页级样式的结构校验、持久化。这里不碰 WPF，方便单独编译测试（同 LauncherTheme 的做法）。</summary>
    internal static class LauncherPageProfiles
    {
        /// <summary>当前写出的最高版本。解析仍然接受 1（没有区块配置的老文件）。</summary>
        internal const int SchemaVersion = 2;

        /// <summary>32 KiB 足够写满 10 个页面 + 每页最多 12 个区块；再大就没必要替用户读进来。</summary>
        internal const int MaxBytes = 32 * 1024;

        internal const string FileName = "launcher-pages.json";

        internal const double MinScale = 0.90;
        internal const double MaxScale = 1.15;

        /// <summary>每页最多声明 12 个区块；顺序值范围 0–31。</summary>
        internal const int MaxSections = 12;
        internal const int MaxOrder = 31;

        /// <summary>
        /// 宿主稳定页面 ID。界面文案可以改，这些 ID 不能改——页级配置、缓存和后续
        /// 区块配置都以它们为锚点。与 MainWindow.NavKeys 的显示名解耦。
        /// </summary>
        internal static readonly string[] PageIds =
        {
            "status", "persona", "stickers", "voice", "moments",
            "reminders", "bridge", "diagnostics", "plugins", "settings",
        };

        internal static readonly string[] TopKeys = { "schema", "pages" };
        internal static readonly string[] StyleKeysV1 = { "density", "fontScale" };
        internal static readonly string[] StyleKeysV2 = { "density", "fontScale", "sections" };
        internal static readonly string[] SectionKeys = { "id", "visible", "order" };

        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        internal static bool IsKnownPage(string pageId)
            => pageId != null && PageIds.Contains(pageId, StringComparer.Ordinal);

        /// <summary>解析并严格校验。任何不合格抛 InvalidDataException，消息可直接给用户看。</summary>
        internal static LauncherPageProfile Parse(byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0) throw new InvalidDataException("页级样式文件是空的。");
            if (bytes.Length > MaxBytes) throw new InvalidDataException("页级样式文件超过 32 KiB 上限。");

            string text;
            try { text = StrictUtf8.GetString(bytes); }
            catch (DecoderFallbackException) { throw new InvalidDataException("页级样式必须是无 BOM 的 UTF-8 文本。"); }

            JsonDocument document;
            try { document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 6 }); }
            catch (JsonException) { throw new InvalidDataException("页级样式不是有效的 JSON。"); }

            using (document)
            {
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("页级样式最外层必须是 JSON 对象。");
                RejectUnknown(root, TopKeys, "页级样式");

                if (!root.TryGetProperty("schema", out var schema)
                    || schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var version))
                    throw new InvalidDataException("页级样式缺少整数 schema。");
                if (version is not (1 or 2)) throw new InvalidDataException("页级样式 schema 必须是 1 或 2。");

                if (!root.TryGetProperty("pages", out var pages) || pages.ValueKind != JsonValueKind.Object)
                    throw new InvalidDataException("页级样式缺少 pages 对象。");
                if (!pages.EnumerateObject().Any()) throw new InvalidDataException("页级样式没有声明任何页面。");

                var allowedKeys = version == 1 ? StyleKeysV1 : StyleKeysV2;
                var profile = new LauncherPageProfile();
                foreach (var page in pages.EnumerateObject())
                {
                    if (!IsKnownPage(page.Name))
                        throw new InvalidDataException("未知页面 ID：" + Safe(page.Name, 32) + "。");
                    if (page.Value.ValueKind != JsonValueKind.Object)
                        throw new InvalidDataException("页面 " + page.Name + " 的样式必须是对象。");
                    RejectUnknown(page.Value, allowedKeys, "页面 " + page.Name);

                    var style = new LauncherPageStyle();
                    var declared = false;
                    if (page.Value.TryGetProperty("density", out var density))
                    {
                        style.Density = Scale(density, page.Name + ".density");
                        style.HasDensity = true;
                        declared = true;
                    }
                    if (page.Value.TryGetProperty("fontScale", out var font))
                    {
                        style.FontScale = Scale(font, page.Name + ".fontScale");
                        style.HasFontScale = true;
                        declared = true;
                    }
                    if (page.Value.TryGetProperty("sections", out var sections))
                    {
                        if (sections.ValueKind != JsonValueKind.Array)
                            throw new InvalidDataException("页面 " + page.Name + ".sections 必须是数组。");
                        var orders = new HashSet<int>();
                        foreach (var item in sections.EnumerateArray())
                        {
                            if (item.ValueKind != JsonValueKind.Object)
                                throw new InvalidDataException("页面 " + page.Name + " 的区块必须是对象。");
                            RejectUnknown(item, SectionKeys, "页面 " + page.Name + " 的区块");
                            if (!item.TryGetProperty("id", out var idValue) || idValue.ValueKind != JsonValueKind.String
                                || !IsValidSectionId(idValue.GetString()))
                                throw new InvalidDataException("页面 " + page.Name + " 的区块 id 必须是 1–32 位小写字母、数字或短横线。");
                            var section = new LauncherPageSection { Id = idValue.GetString() };
                            if (item.TryGetProperty("visible", out var visible))
                            {
                                if (visible.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                                    throw new InvalidDataException("区块 " + section.Id + " 的 visible 必须是 true/false。");
                                section.Visible = visible.GetBoolean();
                            }
                            if (item.TryGetProperty("order", out var order))
                            {
                                if (order.ValueKind != JsonValueKind.Number || !order.TryGetInt32(out var position)
                                    || position < 0 || position > MaxOrder)
                                    throw new InvalidDataException("区块 " + section.Id + " 的 order 必须是 0 到 " + MaxOrder + " 的整数。");
                                if (!orders.Add(position))
                                    throw new InvalidDataException("页面 " + page.Name + " 的区块位置重复：" + position + "。");
                                section.Order = position;
                            }
                            if (style.Sections.Any(existing => existing.Id == section.Id))
                                throw new InvalidDataException("页面 " + page.Name + " 的区块 id 重复：" + section.Id + "。");
                            if (style.Sections.Count >= MaxSections)
                                throw new InvalidDataException("页面 " + page.Name + " 的区块数量超过 " + MaxSections + " 个上限。");
                            style.Sections.Add(section);
                            declared = true;
                        }
                    }
                    if (!declared) throw new InvalidDataException("页面 " + page.Name + " 没有声明任何样式。");
                    if (!profile.Pages.TryAdd(page.Name, style))
                        throw new InvalidDataException("页面 ID 重复：" + page.Name + "。");
                }
                return profile;
            }
        }

        internal static bool TryLoadFile(string path, out LauncherPageProfile profile, out string error)
        {
            profile = null;
            error = "";
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                {
                    error = "找不到这个页级样式文件。";
                    return false;
                }
                if (new FileInfo(path).Length > MaxBytes)
                {
                    error = "页级样式文件超过 32 KiB 上限。";
                    return false;
                }
                profile = Parse(File.ReadAllBytes(path));
                return true;
            }
            catch (Exception ex) when (ex is InvalidDataException or IOException or UnauthorizedAccessException)
            {
                error = ex is InvalidDataException && ex.Message.Length > 0 ? ex.Message : "页级样式读取失败：" + ex.Message;
                return false;
            }
            catch (NotSupportedException ex)
            {
                error = "这个文件读不了：" + ex.Message;
                return false;
            }
        }

        /// <summary>启动时读回上次保存的配置；文件坏 / 内容非法都只当没有，不影响默认外观。</summary>
        internal static LauncherPageProfile LoadActive(string path)
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

        /// <summary>原子写入规范化后的配置；失败只影响"记住这次选择"，不影响已生效的样式。</summary>
        internal static bool Save(string path, LauncherPageProfile profile)
        {
            if (profile == null) return false;
            var staging = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path) ?? AppContext.BaseDirectory);
                File.WriteAllBytes(staging, ToJsonBytes(profile));
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

        internal static byte[] ToJsonBytes(LauncherPageProfile profile)
        {
            // 只有样式时写 schema 1，让只认 v1 的旧启动器仍能读；
            // 一旦有区块配置才写 2（旧启动器会整包忽略，回默认外观）。
            var hasSections = profile.Pages.Values.Any(style => style.HasSections);
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true }))
            {
                writer.WriteStartObject();
                writer.WriteNumber("schema", hasSections ? SchemaVersion : 1);
                writer.WriteStartObject("pages");
                foreach (var id in PageIds)
                {
                    if (!profile.Pages.TryGetValue(id, out var style)) continue;
                    writer.WriteStartObject(id);
                    if (style.HasDensity) writer.WriteNumber("density", Math.Round(style.Density, 3));
                    if (style.HasFontScale) writer.WriteNumber("fontScale", Math.Round(style.FontScale, 3));
                    if (style.HasSections)
                    {
                        writer.WriteStartArray("sections");
                        foreach (var section in style.Sections)
                        {
                            writer.WriteStartObject();
                            writer.WriteString("id", section.Id);
                            if (!section.Visible) writer.WriteBoolean("visible", false);
                            if (section.Order.HasValue) writer.WriteNumber("order", section.Order.Value);
                            writer.WriteEndObject();
                        }
                        writer.WriteEndArray();
                    }
                    writer.WriteEndObject();
                }
                writer.WriteEndObject();
                writer.WriteEndObject();
            }
            return stream.ToArray();
        }

        /// <summary>区块 ID 与页面 ID 同一套语法：小写字母开头，只含小写字母/数字/短横线。</summary>
        internal static bool IsValidSectionId(string id)
        {
            if (string.IsNullOrEmpty(id) || id.Length > 32) return false;
            if (id[0] < 'a' || id[0] > 'z') return false;
            foreach (var ch in id)
                if (!(ch >= 'a' && ch <= 'z') && !(ch >= '0' && ch <= '9') && ch != '-') return false;
            return true;
        }

        private static void RejectUnknown(JsonElement element, string[] allowed, string where)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in element.EnumerateObject())
            {
                if (!allowed.Contains(field.Name, StringComparer.Ordinal))
                    throw new InvalidDataException(where + " 含不支持的字段：" + Safe(field.Name, 32));
                if (!seen.Add(field.Name)) throw new InvalidDataException(where + " 含重复字段：" + Safe(field.Name, 32));
            }
        }

        private static double Scale(JsonElement value, string field)
        {
            if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number)
                || double.IsNaN(number) || double.IsInfinity(number)
                || number < MinScale || number > MaxScale)
                throw new InvalidDataException(field + " 必须在 " + MinScale + " 到 " + MaxScale + " 之间。");
            return Math.Round(number, 3);
        }

        private static string Safe(string value, int max)
        {
            var builder = new StringBuilder();
            foreach (var ch in (value ?? "").Trim())
            {
                if (char.IsControl(ch) || ch is '\u061C' or '\u200E' or '\u200F'
                    || ch is >= '\u202A' and <= '\u202E' || ch is >= '\u2066' and <= '\u2069') continue;
                builder.Append(ch);
            }
            var text = builder.ToString().Trim();
            return text.Length > max ? text.Substring(0, max) : text;
        }
    }
}
