using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>一条公告。字段全部来自远端 announcements.json，展示前已经在 ParseAnnouncement 里清洗和校验过。</summary>
    public sealed class Announcement
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public string Body { get; set; } = "";
        public string Level { get; set; } = "info";
        public string Action { get; set; } = "none";
        public string Url { get; set; } = "";
        public string PublishedAt { get; set; } = "";
        public string MinVersion { get; set; } = "";
        public string MaxVersion { get; set; } = "";
        public int Epoch { get; set; }
        public int Priority { get; set; }
    }

    /// <summary>
    /// 公告节奏。远端可以在 announcements.json 的 config 段里调，但客户端必须再钳一次：
    /// 远端写错或者被改坏时，最多让用户每次启动看到 20 条，不能无限弹。
    /// </summary>
    public sealed class NoticeConfig
    {
        public const int MaxPopupsLimit = 20;
        public const int DefaultMaxPopups = 3;
        public const int DefaultDelayMs = 1200;
        public const int MaxDelayMs = 10000;

        public bool PopupsEnabled { get; set; } = true;
        public int MaxPopupsPerLaunch { get; set; } = DefaultMaxPopups;
        public int PopupDelayMs { get; set; } = DefaultDelayMs;
    }

    /// <summary>一次读取的结果：本机可见的公告 + 生效配置 + 已读集合。</summary>
    public sealed class AnnouncementFeedResult
    {
        public bool Ok { get; set; }
        public bool FromCache { get; set; }
        /// <summary>本次用的是安装目录里的本地文件（发布前预览 / 现场排查），不是远端。</summary>
        public bool FromLocal { get; set; }
        public string Error { get; set; } = "";
        public NoticeConfig Config { get; set; } = new NoticeConfig();
        public List<Announcement> All { get; set; } = new List<Announcement>();
        public HashSet<string> Read { get; set; } = new HashSet<string>(StringComparer.Ordinal);

        public IEnumerable<Announcement> Unread => All.Where(item => !Read.Contains(item.Id));
        public int UnreadCount => Unread.Count();

        /// <summary>只改内存里的已读集合；落盘由 AnnouncementFeed.MarkRead 负责。</summary>
        public void MarkRead(string id)
        {
            if (!string.IsNullOrEmpty(id)) Read.Add(id);
        }
    }

    /// <summary>本地状态：已读 id + 最近一次成功的原始 feed（断网时回退）。</summary>
    public sealed class AnnouncementState
    {
        public Dictionary<string, string> Read { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
        public string CacheJson { get; set; } = "";
        public DateTimeOffset CachedAt { get; set; }
    }

    /// <summary>
    /// 读 website/content/announcements.json 并过滤成本机可显示的那几条。
    ///
    /// 为什么和更新清单一样走「静态文件 + 多源并行 + 本地缓存」：没有后端、不能发一次公告就发版，
    /// 而且国内直连 GitHub 经常不通；清单那套取舍（4 秒超时、失败放行、序号仲裁）已经在线上跑过，
    /// 公告没有理由再造一套。区别只在于公告永远不阻断启动。
    ///
    /// 为什么单独一个文件而不是塞进 release-manifest.json：那个文件管「这个版本还能不能用」，
    /// 公告是日更内容；混在一起会让改一条文案也去动强制更新判定和清单序号。
    /// </summary>
    public static class AnnouncementFeed
    {
        private const string Repo = "Banan1cee/whale_girl";

        // 顺序不重要（并行拉），但源要覆盖几种网络：GitHub 直连 / 墙内镜像 / CDN 兜底 / 自家官网 / 发布页资产。
        private static readonly string[] Sources =
        {
            "https://raw.githubusercontent.com/" + Repo + "/main/website/content/announcements.json",
            "https://gh-proxy.com/https://raw.githubusercontent.com/" + Repo + "/main/website/content/announcements.json",
            "https://cdn.jsdelivr.net/gh/" + Repo + "@main/website/content/announcements.json",
            "https://bot.zyyc.cc/content/announcements.json",
            // 发布页资产：发版时可以把同一份公告随 Release 挂上去，也方便在不动 main 的情况下做一次测试。
            // 指向「最新已发布 Release」（非草稿、非预发布）；没挂这个资产时只是 404，不影响其它源。
            "https://github.com/" + Repo + "/releases/latest/download/announcements.json",
        };

        // 公告里唯一有副作用的动作是「打开链接」，所以只允许这几个站，不能变成任意跳转。
        private static readonly string[] AllowedUrlHosts =
        {
            "github.com", "raw.githubusercontent.com", "bot.zyyc.cc", "afdian.com",
        };

        private static readonly string[] AllowedActions = { "none", "open_url", "check_update" };
        private static readonly string[] AllowedLevels = { "info", "warn", "critical" };
        private static readonly Regex IdPattern = new(@"\A[a-z0-9][a-z0-9._-]{0,63}\z", RegexOptions.CultureInvariant);
        private static readonly Regex VersionPattern = new(@"\A[vV]?[0-9]+(\.[0-9]+){1,3}\z", RegexOptions.CultureInvariant);
        private const int MaxReadEntries = 500;

        private static readonly HttpClient Http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            // 启动时不该被网络拖住：拿不到就按缓存 / 静默跳过，绝不让人等公告。
            Timeout = TimeSpan.FromSeconds(4)
        };

        public static string DefaultStatePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "WhaleGirl", "announcements-state.json");

        // ── 拉取 ───────────────────────────────────────────────

        /// <summary>拉远端公告；失败退回本地缓存；两者都没有就是空结果。永不抛异常。</summary>
        public static async Task<AnnouncementFeedResult> FetchAsync(string baseDir, string statePath = null)
        {
            var path = string.IsNullOrEmpty(statePath) ? DefaultStatePath : statePath;
            var state = LoadState(path);
            var version = UpdateManifestService.LocalVersion(baseDir);
            var epoch = UpdateManifestService.LocalEpoch(baseDir);

            // 本机覆盖优先：维护者把同一份 announcements.json 放到安装目录，就能在发布前先看效果。
            // 本地文件只在存在时生效，不写远端缓存；删掉它就恢复成读远端。
            var local = ReadLocalFeed(baseDir);
            if (local != null)
            {
                var localResult = ApplyFeed(local, version, epoch, state.Read);
                localResult.Ok = true;
                localResult.FromLocal = true;
                return localResult;
            }

            FeedCandidate best = null;
            try
            {
                var all = await Task.WhenAll(Sources.Select(DownloadAsync));
                foreach (var item in all)
                {
                    if (item == null) continue;
                    if (best == null || item.Version > best.Version) best = item;
                }
            }
            catch
            {
                // 每个下载任务内部已经各自吞掉异常；这里只是兜底：公告永远不能把启动器拖垮。
            }

            // jsDelivr / 镜像可能回旧缓存：序号低于本地缓存就继续用缓存，和更新清单同一规则。
            var cachedVersion = ParseManifestVersion(state.CacheJson);
            if (best == null || best.Version < cachedVersion)
            {
                var cached = ApplyFeed(state.CacheJson, version, epoch, state.Read);
                cached.FromCache = state.CacheJson.Length > 0;
                cached.Error = best == null ? "拿不到公告（断网 / 被墙）" : "在线公告序号低于本地缓存，先用缓存";
                return cached;
            }

            var result = ApplyFeed(best.Raw, version, epoch, state.Read);
            result.Ok = true;
            state.CacheJson = best.Raw;
            state.CachedAt = DateTimeOffset.UtcNow;
            SaveState(path, state);
            return result;
        }

        private static async Task<FeedCandidate> DownloadAsync(string url)
        {
            try
            {
                using var response = await Http.GetAsync(url);
                if (!response.IsSuccessStatusCode) return null;
                var raw = await response.Content.ReadAsStringAsync();
                var version = ParseManifestVersion(raw);
                if (version <= 0) return null;   // 连序号都没有的响应不参与仲裁
                return new FeedCandidate { Version = version, Raw = raw };
            }
            catch
            {
                return null;
            }
        }

        // ── 本机覆盖：发布前预览 ───────────────────────────────

        /// <summary>
        /// 安装目录里的本地公告文件（data\announcements.json 优先，其次根目录 announcements.json）。
        /// 只认带合法 manifest_version 的 JSON；没有或写坏就返回 null，继续走远端。
        /// 这样维护者能在发布前先看效果，又不影响任何远端逻辑。
        /// </summary>
        internal static string ReadLocalFeed(string baseDir)
        {
            foreach (var candidate in LocalFeedPaths(baseDir))
            {
                try
                {
                    if (!File.Exists(candidate)) continue;
                    var text = File.ReadAllText(candidate);
                    if (ParseManifestVersion(text) <= 0) continue;
                    return text;
                }
                catch
                {
                    // 单个路径读不了就试下一个，不影响启动。
                }
            }
            return null;
        }

        internal static IEnumerable<string> LocalFeedPaths(string baseDir)
        {
            if (string.IsNullOrWhiteSpace(baseDir)) yield break;
            yield return Path.Combine(baseDir, "data", "announcements.json");
            yield return Path.Combine(baseDir, "announcements.json");
        }

        // ── 解析与过滤（纯函数，方便单测）──────────────────────
        /// <summary>把一份 feed JSON 过滤成本机可显示的结果。解析失败按「没有公告」处理。</summary>
        internal static AnnouncementFeedResult ApplyFeed(string json, string localVersion, int localEpoch,
            IDictionary<string, string> read = null)
        {
            var result = new AnnouncementFeedResult();
            if (read != null)
                foreach (var id in read.Keys)
                    if (!string.IsNullOrEmpty(id)) result.Read.Add(id);
            if (string.IsNullOrWhiteSpace(json)) return result;

            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return result;

                result.Config = ParseConfig(root);
                if (Bool(root, "kill")) return result;   // 一键撤下全部：连历史也不显示

                if (!root.TryGetProperty("announcements", out var list) || list.ValueKind != JsonValueKind.Array)
                    return result;

                foreach (var item in list.EnumerateArray())
                {
                    var announcement = ParseAnnouncement(item, localVersion, localEpoch);
                    if (announcement != null) result.All.Add(announcement);   // 单条写错只跳过这一条
                }

                result.All = result.All
                    .OrderByDescending(item => item.Priority)
                    .ThenByDescending(item => SortTime(item.PublishedAt))
                    .ToList();
            }
            catch
            {
                // 整份写坏按「没有公告」处理：宁可少提示，也不能让启动器起不来。
            }
            return result;
        }

        /// <summary>config 段全部可远端调，但每个值都要钳回本地允许范围。</summary>
        internal static NoticeConfig ParseConfig(JsonElement root)
        {
            var config = new NoticeConfig();
            if (!root.TryGetProperty("config", out var raw) || raw.ValueKind != JsonValueKind.Object) return config;

            if (raw.TryGetProperty("popups_enabled", out var enabled)
                && enabled.ValueKind is JsonValueKind.True or JsonValueKind.False)
                config.PopupsEnabled = enabled.ValueKind == JsonValueKind.True;

            config.MaxPopupsPerLaunch = Clamp(
                Int(raw, "max_popups_per_launch", NoticeConfig.DefaultMaxPopups), 0, NoticeConfig.MaxPopupsLimit);
            config.PopupDelayMs = Clamp(
                Int(raw, "popup_delay_ms", NoticeConfig.DefaultDelayMs), 0, NoticeConfig.MaxDelayMs);
            return config;
        }

        /// <summary>单条公告：字段校验 + 文本清洗 + 版本/代次过滤。不合格返回 null。</summary>
        internal static Announcement ParseAnnouncement(JsonElement item, string localVersion, int localEpoch)
        {
            if (item.ValueKind != JsonValueKind.Object) return null;

            var id = Str(item, "id").Trim();
            if (!IdPattern.IsMatch(id)) return null;

            var title = RemoteText.SafeText(Str(item, "title"), 60);
            var body = RemoteText.SafeMultiline(Str(item, "body"), 400).Trim();
            if (title.Length == 0 || body.Length == 0) return null;

            var level = Str(item, "level").Trim().ToLowerInvariant();
            if (!AllowedLevels.Contains(level)) level = "info";

            var action = Str(item, "action").Trim().ToLowerInvariant();
            if (!AllowedActions.Contains(action)) action = "none";
            var url = Str(item, "url").Trim();
            // 链接不合格就退化成纯文本，不能让远端借公告把人带到任意站点。
            if (action == "open_url" && !IsAllowedUrl(url)) action = "none";
            if (action != "open_url") url = "";

            var minVersion = Str(item, "min_version").Trim();
            var maxVersion = Str(item, "max_version").Trim();
            // 区间写错就当没写：不能因为一个笔误把公告藏掉。
            if (!VersionPattern.IsMatch(minVersion)) minVersion = "";
            if (!VersionPattern.IsMatch(maxVersion)) maxVersion = "";
            if (localVersion.Length > 0 && minVersion.Length > 0
                && UpdateManifestService.CompareVersion(localVersion, minVersion) < 0) return null;
            if (localVersion.Length > 0 && maxVersion.Length > 0
                && UpdateManifestService.CompareVersion(localVersion, maxVersion) > 0) return null;

            var epoch = Int(item, "epoch", 0);
            if (epoch > 0 && localEpoch > 0 && epoch != localEpoch) return null;

            var publishedAt = Str(item, "published_at").Trim();
            if (publishedAt.Length > 0 && !DateTimeOffset.TryParse(publishedAt, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out _))
                publishedAt = "";

            return new Announcement
            {
                Id = id,
                Title = title,
                Body = body,
                Level = level,
                Action = action,
                Url = url,
                PublishedAt = publishedAt,
                MinVersion = minVersion,
                MaxVersion = maxVersion,
                Epoch = epoch,
                Priority = Clamp(Int(item, "priority", 0), -1000, 1000),
            };
        }

        /// <summary>只允许 https + 白名单域名；挡掉 userinfo 花招（https://github.com@evil.example）。</summary>
        internal static bool IsAllowedUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return false;
            if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri)) return false;
            if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)) return false;
            if (!string.IsNullOrEmpty(uri.UserInfo)) return false;
            if (uri.Port != 443) return false;
            var host = uri.Host.ToLowerInvariant();
            foreach (var allowed in AllowedUrlHosts)
                if (host == allowed || host.EndsWith("." + allowed, StringComparison.Ordinal)) return true;
            return false;
        }

        // ── 本地状态：已读 + 缓存 ───────────────────────────────

        public static AnnouncementState LoadState(string path = null)
        {
            var state = new AnnouncementState();
            try
            {
                if (!File.Exists(path)) return state;
                using var doc = JsonDocument.Parse(File.ReadAllText(path));
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return state;

                if (root.TryGetProperty("read", out var read) && read.ValueKind == JsonValueKind.Object)
                    foreach (var entry in read.EnumerateObject())
                        if (entry.Value.ValueKind == JsonValueKind.String)
                            state.Read[entry.Name] = entry.Value.GetString();

                if (root.TryGetProperty("cache", out var cache) && cache.ValueKind == JsonValueKind.Object)
                    state.CacheJson = cache.GetRawText();

                if (root.TryGetProperty("cached_at", out var at) && at.ValueKind == JsonValueKind.String
                    && DateTimeOffset.TryParse(at.GetString(), CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal, out var when))
                    state.CachedAt = when;
            }
            catch
            {
                // 状态文件坏掉就当没用过：下一次成功拉取会重写，已读记录丢了比启动不了强。
            }
            return state;
        }

        public static void SaveState(string path, AnnouncementState state)
        {
            try
            {
                var dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

                using var cache = string.IsNullOrWhiteSpace(state.CacheJson) ? null : JsonDocument.Parse(state.CacheJson);
                var payload = new Dictionary<string, object>
                {
                    ["read"] = PruneRead(state.Read),
                    ["cache"] = cache?.RootElement.Clone(),
                    ["cached_at"] = state.CachedAt == default
                        ? "" : state.CachedAt.ToString("o", CultureInfo.InvariantCulture),
                };

                // tmp + Move 原子替换：写到一半断电也不会把已读记录弄成半截 JSON。
                var temporary = path + ".tmp";
                File.WriteAllText(temporary, JsonSerializer.Serialize(payload));
                File.Move(temporary, path, overwrite: true);
            }
            catch
            {
                // 写不进去不影响这一次使用，下次启动重试。
            }
        }

        /// <summary>标记已读并落盘。传进来的 id 会先按格式过滤，避免把任意字符串写进状态文件。</summary>
        public static void MarkRead(IEnumerable<string> ids, string statePath = null)
        {
            var path = string.IsNullOrEmpty(statePath) ? DefaultStatePath : statePath;
            var state = LoadState(path);
            var when = DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            foreach (var id in ids ?? Enumerable.Empty<string>())
                if (!string.IsNullOrEmpty(id) && IdPattern.IsMatch(id)) state.Read[id] = when;
            SaveState(path, state);
        }

        // ── 小工具 ─────────────────────────────────────────────

        private static Dictionary<string, string> PruneRead(Dictionary<string, string> read)
        {
            if (read == null || read.Count <= MaxReadEntries) return read;
            // ISO 时间字符串按字典序就是时间序；只留最近 500 条，防止状态文件无限长。
            return read.OrderByDescending(pair => pair.Value, StringComparer.Ordinal)
                .Take(MaxReadEntries)
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        }

        private static int ParseManifestVersion(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return 0;
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return 0;
                if (!root.TryGetProperty("manifest_version", out var value)
                    || value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var version)) return 0;
                return version > 0 ? version : 0;
            }
            catch
            {
                return 0;
            }
        }

        private static DateTimeOffset SortTime(string value)
            => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var when)
                ? when : DateTimeOffset.MinValue;

        private static string Str(JsonElement e, string name)
            => e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
                ? (value.GetString() ?? "") : "";

        private static bool Bool(JsonElement e, string name)
            => e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

        private static int Int(JsonElement e, string name, int fallback)
            => e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number
                && value.TryGetInt32(out var number) ? number : fallback;

        private static int Clamp(int value, int min, int max)
            => value < min ? min : value > max ? max : value;

        private sealed class FeedCandidate
        {
            public int Version;
            public string Raw = "";
        }
    }
}
