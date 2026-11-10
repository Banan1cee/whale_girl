using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    /// <summary>
    /// 消息汇总（全局日报）：点一下，内核读今天的记忆交给模型写成简报，这里只负责展示。
    /// 生成可能要几十秒，所以先 POST 拿 202 再自己轮询，别让请求一直挂着。
    /// </summary>
    public partial class DigestPage : UserControl
    {
        private readonly RuntimeSupervisor _sup;
        private bool _busy;

        internal DigestPage(RuntimeSupervisor sup)
        {
            _sup = sup;
            InitializeComponent();
            Loaded += async (_, _) => await LoadStateAsync();
        }

        private string Range => (RangeBox.SelectedItem as ComboBoxItem)?.Tag as string == "yesterday"
            ? "yesterday" : "today";

        private async Task LoadStateAsync()
        {
            var res = await Api.Get(_sup.Url, "/api/digest", 5);
            if (!res.Ok)
            {
                StatusText.Text = "内核没在运行，先点顶栏「启动」。";
                return;
            }
            Apply(res);
            // 上次生成还没结束（比如切走再切回来）：接着看结果，别让页面永远停在「正在整理」。
            if (res.Str("status") == "running" && !_busy) await PollAsync();
        }

        private async void OnGenerate(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            _busy = true;
            BtnGenerate.IsEnabled = false;
            try
            {
                StatusText.Text = "正在整理…";
                StatsText.Text = "";
                var res = await Api.PostJson(_sup.Url, "/api/digest/generate", new { range = Range }, 15);
                if (!res.Ok)
                {
                    StatusText.Text = "生成失败：" + Api.Message(res);
                    return;
                }
                await PollAsync();
            }
            finally
            {
                BtnGenerate.IsEnabled = true;
                _busy = false;
            }
        }

        private async Task PollAsync()
        {
            // 模型正常几秒到几十秒。最多等 2 分钟，超时就明确说「还没好」，不假装成功。
            for (var i = 0; i < 120; i++)
            {
                await Task.Delay(1000);
                var res = await Api.Get(_sup.Url, "/api/digest", 5);
                if (!res.Ok)
                {
                    StatusText.Text = "读取状态失败：" + Api.Message(res);
                    return;
                }
                Apply(res);
                if (res.Str("status") != "running") return;
            }
            StatusText.Text = "生成还没结束。稍等一会儿再点一次「生成汇总」。";
        }

        private void Apply(ApiResult res)
        {
            var state = res.Str("status");
            var message = res.Str("message");
            if (!string.IsNullOrWhiteSpace(message)) StatusText.Text = message;

            var text = res.Str("text");
            if (!string.IsNullOrWhiteSpace(text))
            {
                Output.Text = text;
            }
            else if (state == "empty")
            {
                Output.Text = "这段时间还没有可汇总的聊天记录。";
            }
            else if (state != "running")
            {
                Output.Text = "还没有生成汇总。";
            }

            StatsText.Text = DescribeStats(res.Prop("stats"), res.Long("generatedAt"));
        }

        /// <summary>会话数 / 消息数 / 是否截断 / 生成时间，一行说清楚。</summary>
        private static string DescribeStats(JsonElement stats, long generatedAt)
        {
            var parts = new List<string>();
            if (stats.ValueKind == JsonValueKind.Object)
            {
                if (stats.TryGetProperty("day", out var day) && day.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(day.GetString()))
                {
                    parts.Add(day.GetString());
                }
                var chats = stats.TryGetProperty("chats", out var c) && c.TryGetInt32(out var ci) ? ci : 0;
                var messages = stats.TryGetProperty("messages", out var m) && m.TryGetInt32(out var mi) ? mi : 0;
                parts.Add($"{chats} 个会话");
                parts.Add($"{messages} 条消息");
                if (stats.TryGetProperty("truncated", out var t) && t.ValueKind == JsonValueKind.True)
                    parts.Add("只取了最近的一部分");
            }
            if (generatedAt > 0)
            {
                var time = DateTimeOffset.FromUnixTimeMilliseconds(generatedAt).ToLocalTime();
                parts.Add("生成于 " + time.ToString("HH:mm"));
            }
            return string.Join(" · ", parts);
        }

        private void OnRangeChanged(object sender, SelectionChangedEventArgs e)
        {
            // 初始化时也会触发；那时控件还没建好，也没有旧结果要清。
            if (!IsLoaded || _busy) return;
            Output.Text = "还没有生成汇总。";
            StatsText.Text = "";
            StatusText.Text = "已切换到「" + ((RangeBox.SelectedItem as ComboBoxItem)?.Content as string ?? "") + "」，点「生成汇总」。";
        }

        private void OnCopy(object sender, RoutedEventArgs e)
        {
            var text = Output.Text;
            if (string.IsNullOrWhiteSpace(text) || text == "还没有生成汇总。")
            {
                StatusText.Text = "还没有内容可复制。";
                return;
            }
            try
            {
                Clipboard.SetText(text);
                StatusText.Text = "已复制到剪贴板。";
            }
            catch (Exception ex)
            {
                StatusText.Text = "复制失败：" + ex.Message;
            }
        }
    }
}
