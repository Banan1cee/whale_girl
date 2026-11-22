using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    internal sealed class VersionHistoryPanel : StackPanel
    {
        private const string Repository = "Banan1cee/whale_girl";
        private const string ReleasesApi = "https://api.github.com/repos/" + Repository + "/releases";
        private static readonly HttpClient Client = new();
        private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap };
        private readonly StackPanel _releases = new();
        private readonly Button _retry = new() { Content = "重试", HorizontalAlignment = HorizontalAlignment.Left };
        private readonly Action<string> _openDownload;
        private CancellationTokenSource _loading;

        public VersionHistoryPanel(Action<string> openDownload)
        {
            _openDownload = openDownload;
            _status.SetResourceReference(StyleProperty, "Small");
            _retry.SetResourceReference(StyleProperty, "Ghost");
            _retry.Visibility = Visibility.Collapsed;
            Children.Add(_status);
            Children.Add(_retry);
            Children.Add(_releases);
            Loaded += async (_, _) => await LoadAsync();
            Unloaded += (_, _) => _loading?.Cancel();
            _retry.Click += async (_, _) => await LoadAsync();
        }

        private async Task LoadAsync()
        {
            if (_loading != null) return;
            using var request = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            _loading = request;
            _status.Text = "正在读取公开的 Windows 安装包…";
            _retry.Visibility = Visibility.Collapsed;
            _releases.Children.Clear();
            try
            {
                var releases = await ReadInstallersAsync(request.Token);
                if (!IsLoaded) return;
                _status.Text = releases.Count == 0 ? "GitHub 暂无可下载的 Windows 安装包。" : "";
                foreach (var (tag, date, files) in releases)
                {
                    var row = new WrapPanel { Margin = new Thickness(0, 8, 0, 0) };
                    var version = new TextBlock
                    {
                        Text = date.Length == 0 ? tag : tag + "  ·  " + date,
                        Width = 184,
                        VerticalAlignment = VerticalAlignment.Center,
                    };
                    version.SetResourceReference(TextBlock.ForegroundProperty, "Text");
                    row.Children.Add(version);
                    foreach (var file in files)
                    {
                        var download = new Button { Content = files.Count == 1 ? "下载安装包" : file, ToolTip = file };
                        download.SetResourceReference(StyleProperty, "Ghost");
                        var url = "https://github.com/" + Repository + "/releases/download/"
                            + Uri.EscapeDataString(tag) + "/" + Uri.EscapeDataString(file);
                        download.Click += (_, _) => _openDownload(url);
                        row.Children.Add(download);
                    }
                    _releases.Children.Add(row);
                }
            }
            catch (Exception error) when (error is HttpRequestException or JsonException or OperationCanceledException)
            {
                if (!IsLoaded) return;
                _status.Text = "暂时读不到 GitHub 的历史安装包，请稍后重试。";
                _retry.Visibility = Visibility.Visible;
            }
            finally
            {
                _loading = null;
            }
        }

        private static async Task<List<(string Tag, string Date, List<string> Files)>> ReadInstallersAsync(CancellationToken cancellation)
        {
            var releases = new List<(string, string, List<string>)>();
            for (int page = 1; ; page++)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, ReleasesApi + "?per_page=100&page=" + page);
                request.Headers.UserAgent.ParseAdd("WhaleGirl-Launcher/1.0");
                request.Headers.Accept.ParseAdd("application/vnd.github+json");
                using var response = await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
                response.EnsureSuccessStatusCode();
                using var stream = await response.Content.ReadAsStreamAsync(cancellation);
                using var data = await JsonDocument.ParseAsync(stream, cancellationToken: cancellation);
                if (data.RootElement.ValueKind != JsonValueKind.Array) throw new JsonException("Invalid release list");
                foreach (var release in data.RootElement.EnumerateArray())
                {
                    var tag = JsonRead.Str(release, "tag_name");
                    var assets = JsonRead.Prop(release, "assets");
                    if (string.IsNullOrWhiteSpace(tag) || JsonRead.Bool(release, "draft") ||
                        assets.ValueKind != JsonValueKind.Array) continue;
                    var files = new List<string>();
                    foreach (var asset in assets.EnumerateArray())
                    {
                        var name = JsonRead.Str(asset, "name");
                        if (JsonRead.Str(asset, "state") == "uploaded" &&
                            (name.EndsWith("-setup.exe", StringComparison.OrdinalIgnoreCase) ||
                             name.EndsWith(".msi", StringComparison.OrdinalIgnoreCase)))
                            files.Add(name);
                    }
                    if (files.Count == 0) continue;
                    var date = JsonRead.Str(release, "published_at");
                    releases.Add((tag, DateTimeOffset.TryParse(date, out var published)
                        ? published.ToLocalTime().ToString("yyyy-MM-dd") : "", files));
                }
                if (data.RootElement.GetArrayLength() < 100) return releases;
            }
        }
    }
}
