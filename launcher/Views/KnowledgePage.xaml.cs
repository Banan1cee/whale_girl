using System;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    public partial class KnowledgePage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private bool _busy;
        public KnowledgePage(RuntimeSupervisor sup) { InitializeComponent(); _sup = sup; Loaded += async (_, __) => await RefreshAsync(); }
        public async Task RefreshAsync()
        {
            if (_busy) return; _busy = true;
            try {
                var res = await _sup.ReadConfigurationAsync("/api/knowledge");
                if (!res.Ok) { StatusText.Text = "读取失败：" + Api.Message(res); return; }
                SourceList.Items.Clear(); var items = res.Prop("items");
                if (items.ValueKind == JsonValueKind.Array) foreach (var s in items.EnumerateArray())
                    SourceList.Items.Add(JsonRead.Str(s, "id") + " · " + JsonRead.Str(s, "type") + " · " + JsonRead.Str(s, "status"));
                StatusText.Text = "已加载 " + SourceList.Items.Count + " 个知识来源。";
            } catch (Exception ex) { StatusText.Text = "加载失败：" + ex.Message; }
            finally { _busy = false; }
        }
        private async void OnRefresh(object sender, RoutedEventArgs e) => await RefreshAsync();
        private async void OnSelect(object sender, SelectionChangedEventArgs e)
        {
            var selected = SourceList.SelectedItem as string; if (string.IsNullOrEmpty(selected)) return;
            var id = selected.Split('·')[0].Trim(); var res = await _sup.ReadConfigurationAsync("/api/knowledge");
            if (!res.Ok || res.Prop("items").ValueKind != JsonValueKind.Array) return;
            foreach (var s in res.Prop("items").EnumerateArray()) if (JsonRead.Str(s, "id") == id) {
                IdBox.Text = id; PathBox.Text = JsonRead.Str(s, "path"); EnabledBox.IsChecked = !s.TryGetProperty("enabled", out var enabled) || enabled.ValueKind != JsonValueKind.False;
                var remote = JsonRead.Str(s, "type") == "remote"; TypeBox.SelectedIndex = remote ? 1 : 0; break;
            }
        }
        private object Payload() => new { id = IdBox.Text.Trim(), type = (TypeBox.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "local", path = PathBox.Text.Trim(), enabled = EnabledBox.IsChecked == true };
        private async void OnTest(object sender, RoutedEventArgs e) { var res = await _sup.SaveConfigurationAsync("/api/knowledge/test", Payload()); StatusText.Text = res.Ok ? "测试加载成功。" : "加载失败：" + Api.Message(res); }
        private async void OnSave(object sender, RoutedEventArgs e) { var res = await _sup.SaveConfigurationAsync("/api/knowledge", Payload()); StatusText.Text = res.Ok ? "知识来源已保存并加载。" : "保存失败：" + Api.Message(res); if (res.Ok) await RefreshAsync(); }
        private async void OnDelete(object sender, RoutedEventArgs e) { if (string.IsNullOrWhiteSpace(IdBox.Text)) return; var res = await _sup.SaveConfigurationAsync("/api/knowledge/delete", new { id = IdBox.Text.Trim() }); StatusText.Text = res.Ok ? "知识来源已删除。" : "删除失败：" + Api.Message(res); if (res.Ok) await RefreshAsync(); }
    }
}