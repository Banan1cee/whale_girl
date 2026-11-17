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
        public string Name { get; set; }
        public string Source { get; set; }
        public string Label { get; set; }
        public bool IsUser => string.Equals(Source, "user", StringComparison.OrdinalIgnoreCase);
        public override string ToString() => Label ?? Id ?? "";
    }

    public partial class PersonaPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _saveTimer;
        private bool _loading;
        private bool _loaded;
        private bool _loadedOnline;
        private bool _loadInProgress;
        private bool _applyingPreset;
        private long _editRevision;
        private long _savedRevision;
        private readonly SemaphoreSlim _saveGate = new SemaphoreSlim(1, 1);
        private string _loadedEmoji = "正常";   // 上次载入的颜文字档位，用来判断用户有没有改过
        private string _presetSource = "";      // 内置只读；市场人设修改到本地单文件副本
        private bool _locked;
        private string _currentPresetName = "";

        // 主人名单复用 ContactInfo：名字和 wxid 本来就是联系人的两个字段，
        // 再立一个 MasterEntry 只会多一套同样的模型。
        private readonly List<ContactInfo> _masterEntries = new List<ContactInfo>();
        private DispatcherTimer _masterSearchTimer;
        private int _masterSearchSeq;
        private bool _masterRendering;

        private string _currentPresetId = "";   // 当前人设来自哪一版，用来把下拉框选到正确项

        public PersonaPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            foreach (var field in new TextBox[] { TxtName, TxtAge, TxtJob, TxtLook, TxtPerson, TxtBack,
                TxtPrompt, TxtOwner, TxtAliases, TxtPrivate, TxtGroup, TxtBubbles, TxtTurns, TxtGroupTurns })
                field.TextChanged += OnPersonaTextChanged;

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
            if (_applyingPreset) return;
            if (_loaded && _loadedOnline == _sup.NodeRunning)
            {
                // 状态定时器每两秒调用此方法，不能反复回填表单。
                return;
            }
            if (_loaded && (_savedRevision != _editRevision || _saveGate.CurrentCount == 0)) return;
            await LoadAsync();
        }

        private async Task LoadAsync()
        {
            if (_loadInProgress) return;
            _loadInProgress = true;
            var revision = _editRevision;
            try
            {
            var res = await _sup.ReadConfigurationAsync("/api/persona");
            if (!res.Ok) { SaveState.Text = res.Error; return; }

            var set = await _sup.ReadConfigurationAsync("/api/settings");
            var cfg = await _sup.ReadConfigurationAsync("/api/config");
            // 三份表单数据必须全部成功，不能拿旧控件或空名单完成一次“成功加载”。
            if (!set.Ok || !cfg.Ok)
            {
                SaveState.Text = "读取配置失败：" + Api.Message(!set.Ok ? set : cfg);
                return;
            }
            if (revision != _editRevision || (_loaded && (_savedRevision != _editRevision || _saveGate.CurrentCount == 0)))
                return;

            _loading = true;
            try
            {
                var p = res.Prop("persona");
                _presetSource = res.Str("presetSource");
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

                    ChkProactive.IsChecked = B(p, "proactive");
                    ChkOpinions.IsChecked = B(p, "opinions");

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
            _savedRevision = revision;
            _loaded = true;

            await LoadPresetsAsync(_currentPresetId);
            await LoadMemoryChatsAsync();
            _loadedOnline = _sup.NodeRunning;
            ApplyPersonaEditState();
            SaveState.Text = _loadedOnline ? "" : "可保存到本地 · 启动后生效";
            PresetSaved.Text = "";
            }
            finally { _loadInProgress = false; }
        }

        /** 内置只读；市场人设直接编辑，但不会改写原始插件包。 */
        private void ApplyPersonaEditState()
        {
            _locked = false;
            foreach (var field in new Control[]
            {
                TxtName, TxtAge, TxtJob, TxtLook, TxtPerson, TxtBack, TxtPrompt,
            })
            {
                field.IsEnabled = !_locked;
            }
            PresetLockHint.Visibility = _locked ? Visibility.Visible : Visibility.Collapsed;
            BtnCopyPreset.Visibility = Visibility.Collapsed;
            BtnSavePreset.Visibility = _locked ? Visibility.Collapsed : Visibility.Visible;
            UpdateHints();
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
            if (!AppDialog.Confirm(Window.GetWindow(this),
                $"确定清空「{group.Title}」的全部内部记忆吗？\n\n" +
                "将清除：上下文聊天记录、摘要、人物卡、事件与关系记忆。\n" +
                "微信聊天记录、其他会话记忆和人设设置保留。\n\n" +
                "此操作无法直接撤销；之后从新消息开始记忆。已有的手动备份与自动快照保留。",
                "清空该对话记忆", danger: true, okText: "清空", cancelText: "取消"))
                return;
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
            HintPrivate.Text = "普通私聊最多约 " + TxtPrivate.Text + " 字";
            HintGroup.Text = "普通群聊最多约 " + TxtGroup.Text + " 字";
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
                    var source = S(p, "source");
                    var tag = source switch
                    {
                        "user" => "我的",
                        "market" => "市场",
                        _ => "内置",
                    };
                    items.Add(new PresetItem
                    {
                        Id = id,
                        Name = name,
                        Source = source,
                        Label = $"【{tag}】{(string.IsNullOrEmpty(ver) ? $"{name}（{id}）" : $"{name} · {ver}")}",
                    });
                }
            }
            CmbPreset.ItemsSource = items;
            // 选中「当前人设实际来自哪一版」，而不是永远选第一个，
            // 否则导入 v4 再保存，下拉框会跳回 v1，看起来像没导入成功。
            var hit = items.FirstOrDefault(x => string.Equals(x.Id, currentId, StringComparison.OrdinalIgnoreCase));
            if (hit != null)
            {
                CmbPreset.SelectedItem = hit;
                _currentPresetName = hit.Name;
            }
            else if (items.Count > 0)
            {
                CmbPreset.SelectedIndex = 0;
                _currentPresetName = items[0].Name;
            }
            else PresetSaved.Text = "presets 目录里没有人设版本。";
            UpdatePresetButtons();
        }

        private void UpdatePresetButtons()
        {
            if (BtnUpdatePreset == null || BtnDeletePreset == null || BtnRenamePreset == null) return;
            var selected = CmbPreset.SelectedItem as PresetItem;
            var isCurrent = selected != null && string.Equals(selected.Id, _currentPresetId, StringComparison.OrdinalIgnoreCase);
            BtnUpdatePreset.IsEnabled = selected != null && selected.IsUser && isCurrent;
            BtnRenamePreset.IsEnabled = selected != null && selected.IsUser;
            BtnDeletePreset.IsEnabled = selected != null;
            BtnResetMarket.IsEnabled = selected != null && selected.Source == "market";
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
            _editRevision++;
            SaveState.Text = "等待自动保存…";
            _saveTimer.Stop();
            _saveTimer.Start();
        }

        private void OnPersonaTextChanged(object sender, TextChangedEventArgs e)
        {
            if (_loading || !_loaded) return;
            ScheduleSave();
            PresetSaved.Text = "";
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
            if (string.Equals(level, "关", StringComparison.Ordinal)) return 0;
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

        private async void OnReload(object sender, RoutedEventArgs e)
        {
            if (_savedRevision != _editRevision &&
                !AppDialog.Confirm(Window.GetWindow(this), "重新读取会丢弃尚未保存的修改，是否继续？",
                    "重新读取", danger: true, okText: "丢弃并读取")) return;
            _saveTimer.Stop();
            _loaded = false;
            SaveState.Text = "重新读取…";
            await LoadAsync();
        }

        private async Task<bool> SaveAllAsync(string okText)
        {
            await _saveGate.WaitAsync();
            try
            {
            if (_loading || !_loaded || _applyingPreset) return false;
            var revision = _editRevision;

            if (!TxtAge.TryRead(out var age)) { SaveState.Text = TxtAge.ErrorText; return false; }
            if (!TxtPrivate.TryRead(out var priv)) { SaveState.Text = TxtPrivate.ErrorText; return false; }
            if (!TxtGroup.TryRead(out var grp)) { SaveState.Text = TxtGroup.ErrorText; return false; }
            if (!TxtTurns.TryRead(out var turns)) { SaveState.Text = TxtTurns.ErrorText; return false; }
            if (!TxtGroupTurns.TryRead(out var gturns)) { SaveState.Text = TxtGroupTurns.ErrorText; return false; }
            if (!TxtBubbles.TryRead(out var bubbles)) { SaveState.Text = TxtBubbles.ErrorText; return false; }

            var pct = Math.Clamp((int)Math.Round(SldEmoji.Value), 0, 100);
            // 0% 用档位「关」做硬关；>0 时把档位恢复成可用值，真正生效的是下面的精确概率
            var emoji = pct == 0
                ? "关"
                : (string.Equals(_loadedEmoji, "关", StringComparison.Ordinal) ? "正常" : _loadedEmoji);
            var emojiChance = pct / 100.0;
            // 一次保存使用同一份表单快照，等待 HTTP 时的新编辑留给下一次自动保存。
            var owner = TxtOwner.Text.Trim();
            var extraPatch = new Dictionary<string, object>
            {
                ["persona.masterRoast"] = ChkRoast.IsChecked == true,
                ["persona.aliases"] = LineList(TxtAliases),
                ["persona.master.names"] = MasterList(e => e.Name),
                ["persona.master.wxids"] = MasterList(e => e.Wxid),
                ["chat.emojiChance"] = emojiChance
            };

            // 内置 / 市场预设只锁身份和提示词；字数、上下文、颜文字和开关照常保存
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
                proactive = ChkProactive.IsChecked == true,
                opinions = ChkOpinions.IsChecked == true,
                ownerName = owner,
                aliases = LineList(TxtAliases),
                masterRoast = ChkRoast.IsChecked == true,
                emojiChance
            });
            if (!res.Ok)
            {
                SaveState.Text = "保存失败：" + Api.Message(res);
                return false;
            }

            // 称呼（persona 接口不收，走 settings）；群聊规则统一在「设置 → 群聊」，这里不再写 config
            var ownerResult = await _sup.SaveConfigurationAsync("/api/settings", new { userName = owner });
            if (!ownerResult.Ok)
            {
                SaveState.Text = "人设已保存，但称呼保存失败：" + Api.Message(ownerResult);
                return false;
            }
            var configResult = await _sup.PatchConfigurationAsync(extraPatch);
            if (!configResult.Ok)
            {
                SaveState.Text = "人设与称呼已保存，但其他设置保存失败：" + Api.Message(configResult);
                return false;
            }
            _loadedEmoji = emoji;
            _savedRevision = revision;

            SaveState.Text = revision == _editRevision
                ? okText + PersonaTokenLabel(res.Prop("tokenCheck")) + " · " + DateTime.Now.ToString("HH:mm:ss")
                : "较早修改已保存 · 新修改等待保存…";
            PresetSaved.Text = revision == _editRevision ? "✔ 已保存" : "有修改尚未保存";
            PresetSaved.Foreground = (Brush)FindResource("Text");
            return revision == _editRevision;
            }
            catch (Exception ex) { SaveState.Text = "保存失败：" + Api.FriendlyError(ex); return false; }
            finally { _saveGate.Release(); }
        }

        private async void OnImportPreset(object sender, RoutedEventArgs e)
        {
            if (_applyingPreset) return;
            if (!(CmbPreset.SelectedItem is PresetItem p)) return;
            if (p.Id.StartsWith("market-", StringComparison.Ordinal) &&
                !AppDialog.Confirm(Window.GetWindow(this), "应用此人设会替换人设内容及包内的表达、长度设置，主人账号与密钥不变。是否继续？",
                    "应用插件人设", okText: "应用")) return;
            if (!await FlushEditsAsync()) return;
            _applyingPreset = true;
            _saveTimer.Stop();
            Body.IsEnabled = false;
            await _saveGate.WaitAsync();
            try
            {
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
            finally
            {
                _saveGate.Release();
                _applyingPreset = false;
                Body.IsEnabled = true;
            }
        }

        private void OnPresetChanged(object sender, SelectionChangedEventArgs e)
        {
            if (BtnPersonaTitle != null)
                BtnPersonaTitle.Content = CmbPreset.SelectedItem is PresetItem p ? p.Name : "点击编辑人设名称";
            UpdatePresetButtons();
        }

        private async void OnEditPersonaTitle(object sender, RoutedEventArgs e)
        {
            if (!_loaded || _applyingPreset) return;
            if (CmbPreset.SelectedItem is PresetItem p && p.IsUser)
            {
                OnRenamePreset(sender, e);
                return;
            }
            if (CmbPreset.SelectedItem is PresetItem selected &&
                !string.Equals(selected.Id, _currentPresetId, StringComparison.OrdinalIgnoreCase))
            {
                SaveState.Text = "先应用选中的人设，再创建自定义名称。";
                return;
            }
            if (!await FlushEditsAsync()) return;
            OnSavePreset(sender, e);
        }

        private async Task<bool> FlushEditsAsync()
        {
            _saveTimer.Stop();
            await _saveGate.WaitAsync();
            _saveGate.Release();
            return _savedRevision == _editRevision || await SaveAllAsync("已保存");
        }

        private async void OnExportPersona(object sender, RoutedEventArgs e)
            => await ExportPersonaAsync(false);

        private async void OnExportPrompt(object sender, RoutedEventArgs e)
            => await ExportPersonaAsync(true);

        private async Task ExportPersonaAsync(bool promptOnly)
        {
            if (!_loaded) return;
            if (!AppDialog.Confirm(Window.GetWindow(this),
                promptOnly
                    ? "只导出自定义补充提示词，不含身份字段和页面开关。安装启用后会出现在人设列表。\n请确认提示词正文不包含个人信息。"
                    : "导出当前人设、称呼、别名、顶嘴与交流偏好、颜文字和长度设置。\n不包含主人账号、密钥、聊天记忆或系统权限。\n请检查人设正文及称呼是否写有个人信息。",
                "打包分享", okText: "继续")) return;
            var title = AppDialog.Prompt(Window.GetWindow(this), "分享包名称", "打包分享",
                string.IsNullOrWhiteSpace(_currentPresetName) ? TxtName.Text : _currentPresetName);
            if (title == null) return;
            var author = AppDialog.Prompt(Window.GetWindow(this), "作者昵称（会公开显示）", "打包分享");
            if (author == null) return;
            var id = AppDialog.Prompt(Window.GetWindow(this), "包 ID：小写字母开头，只用小写字母、数字、短横线，最多 48 位。更新同一包时保持不变。",
                "打包分享", "persona-" + Guid.NewGuid().ToString("N").Substring(0, 12));
            if (id == null) return;
            var version = AppDialog.Prompt(Window.GetWindow(this), "包版本，更新时提高版本号", "打包分享", "1.0.0");
            if (version == null) return;
            var file = AppFilePicker.Save("保存人设插件包", ".zip", "persona.zip");
            if (file == null) return;
            try
            {
                _saveTimer.Stop();
                if (!await SaveAllAsync("已保存")) return;
                var result = await _sup.SaveConfigurationAsync("/api/persona/export", new { });
                if (!result.Ok) { SaveState.Text = Api.Message(result); return; }
                PersonaPackage.Export(file, result.Prop("persona"), title.Trim(), author.Trim(), id.Trim(), version.Trim(), promptOnly);
                SaveState.Text = promptOnly
                    ? "纯提示词包已导出，可本地安装分享或按市场流程投稿"
                    : "已打包，可本地安装分享；公开上架需市场校验支持完整设置格式";
            }
            catch (Exception ex) { SaveState.Text = "打包失败：" + Api.FriendlyError(ex); }
        }

        private async void OnSavePreset(object sender, RoutedEventArgs e)
        {
            if (!_loaded || _locked) return;
            var name = AppDialog.Prompt(Window.GetWindow(this),
                "给这份人设起个标题（只用于列表展示，不会改她的名字）。以后保存人设会自动更新它。",
                "另存为人设预设");
            if (name == null) return;
            name = name.Trim();
            if (name.Length == 0 || name.Length > 40)
            {
                PresetSaved.Text = "标题要 1~40 个字";
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            _saveTimer.Stop();
            if (!await SaveAllAsync("已保存")) return;
            var res = await _sup.SaveConfigurationAsync("/api/persona/preset/save", new { name });
            if (!res.Ok)
            {
                PresetSaved.Text = "保存失败：" + Api.Message(res);
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            _loaded = false;
            await LoadAsync();
            SaveState.Text = "已保存为预设「" + name + "」" + PersonaTokenLabel(res.Prop("tokenCheck"));
            PresetSaved.Text = "✔ 已保存";
            PresetSaved.Foreground = (Brush)FindResource("Text");
        }

        private async void OnCopyPreset(object sender, RoutedEventArgs e)
        {
            if (!_loaded || !_locked) return;
            var initial = (string.IsNullOrWhiteSpace(_currentPresetName) ? "我的预设" : _currentPresetName) + " 副本";
            var name = AppDialog.Prompt(Window.GetWindow(this),
                "内置预设不能直接改，先复制成自己的预设。复制后的人设可以随便改，保存会自动同步。",
                "复制为自建预设", initial);
            if (name == null) return;
            name = name.Trim();
            if (name.Length == 0 || name.Length > 40)
            {
                PresetSaved.Text = "标题要 1~40 个字";
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            var res = await _sup.SaveConfigurationAsync("/api/persona/preset/save", new { name });
            if (!res.Ok)
            {
                PresetSaved.Text = "复制失败：" + Api.Message(res);
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            _loaded = false;
            await LoadAsync();
            SaveState.Text = "已复制为自建预设「" + name + "」，现在可以修改了";
            PresetSaved.Text = "✔ 已保存";
            PresetSaved.Foreground = (Brush)FindResource("Text");
        }

        private async void OnRenamePreset(object sender, RoutedEventArgs e)
        {
            if (!_loaded || !(CmbPreset.SelectedItem is PresetItem p) || !p.IsUser) return;
            var name = AppDialog.Prompt(Window.GetWindow(this),
                "只改预设标题，不动人设内容和当前使用状态。", "重命名自建预设", p.Name);
            if (name == null) return;
            name = name.Trim();
            if (name.Length == 0 || name.Length > 40)
            {
                PresetSaved.Text = "名字要 1~40 个字";
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            var res = await _sup.SaveConfigurationAsync("/api/persona/preset/rename", new { id = p.Id, name });
            if (!res.Ok)
            {
                PresetSaved.Text = "重命名失败：" + Api.Message(res);
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            await LoadPresetsAsync(_currentPresetId);
            SaveState.Text = "预设已重命名为「" + name + "」";
            PresetSaved.Text = "✔ 已重命名";
            PresetSaved.Foreground = (Brush)FindResource("Text");
        }

        private async void OnUpdatePreset(object sender, RoutedEventArgs e)
        {
            if (!_loaded || !(CmbPreset.SelectedItem is PresetItem p) || !p.IsUser) return;
            if (!string.Equals(p.Id, _currentPresetId, StringComparison.OrdinalIgnoreCase))
            {
                PresetSaved.Text = "先「导入这版」再更新，避免把当前人设写到别的预设里";
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            if (!AppDialog.Confirm(Window.GetWindow(this),
                $"用当前表单里的内容覆盖预设「{p.Name}」？", "更新自建预设", okText: "更新")) return;
            if (!await FlushEditsAsync()) return;
            var res = await _sup.SaveConfigurationAsync("/api/persona/preset/save", new { id = p.Id, name = p.Name });
            if (!res.Ok)
            {
                PresetSaved.Text = "更新失败：" + Api.Message(res);
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            _loaded = false;
            await LoadAsync();
            SaveState.Text = "已更新预设「" + p.Name + "」" + PersonaTokenLabel(res.Prop("tokenCheck"));
            PresetSaved.Text = "✔ 已保存";
            PresetSaved.Foreground = (Brush)FindResource("Text");
        }

        private async void OnResetMarket(object sender, RoutedEventArgs e)
        {
            if (!_loaded || CmbPreset.SelectedItem is not PresetItem p || p.Source != "market") return;
            if (!AppDialog.Confirm(Window.GetWindow(this),
                "删除这份市场人设的本地修改？当前正在使用的人设不会改变；再次应用预设后才会使用作者版本。此操作不可撤销。",
                "恢复作者版本", danger: true, okText: "删除本地修改")) return;
            if (!await FlushEditsAsync()) return;
            var res = await _sup.SaveConfigurationAsync("/api/persona/preset/reset-market", new { id = p.Id });
            SaveState.Text = res.Ok ? "已删除本地副本，可重新应用作者版本" : "恢复失败：" + Api.Message(res);
        }

        private async void OnDeletePreset(object sender, RoutedEventArgs e)
        {
            if (!_loaded || !(CmbPreset.SelectedItem is PresetItem p)) return;
            var detail = p.IsUser
                ? "这是你自己保存的预设，会直接删除文件。"
                : "内置 / 市场预设只会从列表隐藏，不删除安装目录和插件文件；插件卸载后重新安装会按新文件恢复。";
            if (!AppDialog.Confirm(Window.GetWindow(this),
                $"删除预设「{p.Name}」？\n\n{detail}\n\n正在使用的预设不能删除，请先导入别的人设。",
                "删除预设", danger: true, okText: "删除")) return;
            var res = await _sup.SaveConfigurationAsync("/api/persona/preset/delete", new { id = p.Id });
            if (!res.Ok)
            {
                PresetSaved.Text = "删除失败：" + Api.Message(res);
                PresetSaved.Foreground = (Brush)FindResource("Bad");
                return;
            }
            _loaded = false;
            await LoadAsync();
            SaveState.Text = "已删除预设「" + p.Name + "」";
            PresetSaved.Text = "✔ 已删除";
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
