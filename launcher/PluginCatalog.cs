using System;
using System.Collections.Generic;
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
        private const string PersonaCatalogUrl = "https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/index-personas.json";
        private const int CatalogLimit = 256 * 1024;
        private static readonly HttpClient Http = CreateClient();
        private static readonly JsonSerializerOptions ReadOptions = new() { PropertyNameCaseInsensitive = true };

        private sealed class DownloadMissingException : IOException
        {
            internal DownloadMissingException() : base("下载文件不存在") { }
        }

        private static HttpClient CreateClient()
        {
            var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
            client.DefaultRequestHeaders.UserAgent.ParseAdd("WhaleGirl-PluginMarket");
            return client;
        }

        internal static Task<PluginInfo[]> CatalogAsync() => LoadCatalogAsync(PersonaCatalogUrl, 1, "persona");

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
