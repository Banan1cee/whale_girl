using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    internal sealed class PhoneControl : IDisposable
    {
        internal static bool IsStandardUser()
        {
            using var identity = WindowsIdentity.GetCurrent();
            return !new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }

        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _shutdown = new();
        private readonly Func<string, JsonElement, Task<object>> _dispatch;
        private readonly string _file;
        private readonly byte[] _secret = Encoding.ASCII.GetBytes(Convert.ToHexString(RandomNumberGenerator.GetBytes(32)));

        public PhoneControl(string root, Func<string, JsonElement, Task<object>> dispatch)
        {
            _dispatch = dispatch;
            var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant())));
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WhaleGirlRemoteConsole");
            Directory.CreateDirectory(dir);
            _file = Path.Combine(dir, "launcher-" + id + ".json");
            _listener.Start(4);
            var temp = _file + "." + Environment.ProcessId + ".tmp";
            try
            {
                File.WriteAllText(temp, JsonSerializer.Serialize(new {
                    port = ((IPEndPoint)_listener.LocalEndpoint).Port,
                    key = Encoding.ASCII.GetString(_secret),
                }));
                File.Move(temp, _file, overwrite: true);
            }
            catch
            {
                _listener.Stop();
                throw;
            }
            finally { try { File.Delete(temp); } catch (IOException) { } }
            _ = ListenAsync(_shutdown.Token);
        }

        private async Task ListenAsync(CancellationToken shutdown)
        {
            while (!shutdown.IsCancellationRequested)
            {
                try
                {
                    using var client = await _listener.AcceptTcpClientAsync(shutdown);
                    using var handshake = CancellationTokenSource.CreateLinkedTokenSource(shutdown);
                    handshake.CancelAfter(TimeSpan.FromSeconds(2));
                    var stream = client.GetStream();
                    var input = new byte[150 * 1024];
                    var length = 0;
                    var end = -1;
                    while (length < input.Length)
                    {
                        var count = await stream.ReadAsync(input.AsMemory(length), handshake.Token);
                        if (count == 0) break;
                        end = Array.IndexOf(input, (byte)'\n', length, count);
                        length += count;
                        if (end >= 0) break;
                    }
                    if (end <= _secret.Length + 1 ||
                        input[_secret.Length] != (byte)' ' ||
                        !CryptographicOperations.FixedTimeEquals(input.AsSpan(0, _secret.Length), _secret)) continue;
                    var start = _secret.Length + 1;
                    object response;
                    try
                    {
                        using var request = JsonDocument.Parse(input.AsMemory(start, end - start));
                        var action = request.RootElement.GetProperty("action").GetString();
                        request.RootElement.TryGetProperty("payload", out var payload);
                        response = await _dispatch(action, payload);
                    }
                    catch { response = new { ok = false, error = "启动器未能完成操作，请查看诊断。" }; }
                    await stream.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(response), shutdown);
                }
                catch (OperationCanceledException) { }
                catch (IOException) { }
                catch (SocketException) { }
                catch (ObjectDisposedException) when (shutdown.IsCancellationRequested) { }
            }
        }

        public void Dispose()
        {
            _shutdown.Cancel();
            _listener.Stop();
            try
            {
                using var saved = JsonDocument.Parse(File.ReadAllText(_file));
                if (saved.RootElement.GetProperty("key").GetString() == Encoding.ASCII.GetString(_secret))
                    File.Delete(_file);
            }
            catch { }
            _shutdown.Dispose();
        }
    }
}
