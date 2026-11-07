using System;
using System.Text.Json;
using System.Windows;

namespace WhaleLauncher.Views
{
    public partial class ChatPolicyWindow : Window
    {
        private readonly RuntimeSupervisor _sup;
        private readonly ContactListEditor _muted;
        private readonly ContactListEditor _whitelist;

        public ChatPolicyWindow(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            _muted = new ContactListEditor(sup, "group.mutedGroups", "没有设置黑名单", "编辑黑名单…", true);
            _whitelist = new ContactListEditor(sup, "care.whitelist", "没有选择白名单会话", "编辑白名单…", false);
            MutedHost.Content = _muted;
            WhitelistHost.Content = _whitelist;
            _muted.Status += SetStatus;
            _whitelist.Status += SetStatus;
            Loaded += async (_, __) =>
            {
                SetEditable(false);
                var res = await _sup.ReadConfigurationAsync("/api/config");
                if (!res.Ok) { SetStatus("读取发言范围失败：" + Api.Detail(res)); return; }
                var config = res.Prop("config");
                _muted.SetValue(Property(Property(config, "group"), "mutedGroups"));
                _whitelist.SetValue(Property(Property(config, "care"), "whitelist"));
                WhitelistOnly.IsChecked = Property(Property(config, "wechat"), "whitelistOnly").ValueKind == JsonValueKind.True;
                SetEditable(_sup.NodeRunning);
                if (!_sup.NodeRunning) SetStatus("启动内核后可以编辑名单。");
            };
        }

        private async void OnWhitelistOnly(object sender, RoutedEventArgs e)
        {
            var enabled = WhitelistOnly.IsChecked == true;
            SetEditable(false);
            try
            {
                var res = await Api.Post(_sup.Url, "/api/config", "{\"patch\":{\"wechat.whitelistOnly\":"
                    + (enabled ? "true" : "false") + "}}");
                if (!res.Ok) WhitelistOnly.IsChecked = !enabled;
                SetStatus(res.Ok ? "已保存并生效" : "保存失败：" + Api.Detail(res));
            }
            finally { SetEditable(_sup.NodeRunning); }
        }

        private void SetEditable(bool enabled)
        {
            WhitelistOnly.IsEnabled = enabled;
            MutedHost.IsEnabled = enabled;
            WhitelistHost.IsEnabled = enabled;
        }

        private void SetStatus(string message)
        {
            if (!string.IsNullOrEmpty(message)) StatusText.Text = message;
        }

        private static JsonElement Property(JsonElement obj, string key)
            => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(key, out var value) ? value : default;
    }
}
