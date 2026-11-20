using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using System.Collections.Generic;

namespace WhaleLauncher
{
    /// <summary>在主窗口内容上显示模态弹层，不创建系统窗口。</summary>
    public static class AppDialog
    {
        public static bool Show(Window owner, string message, string title = "助手", bool danger = false)
            => OnUi(() => ShowCore(owner, message, title, danger, "知道了", null, null, null, null));

        public static bool Confirm(Window owner, string message, string title = "助手",
            bool danger = false, string okText = "确定", string cancelText = "取消", string warningText = null)
            => OnUi(() => ShowCore(owner, message, title, danger, okText, cancelText, warningText, null, null));

        public static string Prompt(Window owner, string message, string title = "助手", string initial = "",
            string okText = "保存", string cancelText = "取消")
        {
            return OnUi(() =>
            {
                var box = new TextBox { Text = initial ?? string.Empty, Margin = new Thickness(0, 12, 0, 0), Padding = new Thickness(8, 5, 8, 5), MinWidth = 200 };
                box.SetResourceReference(Control.BackgroundProperty, "FieldBg");
                box.SetResourceReference(Control.ForegroundProperty, "Text");
                return ShowCore(owner, message, title, false, okText, cancelText, null, box, box)
                    ? box.Text.Trim() : null;
            });
        }

        public static void ShowText(string title, string text)
        {
            OnUi(() =>
            {
                var box = new TextBox
                {
                    Text = string.IsNullOrEmpty(text) ? "（没有输出）" : text,
                    IsReadOnly = true, BorderThickness = new Thickness(1), Padding = new Thickness(12),
                    FontFamily = new FontFamily("Cascadia Mono, Consolas, monospace"), FontSize = 12,
                    TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                    VerticalContentAlignment = VerticalAlignment.Top, Height = 320, Margin = new Thickness(0, 12, 0, 0),
                };
                box.SetResourceReference(Control.BackgroundProperty, "FieldBg");
                box.SetResourceReference(Control.ForegroundProperty, "Text");
                ShowCore(null, null, title, false, "关闭", null, null, box, null, 760);
                return true;
            });
        }

        public static bool ShowContent(string title, UIElement content, double width = 620, string okText = "关闭", string cancelText = null)
            => OnUi(() => ShowCore(null, null, title, false, okText, cancelText, null, content, null, width));

        private static T OnUi<T>(Func<T> action)
        {
            var app = Application.Current;
            if (app == null || app.Dispatcher.CheckAccess()) return action();
            return app.Dispatcher.Invoke(action);
        }

