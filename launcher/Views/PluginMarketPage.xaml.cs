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
using System.Windows.Automation;
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
        private Dictionary<string, MarketFavorite> _favorites = new();
        private string _category = "";
        private bool _showInstalled;
        private bool _busy;

        internal PluginMarketPage(PluginMarket market, string version, RuntimeSupervisor sup)
        {
            _market = market;
            _sup = sup;
            _version = version;
            InitializeComponent();
            Loaded += async (_, _) =>
            {
                var config = await _sup.ReadConfigurationAsync("/api/features");
                if (config.Ok && config.Prop("features").ValueKind == JsonValueKind.Array)
                    JavaScriptEnabled.IsChecked = config.Prop("features").EnumerateArray()
                        .Any(f => f.GetProperty("key").GetString() == "javascriptPlugins" && f.GetProperty("value").ValueKind == JsonValueKind.True);
                if (_catalog.Length == 0) await RefreshCatalog();
            };
        }

        private async void OnJavaScriptEnabled(object sender, RoutedEventArgs e)
        {
            JavaScriptEnabled.IsEnabled = false;
            try
            {
                var result = await _sup.SaveConfigurationAsync("/api/features", new { key = "javascriptPlugins", value = JavaScriptEnabled.IsChecked == true });
                if (!result.Ok) { JavaScriptEnabled.IsChecked = JavaScriptEnabled.IsChecked != true; Status.Text = Api.Message(result); }
                else Status.Text = JavaScriptEnabled.IsChecked == true ? "总开关已开，仍需逐个确认插件权限。" : "已关闭 JavaScript 插件，未执行的插件发送将取消。";
            }
            catch (Exception ex) { JavaScriptEnabled.IsChecked = JavaScriptEnabled.IsChecked != true; Status.Text = Api.FriendlyError(ex); }
            finally { JavaScriptEnabled.IsEnabled = true; }
        }

        private async void OnRefresh(object sender, RoutedEventArgs e) => await RefreshCatalog();

        private Task RefreshCatalog() => WithStatus(async () =>
        {
            _catalog = await PluginMarket.CatalogAsync();
            Render();
            var feedback = OptionalMarketData(() => PluginMarket.FeedbackAsync(_catalog));
            var favorites = OptionalMarketData(() => _market.FavoritesAsync(_catalog.Select(plugin => plugin.Id)));
            _feedback = await feedback ?? _feedback;
            _favorites = await favorites ?? _favorites;
            return $"市场收录 {_catalog.Length} 个插件";
        });

        private static async Task<T> OptionalMarketData<T>(Func<Task<T>> load) where T : class
        {
            try { return await load(); }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidDataException or JsonException
                or OperationCanceledException or InvalidOperationException or KeyNotFoundException) { return null; }
        }

        private void OnSearch(object sender, TextChangedEventArgs e) => Render();
        private void OnDiscover(object sender, RoutedEventArgs e) { _showInstalled = false; Render(); }
        private void OnInstalled(object sender, RoutedEventArgs e) { _showInstalled = true; Render(); }

        private void OnCategory(object sender, RoutedEventArgs e)
        {
            if (sender is not Button { Tag: string category } || _category == category) return;
            _category = category;
            Render();
        }

        private void OnToggleDocuments(object sender, RoutedEventArgs e)
        {
            var expanded = DocumentsPanel.Visibility != Visibility.Visible;
            SetDocumentsExpanded(expanded);
            if (expanded) MarketScroll.ScrollToTop();
        }

        private void SetDocumentsExpanded(bool expanded)
        {
            DocumentsPanel.Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
            DocumentsToggle.Content = expanded ? "文档（必看） ▴" : "文档（必看） ▾";
            AutomationProperties.SetHelpText(DocumentsToggle, expanded ? "收起文档列表" : "展开文档列表");
        }

        private async void OnLocal(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            var file = AppFilePicker.Open("选择鲸鲸插件包", ".zip");
            if (file == null) return;
            await WithStatus(async () =>
            {
                PluginInfo selected = null;
                var installed = await Task.Run(() => _market.InstallLocal(file, (info, current) => Dispatcher.Invoke(() =>
                {
                    selected = info;
                    return ConfirmLocalInstall(info, current);
                })));
                if (!installed) return "已取消安装。";
                if (selected?.IsPersona == true) _sup.NotifyPersonaChanged();
                _showInstalled = true;
                _category = "";
                Search.Clear();
                return "已安装，可在「已安装」里启用。";
            });
        }

        private bool ConfirmLocalInstall(PluginInfo info, PluginInfo current)
        {
            var kind = info.IsPersona ? "人设预设" : info.IsMessage ? "消息插件（启用后自动参与聊天）" : "功能工具";
            var details = $"{PluginMarket.SafeText(info.Name, 80)} · {info.Version}（{kind}）"
                + $"\n包内自报作者 · {PluginMarket.SafeText(info.Author, 80)}";
            if (info.IsMessage)
                details += "\n扩展点：" + string.Join("、", info.Hooks ?? Array.Empty<string>())
                    + "\n附加权限：" + string.Join("、", info.Permissions ?? Array.Empty<string>());
            if (current != null)
            {
                details += $"\n将替换已安装的「{PluginMarket.SafeText(current.Name, 80)}」{current.Version}。";
                if (!PluginMarket.SameAuthor(current.Author, info.Author))
                    details += $"\n⚠ 作者已变化：{PluginMarket.SafeText(current.Author, 80)} → {PluginMarket.SafeText(info.Author, 80)}。"
                        + "\n只有在确认新作者可信时才继续。";
            }
            if (info.IsPersona)
                details += "\n\n应用人设会替换包内包含的人设和表达设置。停用或卸载后，已应用的人设仍会保留。";
            return AppDialog.Confirm(Window.GetWindow(this),
                "此本地 ZIP 未经鲸鲸插件市场审核或签名。请确认你信任文件的提供者。\n\n" + details,
                "安装本地插件", danger: true, okText: "仍然安装");
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
            Cards.RowDefinitions.Clear();
            Discover.Style = (Style)FindResource(_showInstalled ? "Ghost" : "Primary");
            Installed.Style = (Style)FindResource(_showInstalled ? "Primary" : "Ghost");
            foreach (var button in Categories.Children.OfType<Button>())
            {
                var selected = Equals(button.Tag, _category);
                button.Style = (Style)FindResource(selected ? "Primary" : "Ghost");
                AutomationProperties.SetItemStatus(button, selected ? "已选择" : "");
            }
            try
            {
                var local = _market.Installed().ToDictionary(p => p.Id);
                var query = Search.Text.Trim();
                var entries = _showInstalled ? local.Values.AsEnumerable() : _catalog.AsEnumerable();
                var columns = Cards.ColumnDefinitions.Count;
                foreach (var info in entries.Where(p => (_category.Length == 0 || p.Kind == _category)
                    && (p.Name + " " + p.Author + " " + p.Description).Contains(query, StringComparison.OrdinalIgnoreCase)))
                {
                    var index = Cards.Children.Count;
                    var column = index % columns;
                    var body = new StackPanel();
                    var card = new Border { Style = (Style)FindResource("Card"), Child = body,
                        Margin = new Thickness(0, 0, column == columns - 1 ? 0 : 12, 12), Padding = new Thickness(14) };
                    var header = new DockPanel { LastChildFill = true };
                    var author = new StackPanel();
                    var documents = new Button
                    {
                        Content = "相关文档", Style = (Style)FindResource("Ghost"),
                        VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 0, 0)
                    };
                    DockPanel.SetDock(documents, Dock.Right);
                    documents.Click += (_, _) => ShowPluginDocuments(info, !_showInstalled ||
                        _catalog.Any(entry => entry.Id == info.Id && entry.Version == info.Version &&
                            entry.Api == info.Api && PluginMarket.SameAuthor(entry.Author, info.Author)));
                    header.Children.Add(documents);
                    author.Children.Add(new TextBlock { Text = PluginMarket.SafeText(info.Name, 80),
                        FontSize = 17, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
                    author.Children.Add(Small(PluginMarket.SafeText(info.Author, 80) + "  ·  v" + info.Version));
                    header.Children.Add(author);
                    body.Children.Add(header);
                    body.Children.Add(Small(PluginMarket.SafeText(info.Description, 600)));
                    body.Children.Add(Small(info.CompatibilityLabel));
                    // 市场签名暂时隐藏，卡片不再显示已签名 / 未签名目录的标注。
                    body.Children.Add(Small(info.IsJavaScript ? "权限：完整系统权限（网络、文件、命令与全部主程序 API）" : info.IsMessage ? "消息插件：启用后自动参与聊天；权限见设置" : info.IsPersona ? "类型：人格预设" :
                        info.HostAction == PluginMarket.DigestAction ? "权限：按次确认后生成聊天汇总" : "权限：仅本页输入"));
                    var buttons = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
                    body.Children.Add(buttons);
                    local.TryGetValue(info.Id, out var current);
                    if (_showInstalled)
                    {
                        var enabled = _market.Enabled(info.Id);
                        AddButton(buttons, enabled ? "停用" : "启用", () =>
                        {
                            if (!enabled && info.IsJavaScript && !AppDialog.Confirm(Window.GetWindow(this),
                                "此 JavaScript 插件会以当前 Windows 用户权限执行。它可以使用网络、读写文件、执行系统命令，读取或更改主程序设置、聊天和记忆，并主动发送消息。\n请只启用信任的作者。上架和扫描不保证安全。\n停用可停止受管理的进程，但无法撤销已经完成的操作或保证停止插件自行启动的独立服务。",
                                "授权 JavaScript 插件", okText: "信任并启用", warningText: "完整系统权限：请核对插件来源"))
                                return Task.FromResult("已取消启用");
                            if (!enabled && info.IsMessage && !AppDialog.Confirm(Window.GetWindow(this),
                                "此插件将自动读取收到的消息、发送者及上一条回复，并参与聊天处理。\n扩展点："
                                + string.Join("、", info.Hooks ?? Array.Empty<string>())
                                + "\n附加权限：" + string.Join("、", info.Permissions ?? Array.Empty<string>())
                                + "\n授权持续到停用插件。是否启用？", "启用消息插件", okText: "启用"))
                                return Task.FromResult("已取消启用");
                            _market.SetEnabled(info.Id, !enabled, fullAccessApproved: info.IsJavaScript);
                            if (info.IsPersona) _sup.NotifyPersonaChanged();
                            return Task.FromResult(enabled ? "已停用" : info.IsJavaScript
                                ? "插件已授权；还需打开 JavaScript 总开关并启动内核。" : info.IsPersona
                                ? "已启用，可在人设页选择，也可点「设置」预览和应用。"
                                : "已启用，点击「设置」即可使用。");
                        });
                        AddButton(buttons, "卸载", () =>
                        {
                            _market.Uninstall(info.Id);
                            if (info.IsPersona) _sup.NotifyPersonaChanged();
                            return Task.FromResult("已卸载");
                        }, false);
                        var settings = new Button { Content = "设置", Style = (Style)FindResource("Ghost"),
                            IsEnabled = (enabled || info.IsFlow) && PluginMarket.Compatible(info, _version, UpdateManifestService.LocalEpoch(_sup.BaseDir)) };
                        settings.Click += async (_, _) =>
                        {
                            if (info.IsFlow) ShowMessageSettings(info);
                            else if (info.IsPersona) await ShowPersonaSettings(info);
                            else ShowDetail(new PluginToolPage(_market, info, _sup));
                        };
                        buttons.Children.Add(settings);
                    }
                    else if (!PluginMarket.Compatible(info, _version, UpdateManifestService.LocalEpoch(_sup.BaseDir)))
                        body.Children.Add(Small("此版本与你的鲸鲸不兼容"));
                    else if (current != null && !PluginMarket.SameAuthor(current.Author, info.Author))
                        body.Children.Add(Small("作者与已安装版本不一致，请先卸载旧版本再安装"));
                    else if (current == null || Version.Parse(info.Version) > Version.Parse(current.Version))
                        AddButton(buttons, current == null ? "安装" : "更新", async () =>
                        {
                            await _market.InstallAsync(info);
                            if (info.IsPersona) _sup.NotifyPersonaChanged();
                            return "已安装 v" + info.Version + "，可在「已安装」管理。";
                        });
                    else body.Children.Add(Small("已安装"));
                    var listing = _showInstalled ? _catalog.FirstOrDefault(p => p.Id == info.Id) : info;
                    if (listing != null) AddMarketActivity(body, listing);
                    if (column == 0) Cards.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                    Grid.SetRow(card, index / columns);
                    Grid.SetColumn(card, column);
                    Cards.Children.Add(card);
                }
                if (Cards.Children.Count == 0)
                {
                    var empty = Small(_showInstalled ? "没有符合条件的已安装插件。" : "没有符合条件的市场插件。");
                    Grid.SetColumnSpan(empty, columns);
                    Cards.Children.Add(empty);
                }
            }
            catch (Exception ex) { Status.Text = "读取插件失败：" + ex.Message; }
        }

        private void AddMarketActivity(Panel card, PluginInfo listing)
        {
            var issue = listing.DiscussionIssue;
            var row = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 8, 0, 0) };
            card.Children.Add(row);
            if (issue > 0)
            {
                _feedback.TryGetValue(issue, out var stats);
                AddButton(row, "评论 " + (stats?.Comments.ToString() ?? "—"), () => OpenFeedback(issue), false);
            }

            _favorites.TryGetValue(listing.Id, out var favorite);
            var favorited = favorite?.Favorited == true;
            AddButton(row, (favorited ? "♥ 已收藏 " : "♡ 收藏 ") + (favorite?.Count.ToString("N0") ?? "—"), async () =>
            {
                var saved = await _market.SetFavoriteAsync(listing.Id, !favorited);
                _favorites[listing.Id] = saved;
                return saved.Favorited ? "已收藏" : "已取消收藏";
            }, false);
        }

        private static Task<string> OpenFeedback(int issue)
        {
            var url = $"https://github.com/Banan1cee/whale-girl-plugins/issues/{issue}#new_comment_field";
            using var browser = Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            return Task.FromResult("在 GitHub 登录后可以评论。");
        }

        private async Task ShowPersonaSettings(PluginInfo info)
        {
            var panel = new StackPanel();
            panel.Children.Add(new TextBlock { Text = PluginMarket.SafeText(info.Name, 80), Style = (Style)FindResource("H1") });
            var hint = Small("正在加载预览…");
            panel.Children.Add(hint);
            ShowDetail(panel);
            var id = "market-" + info.Id;
            var preview = await _sup.PreviewPersonaPresetAsync(id);
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
            hint.Text = "应用人设及其表达、长度设置。应用后可在人设页直接修改，本地修改不影响原始下载包。";
            panel.Children.Add(new TextBox
            {
                Text = PluginMarket.SafeMultiline(prompt.GetString()), IsReadOnly = true, TextWrapping = TextWrapping.Wrap,
                MaxHeight = 280, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                Margin = new Thickness(0, 8, 0, 8)
            });
            panel.Children.Add(new TextBox
            {
                Text = patch.GetRawText(), IsReadOnly = true, TextWrapping = TextWrapping.Wrap,
                MaxHeight = 180, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                Margin = new Thickness(0, 0, 0, 8)
            });
            var apply = new Button
            {
                Content = "应用此人设", Style = (Style)FindResource("Primary"),
                HorizontalAlignment = HorizontalAlignment.Left
            };
            panel.Children.Add(apply);
            apply.Click += async (_, _) =>
            {
                if (!AppDialog.Confirm(Window.GetWindow(this), "将这份人设应用到当前鲸鲸？", "应用人设",
                    okText: "应用")) return;
                apply.IsEnabled = false;
                try
                {
                    var result = await _sup.SaveConfigurationAsync("/api/persona/preset", new { id });
                    if (result.Ok) _sup.NotifyPersonaChanged();
                    hint.Text = result.Ok ? "已应用人设。" : "应用失败：" + Api.Message(result);
                }
                finally { apply.IsEnabled = true; }
            };
        }

        private void ShowDetail(object content)
        {
            SetDocumentsExpanded(false);
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
        private void OnDisclaimer(object sender, RoutedEventArgs e) => ShowGuide("PluginDisclaimer");

        private void ShowPluginDocuments(PluginInfo info, bool inCatalog)
        {
            var body = new DockPanel { Margin = new Thickness(12) };
            var heading = Small(PluginMarket.SafeText(info.Name, 80) + " · 相关文档");
            DockPanel.SetDock(heading, Dock.Top);
            body.Children.Add(heading);
            if (!inCatalog)
            {
                body.Children.Add(Small("这个安装版本没有匹配的市场文档。"));
                ShowDetail(body);
                return;
            }

            var tabs = new WrapPanel { Margin = new Thickness(0, 10, 0, 10) };
            DockPanel.SetDock(tabs, Dock.Top);
            body.Children.Add(tabs);
            var readme = new Button { Content = "README", Margin = new Thickness(0, 0, 8, 0) };
            var tutorial = new Button { Content = "使用教程" };
            tabs.Children.Add(readme);
            tabs.Children.Add(tutorial);
            var viewer = new TextBox
            {
                IsReadOnly = true, TextWrapping = TextWrapping.Wrap,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(12)
            };
            body.Children.Add(viewer);

            var request = 0;
            async Task LoadAsync(bool showTutorial)
            {
                var current = ++request;
                readme.Style = (Style)FindResource(showTutorial ? "Ghost" : "Primary");
                tutorial.Style = (Style)FindResource(showTutorial ? "Primary" : "Ghost");
                viewer.Text = "正在读取文档…";
                string content;
                try
                {
                    var text = await PluginMarket.ReadDocumentAsync(info.Id, showTutorial);
                    content = string.IsNullOrWhiteSpace(text)
                        ? (showTutorial ? "作者还没有提供独立教程，可查看 README。" : "作者还没有提供 README，可查看使用教程。")
                        : text;
                }
                catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidDataException or OperationCanceledException)
                {
                    content = "文档暂时无法读取，请检查网络后点选重试。";
                }
                if (current != request || !ReferenceEquals(DetailContent.Content, body)) return;
                viewer.Text = content;
                viewer.ScrollToHome();
            }

            readme.Click += async (_, _) => await LoadAsync(false);
            tutorial.Click += async (_, _) => await LoadAsync(true);
            ShowDetail(body);
            _ = LoadAsync(false);
        }

        private void ShowMessageSettings(PluginInfo info)
        {
            var body = new StackPanel { Margin = new Thickness(12) };
            body.Children.Add(Small(PluginMarket.SafeText(info.Name, 80) + " · 消息流程设置"));
            body.Children.Add(Small("扩展点：" + string.Join("、", info.Hooks ?? Array.Empty<string>())
                + "\n附加权限：" + string.Join("、", info.Permissions ?? Array.Empty<string>())));
            body.Children.Add(Small("在卡片「相关文档」查阅作者提供的配置样例。这里保存的是插件的 JSON 设置，有配置项时可按样例填写。"));
            body.Children.Add(Small("没有配置项时可保留 {}。保存后的设置会用于后续调用。"));
            var editor = new TextBox { Text = _market.MessageSettings(info.Id), AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap, MinHeight = 160, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            body.Children.Add(editor);
            var buttons = new WrapPanel();
            AddButton(buttons, "保存设置", () => { _market.SetMessageSettings(info.Id, editor.Text); return Task.FromResult("已保存"); });
            AddButton(buttons, "返回插件市场", () => { OnBack(this, new RoutedEventArgs()); return Task.FromResult(""); }, false);
            body.Children.Add(buttons);
            if (info.IsJavaScript && (info.Hooks ?? []).Contains("tool.run"))
            {
                body.Children.Add(Small("手动运行（输入 JSON；需要内核已启动、总开关和插件均已启用）"));
                var input = new TextBox { Text = "{}", AcceptsReturn = true, MinHeight = 70, TextWrapping = TextWrapping.Wrap };
                var result = new TextBox { IsReadOnly = true, AcceptsReturn = true, MinHeight = 100, TextWrapping = TextWrapping.Wrap };
                body.Children.Add(input);
                var actions = new WrapPanel();
                AddButton(actions, "运行一次", async () =>
                {
                    if (!_sup.NodeRunning) throw new InvalidOperationException("请先启动鲸鲸内核");
                    using var payload = JsonDocument.Parse(input.Text);
                    var response = await Api.PostJson(_sup.Url, "/api/plugins/run", new { id = info.Id, input = payload.RootElement }, 125);
                    if (!response.Ok) throw new InvalidOperationException(Api.Message(response));
                    result.Text = response.Prop("result").ToString();
                    return "运行完成";
                });
                body.Children.Add(actions); body.Children.Add(result);
            }
            ShowDetail(body);
        }
        private void OnRulesGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginRulesGuide");
        private void OnSecurityGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginSecurityGuide");
        private void OnAuthorGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginAuthorGuide");
        private void OnMessageGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginMessageGuide");
        private void OnJavaScriptGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginJavaScriptGuide");

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
