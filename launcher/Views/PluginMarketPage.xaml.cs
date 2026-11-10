using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    public partial class PluginMarketPage : UserControl
    {
        private readonly PluginMarket _market;
        private readonly RuntimeSupervisor _sup;
        private readonly string _version;
        private PluginInfo[] _catalog = [];
        private Dictionary<int, PluginFeedback> _feedback = new();
        private bool _showInstalled;
        private bool _busy;

        internal PluginMarketPage(PluginMarket market, string version, RuntimeSupervisor sup)
        {
            _market = market;
            _sup = sup;
            _version = version;
            InitializeComponent();
            Loaded += async (_, _) => { if (_catalog.Length == 0) await RefreshCatalog(); };
        }

        private async void OnRefresh(object sender, RoutedEventArgs e) => await RefreshCatalog();

        private Task RefreshCatalog() => WithStatus(async () =>
        {
            _catalog = await PluginMarket.CatalogAsync();
            Render();
            if (_catalog.Any(info => info.DiscussionIssue > 0))
            {
                try { _feedback = await PluginMarket.FeedbackAsync(); }
                catch (Exception ex) when (ex is HttpRequestException or InvalidDataException or JsonException
                    or OperationCanceledException or InvalidOperationException or KeyNotFoundException) { }
            }
            return $"市场收录 {_catalog.Length} 个插件";
        });

        private void OnSearch(object sender, TextChangedEventArgs e) => Render();
        private void OnDiscover(object sender, RoutedEventArgs e) { _showInstalled = false; Render(); }
        private void OnInstalled(object sender, RoutedEventArgs e) { _showInstalled = true; Render(); }

        private async void OnLocal(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            var picker = new Microsoft.Win32.OpenFileDialog { Filter = "鲸鲸插件包 (*.zip)|*.zip" };
            if (picker.ShowDialog() != true) return;
            await WithStatus(async () =>
            {
                var installed = await Task.Run(() => _market.InstallLocal(picker.FileName,
                    (info, current) => Dispatcher.Invoke(() => ConfirmLocalInstall(info, current))));
                if (!installed) return "已取消安装。";
                _showInstalled = true;
                return "已安装，可在「已安装」里启用。";
            });
        }

        private bool ConfirmLocalInstall(PluginInfo info, PluginInfo current)
        {
            var kind = info.IsPersona ? "人设预设" : "功能工具";
            var details = $"{info.Name} · {info.Version}（{kind}）\n包内自报作者 · {info.Author}";
            if (current != null)
                details += $"\n将替换已安装的「{current.Name}」{current.Version}。";
            if (info.IsPersona)
                details += "\n\n应用人设才会替换当前自定义提示词。停用或卸载后，已应用的提示词仍会保留。";
            return MessageBox.Show(Window.GetWindow(this),
                "此本地 ZIP 未经鲸鲸插件市场审核。请确认你信任文件的提供者。\n\n" + details,
                "安装本地插件", MessageBoxButton.OKCancel, MessageBoxImage.Warning,
                MessageBoxResult.Cancel) == MessageBoxResult.OK;
        }

        private async Task WithStatus(Func<Task<string>> action)
        {
            if (_busy) return;
            _busy = true;
            Status.Text = "正在处理…";
            try { Status.Text = await action(); }
            catch (Exception ex) { Status.Text = "操作失败：" + ex.Message; }
            finally { _busy = false; Render(); }
        }

        private void Render()
        {
            if (Cards == null) return;
            Cards.Children.Clear();
            Discover.Style = (Style)FindResource(_showInstalled ? "Ghost" : "Primary");
            Installed.Style = (Style)FindResource(_showInstalled ? "Primary" : "Ghost");
            try
            {
                var local = _market.Installed().ToDictionary(p => p.Id);
                var query = Search.Text.Trim();
                var entries = _showInstalled ? local.Values.AsEnumerable() : _catalog.AsEnumerable();
                foreach (var info in entries.Where(p => (p.Name + " " + p.Author + " " + p.Description)
                    .Contains(query, StringComparison.OrdinalIgnoreCase)))
                {
                    var body = new StackPanel();
                    var card = new Border { Style = (Style)FindResource("Card"), Child = body, Width = 286,
                        Margin = new Thickness(0, 0, 12, 12), Padding = new Thickness(14) };
                    body.Children.Add(new TextBlock { Text = info.Name, FontSize = 17, FontWeight = FontWeights.SemiBold,
                        TextWrapping = TextWrapping.Wrap });
                    body.Children.Add(Small(info.Author + "  ·  v" + info.Version));
                    body.Children.Add(Small(info.Description));
                    body.Children.Add(Small(info.CompatibilityLabel));
                    body.Children.Add(Small(info.IsPersona ? "类型：人设预设" :
                        info.HostAction == PluginMarket.DigestAction ? "权限：按次确认后生成聊天汇总" : "权限：仅本页输入"));
                    var buttons = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
                    body.Children.Add(buttons);
                    local.TryGetValue(info.Id, out var current);
                    if (_showInstalled)
                    {
                        var enabled = _market.Enabled(info.Id);
                        AddButton(buttons, enabled ? "停用" : "启用", () =>
                        {
                            _market.SetEnabled(info.Id, !enabled);
                            return Task.FromResult(enabled ? "已停用" : info.IsPersona
                                ? "已启用，点击「设置」可预览和应用人设。"
                                : "已启用，点击「设置」即可使用。");
                        });
                        AddButton(buttons, "卸载", () =>
                        {
                            _market.Uninstall(info.Id);
                            return Task.FromResult("已卸载");
                        }, false);
                        var settings = new Button { Content = "设置", Style = (Style)FindResource("Ghost"),
                            IsEnabled = enabled && PluginMarket.Compatible(info, _version) };
                        settings.Click += async (_, _) =>
                        {
                            if (info.IsPersona) await ShowPersonaSettings(info);
                            else ShowDetail(new PluginToolPage(_market, info, _sup));
                        };
                        buttons.Children.Add(settings);
                    }
                    else if (!PluginMarket.Compatible(info, _version))
                        body.Children.Add(Small("此版本与你的鲸鲸不兼容"));
                    else if (current == null || Version.Parse(info.Version) > Version.Parse(current.Version))
                        AddButton(buttons, current == null ? "安装" : "更新", async () =>
                        {
                            await _market.InstallAsync(info);
                            return "已安装 v" + info.Version + "，可在「已安装」管理。";
                        });
                    else body.Children.Add(Small("已安装"));
                    var listing = _showInstalled ? _catalog.FirstOrDefault(p => p.Id == info.Id) : info;
                    AddFeedback(body, listing?.DiscussionIssue ?? 0);
                    Cards.Children.Add(card);
                }
                if (Cards.Children.Count == 0)
                    Cards.Children.Add(Small(_showInstalled ? "没有符合条件的已安装插件。" : "没有符合条件的市场插件。"));
            }
            catch (Exception ex) { Status.Text = "读取插件失败：" + ex.Message; }
        }

        private void AddFeedback(Panel card, int issue)
        {
            if (issue <= 0)
            {
                card.Children.Add(Small("评论与收藏 · 暂未开放"));
                return;
            }
            _feedback.TryGetValue(issue, out var stats);
            var row = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 8, 0, 0) };
            card.Children.Add(row);
            AddButton(row, "评论 " + (stats?.Comments.ToString() ?? "—"), () => OpenFeedback(issue, "#new_comment_field"), false);
            AddButton(row, "♡ 收藏 " + (stats?.Favorites.ToString() ?? "—"), () => OpenFeedback(issue, ""), false);
        }

        private static Task<string> OpenFeedback(int issue, string fragment)
        {
            var url = $"https://github.com/Banan1cee/whale-girl-plugins/issues/{issue}{fragment}";
            using var browser = Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            return Task.FromResult("在 GitHub 登录后可以评论或点爱心。");
        }

        private async Task ShowPersonaSettings(PluginInfo info)
        {
            var panel = new StackPanel();
            panel.Children.Add(new TextBlock { Text = info.Name, Style = (Style)FindResource("H1") });
            var hint = Small(_sup.NodeRunning ? "正在加载预览…" : "请先启动内核，再打开设置预览和应用。");
            panel.Children.Add(hint);
            ShowDetail(panel);
            if (!_sup.NodeRunning) return;
            var id = "market-" + info.Id;
            var preview = await Api.Get(_sup.Url, "/api/persona/preset?id=" + Uri.EscapeDataString(id));
            if (!preview.Ok)
            {
                hint.Text = "预览失败：" + Api.Message(preview);
                return;
            }
            var patch = preview.Prop("patch");
            if (patch.ValueKind != JsonValueKind.Object || !patch.TryGetProperty("customPrompt", out var prompt)
                || prompt.ValueKind != JsonValueKind.String)
            {
                hint.Text = "没有可预览的人设正文。";
                return;
            }
            hint.Text = "预览人设正文。应用后会替换当前的自定义提示词。";
            panel.Children.Add(new TextBox
            {
                Text = prompt.GetString(), IsReadOnly = true, TextWrapping = TextWrapping.Wrap,
                MaxHeight = 280, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                Margin = new Thickness(0, 8, 0, 8)
            });
            var apply = new Button
            {
                Content = "应用此人设", Style = (Style)FindResource("Primary"),
                HorizontalAlignment = HorizontalAlignment.Left
            };
            panel.Children.Add(apply);
            apply.Click += async (_, _) =>
            {
                if (MessageBox.Show("将这份人设应用到当前鲸鲸？", "应用人设",
                    MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
                apply.IsEnabled = false;
                try
                {
                    var result = await Api.PostJson(_sup.Url, "/api/persona/preset", new { id });
                    hint.Text = result.Ok ? "已应用人设。" : "应用失败：" + Api.Message(result);
                }
                finally { apply.IsEnabled = true; }
            };
        }

        private void ShowDetail(object content)
        {
            DetailContent.Content = content;
            ListPanel.Visibility = Visibility.Collapsed;
            DetailPanel.Visibility = Visibility.Visible;
        }

        private void OnBack(object sender, RoutedEventArgs e)
        {
            DetailContent.Content = null;
            DetailPanel.Visibility = Visibility.Collapsed;
            ListPanel.Visibility = Visibility.Visible;
            Render();
        }

        private void OnDownloadGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginDownloadGuide");
        private void OnRulesGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginRulesGuide");
        private void OnAuthorGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginAuthorGuide");

        private void ShowGuide(string resource)
        {
            using var stream = typeof(PluginMarketPage).Assembly.GetManifestResourceStream("WhaleLauncher." + resource + ".md");
            using var reader = new StreamReader(stream);
            var text = Regex.Replace(reader.ReadToEnd(), @"(?m)^#{1,6} |^```.*$|\*\*|`", "");
            text = Regex.Replace(text, @"\[([^\]]+)\]\((https://[^)]+)\)", "$1（$2）");
            ShowDetail(new TextBox
            {
                Text = text, IsReadOnly = true, TextWrapping = TextWrapping.Wrap,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(12)
            });
        }

        private TextBlock Small(string text) => new()
        {
            Text = text, Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 6, 0, 0)
        };

        private void AddButton(Panel panel, string title, Func<Task<string>> action, bool primary = true)
        {
            var button = new Button { Content = title, Style = (Style)FindResource(primary ? "Primary" : "Ghost"),
                Margin = new Thickness(0, 0, 8, 0) };
            button.Click += async (_, _) => await WithStatus(action);
            panel.Children.Add(button);
        }
    }
}
