using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    internal sealed record PluginInfo(string Id, string Name, string Author, string Version, string MinAppVersion,
        string Description, string ResultLabel, int Api, string Download = null, string Sha256 = null, string Kind = "tool",
        string MaxAppVersion = null, int DiscussionIssue = 0, string HostAction = null)
    {
        internal bool IsPersona => Kind == "persona";
        internal string CompatibilityLabel => string.IsNullOrEmpty(MaxAppVersion)
            ? $"鲸鲸 {MinAppVersion} 及以上" : $"鲸鲸 {MinAppVersion} – {MaxAppVersion}";
    }
    internal sealed record PluginFeedback(int Comments, int Favorites);
    internal sealed record PluginPackage(PluginInfo Info, byte[] Module, string Prompt = null);

    internal sealed class PluginMarket
    {
        internal const string CatalogUrl = "https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/index.json";
        internal const string DigestAction = "chat.summary";
        private const string CatalogV2Url = "https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/index-v2.json";
        private const int PackageLimit = 1024 * 1024;
        private static readonly HttpClient Http = CreateClient();

        private static HttpClient CreateClient()
        {
            var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
            client.DefaultRequestHeaders.UserAgent.ParseAdd("WhaleGirl-PluginMarket");
            return client;
        }
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

        internal static bool Compatible(PluginInfo info, string version) =>
            Version.TryParse(version, out var app) && Version.TryParse(info.MinAppVersion, out var min) && app >= min
            && (string.IsNullOrEmpty(info.MaxAppVersion) || (Version.TryParse(info.MaxAppVersion, out var max) && app <= max));

        private static bool Valid(PluginInfo info) => info != null && ValidId(info.Id) && (info.Api == 1 && info.HostAction == null
                || info.Api == 2 && info.Kind == "tool" && info.HostAction is null or DigestAction)
            && Version.TryParse(info.Version, out _) && Version.TryParse(info.MinAppVersion, out var min)
            && (string.IsNullOrEmpty(info.MaxAppVersion) || (Version.TryParse(info.MaxAppVersion, out var max) && max >= min))
            && info.DiscussionIssue >= 0
            && info.Name?.Trim().Length is > 0 and <= 80 && info.Author?.Trim().Length is > 0 and <= 80
            && info.Description?.Length is <= 600 && (info.IsPersona ||
                (info.Kind == "tool" && info.ResultLabel?.Trim().Length is > 0 and <= 80));

        internal static PluginPackage ReadPackage(byte[] bytes)
        {
            if (bytes.Length > PackageLimit) throw new InvalidDataException("插件包超过 1 MiB");
            using var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
            if (zip.Entries.Count != 2 || zip.GetEntry("plugin.json") is not { } manifest)
                throw new InvalidDataException("ZIP 根目录必须包含 plugin.json 和一个插件文件");
            using var metadata = manifest.Open();
            var info = JsonSerializer.Deserialize<PluginInfo>(ReadLimited(metadata, 8192));
            if (!Valid(info)) throw new InvalidDataException("插件清单无效或接口版本不支持");
            if (info.IsPersona)
            {
                using var preset = (zip.GetEntry("persona.json") ??
                    throw new InvalidDataException("人设包需要 persona.json")).Open();
                using var json = JsonDocument.Parse(ReadLimited(preset, 64 * 1024));
                var data = json.RootElement;
                if (data.ValueKind != JsonValueKind.Object ||
                    !data.TryGetProperty("customPrompt", out var value) || value.ValueKind != JsonValueKind.String ||
                    value.GetString()?.Trim().Length is not (> 0 and <= 24000))
                    throw new InvalidDataException("人设正文须填写在 customPrompt，最多 24000 字符");
                return new PluginPackage(info, null, value.GetString().Trim());
            }
            using var code = (zip.GetEntry("plugin.wasm") ??
                throw new InvalidDataException("工具包需要 plugin.wasm")).Open();
            var wasm = ReadLimited(code, 512 * 1024);
            if (wasm.Length < 8 || !wasm.AsSpan(0, 8).SequenceEqual(new byte[] { 0, 97, 115, 109, 1, 0, 0, 0 }))
                throw new InvalidDataException("插件缺少有效的 WebAssembly 模块");
            return new PluginPackage(info, wasm);
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

        private static async Task<byte[]> DownloadAsync(string url, int limit, bool feedback = false)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) throw new InvalidDataException("下载地址无效");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(feedback ? 5 : 20));
            for (var hop = 0; hop < 5; hop++)
            {
                if (uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || uri.UserInfo.Length != 0 ||
                    (uri.Host is not ("raw.githubusercontent.com" or "github.com" or "release-assets.githubusercontent.com" or "objects.githubusercontent.com")
                        && !(feedback && uri.Host == "api.github.com")))
                    throw new InvalidDataException("插件下载地址须使用 GitHub HTTPS");
                using var response = await Http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if ((int)response.StatusCode is 301 or 302 or 303 or 307 or 308 && response.Headers.Location is { } location)
                {
                    uri = new Uri(uri, location);
                    continue;
                }
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength > limit) throw new InvalidDataException("下载文件超过大小限制");
                await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                using var result = new MemoryStream();
                var buffer = new byte[8192];
                int count;
                while ((count = await stream.ReadAsync(buffer.AsMemory(), timeout.Token)) > 0)
                {
                    if (result.Length + count > limit) throw new InvalidDataException("下载文件超过大小限制");
                    result.Write(buffer, 0, count);
                }
                return result.ToArray();
            }
            throw new InvalidDataException("下载重定向次数过多");
        }

        internal static async Task<PluginInfo[]> CatalogAsync()
        {
            var items = ParseCatalog(await DownloadAsync(CatalogUrl, 256 * 1024));
            try
            {
                items = items.Concat(ParseCatalog(await DownloadAsync(CatalogV2Url, 256 * 1024))).ToArray();
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or InvalidDataException
                or OperationCanceledException or InvalidOperationException)
            { /* 旧目录仍可使用，独立的 Api 2 目录可能尚未发布。 */ }
            return items.GroupBy(i => i.Id).SelectMany(group => group
                .GroupBy(i => i.Version).Select(version => version.First())).ToArray();
        }

        internal static PluginInfo[] ParseCatalog(byte[] bytes)
        {
            using var json = JsonDocument.Parse(bytes);
            return json.RootElement.EnumerateArray().Select(item =>
            {
                try { return item.Deserialize<PluginInfo>(); }
                catch (JsonException) { return null; }
            }).Where(i => Valid(i) && !string.IsNullOrWhiteSpace(i.Download) &&
                Regex.IsMatch(i.Sha256 ?? "", @"\A[0-9a-fA-F]{64}\z")).ToArray();
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
                    var info = ReadPackage(ReadFile(FileFor(id, ".zip"))).Info;
                    if (info.Id == id) installed.Add(info);
                }
                catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException) { }
            }
            return installed.OrderBy(i => i.Name).ToArray();
        }

        internal bool Enabled(string id)
        {
            EnsureRoot();
            return File.Exists(FileFor(id, ".enabled")) || File.Exists(FileFor(id, ".persona.json"));
        }

        internal void SetEnabled(string id, bool enabled)
        {
            EnsureRoot();
            var marker = FileFor(id, ".enabled");
            var preset = FileFor(id, ".persona.json");
            if (!enabled)
            {
                File.Delete(marker);
                File.Delete(preset);
                return;
            }
            var package = ReadPackage(ReadFile(FileFor(id, ".zip")));
            if (package.Info.Id != id || !Compatible(package.Info, UpdateManifestService.LocalVersion(_baseDir)))
                throw new InvalidDataException("插件标识或兼容版本无效");
            if (package.Info.IsPersona)
            {
                WriteAtomically(preset, JsonSerializer.SerializeToUtf8Bytes(new
                {
                    name = package.Info.Name, description = package.Info.Description,
                    version = package.Info.Version, customPrompt = package.Prompt
                }));
            }
            else if (!File.Exists(marker))
                using (File.Open(marker, FileMode.CreateNew)) { }
        }

        internal void Uninstall(string id)
        {
            SetEnabled(id, false);
            File.Delete(FileFor(id, ".zip"));
        }

        internal async Task InstallAsync(PluginInfo listing)
        {
            var bytes = await DownloadAsync(listing.Download, PackageLimit);
            if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(listing.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("插件包校验失败");
            var info = ReadPackage(bytes).Info;
            if (info != (listing with { Download = info.Download, Sha256 = info.Sha256, DiscussionIssue = info.DiscussionIssue }))
                throw new InvalidDataException("插件清单与市场目录不一致");
            Install(bytes, info);
        }

        internal bool InstallLocal(string file, Func<PluginInfo, PluginInfo, bool> confirm = null)
        {
            var bytes = ReadFile(file);
            return Install(bytes, ReadPackage(bytes).Info, confirm);
        }

        private bool Install(byte[] bytes, PluginInfo info, Func<PluginInfo, PluginInfo, bool> confirm = null)
        {
            if (!Compatible(info, UpdateManifestService.LocalVersion(_baseDir)))
                throw new InvalidDataException("这个插件需要更新的鲸鲸版本");
            var target = FileFor(info.Id, ".zip");
            PluginInfo current = null;
            if (Directory.Exists(_root)) EnsureRoot();
            if (File.Exists(target))
            {
                current = ReadPackage(ReadFile(target)).Info;
                if (current.Kind != info.Kind) throw new InvalidDataException("同一插件 ID 不能更换类型");
                if (Version.Parse(current.Version) >= Version.Parse(info.Version))
                    throw new InvalidDataException("已安装相同或更新版本");
            }
            if (confirm != null && !confirm(info, current)) return false;
            EnsureRoot();
            if (current != null && info.IsPersona) SetEnabled(info.Id, false);
            WriteAtomically(target, bytes);
            return true;
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

        internal async Task<string> RunAsync(string id, string input, string authorizedAction = null,
            Func<string, Task<string>> host = null)
        {
            EnsureRoot();
            if (!Enabled(id)) throw new InvalidOperationException("请先启用插件");
            var package = ReadPackage(ReadFile(FileFor(id, ".zip")));
            if (package.Info.IsPersona || package.Info.Id != id || !Compatible(package.Info, UpdateManifestService.LocalVersion(_baseDir)))
                throw new InvalidDataException("插件类型、标识或兼容版本无效");
            if (package.Info.HostAction != authorizedAction)
                throw new InvalidOperationException("此插件需要确认宿主权限");
            if (authorizedAction != null)
                input = await (host ?? throw new InvalidOperationException("此权限暂不可用"))(input);

            var node = Path.Combine(_baseDir, "runtime", "node.exe");
            if (!File.Exists(node)) throw new IOException("运行插件需要鲸鲸自带的 Node 运行时");
            var start = new ProcessStartInfo(node)
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8,
            };
            start.Environment.Clear();
            start.Environment["SystemRoot"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            start.ArgumentList.Add("--wasm-max-mem-pages=16");
            start.ArgumentList.Add("--wasm-max-table-size=1024");
            start.ArgumentList.Add("--max-old-space-size=64");
            start.ArgumentList.Add("-e");
            start.ArgumentList.Add(Runner);
            using var worker = Process.Start(start) ?? throw new IOException("无法启动插件运行器");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var output = worker.StandardOutput.ReadToEndAsync();
            var errors = worker.StandardError.ReadToEndAsync();
            try
            {
                var bytes = Encoding.UTF8.GetBytes(input);
                if (bytes.Length > 65536) throw new InvalidDataException("输入超过 64 KiB");
                var payload = JsonSerializer.Serialize(new { api = package.Info.Api, wasm = Convert.ToBase64String(package.Module), input = Convert.ToBase64String(bytes) });
                await worker.StandardInput.WriteAsync(payload.AsMemory(), timeout.Token);
                worker.StandardInput.Close();
                await worker.WaitForExitAsync(timeout.Token);
                var result = await output;
                if (worker.ExitCode != 0 || (package.Info.Api == 1 && !int.TryParse(result, out _)))
                    throw new InvalidDataException("插件执行失败，或请求了未开放的接口");
                return result;
            }
            catch (OperationCanceledException) { throw new TimeoutException("插件运行超时"); }
            finally
            {
                if (!worker.HasExited) worker.Kill(entireProcessTree: true);
                await errors;
            }
        }

        // 插件只拿到字节查询函数，无 WASI、文件、网络或微信接口。
        private const string Runner = """
            let data = '';
            process.stdin.setEncoding('utf8').on('data', chunk => { data += chunk; }).on('end', () => {
              try {
                const args = JSON.parse(data);
                const input = Buffer.from(args.input, 'base64');
                const module = new WebAssembly.Module(Buffer.from(args.wasm, 'base64'));
                const output = [];
                const imports = {
                  input_size: () => input.length, input_byte: i => input[i] ?? -1
                };
                if (args.api === 2) imports.output_byte = value => {
                  if (output.length >= 65536 || value < 0 || value > 255) throw new Error();
                  output.push(value);
                };
                if (WebAssembly.Module.imports(module).some(i =>
                  i.module !== 'whale' || i.kind !== 'function' || !Object.hasOwn(imports, i.name)))
                  throw new Error();
                const wasm = new WebAssembly.Instance(module, { whale: imports });
                const value = wasm.exports.run();
                if (!Number.isInteger(value) || value !== (value | 0)) throw new Error();
                if (args.api === 1) process.stdout.write(String(value));
                else if (value === 0) process.stdout.write(new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(output)));
                else throw new Error();
              } catch { process.exitCode = 1; }
            });
            """;
    }
}
