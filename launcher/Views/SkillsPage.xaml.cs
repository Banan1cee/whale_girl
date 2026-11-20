using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace WhaleLauncher.Views
{
    public partial class SkillsPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private bool _busy;
        public SkillsPage(RuntimeSupervisor sup) { InitializeComponent(); _sup = sup; Loaded += async (_, __) => await RefreshAsync(); }
        public async Task RefreshAsync()
        {
            if (_busy) return; _busy = true;
            try {
                var res = await _sup.ReadConfigurationAsync("/api/skills");
                if (!res.Ok) { StatusText.Text = "读取失败：" + Api.Message(res); return; }
                var rows = res.Prop("items");
                SkillList.Items.Clear();
                if (rows.ValueKind == JsonValueKind.Array) foreach (var s in rows.EnumerateArray()) {
                    var id = JsonRead.Str(s, "id"); var name = JsonRead.Str(s, "name");
                    var enabled = s.TryGetProperty("enabled", out var e) && e.ValueKind == JsonValueKind.True;
                    SkillList.Items.Add((enabled ? "● " : "○ ") + name + "  [" + id + "]");
                }
                StatusText.Text = "已加载 " + SkillList.Items.Count + " 个技能；匹配关键词的技能会自动加入聊天提示词。";
            } catch (Exception ex) { StatusText.Text = "加载失败：" + ex.Message; }
            finally { _busy = false; }
        }
        private async void OnRefresh(object sender, RoutedEventArgs e) => await RefreshAsync();
        private async void OnSelect(object sender, SelectionChangedEventArgs e)
        {
            var selected = SkillList.SelectedItem as string; if (string.IsNullOrEmpty(selected)) return;
            var start = selected.LastIndexOf('['); var end = selected.LastIndexOf(']');
            if (start < 0 || end <= start) return;
            var id = selected.Substring(start + 1, end - start - 1);
            var res = await _sup.ReadConfigurationAsync("/api/skills");
            if (!res.Ok || res.Prop("items").ValueKind != JsonValueKind.Array) return;
            foreach (var s in res.Prop("items").EnumerateArray()) if (JsonRead.Str(s, "id") == id) {
                IdBox.Text = id; NameBox.Text = JsonRead.Str(s, "name"); DescriptionBox.Text = JsonRead.Str(s, "description");
                KeywordsBox.Text = string.Join(", ", s.GetProperty("keywords").EnumerateArray().Select(x => x.GetString()));
                ContentBox.Text = JsonRead.Str(s, "content"); EnabledBox.IsChecked = s.GetProperty("enabled").GetBoolean(); break;
            }
        }
        private async void OnSave(object sender, RoutedEventArgs e)
        {
            var keywords = KeywordsBox.Text.Split(new[] { ',', '，', ';', '；', '\n' }, StringSplitOptions.RemoveEmptyEntries).Select(x => x.Trim()).Where(x => x.Length > 0).ToArray();
            var res = await _sup.SaveConfigurationAsync("/api/skills", new { id = IdBox.Text.Trim(), name = NameBox.Text.Trim(), description = DescriptionBox.Text.Trim(), keywords, content = ContentBox.Text, enabled = EnabledBox.IsChecked == true });
            StatusText.Text = res.Ok ? "技能已保存并生效。" : "保存失败：" + Api.Message(res);
            if (res.Ok) await RefreshAsync();
        }
        private async void OnDelete(object sender, RoutedEventArgs e)
        {
            if (string.IsNullOrWhiteSpace(IdBox.Text)) return;
            var res = await _sup.SaveConfigurationAsync("/api/skills/" + Uri.EscapeDataString(IdBox.Text.Trim()) + "/delete", new { });
            StatusText.Text = res.Ok ? "删除请求已完成。" : "删除失败：" + Api.Message(res);
            if (res.Ok) { OnClear(sender, e); await RefreshAsync(); }
        }
        private void OnClear(object sender, RoutedEventArgs e) { IdBox.Clear(); NameBox.Clear(); DescriptionBox.Clear(); KeywordsBox.Clear(); ContentBox.Clear(); EnabledBox.IsChecked = true; SkillList.SelectedItem = null; }
    }
}