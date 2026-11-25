using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WhaleLauncher.Views
{
    public sealed class RecentItem
    {
        public string Time { get; set; }
        public string Who { get; set; }
        public string Text { get; set; }
    }

    public partial class StatusPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly HostPower _host;

        private DateTime _lastCare = DateTime.MinValue;
        private RuntimeSupervisor.CareState _care;
        private readonly System.Windows.Threading.DispatcherTimer _recentTimer;
        private bool _recentBusy;
        private string _recentJson = "";
        private Snapshot _status = new Snapshot();
        // 刷新会按真实值回写控件；控件事件再触发保存就会互相打架，用它隔开。
        private bool _hostSyncing;

        public StatusPage(RuntimeSupervisor sup, HostPower host)
        {
            InitializeComponent();
            SmoothScroll.Attach(Recent);
            _sup = sup;
            _host = host;
            _recentTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            _recentTimer.Tick += async (_, __) => await PollRecentAsync();
            Loaded += async (_, __) => { _recentTimer.Start(); await PollRecentAsync(); };
            Unloaded += (_, __) => _recentTimer.Stop();
            Loaded += async (_, __) => await RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            var s = await _sup.ProbeAsync();
            _status = s;
            Apply(s);
            // 状态页本来就每 2 秒刷一次，主机状态跟着这条节奏走，不再另开定时器。
            SyncHost(_host.ReadStatus());

            if ((DateTime.Now - _lastCare).TotalSeconds >= 30)
            {
                _lastCare = DateTime.Now;
                await RefreshCareAsync(s);
            }
        }

        private async Task PollRecentAsync()
        {
            if (_recentBusy || !IsLoaded) return;
            _recentBusy = true;
            try { await RefreshRecentAsync(_status); }
            finally { _recentBusy = false; }
        }

        private void Apply(Snapshot s)
        {
            // 内核
            DotNode.Fill = s.NodeReady ? (Brush)FindResource("Ok") : (Brush)FindResource(s.NodeUp ? "Warn" : "Idle");
            NodeMain.Text = !s.NodeUp ? "未启动" : (s.NodeReady ? "运行中" : "等待就绪");
            NodeAge.Text = s.NodeUp ? (s.ExternalNode ? "后台启动 · " : "") + "已跑 " + Short(s.UptimeSec) : "";
            NodeSub.Text = s.NodeUp
                ? $"端口 {s.Port} · {s.Provider}/{s.Model}{(!s.NeedsKey || s.HasKey ? "" : " · 还没有 Key")}{(s.Mock ? " · 演示模式" : "")}"
                : "点顶栏 ⏻ 启动";

            // 桥接
            DotBridge.Fill = s.BrOnline ? (Brush)FindResource("Ok")
                : (s.NodeUp ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));
            BridgeMain.Text = s.BrOnline ? "在线" : (s.NodeUp ? "离线" : "未启动");
            BridgeAge.Text = s.BrOnline && s.BrLastSeenSec >= 0 ? $"心跳 {s.BrLastSeenSec} 秒前" : "";
            BridgeSub.Text = s.BrOnline
                ? (s.BrUia ? "UIA 正常" : "UIA 拿不到") + (s.BrListener ? " · 收消息正常" : " · 收消息停了")
                : (s.NodeUp ? "内核在跑，桥接没连上" : "—");

            // 微信
            var who = !string.IsNullOrEmpty(s.BrAccountNick) ? s.BrAccountNick : s.BrAccount;
            DotWechat.Fill = s.BrOnline && s.BrAccountOk ? (Brush)FindResource("Ok")
                : (s.BrOnline ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));
            WechatMain.Text = !s.BrOnline || string.IsNullOrEmpty(who) ? "未知" : who;
            WechatSub.Text = s.BrOnline
                ? $"窗口 {(string.IsNullOrEmpty(s.BrWindow) ? "未知" : s.BrWindow)} · 账号{(s.BrAccountOk ? "已确认" : "未确认")} · 双开守卫{(s.BrAccountGuard ? "已开" : "已关")}"
                : "—";

            // 用量
            UsageLine.Text = s.NodeUp
                ? $"本次运行   收到 {s.StReceived}   ·   回复 {s.StReplied}   ·   发送 {s.StSent}   ·   失败 {s.StFailed}"
                : "本次运行   内核没起，还没有数";
            if (s.StFailed > 0) UsageLine.Foreground = (Brush)FindResource("Warn");
            else UsageLine.Foreground = (Brush)FindResource("Text");

            // 本轮用量：命中 / 输入 / 输出 / 命中率 / 估算（和内核日志里那行同一个口径）
            RoundUsageLine.Text = FormatRoundUsage(s);
            RoundUsageLine.Foreground = (Brush)FindResource(s.HasUsage ? "Text" : "Dim");
        }

        /// <summary>本轮用量一行。没调过真模型（演示模式 / 还没聊过）就显示「—」，不猜。</summary>
        private static string FormatRoundUsage(Snapshot s)
        {
            if (!s.HasUsage) return "本轮用量   —（还没调用过真实模型；演示模式没有用量）";
            var rate = s.UsHitRate * 100.0;
            var ratio = s.UsRatio * 100.0;
            var sign = ratio >= 0 ? "+" : "";
            var model = string.IsNullOrEmpty(s.UsModel) ? "" : " · " + s.UsModel;
            // 只有 deepseek-flash / deepseek-v4.1-flash 有价目表；其它模型不显示金额
            var cost = s.UsHasCost
                ? " · ¥" + s.UsCny.ToString("0.#####", CultureInfo.InvariantCulture)
                  + "（" + (s.UsBand == "peak" ? "高峰" : "谷时") + "）"
                : "";
            return $"本轮用量   命中 {s.UsCacheHitTokens} / 输入 {s.UsPromptTokens}（{rate:0.0}%）/ 输出 {s.UsCompletionTokens}"
                + $" · 估算 {s.UsEstimatedTokens}（{sign}{ratio:0.0}%）{model}{cost}";
        }

        private async Task RefreshCareAsync(Snapshot s)
        {
            if (!s.NodeUp)
            {
                CareLine.Text = "主动搭话   —";
                return;
            }
            try
            {
                _care = _sup.ReadCareState();
                await _sup.QueryCareDueAsync(_care);
                if (_care.Reason == "disabled") CareLine.Text = "主动搭话   已关闭";
                else if (_care.Due) CareLine.Text = $"主动搭话   今天 {_care.SentToday} 次 · 现在就该来一句了";
                else if (_care.WaitMinutes > 0) CareLine.Text = $"主动搭话   今天 {_care.SentToday} 次 · 下次约 {_care.WaitMinutes} 分后";
                else CareLine.Text = $"主动搭话   今天 {_care.SentToday} 次 · {ReasonText(_care.Reason)}";
            }
            catch
            {
                CareLine.Text = "主动搭话   —";
            }
        }

        private static string ReasonText(string r) => r switch
        {
            "out_of_window" => "现在不在时间窗里",
            "daily_cap" => "今天已经到上限了",
            "too_soon" => "刚说过没多久",
            "group_not_allowed" => "群里不让主动说话",
            "only_master" => "只对主人主动",
            _ => "等待中"
        };

        private async Task RefreshRecentAsync(Snapshot s)
        {
            if (!s.NodeUp)
            {
                Recent.ItemsSource = null;
                _recentJson = "";
                RecentEmpty.Visibility = Visibility.Visible;
                RecentEmpty.Text = "内核没起，看不到消息。";
                RecentHint.Text = "";
                return;
            }
            try
            {
                var res = await Api.Get($"http://127.0.0.1:{s.Port}", "/api/recent?limit=10", 3);
                if (!res.Ok)
                {
                    RecentHint.Text = "更新暂时失败，正在重试";
                    return;
                }
                if (!IsLoaded || res.Raw == _recentJson) return;
                var items = new List<RecentItem>();
                var arr = res.Prop("items");
                if (arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var it in arr.EnumerateArray())
                    {
                        var ts = JsonRead.Long(it, "ts");
                        items.Add(new RecentItem
                        {
                            Time = ts > 0 ? DateTimeOffset.FromUnixTimeMilliseconds(ts).LocalDateTime.ToString("HH:mm") : "",
                            Who = JsonRead.Str(it, "who"),
                            Text = JsonRead.Str(it, "text")
                        });
                    }
                }
                Recent.ItemsSource = items;
                _recentJson = res.Raw;
                RecentEmpty.Visibility = items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
                if (items.Count == 0) RecentEmpty.Text = "还没有消息。先在微信里跟她说一句。";
                RecentHint.Text = items.Count > 0 ? items.Count + " 条" : "";
            }
            catch
            {
                // /api/recent 还没做，或者内核刚起
                RecentHint.Text = "更新暂时失败，正在重试";
            }
        }

        private static string Short(long sec)
        {
            if (sec <= 0) return "0 秒";
            var t = TimeSpan.FromSeconds(sec);
            if (t.TotalHours >= 1) return $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}";
            if (t.TotalMinutes >= 1) return $"{t.Minutes} 分";
            return $"{t.Seconds} 秒";
        }

        // ── 主机：会话 / 保活 / 远程操作权限 ────────────────────
        private void SyncHost(HostPower.HostStatus h)
        {
            _hostSyncing = true;
            try
            {
                HostLine.Text = "会话 " + (h.Locked ? "已锁屏" : "已登录")
                    + "   ·   输入桌面 " + (string.IsNullOrEmpty(h.InputDesktop) ? "—" : h.InputDesktop)
                    + "   ·   空闲 " + (h.IdleSeconds < 0 ? "—" : Short(h.IdleSeconds));
                HostLine.ToolTip = "用户 " + h.UserName + " · 主机 " + h.Hostname
                    + " · 会话 " + h.SessionId + " · 启动器已运行 " + Short(h.UptimeSeconds);
                HostConfigLine.Text = "保活 " + ModeLabel(h.KeepAwake)
                    + "   ·   开机自启 " + (h.AutoStart ? "已开" : "已关")
                    + "   ·   手机启动内核 " + (h.RemoteProcessLaunch ? "允许" : "不允许");
                HostKeepAwake.SelectedIndex = ModeIndex(h.KeepAwake);
                ChkRemoteProcess.IsChecked = h.RemoteProcessLaunch;
                ChkAutoStart.IsChecked = h.AutoStart;
                ChkDisplayControl.IsChecked = h.DisplayControl;
                // 笔记本上不提供远程开关屏幕，开关本身也不显示；台式机上打开开关才出现关屏按钮。
                // 桌面端不提供「点亮屏幕」：人在电脑前，动鼠标/键盘更直接，按钮只会让人误以为是坏的。
                ChkDisplayControl.Visibility = h.IsLaptop ? Visibility.Collapsed : Visibility.Visible;
                BtnDisplayOff.Visibility = !h.IsLaptop && h.DisplayControl ? Visibility.Visible : Visibility.Collapsed;
                BtnDisplayOff.IsEnabled = !h.DisplayOffBlocked;
                BtnDisplayOff.ToolTip = h.DisplayOffBlocked ? h.DisplayOffBlockedReason : "关闭显示器（不锁屏）";
            }
            finally
            {
                _hostSyncing = false;
            }
        }

        private static string ModeLabel(string mode) => mode switch
        {
            "system" => "防睡眠",
            "display" => "防关屏",
            _ => "关",
        };

        private static int ModeIndex(string mode) => mode switch
        {
            "system" => 1,
            "display" => 2,
            _ => 0,
        };

        private static string ModeValue(int index) => index switch
        {
            1 => "system",
            2 => "display",
            _ => "off",
        };

        private void OnHostKeepAwakeChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_hostSyncing) return;
            var error = _host.TrySetKeepAwake(ModeValue(HostKeepAwake.SelectedIndex));
            if (error != null) AppDialog.Show(Window.GetWindow(this), error, "主机");
            SyncHost(_host.ReadStatus());
        }

        private void OnRemoteProcessChanged(object sender, RoutedEventArgs e)
        {
            if (_hostSyncing) return;
            var error = _host.TrySetRemoteProcessLaunch(ChkRemoteProcess.IsChecked == true);
            if (error != null) AppDialog.Show(Window.GetWindow(this), error, "主机");
            SyncHost(_host.ReadStatus());
        }

        private void OnAutoStartChanged(object sender, RoutedEventArgs e)
        {
            if (_hostSyncing) return;
            var error = _host.TrySetAutoStart(ChkAutoStart.IsChecked == true);
            if (error != null) AppDialog.Show(Window.GetWindow(this), error, "主机");
            SyncHost(_host.ReadStatus());
        }

        private void OnDisplayControlChanged(object sender, RoutedEventArgs e)
        {
            if (_hostSyncing) return;
            var error = _host.TrySetDisplayControl(ChkDisplayControl.IsChecked == true);
            if (error != null) AppDialog.Show(Window.GetWindow(this), error, "主机");
            SyncHost(_host.ReadStatus());
        }

        // 关屏和锁屏是两件事：这里只关显示器，会话保持登录；是否会被强制锁屏取决于系统策略。
        // 桌面端不提供「点亮屏幕」——人在电脑前动鼠标/键盘更直接，按钮反而像坏的。
        private void OnDisplayOff(object sender, RoutedEventArgs e)
        {
            var result = _host.RequestDisplayOff();
            if (result != null) AppDialog.Show(Window.GetWindow(this), result, "主机");
        }

        // 教程还没发布，先用官网首页锚点；官网上线教程后只改这一处。
        private const string HostHelpUrl = "https://bot.zyyc.cc/#phone-control";

        private void OnHostHelp(object sender, RoutedEventArgs e)
        {
            try
            {
                Process.Start(new ProcessStartInfo(HostHelpUrl) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                AppDialog.Show(Window.GetWindow(this), "打开教程失败：" + ex.Message, "主机");
            }
        }

        // ── 动作 ────────────────────────────────────────────────
        private async void OnRefresh(object sender, RoutedEventArgs e)
        {
            _lastCare = DateTime.MinValue;
            await RefreshAsync();
            await PollRecentAsync();
        }

    }
}
