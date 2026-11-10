using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Windows;

namespace WhaleLauncher.Views
{
    public partial class ChatPolicyWindow : Window
    {
        private readonly RuntimeSupervisor _sup;
        private readonly ContactCheckList _muted;
        private readonly ContactCheckList _whitelist;

        public ChatPolicyWindow(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            // 名单直接铺在窗口里：搜索 + 勾选 + 立即保存，不再开二级选择弹窗。
            _muted = new ContactCheckList(sup, "group.mutedGroups", true);
            _whitelist = new ContactCheckList(sup, "care.whitelist", false);
            MutedHost.Content = _muted;
            WhitelistHost.Content = _whitelist;
            _muted.Status += SetStatus;
            _whitelist.Status += SetStatus;
            Loaded += async (_, __) =>
            {
                SetEditable(false);
                var res = await _sup.ReadConfigurationAsync("/api/config");
                if (!res.Ok) { SetStatus("读取发言范围失败：" + Api.Message(res)); return; }
                var config = res.Prop("config");
                _muted.SetValue(Property(Property(config, "group"), "mutedGroups"));
                _whitelist.SetValue(Property(Property(config, "care"), "whitelist"));
                WhitelistOnly.IsChecked = Property(Property(config, "wechat"), "whitelistOnly").ValueKind == JsonValueKind.True;
                SetEditable(true);
                await _muted.ReloadAsync();
                await _whitelist.ReloadAsync();
            };
        }

        private async void OnWhitelistOnly(object sender, RoutedEventArgs e)
        {
            var enabled = WhitelistOnly.IsChecked == true;
            SetEditable(false);
            try
            {
                var res = await _sup.PatchConfigurationAsync( new Dictionary<string, object>
                {
                    ["wechat.whitelistOnly"] = enabled
                });
                if (!res.Ok) WhitelistOnly.IsChecked = !enabled;
                SetStatus(res.Ok ? "已保存并生效" : "保存失败：" + Api.Message(res));
            }
            finally { SetEditable(true); }
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
