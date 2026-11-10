using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WhaleLauncher.Views
{
    /// <summary>提醒列表里的一行。</summary>
    public sealed class ReminderRow
    {
        public string Id { get; set; } = "";
        public string Time { get; set; } = "";
        public string Name { get; set; } = "";
        public string Wxid { get; set; } = "";
        public string Text { get; set; } = "";
        public string Status { get; set; } = "";
        public Brush StatusBrush { get; set; }
        public string Error { get; set; } = "";
        public Visibility ErrorVisibility => string.IsNullOrEmpty(Error) ? Visibility.Collapsed : Visibility.Visible;
    }

    /// <summary>提醒列表：只读展示 + 删除（取消）一条提醒。</summary>
    public partial class ReminderPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly ConfigSaver _saver;
        private DateTime _lastLoad = DateTime.MinValue;
        private bool _busy;
        private bool _formsLoaded;   // 表单（提醒规则 / 主动搭话）载入过没有（M30）
        private bool _diaryEnabled;  // 最近一次从服务端读到的日记开关，保存失败时用来回滚界面
        private bool _diarySendToOwner;

        public ReminderPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            _saver = new ConfigSaver(sup);

            // 所有输入都自动保存：输入框失焦、勾选框点一下就写回；手点「保存」按钮仍然可用。
            TxtMaxPerDay.LostFocus += async (_, __) => await SaveRulesAsync();
            TxtQuiet.LostFocus += async (_, __) => await SaveRulesAsync();
            ChkEnabled.Click += async (_, __) => await SaveRulesAsync();
            ChkDiaryEnabled.Click += async (_, __) => await SaveDiaryAsync();
            ChkDiarySend.Click += async (_, __) => await SaveDiaryAsync();
            TxtDiaryTime.LostFocus += async (_, __) => await SaveDiaryAsync();
            foreach (var box in new[] { TxtCareEvery, TxtCareJitter, TxtCareMax, TxtCareQuiet, TxtCareWindows })
                box.LostFocus += async (_, __) => await SaveCareAsync();
            foreach (var chk in new[] { ChkCareEnabled, ChkCareOnlyMaster, ChkCareGroups, ChkCareOthers })
                chk.Click += async (_, __) => await SaveCareAsync();

            Loaded += async (_, __) => await RefreshAsync(true);   // 页面载入才全量回填（M30）
        }

        /// <summary>周期刷新（MainWindow 2 秒定时器驱动）：只刷提醒列表和状态行，不动表单（M30）。</summary>
        public Task RefreshAsync() => RefreshAsync(false);

        /// <summary>full = 全量回填：页面载入/手动刷新时把「提醒规则」「主动搭话」表单也刷回服务端的值。</summary>
        private async Task RefreshAsync(bool full)
        {
            if (_busy) return;
            if ((DateTime.Now - _lastLoad).TotalSeconds < 3) return;
            _lastLoad = DateTime.Now;
            _busy = true;
            try
            {
                var res = await _sup.ReadConfigurationAsync("/api/reminders");
                if (!res.Ok)
                {
                    ShowState("提醒接口还没就绪（GET /api/reminders 失败）。" + Api.Message(res), true);
                    return;
                }

                var rows = new List<ReminderRow>();
                var arr = res.Prop("items");
                if (arr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var it in arr.EnumerateArray())
                    {
                        if (it.ValueKind != JsonValueKind.Object) continue;
                        var rawStatus = JsonRead.Str(it, "status");
                        var (statusText, brushKey) = StatusOf(rawStatus);
                        var wxid = JsonRead.Str(it, "wxid");
                        var name = JsonRead.Str(it, "name");
                        rows.Add(new ReminderRow
                        {
                            Id = JsonRead.Str(it, "id"),
                            Time = FormatDue(it),
                            Name = name.Length > 0 ? name : (wxid.Length > 0 ? wxid : "（未知目标）"),
                            Wxid = wxid,
                            Text = JsonRead.Str(it, "text"),
                            Status = statusText,
                            StatusBrush = (Brush)FindResource(brushKey),
                            Error = JsonRead.Str(it, "error")
                        });
                    }
                }

                ReminderList.ItemsSource = rows;
                if (rows.Count == 0)
                {
                    EmptyText.Text = "还没有提醒";
                    EmptyText.Foreground = (Brush)FindResource("Dim");
                    EmptyText.Visibility = Visibility.Visible;
                }
                else
                {
                    EmptyText.Visibility = Visibility.Collapsed;
                }
                LoadRules(res.Prop("rules"), full || !_formsLoaded);
                await LoadDiaryAsync(full || !_formsLoaded);
                if (full || !_formsLoaded) await LoadCareAsync();   // 周期刷新不碰表单，免得覆盖正在编辑的值（M30）
                _formsLoaded = true;
                StatusText.Text = "共 " + rows.Count + " 条 · " + DateTime.Now.ToString("HH:mm:ss") + " 刷新";
                if (!_sup.NodeRunning) StatusText.Text += " · 可保存到本地，启动后生效";
            }
            catch (Exception ex)
            {
                ShowState("刷新提醒失败：" + ex.Message, true);
            }
            finally
            {
                _busy = false;
            }
        }

        private async void OnRefresh(object sender, RoutedEventArgs e)
        {
            _lastLoad = DateTime.MinValue;
            await RefreshAsync(true);   // 手动刷新 = 全量回填（M30）
        }

        private async Task LoadDiaryAsync(bool full)
        {
            var res = await _sup.ReadConfigurationAsync("/api/diary");
            if (!res.Ok) { DiaryStatus.Text = "读取日记状态失败：" + res.Error; return; }
            if (full)
            {
                _diaryEnabled = res.Bool("enabled");
                _diarySendToOwner = res.Bool("sendToOwner");
                if (!ChkDiaryEnabled.IsKeyboardFocusWithin) ChkDiaryEnabled.IsChecked = _diaryEnabled;
                if (!ChkDiarySend.IsKeyboardFocusWithin) ChkDiarySend.IsChecked = _diarySendToOwner;
                if (!TxtDiaryTime.IsKeyboardFocusWithin) TxtDiaryTime.Text = res.Str("time");
            }
            DiaryStatus.Text = res.Str("message");
            BtnWriteDiary.IsEnabled = _sup.NodeRunning && res.Str("status") != "running";
        }

        private async void OnSaveDiary(object sender, RoutedEventArgs e) => await SaveDiaryAsync();

        private async Task SaveDiaryAsync()
        {
            // 保存失败时把勾选框退回上一次服务端的值，否则周期刷新不回读 enabled，
            // 界面会一直显示一个实际上没写进配置的开关状态。
            var time = TxtDiaryTime.Text.Trim();
            if (!System.Text.RegularExpressions.Regex.IsMatch(time, @"^([01]\d|2[0-3]):[0-5]\d$"))
            {
                ChkDiaryEnabled.IsChecked = _diaryEnabled;
                ChkDiarySend.IsChecked = _diarySendToOwner;
                DiarySettingsStatus.Text = "时间请填 HH:mm，例如 23:00。";
                return;
            }
            try
            {
                var res = await _saver.SaveAsync(() => new Dictionary<string, object>
                {
                    ["diary.enabled"] = ChkDiaryEnabled.IsChecked == true,
                    ["diary.sendToOwner"] = ChkDiarySend.IsChecked == true,
                    ["diary.time"] = time
                });
                if (res.Ok)
                {
                    _diaryEnabled = ChkDiaryEnabled.IsChecked == true;
                    _diarySendToOwner = ChkDiarySend.IsChecked == true;
                    DiarySettingsStatus.Text = "日记设置已保存";
                }
                else
                {
                    ChkDiaryEnabled.IsChecked = _diaryEnabled;
                    ChkDiarySend.IsChecked = _diarySendToOwner;
                    DiarySettingsStatus.Text = "保存失败：" + Api.Message(res);
                }
            }
            catch (Exception ex)
            {
                ChkDiaryEnabled.IsChecked = _diaryEnabled;
                ChkDiarySend.IsChecked = _diarySendToOwner;
                DiarySettingsStatus.Text = Api.FriendlyError(ex);
            }
        }

        private async void OnWriteDiary(object sender, RoutedEventArgs e)
        {
            BtnWriteDiary.IsEnabled = false;
            try
            {
                var res = await Api.Post(_sup.Url, "/api/diary/generate", "{}");
                DiaryStatus.Text = res.Ok ? res.Str("message") : "生成失败：" + res.Error;
                if (res.Ok) await LoadDiaryAsync(false);
                else BtnWriteDiary.IsEnabled = true;
            }
            catch (Exception ex) { DiaryStatus.Text = Api.FriendlyError(ex); BtnWriteDiary.IsEnabled = true; }
        }

        private void OnOpenDiary(object sender, RoutedEventArgs e)
        {
            try
            {
                var dir = Path.Combine(_sup.DataDir, "diary");
                Directory.CreateDirectory(dir);
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + dir + "\"") { UseShellExecute = true });
            }
            catch (Exception ex) { DiaryStatus.Text = Api.FriendlyError(ex); }
        }

        private async void OnCancelReminder(object sender, RoutedEventArgs e)
        {
            if (!(sender is Button btn)) return;
            var id = btn.Tag as string;
            if (string.IsNullOrEmpty(id)) return;

            btn.IsEnabled = false;
            try
            {
                var res = await Api.PostJson(_sup.Url, "/api/reminders/cancel", new { id });
                if (!res.Ok)
                {
                    StatusText.Text = "取消失败：" + Api.Message(res);
                    return;
                }
                StatusText.Text = "已取消提醒 " + id;
                _lastLoad = DateTime.MinValue;
                await RefreshAsync();
            }
            finally
            {
                btn.IsEnabled = true;
            }
        }


        // ── 提醒规则（和主动搭话同语义，配置独立）──────────────
        // ── 主动搭话（同一页，配置独立）────────────────────────
        private async Task LoadCareAsync()
        {
            var cfg = await _sup.ReadConfigurationAsync("/api/config");
            if (!cfg.Ok || cfg.Prop("config").ValueKind != JsonValueKind.Object) return;
            if (!cfg.Prop("config").TryGetProperty("care", out var care) || care.ValueKind != JsonValueKind.Object)
                return;
            // 回填前跳过正在编辑（有键盘焦点）的控件，别把没保存的输入冲掉（M30）
            if (!ChkCareEnabled.IsKeyboardFocusWithin) ChkCareEnabled.IsChecked = JsonRead.Bool(care, "enabled");
            if (!ChkCareOnlyMaster.IsKeyboardFocusWithin) ChkCareOnlyMaster.IsChecked = JsonRead.Bool(care, "onlyMaster");
            if (!ChkCareGroups.IsKeyboardFocusWithin) ChkCareGroups.IsChecked = JsonRead.Bool(care, "allowGroups");
            if (!ChkCareOthers.IsKeyboardFocusWithin) ChkCareOthers.IsChecked = JsonRead.Bool(care, "allowOthers");
            if (!TxtCareEvery.IsKeyboardFocusWithin) TxtCareEvery.Text = JsonRead.Int(care, "everyMinutes", 90).ToString();
            if (!TxtCareJitter.IsKeyboardFocusWithin) TxtCareJitter.Text = JsonRead.Int(care, "jitterMinutes", 25).ToString();
            if (!TxtCareMax.IsKeyboardFocusWithin) TxtCareMax.Text = JsonRead.Int(care, "maxPerDay", 0).ToString();
            if (!TxtCareQuiet.IsKeyboardFocusWithin) TxtCareQuiet.Text = JsonRead.Int(care, "quietAfterMinutes", 0).ToString();
            if (!TxtCareWindows.IsKeyboardFocusWithin) TxtCareWindows.Text = JsonRead.Lines(care, "windows");
            CareStatus.Text = "";
        }

        private async void OnSaveCare(object sender, RoutedEventArgs e) => await SaveCareAsync();

        private async Task<bool> SaveCareAsync()
        {
            if (!IntOr(TxtCareEvery, out var every)
                || !IntOr(TxtCareJitter, out var jitter)
                || !IntOr(TxtCareMax, out var max)
                || !IntOr(TxtCareQuiet, out var quiet))
                return false;

            BtnSaveCare.IsEnabled = false;
            try
            {
                var res = await _saver.SaveAsync(() => new Dictionary<string, object>
                {
                    ["care.enabled"] = ChkCareEnabled.IsChecked == true,
                    ["care.onlyMaster"] = ChkCareOnlyMaster.IsChecked == true,
                    ["care.allowGroups"] = ChkCareGroups.IsChecked == true,
                    ["care.allowOthers"] = ChkCareOthers.IsChecked == true,
                    ["care.everyMinutes"] = every,
                    ["care.jitterMinutes"] = jitter,
                    ["care.maxPerDay"] = max,
                    ["care.quietAfterMinutes"] = quiet,
                    ["care.windows"] = LineList(TxtCareWindows)
                });
                if (!res.Ok)
                {
                    CareStatus.Text = "保存失败：" + Api.Message(res);
                    return false;
                }
                CareStatus.Text = "已保存 " + DateTime.Now.ToString("HH:mm:ss");
                return true;
            }
            finally
            {
                BtnSaveCare.IsEnabled = true;
            }
        }

        private bool IntOr(NumberField field, out int value)
        {
            if (field.TryRead(out value)) return true;
            CareStatus.Text = field.ErrorText;
            return false;
        }


        private static List<string> LineList(System.Windows.Controls.TextBox box)
            => (box.Text ?? "").Split('\n')
                .Select(x => x.Trim()).Where(x => x.Length > 0)
                .ToList();

        private void LoadRules(JsonElement rules, bool apply)
        {
            if (rules.ValueKind != JsonValueKind.Object) return;
            if (!apply) return;   // 周期刷新不动表单（M30）
            // 回填前跳过正在编辑的控件
            if (rules.TryGetProperty("enabled", out var en) && !ChkEnabled.IsKeyboardFocusWithin)
                ChkEnabled.IsChecked = en.ValueKind == JsonValueKind.True;
            if (rules.TryGetProperty("maxPerDay", out var cap) && cap.ValueKind == JsonValueKind.Number && !TxtMaxPerDay.IsKeyboardFocusWithin)
                TxtMaxPerDay.Text = cap.GetInt32().ToString();
            if (rules.TryGetProperty("quietAfterMinutes", out var quiet) && quiet.ValueKind == JsonValueKind.Number && !TxtQuiet.IsKeyboardFocusWithin)
                TxtQuiet.Text = quiet.GetInt32().ToString();
            RulesStatus.Text = "";
        }

        private async void OnSaveRules(object sender, RoutedEventArgs e) => await SaveRulesAsync();

        private async Task<bool> SaveRulesAsync()
        {
            if (!TxtMaxPerDay.TryRead(out var maxPerDay))
            {
                RulesStatus.Text = TxtMaxPerDay.ErrorText;
                return false;
            }
            if (!TxtQuiet.TryRead(out var quiet))
            {
                RulesStatus.Text = TxtQuiet.ErrorText;
                return false;
            }
            BtnSaveRules.IsEnabled = false;
            try
            {
                var res = await _saver.SaveAsync(() => new Dictionary<string, object>
                {
                    ["reminder.enabled"] = ChkEnabled.IsChecked == true,
                    ["reminder.maxPerDay"] = maxPerDay,
                    ["reminder.quietAfterMinutes"] = quiet
                });
                if (!res.Ok)
                {
                    RulesStatus.Text = "保存失败：" + Api.Message(res);
                    return false;
                }
                RulesStatus.Text = "规则已保存 " + DateTime.Now.ToString("HH:mm:ss");
                _lastLoad = DateTime.MinValue;
                await RefreshAsync();
                return true;
            }
            finally
            {
                BtnSaveRules.IsEnabled = true;
            }
        }

        private void ShowState(string text, bool error)
        {
            ReminderList.ItemsSource = null;
            EmptyText.Text = text ?? "";
            EmptyText.Foreground = error ? (Brush)FindResource("Bad") : (Brush)FindResource("Dim");
            EmptyText.Visibility = Visibility.Visible;
            StatusText.Text = error ? "刷新失败" : "";
        }

        // ── 字段读取 ────────────────────────────────────────────
        private static (string Text, string BrushKey) StatusOf(string raw) => raw switch
        {
            "pending" => ("待发", "Warn"),
            "retrying" => ("重试中", "Warn"),
            "done" => ("已发", "Ok"),
            "failed" => ("失败", "Bad"),
            "expired" => ("已过期", "Dim"),
            "cancelled" => ("已取消", "Dim"),
            _ => (string.IsNullOrEmpty(raw) ? "未知" : raw, "Muted")
        };

        private static string FormatDue(JsonElement it)
        {
            long ms = 0;
            if (it.TryGetProperty("dueAt", out var d))
            {
                if (d.ValueKind == JsonValueKind.Number)
                {
                    if (d.TryGetInt64(out var n)) ms = n;
                }
                else if (d.ValueKind == JsonValueKind.String && long.TryParse(d.GetString(), out var s))
                {
                    ms = s;
                }
            }
            if (ms <= 0) return "—";
            if (ms < 100000000000L) ms *= 1000;   // 后端如果给的是秒，兼容一下
            try { return DateTimeOffset.FromUnixTimeMilliseconds(ms).LocalDateTime.ToString("MM-dd HH:mm"); }
            catch { return "—"; }
        }
    }
}
