using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
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
            TryMigrateLegacyThemeAfterGate();
            Loaded += async (_, _) =>
            {
                var config = await _sup.ReadConfigurationAsync("/api/features");
                if (config.Ok && config.Prop("features").ValueKind == JsonValueKind.Array)
                    PluginsEnabled.IsChecked = config.Prop("features").EnumerateArray()
                        .Any(f => f.GetProperty("key").GetString() == "plugins" && f.GetProperty("value").ValueKind == JsonValueKind.True);
                if (_catalog.Length == 0) await RefreshCatalog();
            };
        }

        private LauncherTheme ReadTheme(PluginInfo info) => LauncherThemes.Parse(_market.ThemeBytes(info));

        private bool ThemeActive(PluginInfo info)
        {
            // 已安装包被覆盖更新时，仍可停用/卸载这个 ID 当前生效的快照。
            return info?.IsTheme == true && Appearance.ActiveTheme != null
                && string.Equals(Appearance.ThemeOwner, info.Id, StringComparison.Ordinal);
        }

        /// <summary>把旧版独立 launcher-theme.json 迁成 0 级纯数据插件，保留原文件；重复调用幂等。</summary>
        private string MigrateLegacyTheme(LauncherTheme active)
        {
            if (active == null) return "";
            var digest = LauncherThemes.VisualDigest(active);
            if (digest.Length < 8) return "";
            var id = "legacy-theme-" + digest[..8];
            if (_market.Installed().Any(info => string.Equals(info.Id, id, StringComparison.Ordinal))) return id;
            var copy = new LauncherTheme
            {
                Id = id,
                Name = string.IsNullOrWhiteSpace(active.Name) ? "本机旧版主题" : active.Name,
                Author = "本机迁移",
                Version = "1.0.0",
                FontFamily = active.FontFamily,
                FontScale = active.FontScale,
                Corner = active.Corner,
                Spacing = active.Spacing,
                DialogSurface = active.DialogSurface,
                DialogBorder = active.DialogBorder,
                DialogCorner = active.DialogCorner,
            };
            foreach (var pair in active.Colors) copy.Colors[pair.Key] = pair.Value;
            var manifest = JsonSerializer.SerializeToUtf8Bytes(new
            {
                format = "whale-plugin/1",
                level = 0,
                id,
                name = copy.Name,
                author = copy.Author,
                version = copy.Version,
                minAppVersion = "4.3.0",
                description = "从旧版独立主题迁移，纯数据显示，无执行体与系统权限",
                entry = "theme.json",
                runtime = "theme-data",
                provides = new Dictionary<string, object>(),
                calls = Array.Empty<string>(),
            });
            var theme = LauncherThemes.ToJsonBytes(copy);
            using var buffer = new MemoryStream();
            using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
            {
                using (var entry = zip.CreateEntry("plugin.json").Open()) entry.Write(manifest);
                using (var entry = zip.CreateEntry("theme.json").Open()) entry.Write(theme);
            }
            return _market.InstallThemePackage(buffer.ToArray());
        }

        /// <summary>免责声明放行后才迁移旧主题；已有插件所有权或已匹配到已安装主题时不新增 legacy 卡。</summary>
        private void TryMigrateLegacyThemeAfterGate()
        {
            try
            {
                var active = Appearance.ActiveTheme;
                if (active == null) return;
                if (!string.IsNullOrEmpty(Appearance.ThemeOwner)) return;
                var id = MigrateLegacyTheme(active);
                if (id.Length > 0) Appearance.SetThemeOwner(id);
                Render();
            }
            catch { /* 旧主题仍可继续生效；迁移失败留到下次明确进入 */ }
        }

        private static string PermissionLabel(PluginInfo info) =>
            PluginMarket.LevelName(info.Level) ?? "未知等级";

        private static string CapabilityDetails(PluginInfo info) =>
            "提供：" + string.Join("、", info.Provides.Select(pair => $"{pair.Key}（{pair.Value.Mode} / {pair.Value.Scope}"
                + (pair.Value.IntervalSeconds is int seconds ? $" / {seconds} 秒" : "") + "）"))
            + "\n调用：" + (info.Calls.Length == 0 ? "无" : string.Join("、", info.Calls.Select(call =>
                PluginMarket.HostCallEnabled(call) ? CallDisclosure(call) : call + "（宿主未开放，不会授权）")))
            + (info.RequiresChatAccess ? "\n额外聊天数据：" + (info.DataAccess is { Length: > 0 } access
                ? string.Join("、", access.Select(ChatDataDisclosure)) : "无") : "");

        private static string ChatDataDisclosure(string access) => access switch
        {
            "chat.history" => "当前会话最近 12 条聊天记录（chat.history）",
            "model.prompt" => "本轮系统提示词（model.prompt）",
            _ => access,
        };

        private static string CallDisclosure(string call) => call switch
        {
            "search.query@1" => "search.query@1（联网检索，可能产生服务商费用）",
            "model.complete@1" => "model.complete@1（调用当前模型，按服务商规则计费）",
            "status.read@1" => "status.read@1（读取版本与运行状态）",
            "digest.status@1" => "digest.status@1（读取消息汇总状态）",
            "diary.status@1" => "diary.status@1（读取日记生成状态）",
            "digest.generate@1" => "digest.generate@1（生成消息汇总，走模型计费）",
            "diary.generate@1" => "diary.generate@1（生成日记，走模型计费）",
            "diary.read@1" => "diary.read@1（读取日记正文）",
            "memory.recent@1" => "memory.recent@1（读取当前会话最近消息）",
            "memory.recall@1" => "memory.recall@1（检索长期记忆）",
            "memory.write@1" => "memory.write@1（写入长期记忆）",
            "reminders.list@1" => "reminders.list@1（读取提醒清单）",
            "reminders.rules@1" => "reminders.rules@1（读取提醒规则与今日额度）",
            "reminders.create@1" => "reminders.create@1（写一条提醒，到点由桥接发送）",
            "reminders.cancel@1" => "reminders.cancel@1（取消一条提醒）",
            "stickers.status@1" => "stickers.status@1（读取表情包状态）",
            "stickers.enqueue@1" => "stickers.enqueue@1（排队发一张表情包）",
            "contacts.search@1" => "contacts.search@1（搜索联系人/群）",
            "contacts.get@1" => "contacts.get@1（读取单个联系人）",
            "contacts.list@1" => "contacts.list@1（读取联系人列表）",
            "moments.latest@1" => "moments.latest@1（读取最近一次朋友圈快照）",
            "moments.snapshot@1" => "moments.snapshot@1（读取朋友圈快照）",
            "moments.request@1" => "moments.request@1（请求刷新朋友圈）",
            "moments.action@1" => "moments.action@1（对朋友圈点赞/评论）",
            "moments.result@1" => "moments.result@1（读取朋友圈操作结果）",
            "moments.publish@1" => "moments.publish@1（发表朋友圈）",
            "moments.settings@1" => "moments.settings@1（读取朋友圈设置）",
            "persona.read@1" => "persona.read@1（读取人设摘要）",
            "persona.write@1" => "persona.write@1（修改人设）",
            "settings.read@1" => "settings.read@1（读取设置）",
            "settings.write@1" => "settings.write@1（修改设置）",
            "features.read@1" => "features.read@1（读取功能开关）",
            "care.decide@1" => "care.decide@1（判定当前是否该主动搭话）",
            "wechat.status@1" => "wechat.status@1（读取微信网关状态）",
            "bridge.status@1" => "bridge.status@1（读取桥接在线状态）",
            "plugins.status@1" => "plugins.status@1（读取已安装插件摘要）",
            "message.send@1" => "message.send@1（向微信排队发送消息；排队不等于已送达）",
            _ => call,
        };

        private async void OnPluginsEnabled(object sender, RoutedEventArgs e)
        {
            PluginsEnabled.IsEnabled = false;
            try
            {
                var result = await _sup.SaveConfigurationAsync("/api/features", new { key = "plugins", value = PluginsEnabled.IsChecked == true });
                if (!result.Ok) { PluginsEnabled.IsChecked = PluginsEnabled.IsChecked != true; Status.Text = Api.Message(result); }
                else Status.Text = PluginsEnabled.IsChecked == true ? "总开关已开，仍需逐个确认插件权限。" : "已关闭统一协议插件。";
            }
            catch (Exception ex) { PluginsEnabled.IsChecked = PluginsEnabled.IsChecked != true; Status.Text = Api.FriendlyError(ex); }
            finally { PluginsEnabled.IsEnabled = true; }
        }

        private async void OnRefresh(object sender, RoutedEventArgs e) => await RefreshCatalog();

        private Task RefreshCatalog() => WithStatus(async () =>
        {
            _catalog = await PluginCatalog.CatalogAsync();
            Render();
            var feedback = OptionalMarketData(() => PluginCatalog.FeedbackAsync());
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
            var kind = info.IsPersona ? "人设预设" : PermissionLabel(info);
            var details = $"{PluginMarket.SafeText(info.Name, 80)} · {info.Version}（{kind}）"
                + $"\n包内自报作者 · {PluginMarket.SafeText(info.Author, 80)}";
            if (info.IsUnified) details += "\n" + CapabilityDetails(info);
            if (info.IsTheme) details += "\n纯数据主题：没有执行体、不申请系统权限，启用只改变启动器外观。";
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
                var entries = (_showInstalled ? local.Values.AsEnumerable() : _catalog.AsEnumerable()).Where(p => p.IsUnified || p.IsPersona || p.IsTheme);
                var columns = Cards.ColumnDefinitions.Count;
                foreach (var info in entries.Where(p => (_category.Length == 0 || (_category == "tool" ? (p.IsUnified && p.Provides?.ContainsKey("tool.run@1") == true) : _category == "message" ? (p.IsUnified && p.Provides?.Keys.Any(k => k.StartsWith("chat.", StringComparison.Ordinal)) == true) : p.Kind == _category))
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
                    body.Children.Add(Small(info.IsTheme ? "0 级 · 纯数据主题" : info.IsUnified ? PermissionLabel(info) : info.IsPersona ? "类型：人设预设" : "旧版插件（不可执行）"));
                    var buttons = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
                    body.Children.Add(buttons);
                    local.TryGetValue(info.Id, out var current);
                    if (_showInstalled)
                    {
                        var enabled = info.IsTheme ? ThemeActive(info) : _market.Enabled(info.Id);
                        if (info.IsTheme)
                        {
                            // 主题没有执行体/权限，不需要授权记录；启用=应用外观，停用=恢复内置。
                            AddButton(buttons, enabled ? "停用" : "启用", () =>
                            {
                                if (enabled)
                                {
                                    if (!Appearance.ClearThemePackage(out var clearError)) throw new InvalidOperationException(clearError);
                                    return Task.FromResult("已停用主题，恢复内置外观。");
                                }
                                var theme = ReadTheme(info);
                                if (!Appearance.SetThemePackage(theme, out var applyError, info.Id)) throw new InvalidOperationException(applyError);
                                return Task.FromResult("已启用主题。外观设置页只提供预览，管理统一走插件卡片。");
                            });
                            if (!info.IsTheme) AddButton(buttons, "卸载", () =>
                            {
                                if (enabled)
                                {
                                    if (!Appearance.ClearThemePackage(out var clearError)) throw new InvalidOperationException(clearError);
                                }
                                _market.Uninstall(info.Id);
                                return Task.FromResult("已卸载");
                            }, false);
                        }
                        else if (info.IsUnified || info.IsPersona) AddButton(buttons, enabled ? "停用" : "启用", () =>
                        {
                            var fullAccessApproved = false;
                            var chatAccessApproved = false;
                            if (!enabled && info.RequiresFullAccess)
                            {
                                fullAccessApproved = AppDialog.Confirm(Window.GetWindow(this),
                                    "此插件以当前 Windows 用户权限执行，不是沙箱。它可以访问网络、文件和系统命令。声明的调用仅约束宿主 SDK，不限制代码本身。停用权限不能撤销既有副作用。\n\n"
                                    + CapabilityDetails(info), "授权 4 级插件", danger: true, okText: "确认完整系统权限并启用");
                                if (!fullAccessApproved) return Task.FromResult("已取消启用");
                            }
                            if (!enabled && info.RequiresChatAccess)
                            {
                                chatAccessApproved = AppDialog.Confirm(Window.GetWindow(this),
                                    "此插件会自动收到当前聊天消息和回复草稿，并按声明的模式参与回复处理。它在受限 Wasm 环境运行，不能直接联网、读写文件或执行系统命令。\n\n"
                                    + CapabilityDetails(info), "授权 3 级插件", okText: "允许访问当前聊天并启用", critical: true);
                                if (!chatAccessApproved) return Task.FromResult("已取消启用");
                            }
                            _market.SetEnabled(info.Id, !enabled, fullAccessApproved, chatAccessApproved);
                            return Task.FromResult(enabled ? "已停用" : info.IsUnified
                                ? "插件已授权；还需打开插件总开关并启动内核。"
                                : "已启用，点击「设置」可预览和应用人设。");
                        });
                        if (!info.IsTheme) AddButton(buttons, "卸载", () =>
                        {
                            _market.Uninstall(info.Id);
                            return Task.FromResult("已卸载");
                        }, false);
                        if (info.IsTheme)
                        {
                            // 主题由插件卡片统一管理，不提供独立设置/授权入口。
                        }
                        else
                        {
                            var settings = new Button { Content = "设置", Style = (Style)FindResource("Ghost"),
                                IsEnabled = (info.IsUnified || (enabled && info.IsPersona)) && PluginMarket.Compatible(info, _version, UpdateManifestService.LocalEpoch(_sup.BaseDir)) };
                            settings.Click += async (_, _) =>
                            {
                                if (info.IsUnified) ShowMessageSettings(info);
                                else if (info.IsPersona) await ShowPersonaSettings(info);
                            };
                            buttons.Children.Add(settings);
                        }
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
            body.Children.Add(new TextBlock
            {
                Text = PluginMarket.SafeText(info.Name, 80) + " · 插件详情",
                Style = (Style)FindResource("H1"), TextWrapping = TextWrapping.Wrap,
            });
            body.Children.Add(Small(PluginMarket.SafeText(info.Id, 64) + " · v" + info.Version + " · " + PermissionLabel(info)));
            body.Children.Add(Small(PluginMarket.SafeText(info.Author, 80) + " · " + info.CompatibilityLabel));
            body.Children.Add(Small(CapabilityDetails(info)));
            var settings = _market.MessageSettings(info.Id);
            try
            {
                if (PluginDetailPanel.TryCreate(info, settings, json =>
                {
                    // 既有保存路径：校验、落盘，并在插件已启用时按原有规则重签授权。
                    _market.SetMessageSettings(info.Id, json);
                    return Task.FromResult("设置已保存；已启用插件会按现有规则更新授权代次。");
                }, RunUnifiedTool(info), out var panel, out var reason))
                {
                    body.Children.Add(panel);
                }
                else
                {
                    body.Children.Add(Small("已回退到原始 JSON 设置编辑器：" + PluginMarket.SafeText(reason, 160)));
                    AddRawMessageSettings(body, info, settings);
                }
            }
            catch (Exception ex)
            {
                body.Children.Add(Small("设置面板加载失败，已回退到原始 JSON 设置编辑器：" + PluginMarket.SafeText(ex.Message, 160)));
                AddRawMessageSettings(body, info, settings);
            }
            ShowDetail(body);
        }

        /// <summary>唯一的手动运行路径：仍走原来的 /api/plugins/run + tool.run@1，不新增权限或入口。</summary>
        private Func<string, Task<string>> RunUnifiedTool(PluginInfo info) => async inputText =>
        {
            if (!_sup.NodeRunning) throw new InvalidOperationException("请先启动鲸鲸内核");
            using var payload = JsonDocument.Parse(inputText);
            var response = await Api.PostJson(_sup.Url, "/api/plugins/run",
                new { id = info.Id, capability = "tool.run@1", input = payload.RootElement }, 125);
            if (!response.Ok) throw new InvalidOperationException(Api.Message(response));
            return response.Prop("result").ToString();
        };

        /// <summary>没有可渲染 schema、schema 不受支持或现有设置不合约时保留的原始编辑器。</summary>
        private void AddRawMessageSettings(StackPanel body, PluginInfo info, string settings)
        {
            body.Children.Add(Small("配置为 JSON 对象，应符合插件声明。保存设置不会为停用插件授予权限。"));
            var editor = new TextBox
            {
                Text = settings, AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap, MinHeight = 160, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            };
            body.Children.Add(editor);
            var buttons = new WrapPanel();
            AddButton(buttons, "保存设置", () =>
            {
                _market.SetMessageSettings(info.Id, editor.Text);
                return Task.FromResult("已保存");
            });
            AddButton(buttons, "返回插件市场", () => { OnBack(this, new RoutedEventArgs()); return Task.FromResult(""); }, false);
            body.Children.Add(buttons);
            if (info.Provides.ContainsKey("tool.run@1"))
            {
                body.Children.Add(Small("手动运行（输入 JSON；需要内核已启动、总开关和插件均已启用）"));
                var input = new TextBox { Text = "{}", AcceptsReturn = true, MinHeight = 70, TextWrapping = TextWrapping.Wrap };
                var result = new TextBox { IsReadOnly = true, AcceptsReturn = true, MinHeight = 100, TextWrapping = TextWrapping.Wrap };
                body.Children.Add(input);
                var actions = new WrapPanel();
                var runTool = RunUnifiedTool(info);
                AddButton(actions, "运行一次", async () =>
                {
                    result.Text = await runTool(input.Text);
                    return "运行完成";
                });
                body.Children.Add(actions); body.Children.Add(result);
            }
        }
        private void OnRulesGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginRulesGuide");
        private void OnSecurityGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginSecurityGuide");
        private void OnAuthorGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginAuthorGuide");
        private void OnProtocolGuide(object sender, RoutedEventArgs e) => ShowGuide("PluginProtocolGuide");


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
