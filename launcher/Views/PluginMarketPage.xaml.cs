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
using System.Windows.Threading;
using System.Windows.Media;
using System.Windows.Input;
using System.Windows.Controls.Primitives;
using System.Threading;
using System.Text;

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
        private PluginReadmeView _detailReadme;
        private double _listScrollOffset;
        private readonly List<Border> _cards = new();
        private TextBlock _emptyCardMessage;
        private double _cardGridWidth = double.NaN;
        private double _cardHeight;
        private int _cardColumns;

        internal PluginMarketPage(PluginMarket market, string version, RuntimeSupervisor sup)
        {
            _market = market;
            _sup = sup;
            _version = version;
            InitializeComponent();
            // 可用宽度以 ScrollViewer 视口为准：滚动条出现/消失时视口已经扣掉滚动条，
            // 再手动减一次 VerticalScrollBarWidth 会少算一列宽度或横向溢出。
            MarketScroll.SizeChanged += (_, _) => ApplyCardGrid(MarketScroll.ViewportWidth);
            MarketScroll.ScrollChanged += OnMarketScrollChanged;
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
            + (info.RequiresChatAccess ? "\n3 级聊天访问：读当前会话消息；按 dataAccess 可能读系统提示词或最近 12 条历史；可在发送前改写回复、或在生成前参与是否回复的判断（受限 Wasm，不能联网、读写文件或执行命令）" : "")
            + (info.RequiresChatAccess ? "\n额外聊天数据：" + (info.DataAccess is { Length: > 0 } access
                ? string.Join("、", access.Select(ChatDataDisclosure)) : "无") : "")
            // 4 级没有单独的聊天确认弹窗，但 dataAccess 仍要在授权披露里单列，不能只写进文档。
            + (!info.RequiresChatAccess && info.DataAccess is { Length: > 0 } extra
                ? "\n额外聊天数据（随完整系统权限确认）：" + string.Join("、", extra.Select(ChatDataDisclosure)) : "");

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
            Cards.ColumnDefinitions.Clear();
            _cards.Clear();
            _emptyCardMessage = null;
            _cardGridWidth = double.NaN;
            _cardColumns = 0;
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
                foreach (var info in entries.Where(p => (_category.Length == 0 || (_category == "tool" ? (p.IsUnified && p.Provides?.ContainsKey("tool.run@1") == true) : _category == "message" ? (p.IsUnified && p.Provides?.Keys.Any(k => k.StartsWith("chat.", StringComparison.Ordinal)) == true) : p.Kind == _category))
                    && (p.Name + " " + p.Author + " " + p.Description).Contains(query, StringComparison.OrdinalIgnoreCase)))
                {
                    var card = BuildCard(info, local);
                    _cards.Add(card);
                    Cards.Children.Add(card);
                }
                if (_cards.Count == 0)
                {
                    _emptyCardMessage = Small(_showInstalled ? "没有符合条件的已安装插件。" : "没有符合条件的市场插件。");
                    Cards.Children.Add(_emptyCardMessage);
                }
                ApplyCardGrid(MarketScroll.ViewportWidth > 0 ? MarketScroll.ViewportWidth : Cards.ActualWidth);
            }
            catch (Exception ex) { Status.Text = "读取插件失败：" + ex.Message; }
        }

        /// <summary>四行卡片：标题、作者+版本、简介（≤20 个文本元素）、底行评论/收藏/安装。</summary>
        private Border BuildCard(PluginInfo info, IReadOnlyDictionary<string, PluginInfo> local)
        {
            var card = new Border
            {
                Style = (Style)FindResource("Card"),
                Padding = new Thickness(14),
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Top,
            };
            WireCardDetail(card, info);

            var body = new Grid();
            for (var row = 0; row < 3; row++) body.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            body.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var name = PluginMarket.SafeText(info.Name, 80);
            var title = new TextBlock
            {
                Text = name,
                FontSize = 17,
                FontWeight = FontWeights.SemiBold,
                TextWrapping = TextWrapping.NoWrap,
                TextTrimming = TextTrimming.CharacterEllipsis,
                ToolTip = name,
            };
            Grid.SetRow(title, 0);
            body.Children.Add(title);

            var author = Small(PluginMarket.SafeText(info.Author, 80) + "  ·  v" + info.Version);
            author.TextWrapping = TextWrapping.NoWrap;
            author.TextTrimming = TextTrimming.CharacterEllipsis;
            author.Margin = new Thickness(0, 2, 0, 0);
            // 兼容范围、等级和类型不占第五行，放进作者行的 Tooltip；完整能力披露在详情/授权弹窗。
            author.ToolTip = info.CompatibilityLabel + "\n"
                + (info.IsTheme ? "0 级 · 纯数据主题" : info.IsUnified ? PermissionLabel(info) : info.IsPersona ? "类型：人设预设" : "旧版插件（不可执行）");
            Grid.SetRow(author, 1);
            body.Children.Add(author);

            var descriptionText = PluginMarket.SafeText(info.Description, 600);
            var description = new TextBlock
            {
                Text = PluginCardLayout.Describe(descriptionText, PluginCardLayout.DescriptionLimit),
                Style = (Style)FindResource("Small"),
                TextWrapping = TextWrapping.NoWrap,
                TextTrimming = TextTrimming.CharacterEllipsis,
                Margin = new Thickness(0, 4, 0, 0),
                ToolTip = descriptionText,
            };
            Grid.SetRow(description, 2);
            body.Children.Add(description);

            var actions = new Grid { Margin = new Thickness(0, 8, 0, 0), VerticalAlignment = VerticalAlignment.Bottom };
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var activity = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            AddCardActivity(activity, info);
            Grid.SetColumn(activity, 0);
            actions.Children.Add(activity);

            var primary = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center,
            };
            AddCardPrimary(primary, info, local);
            Grid.SetColumn(primary, 2);
            actions.Children.Add(primary);

            Grid.SetRow(actions, 4);
            body.Children.Add(actions);
            card.Child = body;
            return card;
        }

        private void AddCardActivity(Panel panel, PluginInfo listing)
        {
            var issue = listing.DiscussionIssue;
            if (issue > 0)
            {
                _feedback.TryGetValue(issue, out var stats);
                AddCardButton(panel, "评论 " + CompactCount(stats?.Comments), () => OpenFeedback(issue), false);
            }

            _favorites.TryGetValue(listing.Id, out var favorite);
            var favorited = favorite?.Favorited == true;
            AddCardButton(panel, (favorited ? "♥ 已收藏 " : "♡ 收藏 ") + CompactCount(favorite?.Count), async () =>
            {
                var saved = await _market.SetFavoriteAsync(listing.Id, !favorited);
                _favorites[listing.Id] = saved;
                return saved.Favorited ? "已收藏" : "已取消收藏";
            }, false);
        }

        /// <summary>底行右侧只放安装状态；启用、设置、卸载等管理动作走详情，避免把四行撑乱。</summary>
        private void AddCardPrimary(Panel panel, PluginInfo info, IReadOnlyDictionary<string, PluginInfo> local)
        {
            if (_showInstalled)
            {
                // 主题没有执行体/权限，卡片只显示当前是否生效；启用/停用仍在详情里完成。
                panel.Children.Add(Small(info.IsTheme ? (ThemeActive(info) ? "已启用" : "已停用") : "已安装"));
                return;
            }
            if (!PluginMarket.Compatible(info, _version, UpdateManifestService.LocalEpoch(_sup.BaseDir)))
            {
                var note = Small("此版本与你的鲸鲸不兼容");
                note.ToolTip = info.CompatibilityLabel;
                panel.Children.Add(note);
                return;
            }
            local.TryGetValue(info.Id, out var current);
            if (current != null && !PluginMarket.SameAuthor(current.Author, info.Author))
            {
                var note = Small("作者不一致，请先卸载");
                note.ToolTip = "目录作者与已安装版本不一致，不能直接覆盖安装。";
                panel.Children.Add(note);
                return;
            }
            if (current == null)
            {
                AddCardButton(panel, "安装", async () =>
                {
                    await _market.InstallAsync(info);
                    if (info.IsPersona) _sup.NotifyPersonaChanged();
                    return "已安装 v" + info.Version + "，可在「已安装」管理。";
                });
            }
            else if (Version.TryParse(info.Version, out var directory) && Version.TryParse(current.Version, out var installed)
                && directory > installed)
            {
                AddCardButton(panel, "更新", async () =>
                {
                    await _market.InstallAsync(info);
                    if (info.IsPersona) _sup.NotifyPersonaChanged();
                    return "已安装 v" + info.Version + "，可在「已安装」管理。";
                });
            }
            else panel.Children.Add(Small("已安装"));
        }

        private void AddCardButton(Panel panel, string title, Func<Task<string>> action, bool primary = true)
        {
            var button = new Button
            {
                Content = title,
                Style = (Style)FindResource(primary ? "Primary" : "Ghost"),
                FontSize = 11,
                Padding = new Thickness(10, 5, 10, 5),
                Margin = new Thickness(0, 0, 6, 0),
            };
            button.Click += async (_, _) => await WithStatus(action);
            panel.Children.Add(button);
        }

        /// <summary>卡片里只留一位小数的万级数字，避免大数字把底行挤出卡片。</summary>
        private static string CompactCount(long? count)
        {
            if (count is not long value) return "—";
            if (value < 10000) return value.ToString("N0");
            return (value / 10000.0).ToString("0.#") + "万";
        }

        private void OnMarketScrollChanged(object sender, ScrollChangedEventArgs e)
        {
            // 滚动条出现/消失只改变视口宽度；高度变化不需要重排列。
            if (Math.Abs(e.ViewportWidthChange) > 0.01 || Math.Abs(e.ExtentWidthChange) > 0.01)
                ApplyCardGrid(e.ViewportWidth);
        }

        /// <summary>
        /// 把纯计算结果套到真实 Grid：列宽合计严格等于可用宽，卡片固定在同一槽位，
        /// 少量条目也不会把最后一张拉到整行。宽度未就绪时先不排版，等视口事件。
        /// </summary>
        private void ApplyCardGrid(double availableWidth)
        {
            if (!double.IsFinite(availableWidth) || availableWidth <= 0)
                availableWidth = MarketScroll.ViewportWidth > 0 ? MarketScroll.ViewportWidth : Cards.ActualWidth;
            var layout = PluginCardLayout.Compute(availableWidth);
            if (layout.CardWidth <= 0) return;
            var height = CardHeight();
            if (Math.Abs(_cardGridWidth - availableWidth) < 0.5 && _cardColumns == layout.Columns
                && Math.Abs(_cardHeight - height) < 0.5) return;
            _cardGridWidth = availableWidth;
            _cardColumns = layout.Columns;
            _cardHeight = height;

            // 明确给 Grid 宽度：否则固定列宽会让它在 ScrollViewer 里保留旧的期望宽度，
            // 窗口缩小时 Grid 被按旧宽度安排，卡片区不再响应。
            Cards.Width = availableWidth;
            Cards.HorizontalAlignment = HorizontalAlignment.Left;
            Cards.ColumnDefinitions.Clear();
            foreach (var width in layout.ColumnWidths)
                Cards.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(width) });

            Cards.RowDefinitions.Clear();
            var rows = PluginCardLayout.Rows(_cards.Count, layout.Columns);
            for (var row = 0; row < rows; row++)
                Cards.RowDefinitions.Add(new RowDefinition { Height = new GridLength(height + PluginCardLayout.Gap) });

            for (var index = 0; index < _cards.Count; index++)
            {
                var card = _cards[index];
                card.Width = layout.CardWidth;
                card.Height = height;
                card.Margin = new Thickness(0, 0, 0, PluginCardLayout.Gap);
                Grid.SetColumn(card, index % layout.Columns);
                Grid.SetRow(card, index / layout.Columns);
            }
            if (_emptyCardMessage != null) Grid.SetColumnSpan(_emptyCardMessage, layout.Columns);
        }

        private double CardHeight()
        {
            var small = TryFindResource("FontSizeSmall");
            var size = small is double value && value > 0 ? value : 11.0;
            return PluginCardLayout.CardHeight(size / 11.0);
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

        private void WireCardDetail(Border card, PluginInfo info)
        {
            card.Cursor = Cursors.Hand;
            card.MouseLeftButtonUp += (_, args) =>
            {
                // 卡片里的按钮、文档入口、评论/收藏不能顺带打开详情。
                if (FindButtonAncestor(args.OriginalSource as DependencyObject) != null) return;
                ShowPluginDetail(info);
            };
        }

        private static DependencyObject FindButtonAncestor(DependencyObject source)
        {
            while (source != null)
            {
                if (source is ButtonBase) return source;
                if (source is Visual || source is System.Windows.Media.Media3D.Visual3D)
                {
                    try { source = VisualTreeHelper.GetParent(source); }
                    catch (InvalidOperationException) { return null; }
                }
                else if (source is FrameworkContentElement content) source = content.Parent;
                else return null;
            }
            return null;
        }

        private static void OpenHttpsLink(string url)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
                || uri.Scheme != Uri.UriSchemeHttps || !uri.IsDefaultPort || uri.UserInfo.Length != 0)
                throw new InvalidDataException("链接不是受支持的 HTTPS 地址");
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }

        /// <summary>页内二级详情：标题、版本、作者、更新时间、简介、动作行和 README；不新建窗口。</summary>
        private async void ShowPluginDetail(PluginInfo info)
        {
            var installed = _market.Installed().FirstOrDefault(item => item.Id == info.Id);
            var enabled = installed != null && (info.IsTheme ? ThemeActive(installed) : _market.Enabled(info.Id));
            var currentVersion = installed == null ? "未安装" : "v" + installed.Version;
            var versionLine = "目录版本：v" + info.Version + "　当前版本：" + currentVersion;
            if (installed != null && Version.TryParse(info.Version, out var directory)
                && Version.TryParse(installed.Version, out var current) && directory > current)
                versionLine += "　可更新";

            var body = new DockPanel { Margin = new Thickness(12) };
            var scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
            var content = new StackPanel();
            scroll.Content = content;
            body.Children.Add(scroll);

            content.Children.Add(new TextBlock
            {
                Text = PluginMarket.SafeText(info.Name, 80), Style = (Style)FindResource("H1"),
                TextWrapping = TextWrapping.Wrap,
            });
            content.Children.Add(Small(versionLine));
            content.Children.Add(Small("作者：" + PluginMarket.SafeText(info.Author, 80)));
            content.Children.Add(Small("上次更新：" + (string.IsNullOrWhiteSpace(info.Display?.UpdatedAt)
                ? "暂未提供" : info.Display.UpdatedAt)));
            content.Children.Add(Small(PluginMarket.SafeText(info.Description, 600)));

            var actions = new WrapPanel { Margin = new Thickness(0, 10, 0, 4) };
            content.Children.Add(actions);
            // 卡片改成四行后不再放「相关文档」；入口跟着详情走，避免丢掉目录文档。
            var inCatalog = !_showInstalled || _catalog.Any(entry => entry.Id == info.Id && entry.Version == info.Version
                && entry.Api == info.Api && PluginMarket.SameAuthor(entry.Author, info.Author));
            AddDetailActions(actions, info, installed, enabled, inCatalog);

            var readmeHost = new StackPanel();
            content.Children.Add(readmeHost);
            ShowDetail(body);

            if (info.Display?.Readme == null)
            {
                readmeHost.Children.Add(Small("暂无图文介绍"));
                return;
            }

            _detailReadme = new PluginReadmeView();
            readmeHost.Children.Add(_detailReadme);
            var loading = Small("正在读取图文介绍…");
            readmeHost.Children.Add(loading);
            try
            {
                var asset = await PluginCatalog.FetchReadmeAsync(info);
                if (!ReferenceEquals(DetailContent.Content, body)) return;
                if (asset.Bytes == null)
                {
                    loading.Text = "暂无图文介绍";
                    _detailReadme.Visibility = Visibility.Collapsed;
                    return;
                }
                await _detailReadme.ShowAsync(new PluginReadmeContent
                {
                    Markdown = Encoding.UTF8.GetString(asset.Bytes),
                    SourceLabel = "README.md（目录）",
                    LoadImage = async (src, _) =>
                    {
                        var image = await PluginCatalog.FetchImageAsync(info, src);
                        return image.Bytes == null
                            ? PluginReadmeResource.Failure(image.Error ?? "图片加载失败")
                            : new PluginReadmeResource(image.Bytes, null, null);
                    },
                    OpenLink = OpenHttpsLink,
                });
                loading.Visibility = Visibility.Collapsed;
            }
            catch (Exception ex)
            {
                loading.Text = "暂无图文介绍";
                if (_detailReadme != null) _detailReadme.Visibility = Visibility.Collapsed;
                Status.Text = "图文介绍加载失败：" + PluginMarket.SafeText(ex.Message, 160);
            }
        }

        private void AddDetailActions(Panel actions, PluginInfo info, PluginInfo installed, bool enabled, bool inCatalog)
        {
            var compatible = PluginMarket.Compatible(info, _version, UpdateManifestService.LocalEpoch(_sup.BaseDir));
            var newer = installed != null && Version.TryParse(info.Version, out var directory)
                && Version.TryParse(installed.Version, out var current) && directory > current;
            if (installed == null || newer)
            {
                if (!compatible) actions.Children.Add(Small("此版本与你的鲸鲸不兼容"));
                else if (installed != null && !PluginMarket.SameAuthor(installed.Author, info.Author))
                    actions.Children.Add(Small("作者与已安装版本不一致，请先卸载旧版本再安装"));
                else AddButton(actions, installed == null ? "安装" : "更新", async () =>
                {
                    await _market.InstallAsync(info);
                    if (info.IsPersona) _sup.NotifyPersonaChanged();
                    ShowPluginDetail(info);
                    return "已安装 v" + info.Version;
                });
            }
            else actions.Children.Add(Small("已安装目录版本"));

            if (installed != null)
            {
                AddButton(actions, enabled ? "停用" : "启用",
                    () => ToggleDetailPlugin(info, installed, enabled), false);
                if (!info.IsTheme && (info.IsUnified || (enabled && info.IsPersona)) && compatible)
                {
                    var settings = new Button
                    {
                        Content = "设置", Style = (Style)FindResource("Ghost"),
                        Margin = new Thickness(0, 0, 8, 0),
                    };
                    settings.Click += async (_, _) => await ShowSettings(installed);
                    actions.Children.Add(settings);
                }
                AddButton(actions, "卸载", async () =>
                {
                    if (info.IsTheme && ThemeActive(installed) && !Appearance.ClearThemePackage(out var error))
                        throw new InvalidOperationException(error);
                    _market.Uninstall(installed.Id);
                    OnBack(this, new RoutedEventArgs());
                    return "已卸载";
                }, false);
            }

            var afdian = PluginMarket.AfdianPersonalPage(info.Display?.Donation?.Afdian);
            if (afdian != null)
            {
                var donation = new Button
                {
                    Content = "支持作者（爱发电）", Style = (Style)FindResource("Ghost"),
                    Margin = new Thickness(0, 0, 8, 0),
                    ToolTip = "作者自行提供的爱发电个人主页，未验证链接与作者身份的关系；点击后在系统浏览器打开，不在应用内付款。",
                };
                donation.Click += (_, _) =>
                {
                    try { OpenHttpsLink(afdian); }
                    catch (Exception ex) { Status.Text = "打开链接失败：" + PluginMarket.SafeText(ex.Message, 160); }
                };
                actions.Children.Add(donation);
            }

            if (inCatalog)
                AddButton(actions, "相关文档", () => { ShowPluginDocuments(info, inCatalog); return Task.FromResult(""); }, false);
        }

        /// <summary>详情里的设置入口：仍走原设置面板/人设预览，不新增权限或写入路径。</summary>
        private async Task ShowSettings(PluginInfo info)
        {
            if (info.IsUnified) ShowMessageSettings(info);
            else await ShowPersonaSettings(info);
        }

        private async Task<string> ToggleDetailPlugin(PluginInfo info, PluginInfo installed, bool enabled)
        {
            if (info.IsTheme)
            {
                if (enabled)
                {
                    if (!Appearance.ClearThemePackage(out var clearError)) throw new InvalidOperationException(clearError);
                    return "已停用主题，恢复内置外观。";
                }
                var theme = ReadTheme(installed);
                if (!Appearance.SetThemePackage(theme, out var applyError, installed.Id))
                    throw new InvalidOperationException(applyError);
                return "已启用主题。外观设置页只提供预览，管理统一走插件卡片。";
            }

            var full = false;
            var chat = false;
            if (!enabled && info.RequiresFullAccess)
            {
                full = AppDialog.Confirm(Window.GetWindow(this),
                    "此插件以当前 Windows 用户权限执行，不是沙箱。它可以访问网络、文件和系统命令。声明的调用仅约束宿主 SDK，不限制代码本身。停用权限不能撤销既有副作用。\n\n"
                    + CapabilityDetails(info), "授权 4 级插件", danger: true, okText: "确认完整系统权限并启用");
                if (!full) return "已取消启用";
            }
            if (!enabled && info.RequiresChatAccess)
            {
                chat = AppDialog.Confirm(Window.GetWindow(this),
                    "此插件在受限 Wasm 环境运行，会读取当前会话消息；按声明还可能读取本轮系统提示词或最近 12 条会话历史，并可能在发送前改写回复、或在生成前参与是否回复的判断。它不能直接联网、读写文件或执行系统命令。\n\n"
                    + CapabilityDetails(info), "授权 3 级插件", okText: "允许访问当前聊天并启用", critical: true);
                if (!chat) return "已取消启用";
            }
            _market.SetEnabled(info.Id, !enabled, full, chat);
            return enabled ? "已停用" : "已启用。";
        }

        private void CloseDetailReadme()
        {
            _detailReadme?.Close();
            _detailReadme = null;
        }

        private void ShowDetail(object content)
        {
            // 只有从列表进入详情时才记录列表位置；详情内切设置/文档不能覆盖原位置。
            if (ListPanel.Visibility == Visibility.Visible) _listScrollOffset = MarketScroll.VerticalOffset;
            CloseDetailReadme();
            SetDocumentsExpanded(false);
            DetailContent.Content = content;
            ListPanel.Visibility = Visibility.Collapsed;
            DetailPanel.Visibility = Visibility.Visible;
        }

        private void OnBack(object sender, RoutedEventArgs e)
        {
            CloseDetailReadme();
            DetailContent.Content = null;
            DetailPanel.Visibility = Visibility.Collapsed;
            ListPanel.Visibility = Visibility.Visible;
            Render();
            var offset = _listScrollOffset;
            Dispatcher.BeginInvoke(new Action(() =>
            {
                // 重建卡片后先让 ScrollViewer 量出新的可滚动高度，否则 ScrollToVerticalOffset
                // 会被钳成 0，看起来就像没恢复。
                MarketScroll.UpdateLayout();
                MarketScroll.ScrollToVerticalOffset(offset);
            }), DispatcherPriority.Loaded);
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
