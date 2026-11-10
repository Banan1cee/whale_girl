using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    public sealed class PresetItem
    {
        public string Id { get; set; }
        public string Label { get; set; }
        public override string ToString() => Label ?? Id ?? "";
    }

    public partial class PersonaPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _saveTimer;
        private bool _loading;
        private bool _loaded;
        private bool _loadedOnline;
        private readonly SemaphoreSlim _saveGate = new SemaphoreSlim(1, 1);
        private string _loadedEmoji = "正常";   // 上次载入的颜文字档位，用来判断用户有没有改过

        // 主人名单复用 ContactInfo：名字和 wxid 本来就是联系人的两个字段，
        // 再立一个 MasterEntry 只会多一套同样的模型。
        private readonly List<ContactInfo> _masterEntries = new List<ContactInfo>();
        private DispatcherTimer _masterSearchTimer;
        private int _masterSearchSeq;
        private bool _masterRendering;

        /// <summary>
        /// 这些开关在各自专页已经有入口（微信桥接 / 主动与提醒 / 表情包），
        /// 人设页不再重复列一份，避免同一个键两处可改、改完另一处不刷新。
        /// </summary>
        private static readonly HashSet<string> HiddenFlags = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "wechatAccountGuard", "quoteReply", "stickers",
            "proactiveCare", "careOnlyMaster", "careGroups", "careOthers",
        };

        private string _currentPresetId = "";   // 当前人设来自哪一版，用来把下拉框选到正确项

        public PersonaPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;

            _saveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(450) };
            _saveTimer.Tick += async (_, __) =>
            {
                _saveTimer.Stop();
                await SaveAllAsync("已保存");
            };

            _masterSearchTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(320) };
            _masterSearchTimer.Tick += async (_, __) =>
            {
                _masterSearchTimer.Stop();
                await SearchMasterAsync(TxtMasterSearch.Text.Trim());
            };

            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            if (_loaded && _loadedOnline == _sup.NodeRunning) return;
            await LoadAsync();
        }

        private async Task LoadAsync()
        {
            var res = await _sup.ReadConfigurationAsync("/api/persona");
            if (!res.Ok) { SaveState.Text = res.Error; return; }

            var set = await _sup.ReadConfigurationAsync("/api/settings");
            var cfg = await _sup.ReadConfigurationAsync("/api/config");

            _loading = true;
            try
            {
                var p = res.Prop("persona");
                if (p.ValueKind == JsonValueKind.Object)
                {
                    TxtName.Text = S(p, "name");
                    TxtAge.Text = L(p, "age").ToString();
                    TxtJob.Text = S(p, "job");
                    TxtLook.Text = S(p, "appearance");
                    TxtPerson.Text = S(p, "personality");
                    TxtBack.Text = S(p, "background");
                    TxtPrompt.Text = S(p, "customPrompt");

                    TxtPrivate.Text = L(p, "privateMaxChars").ToString();
                    TxtGroup.Text = L(p, "groupMaxChars").ToString();
                    TxtBubbles.Text = L(p, "maxBubbles").ToString();
                    TxtTurns.Text = L(p, "historyTurns").ToString();
                    TxtGroupTurns.Text = L(p, "groupHistoryTurns").ToString();
                    var emoji = S(p, "emoji");
                    _loadedEmoji = string.IsNullOrEmpty(emoji) ? "正常" : emoji;
                    SldEmoji.Value = EmojiPercent(cfg, _loadedEmoji);
                    UpdateEmojiHint();

                    ChkEmotions.IsChecked = B(p, "emotions");
                    ChkProactive.IsChecked = B(p, "proactive");
                    ChkOpinions.IsChecked = B(p, "opinions");
                    ChkLinks.IsChecked = B(p, "links");

                    var src = S(p, "sourcePreset");
                    _currentPresetId = src;
                    CurrentPreset.Text = string.IsNullOrEmpty(src) ? "人设：手写/默认" : "人设：来自 " + src;
                }

                if (set.Ok) TxtOwner.Text = set.Str("userName");

                if (cfg.Ok && cfg.Prop("config").ValueKind == JsonValueKind.Object &&
                    cfg.Prop("config").TryGetProperty("persona", out var pcfg) && pcfg.ValueKind == JsonValueKind.Object)
                {
                    TxtAliases.Text = JsonRead.Lines(pcfg, "aliases");
                    ChkRoast.IsChecked = B(pcfg, "masterRoast");
                    if (pcfg.TryGetProperty("master", out var m) && m.ValueKind == JsonValueKind.Object)
                    {
                        LoadMasterEntries(m);
                    }
                    else
                    {
                        _masterEntries.Clear();
                        RenderMasterChips();
                    }
                }

                UpdateHints();
            }
            finally { _loading = false; }

            await LoadPresetsAsync(_currentPresetId);
            await LoadFlagsAsync();
            await LoadMemoryChatsAsync();
            _loaded = true;
            _loadedOnline = _sup.NodeRunning;
            SaveState.Text = _loadedOnline ? "" : "可保存到本地 · 启动后生效";
            PresetSaved.Text = "";
        }

        private sealed class MemoryChatItem
        {
            public string Key { get; set; }
            public string Title { get; set; }
            public string Label { get; set; }
        }

        private async Task LoadMemoryChatsAsync()
        {
            BtnResetMemory.IsEnabled = false;
            CmbMemoryChat.ItemsSource = null;
            if (!_sup.NodeRunning)
            {
                MemoryHint.Text = "请先启动内核，再刷新对话列表。";
                return;
            }
            var res = await Api.Get(_sup.Url, "/api/memory/chats");
            if (!res.Ok)
            {
                MemoryHint.Text = "读取对话失败：" + Api.Message(res);
                return;
            }
            var groups = new List<MemoryChatItem>();
            var arr = res.Prop("chats");
            if (arr.ValueKind == JsonValueKind.Array)
                foreach (var g in arr.EnumerateArray())
                {
                    var title = S(g, "title");
                    var key = S(g, "key");
                    groups.Add(new MemoryChatItem { Key = key, Title = title,
                        Label = $"【{(S(g, "chatType") == "group" ? "群聊" : "私聊")}】{title} · {L(g, "messageCount")} 条记录 · {L(g, "peopleCount")} 人记忆（{key}）" });
                }
            CmbMemoryChat.ItemsSource = groups;
            if (groups.Count > 0) CmbMemoryChat.SelectedIndex = 0;
            BtnResetMemory.IsEnabled = groups.Count > 0;
            MemoryHint.Text = groups.Count > 0 ? "列出鲸鲸当前保存了记忆的所有对话，包含群聊和私聊。" : "暂无已保存记忆的对话。";
        }

        private async void OnRefreshMemoryChats(object sender, RoutedEventArgs e)
        {
            BtnRefreshMemory.IsEnabled = false;
            try { await LoadMemoryChatsAsync(); }
            finally { BtnRefreshMemory.IsEnabled = true; }
        }

        private async void OnResetChatMemory(object sender, RoutedEventArgs e)
        {
            if (!_sup.NodeRunning || CmbMemoryChat.SelectedItem is not MemoryChatItem group) return;
            var result = MessageBox.Show(Window.GetWindow(this),
                $"确定清空「{group.Title}」的全部内部记忆吗？\n\n" +
                "将清除：上下文聊天记录、摘要、人物卡、事件与关系记忆。\n" +
                "微信聊天记录、其他会话记忆和人设设置保留。\n\n" +
                "此操作无法直接撤销；之后从新消息开始记忆。已有的手动备份与自动快照保留。",
                "清空该对话记忆", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No);
            if (result != MessageBoxResult.Yes) return;
            BtnResetMemory.IsEnabled = false;
            BtnRefreshMemory.IsEnabled = false;
            CmbMemoryChat.IsEnabled = false;
            try
            {
                var res = await Api.PostJson(_sup.Url, "/api/memory/chats/reset", new { key = group.Key, confirm = true });
                if (!res.Ok)
                {
                    MemoryHint.Text = "清空失败：" + Api.Message(res);
                    return;
                }
                await LoadMemoryChatsAsync();
                MemoryHint.Text = $"已清空「{group.Title}」的内部记忆，微信聊天记录保留。";
            }
            finally
            {
                BtnRefreshMemory.IsEnabled = true;
                CmbMemoryChat.IsEnabled = true;
                BtnResetMemory.IsEnabled = CmbMemoryChat.SelectedItem != null;
            }
        }

        private void UpdateHints()
        {
            HintPrivate.Text = "大约 " + Preview("嗯嗯，我知道啦，那今天先这样吧", TxtPrivate.Text) + " 个字一句话";
            HintGroup.Text = "群里短一些更像活人：" + Preview("在的在的", TxtGroup.Text) + " 个字";
        }

        private static string Preview(string sample, string limit)
        {
            if (!int.TryParse(limit, out var n) || n <= 0) return sample.Length.ToString();
            return Math.Max(1, Math.Min(n, sample.Length)).ToString();
        }

        private async Task LoadPresetsAsync(string currentId = "")
        {
            var res = await _sup.ReadConfigurationAsync("/api/persona/presets");
            if (!res.Ok) return;
            var items = new List<PresetItem>();
            var arr = res.Prop("presets");
            if (arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var p in arr.EnumerateArray())
                {
                    var id = S(p, "id");
                    var name = S(p, "name");
                    var ver = S(p, "version");
                    items.Add(new PresetItem { Id = id, Label = string.IsNullOrEmpty(ver) ? $"{name}（{id}）" : $"{name} · {ver}" });
                }
            }
            CmbPreset.ItemsSource = items;
            // 选中「当前人设实际来自哪一版」，而不是永远选第一个，
            // 否则导入 v4 再保存，下拉框会跳回 v1，看起来像没导入成功。
            var hit = items.FirstOrDefault(x => string.Equals(x.Id, currentId, StringComparison.OrdinalIgnoreCase));
            if (hit != null) CmbPreset.SelectedItem = hit;
            else if (items.Count > 0) CmbPreset.SelectedIndex = 0;
            else PresetSaved.Text = "presets 目录里没有人设版本。";
        }

        private async Task LoadFlagsAsync()
        {
            FlagsHost.Children.Clear();
            var res = await _sup.ReadConfigurationAsync("/api/features");
            if (!res.Ok) return;
            var arr = res.Prop("features");
            if (arr.ValueKind != JsonValueKind.Array) return;

            foreach (var f in arr.EnumerateArray())
            {
                var key = S(f, "key");
                if (HiddenFlags.Contains(key)) continue;   // 有专页的开关不在这里重复
                var label = S(f, "label");
                var desc = S(f, "desc");
                var on = B(f, "value");
                var def = B(f, "default");
                var exp = B(f, "experimental");

                var chk = new CheckBox
                {
                    Content = label + (exp ? "（实验性）" : "") + $"   默认：{(def ? "开" : "关")}",
                    IsChecked = on,
                    Margin = new Thickness(0, 8, 0, 0),
                    Tag = key
                };
                chk.Click += OnFlagClick;
                FlagsHost.Children.Add(chk);

                var d = new TextBlock
                {
                    Text = desc,
                    Style = (Style)FindResource("Small"),
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(20, 3, 0, 0)
                };
                FlagsHost.Children.Add(d);
            }
        }

        private async void OnFlagClick(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            if (!(sender is CheckBox chk) || chk.Tag is not string key) return;
            var value = chk.IsChecked == true;
            var res = await _sup.SaveConfigurationAsync("/api/features", new { key, value });
            SaveState.Text = res.Ok ? $"开关 {key} → {(value ? "开" : "关")}" : "开关保存失败：" + Api.Message(res);
        }

        // ── 主人名单：搜索选择，一次填好名字和 wxid ──────────────
        //
        // 以前是两个多行文本框，名字和 wxid 各填一份，很容易填成「A 的名字 + B 的 wxid」。
        // 微信只按 wxid 认主人，这种错配不会报错，却会让 B 拿到主人权限。
        // 现在统一从联系人里搜、选中，名字和 wxid 一起带出来，不再给手填错配的机会。
        private void LoadMasterEntries(JsonElement master)
        {
            var names = JsonRead.Strings(master, "names");
            var wxids = JsonRead.Strings(master, "wxids");
            _masterEntries.Clear();
            // 旧配置按行号配对：保存时也是这个顺序，所以来回切换不会把已有值弄丢。
            var count = Math.Max(names.Count, wxids.Count);
            for (var i = 0; i < count; i++)
            {
                _masterEntries.Add(new ContactInfo
                {
                    Name = i < names.Count ? names[i] : "",
                    Wxid = i < wxids.Count ? wxids[i] : "",
                });
            }
            RenderMasterChips();
        }

        private void RenderMasterChips()
        {
            MasterChips.Children.Clear();
            foreach (var entry in _masterEntries.ToList())
            {
                var label = string.IsNullOrWhiteSpace(entry.Name) ? entry.Wxid : entry.Name;
                if (!string.IsNullOrWhiteSpace(entry.Name) && !string.IsNullOrWhiteSpace(entry.Wxid)
                    && !string.Equals(entry.Name, entry.Wxid, StringComparison.Ordinal))
                    label = entry.Name + " · " + entry.Wxid;

                var row = new StackPanel { Orientation = Orientation.Horizontal };
                row.Children.Add(new TextBlock
                {
                    Text = label,
                    VerticalAlignment = VerticalAlignment.Center,
                    Foreground = (Brush)FindResource("Text"),
                });
                var remove = new Button
                {
                    Content = "×",
                    Margin = new Thickness(6, 0, 0, 0),
                    Padding = new Thickness(4, 0, 4, 0),
                    Style = (Style)FindResource("Ghost"),
                    Tag = entry,
                    ToolTip = "移除这个主人",
                };
                remove.Click += OnRemoveMaster;
                row.Children.Add(remove);

                MasterChips.Children.Add(new Border
                {
                    Background = (Brush)FindResource("Surface3"),
                    CornerRadius = new CornerRadius(12),
                    Padding = new Thickness(10, 3, 5, 3),
                    Margin = new Thickness(0, 0, 6, 6),
                    Child = row,
                });
            }

            var incomplete = _masterEntries.Any((e) =>
                string.IsNullOrWhiteSpace(e.Name) || string.IsNullOrWhiteSpace(e.Wxid));
            MasterWarn.Text = incomplete
                ? "有主人只填了昵称或只填了 wxid。微信只按 wxid 认主人，请重新搜索选择一次，避免名字和 id 不是同一个人。"
                : "";
            MasterWarn.Visibility = incomplete ? Visibility.Visible : Visibility.Collapsed;
            MasterHint.Text = _sup.NodeRunning
                ? "搜索名字或 wxid，选中后自动填好昵称和 wxid。"
                : "启动内核后可以搜索联系人；当前显示的是已保存的配置。";
        }

        private async void OnMasterSearchChanged(object sender, TextChangedEventArgs e)
        {
            if (_loading || _masterRendering) return;
            _masterSearchTimer.Stop();
            var q = TxtMasterSearch.Text.Trim();
            if (q.Length == 0)
            {
                _masterSearchSeq++;
                MasterSuggest.ItemsSource = null;
                MasterSuggest.Visibility = Visibility.Collapsed;
                RenderMasterChips();
                return;
            }
            _masterSearchTimer.Start();
        }

        private async Task SearchMasterAsync(string q)
        {
            var seq = ++_masterSearchSeq;
            if (!_sup.NodeRunning)
            {
                MasterSuggest.ItemsSource = null;
                MasterSuggest.Visibility = Visibility.Collapsed;
                MasterHint.Text = "启动内核后才能搜索联系人。";
                return;
            }

            var snap = await _sup.Contacts.LoadAsync();
            if (seq != _masterSearchSeq) return;

            if (!snap.Ok && snap.Items.Count == 0)
            {
                MasterSuggest.ItemsSource = null;
                MasterSuggest.Visibility = Visibility.Collapsed;
                MasterHint.Text = "联系人接口还没就绪（GET /api/wechat/contacts 失败）。" + snap.Error;
                return;
            }

            var items = new List<ContactItem>();
            foreach (var info in snap.Items)
            {
                if (info.IsGroup) continue;
                if (_masterEntries.Any((m) => m.Wxid == info.Wxid)) continue;
                if (!ContactDirectory.Matches(info, q)) continue;
                items.Add(new ContactItem
                {
                    Wxid = info.Wxid,
                    Name = info.Name,
                    Remark = info.Remark,
                    IsGroup = false
                });
            }

            _masterRendering = true;
            try
            {
                MasterSuggest.ItemsSource = items;
                MasterSuggest.Visibility = items.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            }
            finally { _masterRendering = false; }

            MasterHint.Text = items.Count > 0
                ? "点一个结果加为主人。"
                : "没有匹配「" + q + "」的联系人；换个名字或直接搜 wxid。";
        }

        private void OnMasterSuggestionPicked(object sender, SelectionChangedEventArgs e)
        {
            if (_masterRendering || _loading) return;
            if (!(MasterSuggest.SelectedItem is ContactItem item)) return;

            var display = string.IsNullOrWhiteSpace(item.Display) ? item.Wxid : item.Display;
            var sameId = _masterEntries.FirstOrDefault((m) => m.Wxid == item.Wxid);
            if (sameId != null)
            {
                if (string.IsNullOrWhiteSpace(sameId.Name)) sameId.Name = display;
            }
            else
            {
                // 旧配置里只有昵称、没有 wxid 的那一条，选中同名联系人时直接补上 id，
                // 而不是再加一条重复的主人。
                var nameOnly = _masterEntries.FirstOrDefault((m) =>
                    string.IsNullOrWhiteSpace(m.Wxid)
                    && string.Equals(m.Name, display, StringComparison.OrdinalIgnoreCase));
                if (nameOnly != null) nameOnly.Wxid = item.Wxid;
                else
                    _masterEntries.Add(new ContactInfo
                    {
                        Name = string.Equals(display, item.Wxid, StringComparison.Ordinal) ? "" : display,
                        Wxid = item.Wxid,
                    });
            }

            _masterRendering = true;
            try
            {
                MasterSuggest.SelectedItem = null;
                MasterSuggest.ItemsSource = null;
                MasterSuggest.Visibility = Visibility.Collapsed;
                TxtMasterSearch.Text = "";
            }
            finally { _masterRendering = false; }

            RenderMasterChips();
            ScheduleSave();
        }

        private void OnRemoveMaster(object sender, RoutedEventArgs e)
        {
            if (!(sender is Button b) || !(b.Tag is ContactInfo entry)) return;
            _masterEntries.Remove(entry);
            RenderMasterChips();
            ScheduleSave();
        }

        private void ScheduleSave()
        {
            if (_loading) return;
            _saveTimer.Stop();
            _saveTimer.Start();
        }

        private List<string> MasterList(Func<ContactInfo, string> pick)
        {
            var list = new List<string>();
            foreach (var entry in _masterEntries)
            {
                var value = (pick(entry) ?? "").Trim();
                if (value.Length > 0) list.Add(value);
            }
            return list;
        }

        // ── 保存 ────────────────────────────────────────────────
        private void OnFieldLostFocus(object sender, RoutedEventArgs e)
        {
            if (_loading) return;
            UpdateHints();
            ScheduleSave();
        }

        private void OnToggleField(object sender, RoutedEventArgs e)
        {
            ScheduleSave();
        }

        private void OnEmojiChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            UpdateEmojiHint();
            ScheduleSave();
        }

        private void UpdateEmojiHint()
        {
            if (HintEmoji == null || SldEmoji == null) return;
            var pct = (int)Math.Round(SldEmoji.Value);
            if (pct <= 0)
            {
                HintEmoji.Text = "关闭：不主动带颜文字";
                return;
            }
            var every = Math.Max(1, (int)Math.Round(100.0 / pct));
            HintEmoji.Text = pct + "% · 约每 " + every + " 条带一次";
        }

        /// <summary>拖动条位置：优先用显式概率，没设过就按档位换算（关/少/正常/多 → 0/12/30/65）。</summary>
        private static double EmojiPercent(ApiResult cfg, string level)
        {
            if (cfg != null && cfg.Ok && cfg.Prop("config").ValueKind == JsonValueKind.Object
                && cfg.Prop("config").TryGetProperty("chat", out var chat) && chat.ValueKind == JsonValueKind.Object
                && chat.TryGetProperty("emojiChance", out var ec) && ec.ValueKind == JsonValueKind.Number)
            {
                var explicitPct = ec.GetDouble() * 100;
                if (explicitPct > 0) return Math.Clamp(explicitPct, 0, 100);
            }
            return level switch
            {
                "关" => 0,
                "少" => 12,
                "多" => 65,
                _ => 30
            };
        }

        private async void OnSaveAll(object sender, RoutedEventArgs e) => await SaveAllAsync("已保存");

        private async void OnReload(object sender, RoutedEventArgs e)
        {
            _loaded = false;
            SaveState.Text = "重新读取…";
            await LoadAsync();
        }

        private async Task SaveAllAsync(string okText)
        {
            await _saveGate.WaitAsync();
            try
            {
            if (_loading || !_loaded) return;

            if (!TxtAge.TryRead(out var age)) { SaveState.Text = TxtAge.ErrorText; return; }
            if (!TxtPrivate.TryRead(out var priv)) { SaveState.Text = TxtPrivate.ErrorText; return; }
            if (!TxtGroup.TryRead(out var grp)) { SaveState.Text = TxtGroup.ErrorText; return; }
            if (!TxtTurns.TryRead(out var turns)) { SaveState.Text = TxtTurns.ErrorText; return; }
            if (!TxtGroupTurns.TryRead(out var gturns)) { SaveState.Text = TxtGroupTurns.ErrorText; return; }
            if (!TxtBubbles.TryRead(out var bubbles)) { SaveState.Text = TxtBubbles.ErrorText; return; }

            var pct = Math.Clamp((int)Math.Round(SldEmoji.Value), 0, 100);
            // 0% 用档位「关」做硬关；>0 时把档位恢复成可用值，真正生效的是下面的精确概率
            var emoji = pct == 0
                ? "关"
                : (string.Equals(_loadedEmoji, "关", StringComparison.Ordinal) ? "正常" : _loadedEmoji);
            var emojiChance = pct / 100.0;

            var res = await _sup.SaveConfigurationAsync("/api/persona", new
            {
                name = TxtName.Text.Trim(),
                age,
                job = TxtJob.Text.Trim(),
                appearance = TxtLook.Text.Trim(),
                personality = TxtPerson.Text.Trim(),
                background = TxtBack.Text.Trim(),
                customPrompt = TxtPrompt.Text.Trim(),
                privateMaxChars = priv,
                groupMaxChars = grp,
                maxBubbles = bubbles,
                historyTurns = turns,
                groupHistoryTurns = gturns,
                emoji,
                emotions = ChkEmotions.IsChecked == true,
                proactive = ChkProactive.IsChecked == true,
                opinions = ChkOpinions.IsChecked == true,
                links = ChkLinks.IsChecked == true
            });
            if (!res.Ok)
            {
                SaveState.Text = "保存失败：" + Api.Message(res);
                return;
            }

            // 称呼（persona 接口不收，走 settings）；群聊规则统一在「设置 → 群聊」，这里不再写 config
            var owner = TxtOwner.Text.Trim();
            var ownerResult = await _sup.SaveConfigurationAsync("/api/settings", new { userName = owner });
            if (!ownerResult.Ok)
            {
                SaveState.Text = "人设已保存，但称呼保存失败：" + Api.Message(ownerResult);
                return;
            }
            var configResult = await _sup.PatchConfigurationAsync( new Dictionary<string, object>
            {
                ["persona.masterRoast"] = ChkRoast.IsChecked == true,
                ["persona.aliases"] = LineList(TxtAliases),
                ["persona.master.names"] = MasterList(e => e.Name),
                ["persona.master.wxids"] = MasterList(e => e.Wxid),
                ["chat.emojiChance"] = emojiChance
            });
            if (!configResult.Ok)
            {
                SaveState.Text = "人设与称呼已保存，但其他设置保存失败：" + Api.Message(configResult);
                return;
            }
            _loadedEmoji = emoji;

            SaveState.Text = okText + PersonaTokenLabel(res.Prop("tokenCheck")) + " · " + DateTime.Now.ToString("HH:mm:ss");
            PresetSaved.Text = "✔ 已保存";
            PresetSaved.Foreground = (Brush)FindResource("Text");
            }
            finally { _saveGate.Release(); }
        }

        private async void OnImportPreset(object sender, RoutedEventArgs e)
        {
            if (!(CmbPreset.SelectedItem is PresetItem p)) return;
            if (p.Id.StartsWith("market-", StringComparison.Ordinal) &&
                MessageBox.Show(Window.GetWindow(this), "应用此人设会替换当前的自定义提示词。是否继续？",
                    "应用插件人设", MessageBoxButton.OKCancel, MessageBoxImage.Question,
                    MessageBoxResult.Cancel) != MessageBoxResult.OK) return;
            var res = await _sup.SaveConfigurationAsync("/api/persona/preset", new { id = p.Id });
            if (!res.Ok)
            {
                PresetSaved.Text = "导入失败：" + Api.Message(res);
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            _loaded = false;
            await LoadAsync();                       // LoadAsync 会按新的 sourcePreset 选中下拉框
            SaveState.Text = "人设预设已导入" + PersonaTokenLabel(res.Prop("tokenCheck"));
            PresetSaved.Text = "✔ 已保存";
            PresetSaved.Foreground = (Brush)FindResource("Text");
        }

        private static string PersonaTokenLabel(JsonElement check)
        {
            var tokens = L(check, "tokens");
            if (tokens <= 0) return "";
            var limit = L(check, "limit");
            var estimate = B(check, "exact") ? "" : "约 ";
            return $" · 人设 {estimate}{tokens:N0} token / 当前上限 {limit:N0}";
        }

        /// <summary>多行输入框 → 字符串列表</summary>
        private static List<string> LineList(System.Windows.Controls.TextBox box)
            => (box.Text ?? "").Split('\n')
                .Select(x => x.Trim()).Where(x => x.Length > 0)
                .ToList();

        private static string S(JsonElement e, string n) => JsonRead.Str(e, n);

        private static bool B(JsonElement e, string n) => JsonRead.Bool(e, n);

        private static long L(JsonElement e, string n) => JsonRead.Long(e, n);
    }
}
