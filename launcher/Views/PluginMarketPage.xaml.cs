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
        private bool _showDeveloper;
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
                    PluginsEnabled.IsChecked = config.Prop("features").EnumerateArray()
                        .Any(f => f.GetProperty("key").GetString() == "plugins" && f.GetProperty("value").ValueKind == JsonValueKind.True);
                if (_catalog.Length == 0) await RefreshCatalog();
            };
        }

        private async void OnPluginsEnabled(object sender, RoutedEventArgs e)
        {
            PluginsEnabled.IsEnabled = false;
            try
            {
                var result = await _sup.SaveConfigurationAsync("/api/features", new { key = "plugins", value = PluginsEnabled.IsChecked == true });
                if (!result.Ok) { PluginsEnabled.IsChecked = PluginsEnabled.IsChecked != true; Status.Text = Api.Message(result); }
                else Status.Text = PluginsEnabled.IsChecked == true ? "总开关已开，各插件仍须单独启用。" : "已关闭统一协议插件。";
            }
            catch (Exception ex) { PluginsEnabled.IsChecked = PluginsEnabled.IsChecked != true; Status.Text = Api.FriendlyError(ex); }
            finally { PluginsEnabled.IsEnabled = true; }
        }

        private async void OnRefresh(object sender, RoutedEventArgs e) => await RefreshCatalog();

        private Task RefreshCatalog() => WithStatus(async () =>
        {
            _catalog = await PluginCatalog.CatalogAsync();
            Render();
            if (_catalog.Any(info => info.DiscussionIssue > 0))
            {
                try { _feedback = await PluginCatalog.FeedbackAsync(); }
                catch (Exception ex) when (ex is HttpRequestException or InvalidDataException or JsonException
                    or OperationCanceledException or InvalidOperationException or KeyNotFoundException) { }
            }
            return $"市场收录 {_catalog.Length} 个插件";
        });

        private void OnSearch(object sender, TextChangedEventArgs e) => Render();
        private void OnDiscover(object sender, RoutedEventArgs e) { _showInstalled = false; _showDeveloper = false; Render(); }
        private void OnInstalled(object sender, RoutedEventArgs e) { _showInstalled = true; _showDeveloper = false; Render(); }
        private void OnDeveloper(object sender, RoutedEventArgs e) { _showInstalled = false; _showDeveloper = true; Render(); }

        private void OnMarketReadme(object sender, RoutedEventArgs e) => PluginDeveloperLinks.Open(PluginDeveloperLinks.Readme, Window.GetWindow(this));
        private void OnMarketExamples(object sender, RoutedEventArgs e) => PluginDeveloperLinks.Open(PluginDeveloperLinks.Examples, Window.GetWindow(this));
        private void OnMarketIssues(object sender, RoutedEventArgs e) => PluginDeveloperLinks.Open(PluginDeveloperLinks.Issues, Window.GetWindow(this));
        private void OnMarketSubmit(object sender, RoutedEventArgs e) => PluginDeveloperLinks.Open(PluginDeveloperLinks.Submit, Window.GetWindow(this));

        private async void OnValidatePackage(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            var file = AppFilePicker.Open("选择要校验的插件 ZIP", ".zip");
            if (file == null) return;
            ValidationResult.Text = "正在只读校验…";
            try
            {
                var package = await Task.Run(() => PluginMarket.ValidateLocal(file, _version,
                    UpdateManifestService.LocalEpoch(_sup.BaseDir)));
                var info = package.Info;
                var kind = info.IsPersona ? "人设预设" : PermissionLabel(info);
                ValidationResult.Text = $"ZIP 结构、清单和当前客户端兼容性通过。\n{PluginMarket.SafeText(info.Name, 80)} · {info.Id} · v{info.Version} · {kind}\n{info.CompatibilityLabel}"
                    + (info.IsUnified ? "\n" + CapabilityDetails(info) + "\n统一协议插件仅供本地试装，市场尚未开放投稿。" : "")
                    + "\n此操作未安装、启用或写入插件数据；仍需按市场要求提交源码、包和试装信息。";
            }
            catch (Exception ex) { ValidationResult.Text = "ZIP 校验失败：" + ex.Message; }
        }

        private async void OnLocal(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            var file = AppFilePicker.Open("选择鲸鲸插件包", ".zip");
            if (file == null) return;
            await WithStatus(async () =>
            {
                var installed = await Task.Run(() => _market.InstallLocal(file,
                    (info, current) => Dispatcher.Invoke(() => ConfirmLocalInstall(info, current))));
                if (!installed) return "已取消安装。";
                _showInstalled = true;
                return "已安装，可在「已安装」里启用。";
            });
        }

        private bool ConfirmLocalInstall(PluginInfo info, PluginInfo current)
        {
            var kind = info.IsPersona ? "人设预设" : PermissionLabel(info);
            var details = $"{PluginMarket.SafeText(info.Name, 80)} · {info.Version}（{kind}）"
                + $"\n包内自报作者 · {PluginMarket.SafeText(info.Author, 80)}";
            if (info.IsUnified) details += "\n" + CapabilityDetails(info);
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
            Discover.Style = (Style)FindResource(!_showInstalled && !_showDeveloper ? "Primary" : "Ghost");
            Installed.Style = (Style)FindResource(_showInstalled ? "Primary" : "Ghost");
            Developer.Style = (Style)FindResource(_showDeveloper ? "Primary" : "Ghost");
            CardsScroll.Visibility = _showDeveloper ? Visibility.Collapsed : Visibility.Visible;
            DeveloperContent.Visibility = _showDeveloper ? Visibility.Visible : Visibility.Collapsed;
            if (_showDeveloper) return;
            try
            {
                var local = _market.Installed().ToDictionary(p => p.Id);
                var query = Search.Text.Trim();
                var entries = _showInstalled
                    ? local.Values.Where(p => p.IsUnified || p.IsPersona).AsEnumerable()
                    : _catalog.Where(p => p.IsUnified || p.IsPersona).AsEnumerable();
                foreach (var info in entries.Where(p => (p.Name + " " + p.Author + " " + p.Description)
                    .Contains(query, StringComparison.OrdinalIgnoreCase)))
                {
                    var body = new StackPanel();
                    var card = new Border { Style = (Style)FindResource("Card"), Child = body, Width = 286,
                        Margin = new Thickness(0, 0, 12, 12), Padding = new Thickness(14) };
                    body.Children.Add(new TextBlock { Text = PluginMarket.SafeText(info.Name, 80),
                        FontSize = 17, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
                    body.Children.Add(Small(PluginMarket.SafeText(info.Author, 80) + "  ·  v" + info.Version));
                    body.Children.Add(Small(PluginMarket.SafeText(info.Description, 600)));
                    body.Children.Add(Small(info.CompatibilityLabel));
                    // 市场签名暂时隐藏，卡片不再显示已签名 / 未签名目录的标注。
                    body.Children.Add(Small(info.IsUnified ? PermissionLabel(info) + "；当前仅支持本地安装"
                        : "类型：人设预设"));
                    if (info.IsUnified) body.Children.Add(Small(CapabilityDetails(info)));
                    var buttons = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
                    body.Children.Add(buttons);
                    local.TryGetValue(info.Id, out var current);
                    if (_showInstalled)
                    {
                        var enabled = _market.Enabled(info.Id);
                        if (info.IsUnified || info.IsPersona) AddButton(buttons, enabled ? "停用" : "启用", () =>
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
                        AddButton(buttons, "卸载", () =>
                        {
                            _market.Uninstall(info.Id);
                            return Task.FromResult("已卸载");
                        }, false);
                        var settings = new Button { Content = "设置", Style = (Style)FindResource("Ghost"),
                            IsEnabled = (info.IsUnified || (enabled && info.IsPersona)) && PluginMarket.Compatible(info, _version, UpdateManifestService.LocalEpoch(_sup.BaseDir)) };
                        settings.Click += async (_, _) =>
                        {
                            if (info.IsUnified) ShowMessageSettings(info);
                            else if (info.IsPersona) await ShowPersonaSettings(info);
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
            panel.Children.Add(new TextBlock { Text = PluginMarket.SafeText(info.Name, 80), Style = (Style)FindResource("H1") });
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
        private void OnDisclaimer(object sender, RoutedEventArgs e) => ShowGuide("PluginDisclaimer");

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

        private void ShowMessageSettings(PluginInfo info)
        {
            var body = new StackPanel { Margin = new Thickness(12) };
            body.Children.Add(Small(PluginMarket.SafeText(info.Name, 80) + " · 插件设置"));
            body.Children.Add(Small(CapabilityDetails(info)));
            body.Children.Add(Small("配置为 JSON 对象，应符合插件声明。保存设置不会为停用插件授予权限。"));
            var editor = new TextBox { Text = _market.MessageSettings(info.Id), AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap, MinHeight = 160, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            body.Children.Add(editor);
            var buttons = new WrapPanel();
            AddButton(buttons, "保存设置", () => { _market.SetMessageSettings(info.Id, editor.Text); return Task.FromResult("已保存"); });
            AddButton(buttons, "返回插件市场", () => { OnBack(this, new RoutedEventArgs()); return Task.FromResult(""); }, false);
            body.Children.Add(buttons);
            if (info.Provides.ContainsKey("tool.run@1"))
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
                    var response = await Api.PostJson(_sup.Url, "/api/plugins/run", new { id = info.Id, capability = "tool.run@1", input = payload.RootElement }, 125);
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
