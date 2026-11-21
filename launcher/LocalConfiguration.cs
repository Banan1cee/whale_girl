using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    internal sealed class LocalConfiguration
    {
        private readonly string _root;
        private readonly SemaphoreSlim _gate = new SemaphoreSlim(1, 1);
        private JsonElement _snapshot;
        private DateTime _loadedAt;

        public LocalConfiguration(string root) { _root = root; }

        public Task<ApiResult> ReadAsync(string path, bool forceRefresh = false) => RunAsync(path, null, forceRefresh);
        public Task<ApiResult> PreviewPersonaPresetAsync(string id) => RunAsync(null, null, presetId: id);

        public Task<ApiResult> SaveAsync(string path, object body)
            => RunAsync(path, JsonSerializer.Serialize(new { path, body }));

        private async Task<ApiResult> RunAsync(string path, string request, bool forceRefresh = false, string presetId = null)
        {
            await _gate.WaitAsync();
            try
            {
                if (request != null || presetId != null || forceRefresh || _snapshot.ValueKind != JsonValueKind.Object
                    || DateTime.UtcNow - _loadedAt > TimeSpan.FromSeconds(2))
                {
                    var node = Path.Combine(_root, "runtime", "node.exe");
                    var info = new ProcessStartInfo
                    {
                        FileName = File.Exists(node) ? node : "node",
                        WorkingDirectory = _root,
                        UseShellExecute = false, CreateNoWindow = true,
                        RedirectStandardOutput = true, RedirectStandardError = true,
                        RedirectStandardInput = request != null,
                        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
                    };
                    info.ArgumentList.Add(Path.Combine(_root, "src", "services", "launcherSnapshot.js"));
                    if (request != null)
                    {
                        info.ArgumentList.Add("--save");
                        info.StandardInputEncoding = new UTF8Encoding(false);
                        _snapshot = default;
                    }
                    if (presetId != null)
                    {
                        info.ArgumentList.Add("--preview-preset");
                        info.ArgumentList.Add(presetId);
                    }
                    var command = await ProcessRunner.RunAsync(info, request, TimeSpan.FromSeconds(8));
                    if (!command.Success) throw new IOException("无法读取本地配置，请检查配置文件格式与目录权限。");
                    var text = command.Output;
                    using var doc = JsonDocument.Parse(text);
                    if (request != null || presetId != null)
                    {
                        var result = new ApiResult { Root = doc.RootElement.Clone() };
                        result.Ok = result.Bool("ok");
                        result.Error = result.Str("error");
                        return result;
                    }
                    _snapshot = doc.RootElement.Clone();
                    _loadedAt = DateTime.UtcNow;
                }
                if (!_snapshot.TryGetProperty(path, out var payload))
                    return new ApiResult { Ok = false, Error = "此功能需要启动内核。" };
                return new ApiResult { Ok = true, StatusCode = 200, Root = payload.Clone() };
            }
            catch
            {
                return new ApiResult { Ok = false, Error = (request == null ? "读取" : "保存") + "本地配置失败，请检查配置文件和 Node 运行环境。" };
            }
            finally { _gate.Release(); }
        }
    }
}
