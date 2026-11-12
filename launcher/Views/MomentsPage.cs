using System;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views;

// 读取只查本地缓存；互动会操作微信窗口，执行后必须由用户在微信里确认。
public sealed partial class MomentsPage : UserControl
{
    static readonly (string Value, string Label)[] Actions = {
        ("like", "点赞"), ("unlike", "取消点赞"), ("comment", "评论"), ("reply", "回复评论"),
    };

    readonly RuntimeSupervisor sup;
    bool reading;
    bool loadingSettings;
    bool publishSettingsLoaded;
    int viewGeneration;

    public MomentsPage(RuntimeSupervisor supervisor)
    {
        InitializeComponent();
        sup = supervisor;
        ActionBox.ItemsSource = Array.ConvertAll(Actions, a => a.Label);
        ActionBox.SelectedIndex = 0;

        BtnRead.Click += async (_, _) => await ReadAsync();
        BtnInteract.Click += async (_, _) => await InteractAsync();
        BtnDraft.Click += (_, _) => CopyDraft();
        BtnSavePublish.Click += async (_, _) => await SavePublishAsync();
        BtnTestPublish.Click += async (_, _) => await TestPublishAsync();
        BtnRefreshPublish.Click += async (_, _) => await LoadPublishAsync();
        BtnPublishHappy.Click += async (_, _) => await OpenPublishFolderAsync("happy");
        BtnPublishCute.Click += async (_, _) => await OpenPublishFolderAsync("cute");
        BtnPublishAngry.Click += async (_, _) => await OpenPublishFolderAsync("angry");
        Loaded += async (_, _) => await Task.WhenAll(LoadSettingsAsync(), LoadLatestAsync(), LoadPublishAsync());

        // 离开页面即清空第三方正文与输入，并让旧请求停止回填。
        Unloaded += (_, _) => {
            viewGeneration++;
            publishSettingsLoaded = false;
            BtnRefreshPublish.IsEnabled = true;
            TxtOutput.Clear();
            StatusText.Text = "";
            TxtKeyword.Clear(); TxtUsername.Clear(); TxtPublisher.Clear();
            TxtComment.Clear(); TxtReplyTo.Clear();
        };
    }

    async Task ReadAsync()
    {
        if (reading) return;
        reading = true;
        BtnRead.IsEnabled = false;
        TxtOutput.Clear();
        var generation = viewGeneration;
        try
        {
            StatusText.Text = "等候桥接读取，请确保微信和桥接已启动…";
            var account = await AccountAsync();
            var response = await Api.PostJson(sup.Url, "/api/moments/read", new {
                account, limit = 20, keyword = TxtKeyword.Text, username = TxtUsername.Text, own = ChkOwn.IsChecked == true
            });
            if (generation != viewGeneration) return;
            if (!response.Ok) { StatusText.Text = Api.Message(response); return; }
            var id = response.Str("id");
            var result = await WaitForMomentsAsync(id, generation);
            if (result == null) { if (generation == viewGeneration) StatusText.Text = "读取超时；请检查桥接是否正在运行。"; return; }
            if (!result.Ok || result.Str("status") == "failed") { StatusText.Text = result.Error; return; }
            var items = result.Prop("items");
            var formatted = FormatItems(items);
            TxtOutput.Text = formatted.Text;
            StatusText.Text = formatted.Count == 0 ? "本地缓存中没有匹配的动态；这不代表微信服务器没有新动态。" : $"已读取 {formatted.Count} 条（已保存最近快照，主人问起时可直接回答）";
        }
        catch (Exception ex) { if (generation == viewGeneration) StatusText.Text = Api.FriendlyError(ex); }
        finally { reading = false; BtnRead.IsEnabled = true; }
    }

    async Task InteractAsync()
    {
        if (reading) return;
        if (string.IsNullOrWhiteSpace(TxtPublisher.Text) || string.IsNullOrWhiteSpace(TxtKeyword.Text))
        {
            StatusText.Text = "执行互动需要同时填写发布者准确昵称和正文关键词。";
            return;
        }
        reading = true; BtnInteract.IsEnabled = false;
        var generation = viewGeneration;
        try
        {
            var account = await AccountAsync();
            var result = await Api.PostJson(sup.Url, "/api/moments/action", new {
                account, action = Actions[ActionBox.SelectedIndex].Value, publisher = TxtPublisher.Text,
                keyword = TxtKeyword.Text, content = TxtComment.Text, replyTo = TxtReplyTo.Text
            });
            if (generation != viewGeneration) return;
            if (!result.Ok) { StatusText.Text = result.Error; return; }
            var state = await WaitForMomentsAsync(result.Str("id"), generation);
            if (state == null) { if (generation == viewGeneration) StatusText.Text = "操作状态未知，请在微信中确认，不要重复发送。"; return; }
            if (!state.Ok || state.Str("status") != "done")
                StatusText.Text = state.Error;
            else
                StatusText.Text = "互动已执行；请在微信里确认结果，不要重复操作。";
        }
        finally { reading = false; BtnInteract.IsEnabled = true; }
    }

