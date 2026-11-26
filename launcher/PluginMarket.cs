using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    internal sealed record PluginAppRange(
        [property: System.Text.Json.Serialization.JsonPropertyName("appEpoch")] int AppEpoch,
        [property: System.Text.Json.Serialization.JsonPropertyName("minAppVersion")] string MinAppVersion,
        [property: System.Text.Json.Serialization.JsonPropertyName("maxAppVersion")] string MaxAppVersion = null);

    internal sealed record PluginProvider(string Mode, string Scope, int? IntervalSeconds);

    internal sealed record PluginDisplayAsset(string Path, string Sha256, int Bytes);
    internal sealed record PluginDisplayImage(string Path, string Sha256, int Bytes, string Media);
    internal sealed record PluginDisplayDonation(string Afdian);
    internal sealed record PluginDisplayInfo(PluginDisplayAsset Readme, PluginDisplayImage[] Images,
        PluginDisplayDonation Donation, string UpdatedAt);
    internal sealed record PluginAssetResult(byte[] Bytes, string Error);

    internal sealed record PluginInfo(string Id, string Name, string Author, string Version, string MinAppVersion,
        string Description, string ResultLabel, int Api, string Download = null, string Sha256 = null, string Kind = "tool",
        string MaxAppVersion = null, int DiscussionIssue = 0, string HostAction = null,
        string[] Hooks = null, string[] Permissions = null, string Signature = null,
        int ExecutionTimeoutMs = 30000, int IntervalSeconds = 60,
        [property: System.Text.Json.Serialization.JsonPropertyName("appEpoch")] int AppEpoch = 0,
        [property: System.Text.Json.Serialization.JsonPropertyName("appCompatibility")] PluginAppRange[] AppCompatibility = null,
        Dictionary<string, PluginProvider> Provides = null, string[] Calls = null, JsonElement? SettingsSchema = null,
        int Level = 0, string[] DataAccess = null, PluginDisplayInfo Display = null,
        [property: System.Text.Json.Serialization.JsonPropertyName("compat")] string Compat = null)
    {
        internal bool IsPersona => Api == 1 && Kind == "persona";
        internal bool IsUnified => Api == 5 && Kind == "plugin" && Level is >= 1 and <= 4;
        internal bool IsTheme => Api == 5 && Kind == "theme" && Level == 0;
        internal bool RequiresFullAccess => IsUnified && Level == 4;
        internal bool RequiresChatAccess => IsUnified && Level == 3 && PluginMarket.DeclaresChatContent(Provides?.Keys);
        internal int EffectiveAppEpoch => AppEpoch == 0 ? 1 : AppEpoch;
        internal PluginAppRange[] AppRanges => AppCompatibility
            ?? [new(EffectiveAppEpoch, MinAppVersion, MaxAppVersion)];
        internal string CompatibilityLabel => string.Join("；", AppRanges.Select(range =>
            (range.AppEpoch == 2 ? "正式版 · " : "旧版 · ")
            + (string.IsNullOrEmpty(range.MaxAppVersion)
                ? $"鲸鲸 {range.MinAppVersion} 及以上" : $"鲸鲸 {range.MinAppVersion} – {range.MaxAppVersion}")));
    }
    internal sealed record PluginFeedback(int Comments, int Favorites = 0);
    internal sealed record MarketFavorite(string Id, long Count, bool Favorited);
    internal sealed record PluginPackage(PluginInfo Info, byte[] Module, string Prompt = null, string Persona = null, byte[] RawManifest = null, byte[] ThemeBytes = null);

    internal sealed class PluginMarket
    {
        private const string FavoritesUrl = "https://whalegirl-market-favorites.chrisgao0312.workers.dev/api/favorites";
        private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false });
        internal const string DigestAction = "chat.summary";
        /// <summary>主题包的完整校验入口（由启动器 Appearance 注入）；测试夹具没有启动器界面时为 null，只做包形状校验。</summary>
        internal static Func<byte[], string> ThemeValidator { get; set; }

        // 市场签名暂时隐藏：验签代码、内置公钥和签名工具都保留，恢复时把这里改成 true 即可。
        // 关闭时目录不再拉取 .sig、条目里的 Signature 只解析不校验，卡片也不显示签名状态，
        // 避免用户以为包已经验过；SHA-256、下载域名白名单和包内清单一致性照常检查。
        internal static readonly bool MarketSignatureEnabled = false;
        private static readonly JsonElement Registry = LoadRegistry();
        // 聊天内容类 provider：注册表里 dataAccess 含 current-message 的能力；名单不手抄。
        private static readonly HashSet<string> ChatContentProviders = LoadChatContentProviders();
        private static readonly int PackageLimit = Limit("maxPackageBytes");
        private static readonly UTF8Encoding StrictUtf8 = new(false, true);
        private static readonly JsonSerializerOptions ReadOptions = new() { PropertyNameCaseInsensitive = true };

        private readonly string _baseDir;
        private readonly string _root;

        internal PluginMarket(string baseDir)
        {
            _baseDir = baseDir;
            _root = Path.Combine(baseDir, "data", "plugins");
        }

        private void EnsureRoot()
        {
            var data = Directory.CreateDirectory(Path.GetDirectoryName(_root));
            if ((data.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("插件数据目录不能是链接");
            if ((Directory.CreateDirectory(_root).Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("插件目录不能是链接");
        }

        private static bool ValidId(string id) => Regex.IsMatch(id ?? "", @"\A[a-z][a-z0-9-]{0,47}\z")
            && !Regex.IsMatch(id, @"\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\z");

        /// <summary>展示前把换行、控制字符和双向文本标记压成空格，避免用清单字段伪造对话框。</summary>
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

        /// <summary>工具结果保留换行，但仍清掉控制字符和双向文本标记。</summary>
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

        internal static bool SameAuthor(string left, string right) =>
            string.Equals((left ?? "").Trim(), (right ?? "").Trim(), StringComparison.OrdinalIgnoreCase);

        internal static bool Compatible(PluginInfo info, string version, int appEpoch = 1) =>
            info != null && ValidAppRanges(info)
            && Version.TryParse(version, out var app)
            && info.AppRanges.Any(range => range.AppEpoch == (appEpoch == 0 ? 1 : appEpoch)
                && Version.TryParse(range.MinAppVersion, out var min) && app >= min
                && (string.IsNullOrEmpty(range.MaxAppVersion) || (Version.TryParse(range.MaxAppVersion, out var max) && app <= max)));

        private static bool ValidAppRanges(PluginInfo info) =>
            info.AppEpoch is >= 0 and <= 2
            && info.AppRanges is { Length: > 0 and <= 2 } ranges
            && ranges.All(range => range != null && range.AppEpoch is 1 or 2
                && Version.TryParse(range.MinAppVersion, out var min)
                && min >= (range.AppEpoch == 2 ? new Version(1, 0, 0)
                    : info.IsTheme ? new Version(4, 3, 0)
                    : info.IsUnified ? new Version(4, 1, 2) : new Version(0, 0))
                && (string.IsNullOrEmpty(range.MaxAppVersion)
                    || Version.TryParse(range.MaxAppVersion, out var max) && max >= min))
            && ranges.Select(range => range.AppEpoch).Distinct().Count() == ranges.Length;

        private static JsonElement LoadRegistry()
        {
            using var stream = typeof(PluginMarket).Assembly.GetManifestResourceStream("WhaleLauncher.PluginProtocolRegistry.json")
                ?? throw new InvalidOperationException("缺少插件协议注册表");
            using var json = JsonDocument.Parse(stream);
            return json.RootElement.Clone();
        }

        /// <summary>从内嵌注册表派生聊天内容类 provider：声明了它们就要确认聊天访问。</summary>
        private static HashSet<string> LoadChatContentProviders()
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            if (!Registry.TryGetProperty("providers", out var providers) || providers.ValueKind != JsonValueKind.Object) return set;
            foreach (var provider in providers.EnumerateObject())
            {
                if (!provider.Value.TryGetProperty("dataAccess", out var access) || access.ValueKind != JsonValueKind.Array) continue;
                if (access.EnumerateArray().Any(item => item.ValueKind == JsonValueKind.String && item.GetString() == "current-message"))
                    set.Add(provider.Name);
            }
            return set;
        }

        internal static bool DeclaresChatContent(IEnumerable<string> names) => names != null && ChatContentProviders.Overlaps(names);

        private static int Limit(string key) => Registry.GetProperty("limits").GetProperty(key).GetInt32();
        private static string ProtocolFile(string key) => Registry.GetProperty("files").GetProperty(key).GetString();
        private static JsonElement LevelPolicy(int level) => Registry.GetProperty("levels").GetProperty(level.ToString(System.Globalization.CultureInfo.InvariantCulture));
        internal static string LevelName(int level) => Registry.GetProperty("levelNames").TryGetProperty(
            level.ToString(System.Globalization.CultureInfo.InvariantCulture), out var name) ? name.GetString() : null;
        private static string EntryFile(PluginInfo info) => Text(LevelPolicy(info.Level), "entry");
        private static bool Fields(JsonElement value, IEnumerable<string> allowed)
        {
            if (value.ValueKind != JsonValueKind.Object) return false;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            return value.EnumerateObject().All(field => allowed.Contains(field.Name, StringComparer.Ordinal) && seen.Add(field.Name));
        }
        private static string Text(JsonElement value, string key) =>
            value.TryGetProperty(key, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() : null;
        private static bool Contains(JsonElement array, string value) => array.EnumerateArray().Any(item => item.GetString() == value);
        private static bool Metadata(PluginInfo info) => ValidId(info.Id)
            && Version.TryParse(info.Version, out _) && Version.TryParse(info.MinAppVersion, out _)
            && ValidAppRanges(info) && info.DiscussionIssue >= 0
            && info.Name?.Trim().Length is > 0 and <= 80 && SafeText(info.Name, 80).Length > 0
            && info.Author?.Trim().Length is > 0 and <= 80 && SafeText(info.Author, 80).Length > 0
            && info.Description?.Length is <= 600
            && (string.IsNullOrEmpty(info.MaxAppVersion) || (Version.TryParse(info.MaxAppVersion, out var max)
                && max >= Version.Parse(info.MinAppVersion)));

        internal static bool Valid(PluginInfo info) => info != null && info.IsPersona && Metadata(info)
            && info.Hooks == null && info.Permissions == null
            && info.Provides == null && info.Calls == null && info.SettingsSchema == null;

        /// <summary>爱发电个人页：只接受 https://afdian.com/a/&lt;id&gt;，返回规范化地址；其它一律 null。</summary>
        internal static string AfdianPersonalPage(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)) return null;
            if (uri.Scheme != Uri.UriSchemeHttps || uri.Host != "afdian.com" || !uri.IsDefaultPort
                || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0) return null;
            if (!Regex.IsMatch(uri.AbsolutePath, @"\A/a/[A-Za-z0-9_-]{1,64}/?\z")) return null;
            return "https://afdian.com" + uri.AbsolutePath.TrimEnd('/');
        }

        private static readonly Regex Sha256Pattern = new(@"\A[0-9a-fA-F]{64}\z", RegexOptions.Compiled);

        internal static bool ValidDisplayPath(string path, string extension)
        {
            if (string.IsNullOrWhiteSpace(path) || path.StartsWith("/", StringComparison.Ordinal)
                || path.Contains('\\') || path.Contains("..", StringComparison.Ordinal)
                || !path.StartsWith("plugins/", StringComparison.Ordinal)) return false;
            var segments = path.Split('/');
            if (segments.Any(segment => segment.Length == 0 || segment == ".")) return false;
            return string.Equals(Path.GetExtension(path), extension, StringComparison.OrdinalIgnoreCase);
        }

        internal static bool ValidDisplayAsset(PluginDisplayAsset asset, int limit)
        {
            return asset != null && ValidDisplayPath(asset.Path, ".md") && asset.Bytes is > 0 and <= 64 * 1024
                && asset.Bytes <= limit && Sha256Pattern.IsMatch(asset.Sha256 ?? "");
        }

        internal static bool ValidDisplayImage(PluginDisplayImage image, int limit)
        {
            if (image == null || image.Bytes is <= 0 || image.Bytes > limit
                || !Sha256Pattern.IsMatch(image.Sha256 ?? "") || !ValidDisplayPath(image.Path, Path.GetExtension(image.Path) ?? ""))
                return false;
            var extension = Path.GetExtension(image.Path).ToLowerInvariant();
            var media = extension switch
            {
                ".png" => "image/png",
                ".jpg" or ".jpeg" => "image/jpeg",
                ".gif" => "image/gif",
                _ => null,
            };
            return media != null && string.Equals(image.Media, media, StringComparison.Ordinal);
        }

        internal static bool ValidDisplay(PluginDisplayInfo display)
        {
            if (display == null) return true;
            if (display.Readme != null && !ValidDisplayAsset(display.Readme, 64 * 1024)) return false;
            if (display.Images is { Length: > 8 }) return false;
            if (display.Images != null)
            {
                var paths = new HashSet<string>(StringComparer.Ordinal);
                foreach (var image in display.Images)
                {
                    if (!ValidDisplayImage(image, 2 * 1024 * 1024)) return false;
                    if (!paths.Add(image.Path)) return false;
                }
            }
            if (display.Donation != null && AfdianPersonalPage(display.Donation.Afdian) == null) return false;
            if (display.UpdatedAt != null
                && !DateTime.TryParseExact(display.UpdatedAt, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.None, out _)) return false;
            return true;
        }

        /// <summary>目录展示校验：v5 条目只校验展示/包定位；包清单一律走 ReadPackage，安装仍是严格路径。</summary>
        internal static bool ValidCatalog(PluginInfo info)
        {
            if (info == null) return false;
            if (info.IsPersona) return Valid(info);
            if (!info.IsUnified && !info.IsTheme) return false;
            return Metadata(info)
                && info.Level is >= 0 and <= 4
                && !string.IsNullOrWhiteSpace(info.Download)
                && Sha256Pattern.IsMatch(info.Sha256 ?? "")
                && (info.IsTheme
                    ? info.Provides.Count == 0 && info.Calls.Length == 0
                    : info.Provides.Count > 0)
                && ValidDisplay(info.Display);
        }

        internal static PluginInfo ParseUnified(JsonElement manifest)
        {
            var failure = new InvalidDataException("统一插件清单无效，或声明了未开放的能力、作用域或调用");
            var manifestPolicy = Registry.GetProperty("manifest");
            if (!Fields(manifest, manifestPolicy.GetProperty("allowed").EnumerateArray().Select(item => item.GetString()))
                || manifestPolicy.GetProperty("required").EnumerateArray().Any(field => !manifest.TryGetProperty(field.GetString(), out _))
                || Text(manifest, "format") != Registry.GetProperty("format").GetString()
                || !manifest.TryGetProperty("level", out var levelValue) || levelValue.ValueKind != JsonValueKind.Number
                || !levelValue.TryGetInt32(out var level) || level is < 0 or > 4
                || Text(manifest, "runtime") != Text(LevelPolicy(level), "runtime")
                || Text(manifest, "entry") != Text(LevelPolicy(level), "entry")
                || !manifest.TryGetProperty("provides", out var declared) || declared.ValueKind != JsonValueKind.Object
                || !manifest.TryGetProperty("calls", out var callList) || callList.ValueKind != JsonValueKind.Array)
                throw failure;
            var themePackage = level == 0;
            var levelPolicy = LevelPolicy(level);
            var provides = new Dictionary<string, PluginProvider>(StringComparer.Ordinal);
            var providers = Registry.GetProperty("providers");
            foreach (var field in declared.EnumerateObject())
            {
                if (!Contains(levelPolicy.GetProperty("providers"), field.Name)
                    || !providers.TryGetProperty(field.Name, out var rule)
                    || !Fields(field.Value, ["mode", "scope", "intervalSeconds"])) throw failure;
                var mode = Text(field.Value, "mode");
                var scope = Text(field.Value, "scope");
                if (!Contains(rule.GetProperty("modes"), mode) || !Contains(rule.GetProperty("scopes"), scope)) throw failure;
                int? interval = null;
                var requiresInterval = rule.TryGetProperty("intervalSeconds", out var range);
                var hasInterval = field.Value.TryGetProperty("intervalSeconds", out var value);
                if (requiresInterval != hasInterval) throw failure;
                if (requiresInterval)
                {
                    if (value.ValueKind != JsonValueKind.Number
                        || !value.TryGetInt32(out var seconds) || seconds < range.GetProperty("min").GetInt32()
                        || seconds > range.GetProperty("max").GetInt32()) throw failure;
                    interval = seconds;
                }
                if (!provides.TryAdd(field.Name, new(mode, scope, interval))) throw failure;
            }
            if (themePackage ? provides.Count != 0 : provides.Count == 0) throw failure;
            var calls = new List<string>();
            foreach (var call in callList.EnumerateArray())
            {
                if (call.ValueKind != JsonValueKind.String || !Registry.GetProperty("calls").TryGetProperty(call.GetString(), out _)
                    || !Contains(levelPolicy.GetProperty("calls"), call.GetString())
                    || calls.Contains(call.GetString(), StringComparer.Ordinal)) throw failure;
                calls.Add(call.GetString());
            }
            var timeout = 30000;
            if (manifest.TryGetProperty("executionTimeoutMs", out var timeoutValue)
                && (timeoutValue.ValueKind != JsonValueKind.Number || !timeoutValue.TryGetInt32(out timeout)
                    || timeout < Limit("minExecutionTimeoutMs") || timeout > Limit("maxExecutionTimeoutMs"))) throw failure;
            JsonElement? schema = null;
            if (manifest.TryGetProperty("settingsSchema", out var settingsSchema))
            {
                if (themePackage) throw failure;
                if (settingsSchema.ValueKind != JsonValueKind.Object || Text(settingsSchema, "type") != "object"
                    || !ValidSchema(settingsSchema, 0)) throw failure;
                schema = settingsSchema.Clone();
            }
            var appEpoch = 0;
            if (manifest.TryGetProperty("appEpoch", out var epoch) && (epoch.ValueKind != JsonValueKind.Number
                || !epoch.TryGetInt32(out appEpoch) || appEpoch is not (1 or 2))) throw failure;
            PluginAppRange[] ranges = null;
            if (manifest.TryGetProperty("appCompatibility", out var compatibility))
            {
                if (compatibility.ValueKind != JsonValueKind.Array || compatibility.GetArrayLength() is < 1 or > 2) throw failure;
                ranges = compatibility.EnumerateArray().Select(range =>
                {
                    if (!Fields(range, ["appEpoch", "minAppVersion", "maxAppVersion"])
                        || !range.TryGetProperty("appEpoch", out var rangeEpoch) || rangeEpoch.ValueKind != JsonValueKind.Number
                        || !rangeEpoch.TryGetInt32(out var generation) || generation is not (1 or 2)
                        || Text(range, "minAppVersion") is not string min
                        || range.TryGetProperty("maxAppVersion", out var maximum) && maximum.ValueKind != JsonValueKind.String) throw failure;
                    return new PluginAppRange(generation, min, Text(range, "maxAppVersion"));
                }).ToArray();
            }
            if (manifest.TryGetProperty("maxAppVersion", out var maxVersion) && maxVersion.ValueKind != JsonValueKind.String)
                throw failure;
            var dataAccess = new List<string>();
            if (manifest.TryGetProperty("dataAccess", out var dataList))
            {
                if (dataList.ValueKind != JsonValueKind.Array || !DeclaresChatContent(provides.Keys)
                    || !levelPolicy.TryGetProperty("dataAccess", out var allowedData)) throw failure;
                foreach (var item in dataList.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.String || !Contains(allowedData, item.GetString())
                        || dataAccess.Contains(item.GetString(), StringComparer.Ordinal)) throw failure;
                    dataAccess.Add(item.GetString());
                }
            }
            // compat 只改变 3 级 Wasm 的输入信封与 whale 导入别名，不改变能力授权、调用白名单或输出校验；
            // 合法值/等级/运行时只认注册表 manifest.compat 这一份策略，不在启动器里另抄枚举。
            // 旧信封只认识 compat.hooks 登记过的那几个 provider，声明了映射不到的 provider
            // （如 tool.run@1）会安装成功、第一次派发才撞 invalid_wasm_compat，所以这里就拒绝。
            // 未声明 compat 的旧包 Compat 保持 null，安装与授权语义不变。
            string compat = null;
            if (manifest.TryGetProperty("compat", out var compatValue))
            {
                var compatPolicy = manifestPolicy.GetProperty("compat");
                var compatLevels = compatPolicy.GetProperty("levels").EnumerateArray().Any(item =>
                    item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out var allowed) && allowed == level);
                var compatHooks = compatPolicy.GetProperty("hooks");
                if (compatValue.ValueKind != JsonValueKind.String
                    || !Contains(compatPolicy.GetProperty("values"), compatValue.GetString())
                    || !compatLevels || Text(manifest, "runtime") != Text(compatPolicy, "runtime")
                    || !provides.Keys.All(name => compatHooks.TryGetProperty(name, out _))) throw failure;
                compat = compatValue.GetString();
            }
            var info = new PluginInfo(Text(manifest, "id"), Text(manifest, "name"), Text(manifest, "author"),
                Text(manifest, "version"), Text(manifest, "minAppVersion"), Text(manifest, "description"), null, 5,
                Kind: themePackage ? "theme" : "plugin", MaxAppVersion: Text(manifest, "maxAppVersion"), ExecutionTimeoutMs: timeout,
                AppEpoch: appEpoch, AppCompatibility: ranges,
                Provides: provides, Calls: calls.ToArray(), SettingsSchema: schema, Level: level,
                DataAccess: dataAccess.ToArray(), Compat: compat);
            if (!Metadata(info)) throw failure;
            return info;
        }

        private static bool ValidSchema(JsonElement schema, int depth)
        {
            var policy = Registry.GetProperty("settingsSchema");
            if (depth >= policy.GetProperty("maxDepth").GetInt32()
                || !Fields(schema, policy.GetProperty("supportedKeywords").EnumerateArray().Select(item => item.GetString()))
                || !ValidAnnotations(schema, policy)) return false;
            var type = Text(schema, "type");
            if (!Contains(policy.GetProperty("allowedTypes"), type)) return false;
            if (schema.TryGetProperty("properties", out var properties))
            {
                if (type != "object" || properties.ValueKind != JsonValueKind.Object) return false;
                var names = new HashSet<string>(StringComparer.Ordinal);
                if (properties.EnumerateObject().Any(field => !names.Add(field.Name) || !ValidSchema(field.Value, depth + 1))) return false;
            }
            if (schema.TryGetProperty("required", out var required))
            {
                if (type != "object" || required.ValueKind != JsonValueKind.Array) return false;
                var names = new HashSet<string>(StringComparer.Ordinal);
                if (required.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String || !names.Add(item.GetString()))) return false;
            }
            if (schema.TryGetProperty("additionalProperties", out var additional)
                && (type != "object" || additional.ValueKind is not (JsonValueKind.True or JsonValueKind.False))) return false;
            if (!SchemaRange(schema, "minimum", "maximum", type is "integer" or "number", false)
                || !SchemaRange(schema, "minLength", "maxLength", type == "string", true)) return false;
            if (schema.TryGetProperty("enum", out var choices) && (choices.ValueKind != JsonValueKind.Array
                || choices.GetArrayLength() == 0 || choices.EnumerateArray().Any(item => !MatchesType(item, type)))) return false;
            return true;
        }

        /// <summary>
        /// settingsSchema 的展示注解：长度与控制字符范围来自嵌入的共享注册表，
        /// 与 Node 运行时 / 作者 CLI 保持同一策略；注解只影响展示。
        /// </summary>
        private static bool ValidAnnotations(JsonElement schema, JsonElement policy)
        {
            if (!policy.TryGetProperty("annotations", out var annotations) || annotations.ValueKind != JsonValueKind.Object
                || !annotations.TryGetProperty("forbiddenRanges", out var forbidden) || forbidden.ValueKind != JsonValueKind.Array)
                return false;
            var ranges = new List<(int Low, int High)>();
            foreach (var range in forbidden.EnumerateArray())
            {
                if (range.ValueKind != JsonValueKind.Array || range.GetArrayLength() != 2
                    || !range[0].TryGetInt32(out var low) || !range[1].TryGetInt32(out var high) || low > high) return false;
                ranges.Add((low, high));
            }
            foreach (var name in new[] { "title", "description" })
            {
                if (!schema.TryGetProperty(name, out var value)) continue;
                if (value.ValueKind != JsonValueKind.String) return false;
                var text = value.GetString() ?? "";
                if (name == "title" && string.IsNullOrWhiteSpace(text)) return false;
                if (!annotations.TryGetProperty(name, out var limit) || limit.ValueKind != JsonValueKind.Number
                    || !limit.TryGetInt32(out var max) || max < 0) return false;
                var count = 0;
                foreach (var rune in text.EnumerateRunes())
                {
                    count++;
                    if (ranges.Any(range => rune.Value >= range.Low && rune.Value <= range.High)) return false;
                }
                if (count > max) return false;
            }
            return true;
        }

        private static bool SchemaRange(JsonElement schema, string min, string max, bool allowed, bool length)
        {
            var hasMin = schema.TryGetProperty(min, out var lower);
            var hasMax = schema.TryGetProperty(max, out var upper);
            bool ValidBound(JsonElement value) => value.ValueKind == JsonValueKind.Number && double.IsFinite(value.GetDouble())
                && (!length || value.TryGetInt32(out var count) && count >= 0);
            return (!hasMin && !hasMax) || allowed && (!hasMin || ValidBound(lower)) && (!hasMax || ValidBound(upper))
                && (!hasMin || !hasMax || lower.GetDouble() <= upper.GetDouble());
        }

        private static bool MatchesType(JsonElement value, string type) => type switch
        {
            "object" => value.ValueKind == JsonValueKind.Object,
            "string" => value.ValueKind == JsonValueKind.String,
            "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
            "integer" => value.ValueKind == JsonValueKind.Number && double.IsFinite(value.GetDouble()) && Math.Truncate(value.GetDouble()) == value.GetDouble(),
            "number" => value.ValueKind == JsonValueKind.Number && double.IsFinite(value.GetDouble()),
            _ => false
        };

        private static bool MatchesSchema(JsonElement value, JsonElement schema)
        {
            var type = Text(schema, "type");
            if (!MatchesType(value, type)) return false;
            if (schema.TryGetProperty("enum", out var choices)
                && !choices.EnumerateArray().Any(item => JsonElement.DeepEquals(item, value))) return false;
            if (type == "object")
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                var hasProps = schema.TryGetProperty("properties", out var props);
                var allowExtra = !schema.TryGetProperty("additionalProperties", out var extra) || extra.GetBoolean();
                foreach (var field in value.EnumerateObject())
                    if (!seen.Add(field.Name) || (hasProps && props.TryGetProperty(field.Name, out var fieldSchema)
                        ? !MatchesSchema(field.Value, fieldSchema) : !allowExtra)) return false;
                return !schema.TryGetProperty("required", out var required) || required.EnumerateArray().All(item => seen.Contains(item.GetString()));
            }
            var lower = type == "string" ? "minLength" : "minimum";
            var upper = type == "string" ? "maxLength" : "maximum";
            var number = type == "string" ? value.GetString().EnumerateRunes().Count() : type is "integer" or "number" ? value.GetDouble() : 0;
            return (!schema.TryGetProperty(lower, out var min) || number >= min.GetDouble())
                && (!schema.TryGetProperty(upper, out var max) || number <= max.GetDouble());
        }

        internal static PluginPackage ReadPackage(byte[] bytes)
        {
            if (bytes.Length > PackageLimit) throw new InvalidDataException("插件包超过 16 MiB");
            using var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
            if (zip.Entries.Count != 2 || zip.GetEntry("plugin.json") is not { } manifest)
                throw new InvalidDataException("ZIP 根目录必须包含 plugin.json 和一个插件文件");
            if (zip.Entries.Any(entry => ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000))
                throw new InvalidDataException("插件包不得包含符号链接");
            using var metadata = manifest.Open();
            var raw = ReadLimited(metadata, Limit("maxManifestBytes"));
            using var json = JsonDocument.Parse(raw);
            if (json.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException("插件清单必须为 JSON 对象");
            if (json.RootElement.TryGetProperty("format", out _))
            {
                var info = ParseUnified(json.RootElement);
                var filename = EntryFile(info);
                using var entry = (zip.GetEntry(filename) ?? throw new InvalidDataException($"该等级需要 {filename}")).Open();
                var source = ReadLimited(entry, LevelPolicy(info.Level).GetProperty("maxEntryBytes").GetInt32());
                if (info.IsTheme)
                {
                    if (ThemeValidator != null)
                    {
                        try
                        {
                            if (!string.Equals(ThemeValidator(source), info.Id, StringComparison.Ordinal))
                                throw new InvalidDataException("theme.json 的 id 必须与插件清单 id 一致");
                        }
                        catch (InvalidDataException ex) { throw new InvalidDataException("主题包无效：" + ex.Message); }
                    }
                    // 启动器只校验包形状与 JSON 对象/id 一致性；完整 token/对比度由 Appearance 在启用时校验。
                    try
                    {
                        using var themeJson = JsonDocument.Parse(source);
                        if (themeJson.RootElement.ValueKind != JsonValueKind.Object
                            || !themeJson.RootElement.TryGetProperty("schema", out var schemaValue)
                            || schemaValue.ValueKind != JsonValueKind.Number || schemaValue.GetInt32() != 1
                            || Text(themeJson.RootElement, "id") != info.Id) throw new InvalidDataException("theme.json 无效或 id 不一致");
                    }
                    catch (JsonException) { throw new InvalidDataException("theme.json 必须是合法 JSON 对象"); }
                    return new PluginPackage(info, source, RawManifest: raw, ThemeBytes: source);
                }
                if (info.RequiresFullAccess)
                {
                    try
                    {
                        if (string.IsNullOrWhiteSpace(StrictUtf8.GetString(source))) throw new InvalidDataException("plugin.js 不能为空");
                    }
                    catch (DecoderFallbackException) { throw new InvalidDataException("plugin.js 必须为 UTF-8"); }
                }
                else if (!source.AsSpan().StartsWith(new byte[] { 0, 97, 115, 109, 1, 0, 0, 0 }))
                    throw new InvalidDataException("plugin.wasm 必须具有有效的 WebAssembly v1 文件头");
                return new PluginPackage(info, source, RawManifest: raw);
            }
            var persona = json.RootElement.Deserialize<PluginInfo>(ReadOptions);
            if (!Valid(persona)) throw new InvalidDataException("人设包清单无效");
            if (raw.Length > 8192 || bytes.Length > 1024 * 1024) throw new InvalidDataException("人设包超过大小限制");
            using var preset = (zip.GetEntry("persona.json") ?? throw new InvalidDataException("人设包需要 persona.json")).Open();
            using var data = JsonDocument.Parse(ReadLimited(preset, 192 * 1024));
            var document = PersonaPackage.Read(data.RootElement);
            return new PluginPackage(persona, null, (string)document["customPrompt"], JsonSerializer.Serialize(document));
        }

        private static byte[] ReadLimited(Stream stream, int limit)
        {
            using var output = new MemoryStream();
            var buffer = new byte[8192];
            int count;
            while ((count = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                if (output.Length + count > limit) throw new InvalidDataException("插件文件超过大小限制");
                output.Write(buffer, 0, count);
            }
            return output.ToArray();
        }

        internal static PluginPackage ValidateLocal(string file, string version, int appEpoch = 1)
        {
            var package = ReadPackage(ReadFile(file));
            if (!Compatible(package.Info, version, appEpoch))
                throw new InvalidDataException("插件适用的鲸鲸版本体系或版本范围与当前客户端不兼容");
            return package;
        }

        internal static string DocumentUrl(string id, bool tutorial)
        {
            if (!ValidId(id)) throw new InvalidDataException("插件 ID 无效");
            var filename = tutorial ? "GUIDE.md" : "README.md";
            return $"https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/plugins/{id}/{filename}";
        }

        internal static async Task<string> ReadDocumentAsync(string id, bool tutorial)
        {
            try
            {
                var bytes = await PluginCatalog.DownloadAsync(DocumentUrl(id, tutorial), 64 * 1024,
                    stopOnNotFound: true);
                return SafeMultiline(new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF'));
            }
            catch (PluginCatalog.DownloadMissingException) { return null; }
            catch (DecoderFallbackException) { throw new InvalidDataException("文档须使用 UTF-8"); }
        }

        internal async Task<Dictionary<string, MarketFavorite>> FavoritesAsync(IEnumerable<string> ids)
        {
            var favorites = new Dictionary<string, MarketFavorite>(StringComparer.Ordinal);
            foreach (var batch in ids.Where(ValidId).Distinct().Chunk(64))
            {
                using var request = new HttpRequestMessage(HttpMethod.Get,
                    FavoritesUrl + "?ids=" + Uri.EscapeDataString(string.Join(",", batch)));
                var states = await SendFavoriteRequest(request);
                foreach (var id in batch)
                {
                    if (!states.TryGetValue(id, out var state)) throw new InvalidDataException("收藏统计缺少插件数据");
                    favorites.Add(id, state);
                }
            }
            return favorites;
        }

        internal async Task<MarketFavorite> SetFavoriteAsync(string id, bool favorited)
        {
            if (!ValidId(id)) throw new InvalidDataException("插件 ID 无效");
            using var request = new HttpRequestMessage(HttpMethod.Put, FavoritesUrl)
            {
                Content = new StringContent(JsonSerializer.Serialize(new { id, favorited }), Encoding.UTF8, "application/json")
            };
            var states = await SendFavoriteRequest(request);
            if (!states.TryGetValue(id, out var state) || state.Favorited != favorited)
                throw new InvalidDataException("未收到收藏确认");
            return state;
        }

        private async Task<Dictionary<string, MarketFavorite>> SendFavoriteRequest(HttpRequestMessage request)
        {
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", FavoriteInstallationKey());
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode) throw new HttpRequestException("暂时无法连接收藏服务，请稍后重试");
            await response.Content.LoadIntoBufferAsync(32 * 1024, timeout.Token);
            return ParseFavoriteStates(await response.Content.ReadAsByteArrayAsync(timeout.Token));
        }

        internal static Dictionary<string, MarketFavorite> ParseFavoriteStates(byte[] json)
        {
            using var payload = JsonDocument.Parse(json);
            var states = new Dictionary<string, MarketFavorite>(StringComparer.Ordinal);
            foreach (var item in payload.RootElement.GetProperty("favorites").EnumerateArray())
            {
                var id = item.GetProperty("id").GetString();
                var count = item.GetProperty("count").GetInt64();
                var favorited = item.GetProperty("favorited").GetBoolean();
                if (!ValidId(id) || count < 0 || (favorited && count == 0) || !states.TryAdd(id, new(id, count, favorited)))
                    throw new InvalidDataException("收藏统计格式无效");
            }
            return states;
        }

        private string FavoriteInstallationKey()
        {
            EnsureRoot();
            var file = FileFor("market-favorites", ".key");
            if (!File.Exists(file))
            {
                var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    File.WriteAllText(temporary, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)));
                    try { File.Move(temporary, file); }
                    catch (IOException) when (File.Exists(file)) { }
                }
                finally { File.Delete(temporary); }
            }
            var key = File.ReadAllText(FileFor("market-favorites", ".key"));
            if (!Regex.IsMatch(key, @"\A[0-9a-f]{64}\z")) throw new InvalidDataException("本地收藏凭据无效");
            return key;
        }

        private string FileFor(string id, string suffix)
        {
            if (!ValidId(id)) throw new InvalidDataException("插件 ID 无效");
            var path = Path.Combine(_root, id + suffix);
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("插件文件不能是链接");
            return path;
        }

        private static byte[] ReadFile(string path)
        {
            using var stream = File.OpenRead(path);
            return ReadLimited(stream, PackageLimit);
        }

        internal PluginInfo[] Installed()
        {
            EnsureRoot();
            var installed = new List<PluginInfo>();
            foreach (var path in Directory.EnumerateFiles(_root, "*.zip"))
            {
                try
                {
                    var id = Path.GetFileNameWithoutExtension(path);
                    var bytes = ReadFile(FileFor(id, ".zip"));
                    var info = ReadInstalledInfo(bytes);
                    if (info.Id == id) installed.Add(info);
                }
                catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException) { }
            }
            return installed.OrderBy(i => i.Name).ToArray();
        }

        private static string Digest(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        private const string SettingsFilename = "settings.json";

        private string InstallDirectory(string id)
        {
            var path = FileFor(id, "");
            if (Path.Exists(path) && (!Directory.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0))
                throw new IOException("插件安装目录必须是普通目录");
            return path;
        }

        private string InstallFile(string id, string filename)
        {
            var path = Path.Combine(InstallDirectory(id), filename);
            if (Path.Exists(path) && (!File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0))
                throw new IOException("插件数据文件不能是链接或目录");
            return path;
        }

        private static PluginInfo ReadInstalledInfo(byte[] bytes)
        {
            try { return ReadPackage(bytes).Info; }
            catch (InvalidDataException)
            {
                using var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
                using var entry = (zip.GetEntry("plugin.json") ?? throw new InvalidDataException("缺少清单")).Open();
                var info = JsonSerializer.Deserialize<PluginInfo>(ReadLimited(entry, 8192), ReadOptions);
                if (info?.Api is < 1 or > 4 || info?.Kind == "persona" || info == null || !Metadata(info)) throw;
                return info;
            }
        }

        private void Revoke(string id)
        {
            var grant = InstallFile(id, ProtocolFile("grant"));
            if (File.Exists(grant)) File.Delete(grant);
            File.Delete(FileFor(id, ".flow-grant.json"));
            File.Delete(FileFor(id, ".enabled"));
            File.Delete(FileFor(id, ".persona.json"));
        }

        internal bool Enabled(string id)
        {
            EnsureRoot();
            if (File.Exists(FileFor(id, ".persona.json"))) return true;
            try
            {
                var grant = InstallFile(id, ProtocolFile("grant"));
                if (!File.Exists(grant)) return false;
                var archive = ReadFile(FileFor(id, ".zip"));
                var installed = ReadPackage(archive);
                if (!installed.Info.IsUnified || installed.Info.Id != id) return false;
                using var parsed = JsonDocument.Parse(ReadFile(grant));
                return GrantMatches(id, parsed.RootElement, installed, archive);
            }
            catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException) { return false; }
        }

        private bool DeploymentMatches(string id, PluginPackage installed) =>
            ReadFile(InstallFile(id, ProtocolFile("manifest"))).AsSpan().SequenceEqual(installed.RawManifest)
            && ReadFile(InstallFile(id, EntryFile(installed.Info))).AsSpan().SequenceEqual(installed.Module);

        private bool GrantMatches(string id, JsonElement grant, PluginPackage installed, byte[] archive)
        {
            if (grant.ValueKind != JsonValueKind.Object) return false;
            bool Flag(string name, bool expected) => grant.TryGetProperty(name, out var value)
                && value.ValueKind == (expected ? JsonValueKind.True : JsonValueKind.False);
            return grant.TryGetProperty("level", out var level) && level.ValueKind == JsonValueKind.Number
                && level.TryGetInt32(out var grantedLevel) && grantedLevel == installed.Info.Level
                && Flag("enabled", true) && Flag("fullAccess", installed.Info.RequiresFullAccess)
                && Flag("nodeFullConfirmed", installed.Info.RequiresFullAccess)
                && Flag("chatConfirmed", installed.Info.RequiresChatAccess)
                && DataAccessMatches(grant, installed.Info)
                && Guid.TryParseExact(Text(grant, "epoch"), "D", out _)
                && Text(grant, "packageHash") == Digest(archive)
                && Text(grant, "manifestHash") == Digest(installed.RawManifest)
                && Text(grant, "entryHash") == Digest(installed.Module)
                && DeploymentMatches(id, installed);
        }

        private static bool DataAccessMatches(JsonElement grant, PluginInfo info)
        {
            var expected = info.DataAccess ?? Array.Empty<string>();
            if (!grant.TryGetProperty("approvedDataAccess", out var value) || value.ValueKind != JsonValueKind.Array) return expected.Length == 0;
            var actual = value.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString()).ToArray();
            return actual.Length == expected.Length && expected.All(name => actual.Contains(name, StringComparer.Ordinal));
        }

        internal void SetEnabled(string id, bool enabled, bool fullAccessApproved = false, bool chatAccessApproved = false)
        {
            EnsureRoot();
            if (!enabled) { Revoke(id); return; }
            var archive = ReadFile(FileFor(id, ".zip"));
            var package = ReadPackage(archive);
            if (package.Info.Id != id || !Compatible(package.Info, UpdateManifestService.LocalVersion(_baseDir), UpdateManifestService.LocalEpoch(_baseDir)))
                throw new InvalidDataException("插件标识或兼容版本无效");
            if (package.Info.IsPersona)
            {
                using var json = JsonDocument.Parse(package.Persona);
                var document = PersonaPackage.Read(json.RootElement);
                document["name"] = package.Info.Name;
                document["description"] = package.Info.Description;
                document["version"] = package.Info.Version;
                WriteAtomically(FileFor(id, ".persona.json"), JsonSerializer.SerializeToUtf8Bytes(document));
                return;
            }
            if (package.Info.RequiresFullAccess && !fullAccessApproved)
                throw new InvalidDataException("启动此插件需要明确确认完整系统权限");
            if (package.Info.RequiresChatAccess && !chatAccessApproved)
                throw new InvalidDataException("启动此插件需要明确确认聊天数据访问");
            if (package.Info.IsTheme)
                throw new InvalidDataException("纯数据主题不需要授权，请在插件卡片启用");
            if (!DeploymentMatches(id, package)) throw new InvalidDataException("已安装文件与原始插件包不一致，请重新安装");
            using var settings = ParseSettings(package.Info, MessageSettings(id));
            SaveGrant(id, package, archive, settings.RootElement);
        }

        internal void Uninstall(string id)
        {
            SetEnabled(id, false);
            File.Delete(FileFor(id, ".zip"));
            File.Delete(FileFor(id, ".flow.json"));
            DeleteLegacyPluginData(id);
            var install = InstallDirectory(id);
            if (!Directory.Exists(install)) return;
            File.Delete(InstallFile(id, ProtocolFile("manifest")));
            foreach (var entry in Registry.GetProperty("levels").EnumerateObject().Select(pair => Text(pair.Value, "entry")).Distinct())
                File.Delete(InstallFile(id, entry));
            File.Delete(InstallFile(id, SettingsFilename));
            // 插件拥有完整权限；不递归清除插件可控制的路径，避免删除链接目标或用户文件。
        }

        private void DeleteLegacyPluginData(string id)
        {
            File.Delete(FileFor(id, ".flow-settings.json"));
            foreach (var pattern in new[] { id + ".*.state.json", id + ".*.state.json.*.tmp" })
            {
                foreach (var file in Directory.EnumerateFiles(_root, pattern))
                {
                    try { File.Delete(file); }
                    catch (IOException) { }
                }
            }
        }

        internal async Task InstallAsync(PluginInfo listing)
        {
            var bytes = await PluginCatalog.DownloadAsync(listing.Download, PackageLimit);
            // 签名暂时隐藏：恢复 MarketSignatureEnabled 后，条目里带了 Signature 就必须验过。
            if (MarketSignatureEnabled && !string.IsNullOrWhiteSpace(listing.Signature) && !PluginTrust.Verify(bytes, listing.Signature))
                throw new InvalidDataException("插件包签名无效，已拒绝安装");
            if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(listing.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("插件包校验失败");
            var info = ReadPackage(bytes).Info;
            if (!SameListing(listing, info)) throw new InvalidDataException("插件清单与市场目录不一致");
            Install(bytes, info);
        }

        /// <summary>
        /// 安装一致性比较：Display 只是市场展示元数据，不进包清单，必须忽略；
        /// 其余清单字段（含 compat——它决定 3 级 Wasm 的输入信封与导入别名）都必须一致，
        /// 否则市场目录描述的运行方式与包内清单不是同一个插件。
        /// </summary>
        internal static bool SameListing(PluginInfo listing, PluginInfo info)
        {
            if (listing == null || info == null) return false;
            var packaged = JsonSerializer.Serialize(info with { Display = null });
            var catalog = JsonSerializer.Serialize(listing with
            {
                Download = info.Download, Sha256 = info.Sha256, DiscussionIssue = info.DiscussionIssue,
                Signature = info.Signature, Display = null
            });
            return packaged == catalog;
        }

        internal bool InstallLocal(string file, Func<PluginInfo, PluginInfo, bool> confirm = null)
        {
            var bytes = ReadFile(file);
            return Install(bytes, ReadPackage(bytes).Info, confirm);
        }

        private bool Install(byte[] bytes, PluginInfo info, Func<PluginInfo, PluginInfo, bool> confirm = null)
        {
            if (!Compatible(info, UpdateManifestService.LocalVersion(_baseDir), UpdateManifestService.LocalEpoch(_baseDir)))
                throw new InvalidDataException("插件适用的鲸鲸版本体系或版本范围与当前客户端不兼容");
            if (Directory.Exists(_root)) EnsureRoot();
            var target = FileFor(info.Id, ".zip");
            PluginInfo current = null;
            if (File.Exists(target))
            {
                try { current = ReadPackage(ReadFile(target)).Info; }
                catch (InvalidDataException) { throw new InvalidDataException("该插件 ID 已有旧版或损坏的安装，请先卸载"); }
                if (current.Kind != info.Kind) throw new InvalidDataException("同一插件 ID 不能更换类型");
                if (Version.Parse(current.Version) >= Version.Parse(info.Version))
                    throw new InvalidDataException("已安装相同或更新版本");
                if (!SameAuthor(current.Author, info.Author))
                    throw new InvalidDataException("插件 ID 已被其他作者使用，请先卸载旧版本");
            }
            if (confirm != null && !confirm(info, current)) return false;
            EnsureRoot();
            // 更新永远先撤权；安装与保存配置不会新建授权。
            Revoke(info.Id);
            if (info.IsUnified)
            {
                var package = ReadPackage(bytes);
                var install = InstallDirectory(info.Id);
                Directory.CreateDirectory(install);
                var data = Directory.CreateDirectory(Path.Combine(install, ProtocolFile("dataDirectory")));
                if ((data.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("插件数据目录不能是链接");
                var entry = EntryFile(info);
                if (current?.IsUnified == true && EntryFile(current) != entry)
                    File.Delete(InstallFile(info.Id, EntryFile(current)));
                WriteAtomically(InstallFile(info.Id, ProtocolFile("manifest")), package.RawManifest);
                WriteAtomically(InstallFile(info.Id, entry), package.Module);
            }
            WriteAtomically(target, bytes);
            return true;
        }

        /// <summary>读取已安装主题插件的 theme.json 原始字节；执行/校验交给 Appearance。</summary>
        internal byte[] ThemeBytes(PluginInfo info)
        {
            EnsureRoot();
            if (info?.IsTheme != true) throw new InvalidDataException("不是纯数据主题插件");
            var package = ReadPackage(ReadFile(FileFor(info.Id, ".zip")));
            if (!package.Info.IsTheme || package.Info.Id != info.Id || package.ThemeBytes == null)
                throw new InvalidDataException("已安装的主题插件无效");
            return package.ThemeBytes;
        }

        /// <summary>旧主题迁移用：把已经构造好的 0 级主题 ZIP 写进插件目录，不产生授权。</summary>
        internal string InstallThemePackage(byte[] bytes)
        {
            var package = ReadPackage(bytes);
            if (!package.Info.IsTheme) throw new InvalidDataException("不是纯数据主题包");
            EnsureRoot();
            WriteAtomically(FileFor(package.Info.Id, ".zip"), bytes);
            return package.Info.Id;
        }

        internal string MessageSettings(string id)
        {
            var file = InstallFile(id, SettingsFilename);
            if (!File.Exists(file)) return "{}";
            return StrictUtf8.GetString(ReadFile(file));
        }

        private static JsonDocument ParseSettings(PluginInfo info, string settings)
        {
            if (Encoding.UTF8.GetByteCount(settings) > Limit("maxSettingsBytes"))
                throw new InvalidDataException("设置超过大小限制");
            var value = JsonDocument.Parse(settings);
            if (value.RootElement.ValueKind == JsonValueKind.Object
                && (info.SettingsSchema == null || MatchesSchema(value.RootElement, info.SettingsSchema.Value))) return value;
            value.Dispose();
            throw new InvalidDataException("设置必须为符合此插件声明的 JSON 对象");
        }

        internal void SetMessageSettings(string id, string settings)
        {
            EnsureRoot();
            var archive = ReadFile(FileFor(id, ".zip"));
            var package = ReadPackage(archive);
            if (!package.Info.IsUnified || package.Info.Id != id || !DeploymentMatches(id, package))
                throw new InvalidDataException("已安装的统一插件无效");
            using var value = ParseSettings(package.Info, settings);
            var grant = InstallFile(id, ProtocolFile("grant"));
            var wasEnabled = Enabled(id);
            if (wasEnabled) File.Delete(grant);
            WriteAtomically(InstallFile(id, SettingsFilename), Encoding.UTF8.GetBytes(settings));
            if (wasEnabled) SaveGrant(id, package, archive, value.RootElement);
        }

        internal static bool HostCallEnabled(string id) => Registry.GetProperty("calls").TryGetProperty(id, out var call)
            && call.TryGetProperty("enabled", out var enabled) && enabled.ValueKind == JsonValueKind.True;

        private void SaveGrant(string id, PluginPackage package, byte[] archive, JsonElement settings)
        {
            WriteAtomically(InstallFile(id, ProtocolFile("grant")), JsonSerializer.SerializeToUtf8Bytes(new
            {
                enabled = true, level = package.Info.Level, fullAccess = package.Info.RequiresFullAccess,
                nodeFullConfirmed = package.Info.RequiresFullAccess, chatConfirmed = package.Info.RequiresChatAccess,
                approvedDataAccess = package.Info.DataAccess ?? Array.Empty<string>(),
                epoch = Guid.NewGuid().ToString("D"),
                packageHash = Digest(archive), manifestHash = Digest(package.RawManifest), entryHash = Digest(package.Module),
                approvedCalls = package.Info.Calls.Where(HostCallEnabled).ToArray(),
                approvedProviders = package.Info.Provides.Keys.ToArray(), settings
            }));
        }

        private void WriteAtomically(string target, byte[] bytes)
        {
            var staging = Path.Combine(_root, Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (var stream = File.Open(staging, FileMode.CreateNew)) stream.Write(bytes);
                File.Move(staging, target, true);
            }
            finally { File.Delete(staging); }
        }
    }
}
