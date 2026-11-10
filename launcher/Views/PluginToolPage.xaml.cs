using System;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    public partial class PluginToolPage : UserControl
    {
        private readonly PluginMarket _market;
        private readonly PluginInfo _info;
        private readonly RuntimeSupervisor _sup;

        internal PluginToolPage(PluginMarket market, PluginInfo info, RuntimeSupervisor sup)
        {
            _market = market;
            _info = info;
            _sup = sup;
            InitializeComponent();
            Title.Text = info.Name;
            Description.Text = info.Description;
            if (info.HostAction == PluginMarket.DigestAction)
            {
                InputPanel.Visibility = Visibility.Collapsed;
                DigestPanel.Visibility = Visibility.Visible;
                Run.Content = "生成汇总";
            }
        }

        private async void OnRun(object sender, RoutedEventArgs e)
        {
            var digest = _info.HostAction == PluginMarket.DigestAction;
            var range = DateRange.SelectedIndex == 1 ? "yesterday" : "today";
            if (digest && MessageBox.Show(
                $"允许「{_info.Name}」生成{(range == "today" ? "今天" : "昨天")}的聊天汇总？\n"
                + "鲸鲸会把本机所选日期内可用的群聊和私聊片段交给当前模型。如果使用云端模型，片段会发送给模型服务商，调用可能产生费用。插件只接收汇总结果。",
                "确认聊天汇总权限", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK)
                return;
            Run.IsEnabled = false;
            Result.Text = "运行中…";
            try
            {
                var result = await _market.RunAsync(_info.Id, digest ? range : Input.Text, _info.HostAction,
                    digest ? value => PluginHostActions.SummarizeAsync(_sup, value) : null);
                Result.Text = _info.Api == 1 ? _info.ResultLabel + "：" + result : result;
            }
            catch (Exception ex) { Result.Text = "运行失败：" + ex.Message; }
            finally { Run.IsEnabled = true; }
        }
    }
}