    void CopyDraft()
    {
        if (string.IsNullOrWhiteSpace(TxtComment.Text)) return;
        try
        {
            Clipboard.SetText(TxtComment.Text);
            StatusText.Text = "文案已复制，请在微信朋友圈中粘贴并手动发表。";
        }
        catch (Exception ex)
        {
            StatusText.Text = "复制失败：" + Api.FriendlyError(ex);
        }
    }

    async Task LoadSettingsAsync()
    {
        loadingSettings = true;
        try
        {
            var res = await sup.ReadConfigurationAsync("/api/moments/settings");
            if (!res.Ok) { AutoStatus.Text = "读不到自动策略设置：" + res.Error; return; }
            ChkAutoLike.IsChecked = res.Bool("autoLike");
            var hours = (int)res.Long("autoReadEveryHours");
            var matched = false;
            for (var i = 0; i < CmbAutoRead.Items.Count; i++)
            {
                if (CmbAutoRead.Items[i] is ComboBoxItem item
                    && int.TryParse(item.Tag?.ToString(), out var tag) && tag == hours)
                {
                    CmbAutoRead.SelectedIndex = i;
                    matched = true;
                    break;
                }
            }
            if (!matched)
            {
                // 手动在 config.json 里填了 5/8 这类值时，不要把界面显示成「关闭」。
                var item = new ComboBoxItem { Content = $"每 {hours} 小时", Tag = hours.ToString() };
                CmbAutoRead.Items.Add(item);
                CmbAutoRead.SelectedItem = item;
            }
            var max = res.Long("autoLikeMaxPerDay");
            AutoStatus.Text = res.Bool("autoLike")
                ? $"自动点赞已开，每天最多 {max} 条。" : "自动点赞已关。";
        }
        catch (Exception ex) { AutoStatus.Text = "读不到自动策略设置：" + Api.FriendlyError(ex); }
        finally { loadingSettings = false; }
    }

    async Task SaveSettingsAsync()
    {
        if (loadingSettings) return;
        try
        {
            var res = await sup.SaveConfigurationAsync("/api/moments/settings", new {
                autoLike = ChkAutoLike.IsChecked == true,
                autoReadEveryHours = SelectedAutoReadHours(),
            });
            if (!res.Ok) { AutoStatus.Text = Api.Message(res); return; }
            var max = res.Long("autoLikeMaxPerDay");
            AutoStatus.Text = res.Bool("autoLike")
                ? $"自动策略已保存；每天最多 {max} 条。" : "自动策略已保存；自动点赞已关闭。";
        }
        catch (Exception ex) { AutoStatus.Text = "保存失败：" + Api.FriendlyError(ex); }
    }

    int SelectedAutoReadHours()
    {
        if (CmbAutoRead.SelectedItem is ComboBoxItem item
            && int.TryParse(item.Tag?.ToString(), out var hours)) return hours;
        return 0;
    }

    async void OnAutoLikeChanged(object sender, RoutedEventArgs e)
    {
        if (!IsLoaded) return;
        await SaveSettingsAsync();
    }

