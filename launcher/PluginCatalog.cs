using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
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
    internal static class PluginCatalog
    {
        internal const string V5CatalogUrl = "https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/index-v5.json";
        // 唯一裸 raw 链接：人设目录、README/图片都从同一根前缀派生，避免再写第二条裸链接。
        private static readonly string MarketRoot = V5CatalogUrl[..(V5CatalogUrl.LastIndexOf('/') + 1)];
        private static readonly string PersonaCatalogUrl = MarketRoot + "index-personas.json";
        private const int CatalogLimit = 256 * 1024;
        private const int PackageLimit = 16 * 1024 * 1024;
        private static readonly HttpClient Http = CreateClient();
        private static readonly JsonSerializerOptions ReadOptions = new() { PropertyNameCaseInsensitive = true };

        internal sealed class DownloadMissingException : IOException
        {
            internal DownloadMissingException() : base("下载文件不存在") { }
        }

        private static HttpClient CreateClient()
        {
            var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
            client.DefaultRequestHeaders.UserAgent.ParseAdd("WhaleGirl-PluginMarket");
            return client;
        }

        internal static async Task<PluginInfo[]> CatalogAsync()
        {
            var personas = await LoadCatalogAsync(PersonaCatalogUrl, 1, "persona");
            // v5 目录是增量：404/网络/格式问题都不能把整个人设市场判失败。
            try
            {
                var v5 = await LoadV5Async();
                return personas.Concat(v5).ToArray();
            }
            catch (Exception ex) when (ex is HttpRequestException or InvalidDataException
                or OperationCanceledException or IOException or JsonException)
            {
                return personas;
            }
        }

        private static async Task<PluginInfo[]> LoadV5Async()
        {
            var bytes = await DownloadAsync(V5CatalogUrl, CatalogLimit);
            return ParseV5(bytes);
        }

        /// <summary>v5 目录条目 → PluginInfo。单条非法只丢该条，不拖垮整份目录。</summary>
        internal static PluginInfo[] ParseV5(byte[] bytes)
        {
            using var json = JsonDocument.Parse(bytes);
            if (json.RootElement.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException("v5 市场目录格式无效");
            var result = new List<PluginInfo>();
            foreach (var item in json.RootElement.EnumerateArray())
            {
                try
                {
                    if (item.ValueKind != JsonValueKind.Object
                        || !item.TryGetProperty("manifest", out var manifest) || manifest.ValueKind != JsonValueKind.Object
                        || !item.TryGetProperty("package", out var package) || package.ValueKind != JsonValueKind.Object)
                        continue;
                    var info = PluginMarket.ParseUnified(manifest);
                    var path = Text(package, "path");
                    var download = Text(package, "download");
                    var sha = Text(package, "sha256");
                    if (!package.TryGetProperty("bytes", out var sizeValue) || sizeValue.ValueKind != JsonValueKind.Number
                        || !sizeValue.TryGetInt64(out var size) || size <= 0 || size > PackageLimit) continue;
                    if (path != $"packages/{info.Id}-{info.Version}.zip") continue;
                    if (download != MarketRoot + path || !Regex.IsMatch(sha ?? "", @"\A[a-fA-F0-9]{64}\z")) continue;
                    info = info with { Download = download, Sha256 = sha, Display = ParseDisplay(item) };
                    if (PluginMarket.ValidCatalog(info)) result.Add(info);
                }
                catch (Exception ex) when (ex is InvalidDataException or JsonException or FormatException)
                {
                }
            }
            return result.ToArray();
        }

        private static PluginDisplayInfo ParseDisplay(JsonElement entry)
        {
            if (!entry.TryGetProperty("display", out var display) || display.ValueKind != JsonValueKind.Object) return null;
            PluginDisplayAsset readme = null;
            if (display.TryGetProperty("readme", out var readmeValue) && readmeValue.ValueKind == JsonValueKind.Object)
            {
                var asset = new PluginDisplayAsset(Text(readmeValue, "path"), Text(readmeValue, "sha256"),
                    Number(readmeValue, "bytes"));
                if (PluginMarket.ValidDisplayAsset(asset, 64 * 1024)) readme = asset;
            }
            var images = new List<PluginDisplayImage>();
            if (display.TryGetProperty("images", out var imageList) && imageList.ValueKind == JsonValueKind.Array)
            {
                var paths = new HashSet<string>(StringComparer.Ordinal);
                foreach (var value in imageList.EnumerateArray())
                {
                    if (images.Count >= 8 || value.ValueKind != JsonValueKind.Object) continue;
                    var image = new PluginDisplayImage(Text(value, "path"), Text(value, "sha256"),
                        Number(value, "bytes"), Text(value, "media"));
                    if (!PluginMarket.ValidDisplayImage(image, 2 * 1024 * 1024) || !paths.Add(image.Path)) continue;
                    images.Add(image);
                }
            }
            PluginDisplayDonation donation = null;
            if (display.TryGetProperty("donation", out var donationValue) && donationValue.ValueKind == JsonValueKind.Object)
            {
                var afdian = PluginMarket.AfdianPersonalPage(Text(donationValue, "afdian"));
                if (afdian != null) donation = new PluginDisplayDonation(afdian);
            }
            string updated = null;
            if (display.TryGetProperty("updatedAt", out var updatedValue) && updatedValue.ValueKind == JsonValueKind.String
                && DateTimeOffset.TryParse(updatedValue.GetString(), CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind, out var stamp))
                updated = stamp.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            if (readme == null && images.Count == 0 && donation == null && updated == null) return null;
            var parsed = new PluginDisplayInfo(readme, images.Count > 0 ? images.ToArray() : null, donation, updated);
            return PluginMarket.ValidDisplay(parsed) ? parsed : null;
        }

        internal static async Task<PluginAssetResult> FetchReadmeAsync(PluginInfo info)
        {
            var asset = info?.Display?.Readme;
            if (asset == null) return new(null, "该插件没有展示用 README");
            return await FetchAssetAsync(asset.Path, asset.Sha256, asset.Bytes, 64 * 1024);
        }

        internal static async Task<PluginAssetResult> FetchImageAsync(PluginInfo info, string source)
        {
            if (info?.Display?.Images is not { Length: > 0 } images) return new(null, "该插件没有展示图片");
            var path = ResolveImagePath(info, source);
            if (path == null) return new(null, "图片地址不在市场仓库或格式非法");
            var image = images.FirstOrDefault(item => string.Equals(item.Path, path, StringComparison.Ordinal));
            if (image == null) return new(null, "图片未在展示元数据中声明");
            return await FetchAssetAsync(image.Path, image.Sha256, image.Bytes, 2 * 1024 * 1024);
        }

        private static string ResolveImagePath(PluginInfo info, string source)
        {
            if (string.IsNullOrWhiteSpace(source)) return null;
            var value = source.Trim();
            string path;
            if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps)
            {
                if (!value.StartsWith(MarketRoot, StringComparison.Ordinal)) return null;
                path = value[MarketRoot.Length..];
            }
            else
            {
                if (value.Contains('\\') || value.Contains("..", StringComparison.Ordinal)) return null;
                var directory = info.Display?.Readme?.Path is { } readme
                    ? readme[..(readme.LastIndexOf('/') + 1)] : $"plugins/{info.Id}/";
                path = directory + value.TrimStart('/');
            }
            if (!path.StartsWith("plugins/", StringComparison.Ordinal) || path.Contains('\\')
                || path.Contains("..", StringComparison.Ordinal)) return null;
            return path;
        }

        private static async Task<PluginAssetResult> FetchAssetAsync(string path, string sha256, int bytes, int limit)
        {
            try
            {
                var raw = await DownloadAsync(MarketRoot + path, limit);
                if (raw.Length != bytes) return new(null, "文件大小与目录声明不一致");
                if (!Convert.ToHexString(SHA256.HashData(raw)).Equals(sha256, StringComparison.OrdinalIgnoreCase))
                    return new(null, "文件校验失败");
                return new(raw, null);
            }
            catch (Exception ex) when (ex is HttpRequestException or InvalidDataException
                or OperationCanceledException or IOException)
            {
                return new(null, "读取失败：" + ex.Message);
            }
        }

        private static string Text(JsonElement value, string key) =>
            value.TryGetProperty(key, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() : null;

        private static int Number(JsonElement value, string key) =>
            value.TryGetProperty(key, out var item) && item.ValueKind == JsonValueKind.Number
                && item.TryGetInt32(out var number) ? number : 0;

        private static async Task<PluginInfo[]> LoadCatalogAsync(string url, int? expectedApi = null,
            string expectedKind = null)
        {
            var bytes = await DownloadAsync(url, CatalogLimit);
            if (!PluginMarket.MarketSignatureEnabled) return ParseCatalog(bytes, expectedApi, expectedKind);
            string signature = null;
            try
            {
                signature = Encoding.UTF8.GetString(await DownloadAsync(url + ".sig", 4096, stopOnNotFound: true)).Trim();
            }
            catch (DownloadMissingException)
            {
            }
            if (string.IsNullOrWhiteSpace(signature)) return ParseCatalog(bytes, expectedApi, expectedKind);
            return ParseSignedCatalog(bytes, signature, expectedApi, expectedKind);
        }

        internal static PluginInfo[] ParseSignedCatalog(byte[] bytes, string signature, int? expectedApi = null,
            string expectedKind = null)
        {
            if (!PluginTrust.Verify(bytes, signature))
                throw new InvalidDataException("市场目录签名无效，已拒绝加载");
            return ParseCatalog(bytes, expectedApi, expectedKind);
        }

        internal static PluginInfo[] ParseCatalog(byte[] bytes, int? expectedApi = null, string expectedKind = null)
        {
            using var json = JsonDocument.Parse(bytes);
            if (json.RootElement.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException("市场目录格式无效");
            return json.RootElement.EnumerateArray().Select(item =>
            {
                try { return item.Deserialize<PluginInfo>(ReadOptions); }
                catch (JsonException) { return null; }
            }).Where(info => PluginMarket.Valid(info) && (!expectedApi.HasValue || info.Api == expectedApi.Value)
                && (expectedKind == null || info.Kind == expectedKind) && !string.IsNullOrWhiteSpace(info.Download)
                && Regex.IsMatch(info.Sha256 ?? "", @"\A[0-9a-fA-F]{64}\z")).ToArray();
        }

        internal static async Task<Dictionary<int, PluginFeedback>> FeedbackAsync()
        {
            const string url = "https://api.github.com/repos/Banan1cee/whale-girl-plugins/issues?state=open&per_page=100";
            using var payload = JsonDocument.Parse(await DownloadAsync(url, 1024 * 1024, feedback: true));
            var feedback = new Dictionary<int, PluginFeedback>();
            foreach (var issue in payload.RootElement.EnumerateArray())
            {
                if (issue.TryGetProperty("pull_request", out _)) continue;
                var number = issue.GetProperty("number").GetInt32();
                var comments = issue.GetProperty("comments").GetInt32();
                var favorites = issue.GetProperty("reactions").GetProperty("heart").GetInt32();
                feedback[number] = new PluginFeedback(comments, favorites);
            }
            return feedback;
        }

        internal static async Task<byte[]> DownloadAsync(string url, int limit, bool feedback = false, bool stopOnNotFound = false)
        {
            Exception last = null;
            foreach (var candidate in DownloadCandidates(url))
            {
                try { return await DownloadOnce(candidate, limit, feedback, stopOnNotFound); }
                catch (DownloadMissingException) { throw; }
                catch (Exception ex) when (ex is HttpRequestException or InvalidDataException
                    or OperationCanceledException or IOException) { last = ex; }
            }
            throw last ?? new InvalidDataException("插件下载失败");
        }

        private static IEnumerable<string> DownloadCandidates(string url)
        {
            yield return url;
            if (url.StartsWith("https://raw.githubusercontent.com/", StringComparison.Ordinal))
            {
                var rest = url.Substring("https://raw.githubusercontent.com/".Length);
                var parts = rest.Split('/');
                if (parts.Length >= 3)
                    yield return $"https://cdn.jsdelivr.net/gh/{parts[0]}/{parts[1]}@{parts[2]}/{string.Join("/", parts.Skip(3))}";
            }
            if (url.StartsWith("https://raw.githubusercontent.com/", StringComparison.Ordinal)
                || url.StartsWith("https://github.com/", StringComparison.Ordinal)
                || url.StartsWith("https://release-assets.githubusercontent.com/", StringComparison.Ordinal)
                || url.StartsWith("https://objects.githubusercontent.com/", StringComparison.Ordinal))
            {
                yield return "https://gh-proxy.com/" + url;
                yield return "https://ghfast.top/" + url;
            }
        }

        private static async Task<byte[]> DownloadOnce(string url, int limit, bool feedback = false, bool stopOnNotFound = false)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) throw new InvalidDataException("下载地址无效");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(feedback ? 5 : 20));
            for (var hop = 0; hop < 5; hop++)
            {
                var allowedHost = uri.Host is "raw.githubusercontent.com" or "github.com" or "release-assets.githubusercontent.com"
                    or "objects.githubusercontent.com" or "cdn.jsdelivr.net" or "gh-proxy.com" or "ghfast.top"
                    || (feedback && uri.Host == "api.github.com");
                if (uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || !allowedHost)
                    throw new InvalidDataException("插件下载地址须使用 GitHub HTTPS");
                using var response = await Http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308 && response.Headers.Location is { } location)
                {
                    uri = new Uri(uri, location);
                    continue;
                }
                if (stopOnNotFound && response.StatusCode == HttpStatusCode.NotFound)
                    throw new DownloadMissingException();
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength > limit) throw new InvalidDataException("下载文件超过大小限制");
                await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                using var result = new System.IO.MemoryStream();
                var buffer = new byte[8192];
                int count;
                while ((count = await stream.ReadAsync(buffer.AsMemory(), timeout.Token)) > 0)
                {
                    if (result.Length + count > limit) throw new InvalidDataException("下载文件超过大小限制");
                    result.Write(buffer, 0, count);
                }
                return result.ToArray();
            }
            throw new InvalidDataException("插件下载重定向次数过多");
        }
    }
}
