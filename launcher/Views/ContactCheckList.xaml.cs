using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WhaleLauncher.Views
{
    /// <summary>名单列表里的一行。</summary>
    public sealed class ContactItem : ContactInfo
    {
        private bool _isSelected;

        public bool IsSelected
        {
            get => _isSelected;
            set => Set(ref _isSelected, value);
        }

        public string Sub => Wxid + (IsGroup ? " · 群聊" : " · 私聊");
        public Visibility GroupBadgeVisibility => IsGroup ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>
    /// 白名单 / 静音黑名单的内联选择器：搜索 + 勾选，勾一下立即写回 config。
    ///
    /// 以前是「chips + 编辑按钮 + 二级弹窗」，用户每选一个会话都要开关一次弹窗，
    /// 白名单和黑名单还得各开一遍。现在名单直接铺在发言范围窗口里：
    /// 搜索框实时过滤本地联系人，勾选后马上 PATCH，不再有「确定 / 取消」两道关。
    /// 勾选即保存是有意的：用户点复选框就是最终表达，回窗口再点保存反而容易漏。
    /// </summary>
    public partial class ContactCheckList : UserControl
    {
        private readonly RuntimeSupervisor _sup;
        private readonly string _configPath;
        private readonly bool _allowAllMute;
        private readonly ConfigSaver _saver;

        private readonly List<ContactItem> _all = new List<ContactItem>();
        private readonly List<string> _chosen = new List<string>();
        private List<string> _savedIds = new List<string>();
        private bool _savedAllMute;

        private bool _ready;
        private bool _loading;
        private bool _applying;

        /// <summary>把一行结果文字抛给宿主页面（宿主自己决定显示在哪）。</summary>
        public event Action<string> Status;

        public ContactCheckList(RuntimeSupervisor sup, string configPath, bool allowAllMute)
        {
            InitializeComponent();
            _sup = sup;
            _configPath = configPath;
            _allowAllMute = allowAllMute;
            _saver = new ConfigSaver(sup);

            AllMuteCheck.Visibility = allowAllMute ? Visibility.Visible : Visibility.Collapsed;
            Loaded += (_, __) => _ready = true;
            RenderFooter();
        }

        /// <summary>从 config 回填（不会触发保存）。</summary>
        public void SetValue(JsonElement v)
        {
            _chosen.Clear();
            var allMute = false;
            if (v.ValueKind == JsonValueKind.Array)
            {
                foreach (var x in v.EnumerateArray())
                {
                    if (x.ValueKind != JsonValueKind.String) continue;
                    var id = (x.GetString() ?? "").Trim();
                    if (id.Length == 0) continue;
                    if (id == "*")
                    {
                        // 只有黑名单认「全部静音」；白名单里的 * 是老配置残留，不往 care.whitelist 写回去。
                        if (_allowAllMute) allMute = true;
                        continue;
                    }
                    if (!_chosen.Contains(id)) _chosen.Add(id);
                }
            }
            _savedIds = new List<string>(_chosen);
            _savedAllMute = allMute;

            _applying = true;
            try { AllMuteCheck.IsChecked = allMute; }
            finally { _applying = false; }
            ApplyAllMuteState();
            UpdateList();
        }

        /// <summary>拉联系人列表；失败时保留已勾选条目，只显示原因。</summary>
        public async Task ReloadAsync(bool force = false)
        {
            if (_loading) return;
            if (!_sup.NodeRunning)
            {
                ShowState("内核没起，连不上服务器。已勾选的条目不会丢，启动内核后再刷新。", true);
                return;
            }

            _loading = true;
            BtnReload.IsEnabled = false;
            try
            {
                var snap = await _sup.Contacts.LoadAsync(force);
                if (!snap.Ok) SetError("联系人接口还没就绪（GET /api/wechat/contacts 失败）。" + snap.Error);

                _all.Clear();
                foreach (var info in snap.Items)
                {
                    _all.Add(new ContactItem
                    {
                        Wxid = info.Wxid,
                        Name = info.Name,
                        Remark = info.Remark,
                        IsGroup = info.IsGroup,
                        IsSelected = _chosen.Contains(info.Wxid)
                    });
                }

                // 已选但不在联系人缓存里的 id 仍然要能看见、能取消，否则用户会以为选择丢了。
                foreach (var id in _chosen)
                {
                    if (_all.Any(x => x.Wxid == id)) continue;
                    _all.Add(new ContactItem
                    {
                        Wxid = id,
                        Name = id == "filehelper" ? "文件传输助手" : "",
                        IsGroup = false,
                        IsSelected = true
                    });
                }

                if (_all.Count == 0)
                {
                    ShowState(!snap.Ok
                        ? "联系人列表加载失败，已勾选的条目仍然保留。"
                        : (snap.UpdatedAt == 0
                            ? "联系人缓存还没同步（updatedAt = 0）：联系人只在核心启动时扫描一次，重启核心后再刷新。"
                            : "联系人列表是空的。"), !snap.Ok);
                }
                else
                {
                    UpdateList();
                }
                RenderFooter();
            }
            finally
            {
                _loading = false;
                BtnReload.IsEnabled = !AllMuted;
            }
        }

        private async void OnReload(object sender, RoutedEventArgs e) => await ReloadAsync(force: true);

        private void OnSearchChanged(object sender, TextChangedEventArgs e)
        {
            if (!IsLoaded) return;
            UpdateList();
        }

        private async void OnItemToggled(object sender, RoutedEventArgs e)
        {
            if (!_ready || !(sender is CheckBox cb) || !(cb.DataContext is ContactItem item)) return;
            item.IsSelected = cb.IsChecked == true;
            if (item.IsSelected)
            {
                if (!_chosen.Contains(item.Wxid)) _chosen.Add(item.Wxid);
            }
            else
            {
                _chosen.Remove(item.Wxid);
            }
            RenderFooter();
            await SaveAsync();
        }

        private async void OnAllMuteChanged(object sender, RoutedEventArgs e)
        {
            if (!_ready || _applying) return;
            ApplyAllMuteState();
            await SaveAsync();
        }

        private bool AllMuted => _allowAllMute && AllMuteCheck.IsChecked == true;

        private void ApplyAllMuteState()
        {
            var all = AllMuted;
            List.IsEnabled = !all;
            SearchBox.IsEnabled = !all;
            BtnReload.IsEnabled = !all && !_loading;
            AllMuteHint.Visibility = all ? Visibility.Visible : Visibility.Collapsed;
            AllMuteHint.Text = all ? "全部静音期间暂停向所有会话发言，取消后恢复按名单静音。" : "";
            RenderFooter();
        }

        /// <summary>本地过滤，输入即出结果；联系人本身仍保留原始勾选状态。</summary>
        private void UpdateList()
        {
            var q = (SearchBox.Text ?? "").Trim();
            var filtered = q.Length == 0
                ? _all
                : _all.Where(x => ContactDirectory.Matches(x, q)).ToList();

            // 已选的排前面，方便确认名单；其余保持联系人接口的原始顺序。
            var ordered = filtered.OrderByDescending(x => x.IsSelected).ToList();
            List.ItemsSource = ordered;

            if (ordered.Count > 0)
            {
                StateText.Visibility = Visibility.Collapsed;
            }
            else if (_all.Count > 0)
            {
                ShowState("没有匹配「" + q + "」的联系人。", false);
            }
        }

        private async Task SaveAsync()
        {
            if (!_sup.NodeRunning)
            {
                Revert();
                SetError("内核没起，改动没保存。点顶栏 ⏻ 启动后再选。");
                return;
            }

            var res = await _saver.SaveAsync(BuildPatch);
            if (!res.Ok)
            {
                Revert();
                SetError("保存失败：" + Api.Message(res));
                Status?.Invoke("名单保存失败，已恢复到上次保存的状态。");
                return;
            }

            _savedIds = new List<string>(_chosen);
            _savedAllMute = AllMuted;
            SetError("");
            Status?.Invoke("已保存 " + DateTime.Now.ToString("HH:mm:ss"));
        }

        private IDictionary<string, object> BuildPatch()
            => new Dictionary<string, object>
            {
                [_configPath] = AllMuted ? new List<string> { "*" } : new List<string>(_chosen)
            };

        private void Revert()
        {
            _chosen.Clear();
            _chosen.AddRange(_savedIds);
            _applying = true;
            try { AllMuteCheck.IsChecked = _savedAllMute; }
            finally { _applying = false; }
            foreach (var item in _all) item.IsSelected = _chosen.Contains(item.Wxid);
            ApplyAllMuteState();
            UpdateList();
        }

        private void RenderFooter()
        {
            FootText.Text = AllMuted
                ? "已勾全部静音，将以 * 保存"
                : "已选 " + _chosen.Count + " 个 · 勾选即保存";
        }

        private void ShowState(string text, bool error)
        {
            List.ItemsSource = null;
            StateText.Text = text ?? "";
            StateText.Foreground = error ? (Brush)FindResource("Bad") : (Brush)FindResource("Dim");
            StateText.Visibility = Visibility.Visible;
        }

        private void SetError(string text)
        {
            ErrorText.Text = text ?? "";
            ErrorText.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;
            if (!string.IsNullOrEmpty(text)) Status?.Invoke(text);
        }
    }
}