    async void OnAutoReadChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded) return;
        await SaveSettingsAsync();
    }

    async Task LoadLatestAsync()
    {
        var generation = viewGeneration;
        try
        {
            var res = await Api.Get(sup.Url, "/api/moments/latest");
            if (generation != viewGeneration || !res.Ok) return;
            var snapshot = res.Prop("snapshot");
            if (snapshot.ValueKind != JsonValueKind.Object) return;
            if (!snapshot.TryGetProperty("items", out var items)) return;
            var formatted = FormatItems(items);
            if (formatted.Count == 0) return;
            TxtOutput.Text = formatted.Text;
            snapshot.TryGetProperty("savedAt", out var savedAt);
            var when = savedAt.ValueKind == JsonValueKind.Number && savedAt.GetDouble() > 0
                ? DateTimeOffset.FromUnixTimeMilliseconds((long)savedAt.GetDouble()).ToLocalTime().ToString("yyyy-MM-dd HH:mm")
                : "时间未知";
            StatusText.Text = $"上次读取：{when}（{formatted.Count} 条本地快照）";
        }
        catch { /* 旧快照读不到就保持空页面 */ }
    }

    static (int Count, string Text) FormatItems(JsonElement items)
    {
        var text = new StringBuilder();
        var count = 0;
        if (items.ValueKind == JsonValueKind.Array)
            foreach (var item in items.EnumerateArray())
            {
                count++;
                var name = item.GetProperty("nickname").GetString();
                var seconds = item.GetProperty("create_time").GetDouble();
                var time = seconds >= 0 && seconds <= 253402300799
                    ? DateTimeOffset.FromUnixTimeSeconds((long)seconds).ToLocalTime().ToString("yyyy-MM-dd HH:mm") : "时间未知";
                text.AppendLine($"{name} · {time}");
                text.AppendLine(item.GetProperty("text").GetString());
                text.AppendLine($"图片 {item.GetProperty("imageCount")} / 视频 {item.GetProperty("videoCount")}");
                text.AppendLine();
            }
        return (count, text.ToString());
    }

    // 读取和互动共用一个轮询：等待 done / failed / unconfirmed，超时返回 null。
    async Task<ApiResult> WaitForMomentsAsync(string id, int generation, int attempts = 48)
    {
        for (var i = 0; i < attempts; i++)
        {
            await Task.Delay(2000);
            if (generation != viewGeneration) return null;
            var result = await Api.Get(sup.Url, "/api/moments/result?id=" + Uri.EscapeDataString(id));
            if (generation != viewGeneration) return null;
            if (!result.Ok) return result;
            var status = result.Str("status");
            if (status == "done" || status == "failed" || status == "unconfirmed") return result;
        }
        return null;
    }

    // 双开时把任务钉到当前桥接账号，避免另一个账号的桥接把任务领走。
    async Task LoadPublishAsync()
    {
        if (!BtnRefreshPublish.IsEnabled) return;
        BtnRefreshPublish.IsEnabled = false;
        var generation = viewGeneration;
        try
        {
            var res = await sup.ReadConfigurationAsync("/api/moments/publish-settings");
            if (generation != viewGeneration) return;
            if (!res.Ok)
            {
                PublishStatus.Text = "读取发表设置失败：" + Api.Message(res);
                return;
            }
            // 刷新任务状态时保留用户尚未保存的输入。
            if (!publishSettingsLoaded)
            {
                ChkPublishFeature.IsChecked = res.Bool("featureEnabled");
                ChkPublish.IsChecked = res.Bool("enabled");
                ChkPublishImage.IsChecked = res.Bool("withImage");
                TxtPublishInterval.Text = res.Prop("interval").ToString();
                TxtPublishLimit.Text = res.Long("maxPerDay").ToString();
                publishSettingsLoaded = true;
            }
            ShowPublishStatus(res);
        }
        finally { if (generation == viewGeneration) BtnRefreshPublish.IsEnabled = true; }
    }

    async Task SavePublishAsync()
    {
        if (!double.TryParse(TxtPublishInterval.Text, out var interval) || !double.IsFinite(interval) || interval <= 0
            || !int.TryParse(TxtPublishLimit.Text, out var maxPerDay) || maxPerDay < 0)
        {
            PublishStatus.Text = "间隔请填大于 0 的小时数（可填小数），每日上限填非负整数，0 表示不限。";
            return;
        }
        var featureEnabled = ChkPublishFeature.IsChecked == true;
        var enabled = featureEnabled && ChkPublish.IsChecked == true;
        BtnSavePublish.IsEnabled = false;
        try
        {
            var res = await sup.SaveConfigurationAsync("/api/moments/publish-settings",
                new { featureEnabled, enabled, withImage = ChkPublishImage.IsChecked == true, interval, maxPerDay });
            if (!res.Ok) { PublishStatus.Text = Api.Message(res); return; }
            publishSettingsLoaded = true;
            ChkPublish.IsChecked = res.Bool("enabled");
            ShowPublishStatus(res);
        }
        finally { BtnSavePublish.IsEnabled = true; }
    }

    async Task TestPublishAsync()
    {
        if (ChkPublishFeature.IsChecked != true)
        {
            PublishStatus.Text = "请先开启并保存朋友圈发表总开关。";
            return;
        }
        var generation = viewGeneration;
        BtnTestPublish.IsEnabled = false;
        try
        {
            var res = await Api.PostJson(sup.Url, "/api/moments/publish-test",
                new { confirm = true, withImage = ChkPublishImage.IsChecked == true });
            if (generation != viewGeneration) return;
            if (!res.Ok) { PublishStatus.Text = Api.Message(res); return; }
            ShowPublishStatus(res);
            for (var i = 0; i < 60; i++)
            {
                await Task.Delay(2000);
                if (generation != viewGeneration) return;
                res = await Api.Get(sup.Url, "/api/moments/publish-settings");
                if (generation != viewGeneration) return;
                if (!res.Ok) { PublishStatus.Text = Api.Message(res); return; }
                ShowPublishStatus(res);
                if (res.Str("status") is not ("generating" or "queued" or "sending")) return;
            }
            PublishStatus.Text = "发表结果待确认，请到微信核对。";
        }
        catch (Exception ex) { if (generation == viewGeneration) PublishStatus.Text = Api.FriendlyError(ex); }
        finally { BtnTestPublish.IsEnabled = true; }
    }

    void ShowPublishStatus(ApiResult res)
    {
        var reason = res.Str("error");
        var detail = res.Str("status") switch
        {
            "generating" => "正在生成文案",
            "queued" => "已排队，等待微信",
            "sending" => "正在识别微信界面",
            "confirmed" => "已在自己的朋友圈缓存中确认",
            "unconfirmed" => "上次已尝试发表，需在微信确认",
            "no_material" => "近 24 小时没有至少 3 条可用聊天素材，本次未发表",
            "model_unavailable" => "模型未就绪，本次未发表",
            "filtered" => "文案重复或未通过检查，已跳过",
            "state_error" => "发布状态文件无法读取，已暂停",
            "failed" => "上次未完成：" + (reason switch {
                "fullscreen_blocked" => "前台处于全屏，已跳过本次自动发表；可点击立即发表",
                "account_not_verified" => "微信账号窗口尚未确认，请查看微信桥接状态",
                "window_unavailable" => "微信窗口已失效，请刷新桥接账号",
                "gui_unavailable" => "微信操作驱动未就绪，请重启桥接",
                "window_bind_failed" => "未能绑定到已确认的微信窗口",
                "job_cancelled" => "任务已取消或超时，请检查当前微信界面",
                "ocr_transport_error" => "微信界面识别或操作失败，请查看桥接诊断",
                "publish_worker_exited" => "朋友圈操作进程异常退出，请查看诊断中的最后步骤",
                "publish_worker_timeout" => "朋友圈操作超时，已停止，请查看微信当前界面",
                "camera_not_recognized" => "未识别到朋友圈相机按钮",
                "timeline_not_recognized" => "未识别到朋友圈页面",
                "text_menu_not_recognized" => "未识别到发表文字菜单",
                "image_menu_not_recognized" => "未识别到相机菜单中的图片入口",
                "image_dialog_not_recognized" => "未识别到微信选图窗口或文件名框",
                "image_picker_still_open" => "选图窗口未关闭，图片尚未导入，本次未发表",
                "image_dialog_timeout" => "微信选图窗口未响应，已停止本次操作",
                "image_preview_not_recognized" => "无法确认图片预览，已停止",
                "editor_not_recognized" => "未识别到朋友圈编辑框",
                "editor_not_empty" => "无法确认空白编辑框，已停止",
                "draft_not_verified" => "无法确认待发文案，已停止",
                "wechat_not_foreground" => "微信没有切到前台",
                "invalid_draft" => "文案不符合发表要求",
                "invalid_image" => "配图无效",
                "publish_exception" => "发表流程异常",
                _ => "请查看桥接诊断",
            }),
            _ => "等待下一次检查",
        };
        var preview = res.Str("preview");
        var imageInfo = res.Str("imageReason") switch
        {
            "selected" => $"配图已选中（{res.Str("category")}）",
            "disabled" => "本次纯文字：未勾选按情绪配图",
            "no_usable_image" => $"本次纯文字：「{res.Str("category")}」目录没有可用的 PNG/JPG（每张不超过 8 MB）",
            _ => res.Bool("withImage") ? "已开启配图" : "配图未开启",
        };
        if (res.Str("status") is not ("no_material" or "model_unavailable" or "filtered" or "generating"))
            detail += " · " + imageInfo;
        var mode = res.Bool("enabled") ? "定时发表已开" : "定时发表已关";
        PublishStatus.Text = res.Bool("featureEnabled")
            ? $"{mode} · 今日自动发表占用 {res.Long("count")} 条额度 · {detail}" + (preview.Length > 0 ? Environment.NewLine + preview : "")
            : "朋友圈发表总开关已关闭";
    }

    async Task OpenPublishFolderAsync(string emotion)
    {
        var res = await Api.PostJson(sup.Url, "/api/moments/publish-folder", new { emotion });
        if (!res.Ok) { PublishStatus.Text = Api.Message(res); return; }
        try { using var folder = Process.Start(new ProcessStartInfo(res.Str("dir")) { UseShellExecute = true }); }
        catch (Exception ex) { PublishStatus.Text = Api.FriendlyError(ex); }
    }

    async Task<string> AccountAsync()
    {
        try { var snapshot = await sup.ProbeAsync(); return snapshot.BrAccount ?? ""; }
        catch { return ""; }
    }
}