        private static bool ShowCore(Window owner, string message, string title, bool danger,
            string okText, string cancelText, string warningText, UIElement extra, TextBox input, double width = 480)
        {
            var window = Application.Current?.MainWindow ?? owner;
            if (window?.Content is not Grid root || !window.IsVisible) return false;

            var frame = new DispatcherFrame();
            bool result = false;
            var overlay = new Grid { Background = new SolidColorBrush(Color.FromArgb(166, 0, 0, 0)), Focusable = true };
            KeyboardNavigation.SetTabNavigation(overlay, KeyboardNavigationMode.Cycle);
            Grid.SetRowSpan(overlay, Math.Max(1, root.RowDefinitions.Count));
            Grid.SetColumnSpan(overlay, Math.Max(1, root.ColumnDefinitions.Count));
            Panel.SetZIndex(overlay, int.MaxValue);
            var card = new Border { Width = width, MaxWidth = Math.Max(200, window.ActualWidth - 48), MaxHeight = Math.Max(200, window.ActualHeight - 48), CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(1), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            card.SetResourceReference(Border.BackgroundProperty, "PopupBg");
            card.SetResourceReference(Border.BorderBrushProperty, "CardBorder");
            var panel = new StackPanel { Margin = new Thickness(24, 20, 24, 18) };
            var layout = new DockPanel();
            card.Child = layout;
            var scroll = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            overlay.Children.Add(card);
            var header = new DockPanel { Margin = new Thickness(24, 16, 24, 0) };
            DockPanel.SetDock(header, Dock.Top);
            layout.Children.Add(header);
            var close = new Button { Content = "×", FontSize = 18, Width = 32, Height = 32, Padding = new Thickness(0), Style = Application.Current?.TryFindResource("Ghost") as Style, ToolTip = "关闭" };
            System.Windows.Automation.AutomationProperties.SetName(close, "关闭弹窗");
            DockPanel.SetDock(close, Dock.Right);
            header.Children.Add(close);
            var head = new TextBlock { Text = string.IsNullOrWhiteSpace(title) ? "助手" : title, FontSize = 16, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
            head.SetResourceReference(TextBlock.ForegroundProperty, "Text");
            header.Children.Add(head);
            if (!string.IsNullOrWhiteSpace(warningText))
            {
                var warning = new TextBlock { Text = warningText, FontSize = 13, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 0) };
                warning.SetResourceReference(TextBlock.ForegroundProperty, "Bad");
                panel.Children.Add(warning);
            }
            if (!string.IsNullOrEmpty(message))
            {
                var body = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 0), LineHeight = 21, FontSize = 13 };
                body.SetResourceReference(TextBlock.ForegroundProperty, "Text2");
                panel.Children.Add(body);
            }
            if (extra != null) panel.Children.Add(extra);
            var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 18, 0, 0) };
            void Finish(bool accepted) { result = accepted; frame.Continue = false; }
            close.Click += (_, _) => Finish(false);
            if (cancelText != null)
            {
                var cancel = new Button { Content = cancelText, Style = Application.Current?.TryFindResource("Ghost") as Style, Padding = new Thickness(16, 5, 16, 5) };
                cancel.Click += (_, _) => Finish(false);
                row.Children.Add(cancel);
            }
            var ok = new Button { Content = okText, Style = Application.Current?.TryFindResource(danger ? "Ghost" : "Primary") as Style, Padding = new Thickness(16, 5, 16, 5), Margin = new Thickness(cancelText == null ? 0 : 10, 0, 0, 0) };
            if (danger) ok.SetResourceReference(Control.ForegroundProperty, "Bad");
            ok.Click += (_, _) => Finish(true);
            row.Children.Add(ok);
            row.Margin = new Thickness(22, 12, 22, 18);
            DockPanel.SetDock(row, Dock.Bottom);
            layout.Children.Add(row);
            layout.Children.Add(scroll);
            overlay.PreviewKeyDown += (_, e) =>
            {
                if (e.Key == Key.Escape) { Finish(false); e.Handled = true; }
                else if (e.Key == Key.Enter && input != null && Keyboard.FocusedElement == input) { Finish(true); e.Handled = true; }
            };
            EventHandler closed = (_, _) => Finish(false);
            window.Closed += closed;
            var previousFocus = Keyboard.FocusedElement;
            var previous = new List<(UIElement element, bool enabled, Effect effect)>();
            foreach (UIElement child in root.Children)
            {
                previous.Add((child, child.IsEnabled, child.Effect));
                child.SetCurrentValue(UIElement.IsEnabledProperty, false);
                child.SetCurrentValue(UIElement.EffectProperty, new BlurEffect { Radius = 8 });
            }
            root.Children.Add(overlay);
            overlay.Loaded += (_, _) => { if (input != null) { input.Focus(); input.SelectAll(); } else ok.Focus(); };
            try { Dispatcher.PushFrame(frame); }
            finally
            {
                root.Children.Remove(overlay);
                if (extra != null) panel.Children.Remove(extra);
                foreach (var item in previous) { item.element.SetCurrentValue(UIElement.EffectProperty, item.effect); item.element.SetCurrentValue(UIElement.IsEnabledProperty, item.enabled); }
                window.Closed -= closed;
                if (previousFocus is IInputElement focus) Keyboard.Focus(focus);
            }
            return result;
        }
    }
}
