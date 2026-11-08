using System;
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
        Loaded += async (_, _) => {
            await LoadSettingsAsync();
            await LoadLatestAsync();
        };

        // 离开页面即清空第三方正文与输入，并让旧请求停止回填。
        Unloaded += (_, _) => {
            viewGeneration++;
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
            for (var i = 0; i < 48; i++)
            {
                await Task.Delay(2000);
                if (generation != viewGeneration) return;
                var result = await Api.Get(sup.Url, "/api/moments/result?id=" + Uri.EscapeDataString(id));
                if (generation != viewGeneration) return;
                if (!result.Ok || result.Str("status") == "failed") { StatusText.Text = result.Error; return; }
                if (result.Str("status") != "done") continue;
                var items = result.Prop("items");
                var formatted = FormatItems(items);
                TxtOutput.Text = formatted.Text;
                StatusText.Text = formatted.Count == 0 ? "本地缓存中没有匹配的动态；这不代表微信服务器没有新动态。" : $"已读取 {formatted.Count} 条（已保存最近快照，主人问起时可直接回答）";
                return;
            }
            StatusText.Text = "读取超时；请检查桥接是否正在运行。";
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
            for (var i = 0; i < 48; i++)
            {
                await Task.Delay(2000);
                if (generation != viewGeneration) return;
                var state = await Api.Get(sup.Url, "/api/moments/result?id=" + Uri.EscapeDataString(result.Str("id")));
                if (!state.Ok || state.Str("status") == "failed" || state.Str("status") == "unconfirmed")
                {
                    StatusText.Text = state.Error; return;
                }
                StatusText.Text = "正在执行互动，请勿同时操作微信…";
            }
            StatusText.Text = "操作状态未知，请在微信中确认，不要重复发送。";
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
            var res = await Api.Get(sup.Url, "/api/moments/settings");
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
            var res = await Api.PostJson(sup.Url, "/api/moments/settings", new {
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

    // 双开时把任务钉到当前桥接账号，避免另一个账号的桥接把任务领走。
    async Task<string> AccountAsync()
    {
        try { var snapshot = await sup.ProbeAsync(); return snapshot.BrAccount ?? ""; }
        catch { return ""; }
    }
}
