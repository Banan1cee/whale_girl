using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WhaleLauncher
{
    /// <summary>
    /// 启动器统一的应用内弹窗。
    ///
    /// 为什么不用 MessageBox：系统弹窗是白底、系统字体、系统按钮，和启动器的
    /// 深色/浅色主题完全脱节，用户看到的就是「应用里突然弹出一块 Windows 框」。
    /// 这里只做三件事：一段说明、一个主按钮、一个可选取消按钮，样式全部走主题资源。
    /// </summary>
    public static class AppDialog
    {
        public static bool Show(Window owner, string message, string title = "鲸鲸", bool danger = false)
        {
            return OnUi(() =>
            {
                var win = Build(ResolveOwner(owner), message, title, danger, "知道了", null);
                win.ShowDialog();
                return true;
            });
        }

        /// <summary>确认框：确定返回 true，取消/关闭返回 false。</summary>
        public static bool Confirm(Window owner, string message, string title = "鲸鲸",
            bool danger = false, string okText = "确定", string cancelText = "取消")
        {
            return OnUi(() =>
            {
                var win = Build(ResolveOwner(owner), message, title, danger, okText, cancelText);
                return win.ShowDialog() == true;
            });
        }

        /// <summary>长文本查看器（UIA 自检、日志导出等）。</summary>
        public static void ShowText(string title, string text)
        {
            OnUi(() =>
            {
                var box = new TextBox
                {
                    Text = string.IsNullOrEmpty(text) ? "（没有输出）" : text,
                    IsReadOnly = true,
                    BorderThickness = new Thickness(1),
                    Padding = new Thickness(12),
                    FontFamily = new FontFamily("Cascadia Mono, Consolas, monospace"),
                    FontSize = 12,
                    TextWrapping = TextWrapping.Wrap,
                    VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                    VerticalContentAlignment = VerticalAlignment.Top,
                    MinHeight = 320,
                };
                box.SetResourceReference(Control.BackgroundProperty, "FieldBg");
                box.SetResourceReference(Control.ForegroundProperty, "Text");
                var win = new Window
                {
                    Title = string.IsNullOrWhiteSpace(title) ? "鲸鲸" : title,
                    Width = 760,
                    Height = 540,
                    Owner = ResolveOwner(null),
                    WindowStartupLocation = WindowStartupLocation.CenterOwner,
                    Content = box,
                };
                win.SetResourceReference(Window.BackgroundProperty, "Bg");
                win.ShowDialog();
                return true;
            });
        }

        /// <summary>
        /// 多按钮弹窗：按下的按钮返回它的 key；直接关窗返回 null。
        /// 用于「停下之后给你几条出路」这种场景（下架后要下载旧包 / 打开 data 目录）。
        /// </summary>
        public static string ShowActions(Window owner, string message, string title, bool danger,
            params (string key, string text, bool primary)[] actions)
        {
            return OnUi(() =>
            {
                string picked = null;
                var win = BuildWithActions(ResolveOwner(owner), message, title, danger, actions,
                    key => picked = key);
                win.ShowDialog();
                return picked;
            });
        }

        private static Window ResolveOwner(Window owner)
        {
            return owner ?? Application.Current?.MainWindow;
        }

        private static T OnUi<T>(Func<T> action)
        {
            var app = Application.Current;
            if (app == null || app.Dispatcher.CheckAccess()) return action();
            return app.Dispatcher.Invoke(action);
        }

        /// <summary>标题 + 正文 + 空按钮行；两种弹窗共用这一套壳，样式只在这里定义一次。</summary>
        private static (Window win, StackPanel panel) BuildShell(Window owner, string message, string title)
        {
            var win = new Window
            {
                Title = string.IsNullOrWhiteSpace(title) ? "鲸鲸" : title,
                Width = 480,
                SizeToContent = SizeToContent.Height,
                ResizeMode = ResizeMode.NoResize,
                WindowStartupLocation = owner != null
                    ? WindowStartupLocation.CenterOwner
                    : WindowStartupLocation.CenterScreen,
                ShowInTaskbar = false,
                Owner = owner,
            };
            win.SetResourceReference(Window.BackgroundProperty, "Bg");

            var panel = new StackPanel { Margin = new Thickness(22, 20, 22, 18) };
            var textBrush = Application.Current?.TryFindResource("Text") as Brush;
            var bodyBrush = Application.Current?.TryFindResource("Text2") as Brush;

            panel.Children.Add(new TextBlock
            {
                Text = win.Title,
                FontSize = 15,
                FontWeight = FontWeights.SemiBold,
                TextWrapping = TextWrapping.Wrap,
                Foreground = textBrush,
            });

            panel.Children.Add(new TextBlock
            {
                Text = message ?? string.Empty,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 10, 0, 0),
                LineHeight = 21,
                Foreground = bodyBrush,
            });

            win.Content = panel;
            return (win, panel);
        }

        private static Window Build(Window owner, string message, string title, bool danger,
            string okText, string cancelText)
        {
            var (win, panel) = BuildShell(owner, message, title);
            var primary = Application.Current?.TryFindResource("Primary") as Style;
            var ghost = Application.Current?.TryFindResource("Ghost") as Style;

            var row = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                Margin = new Thickness(0, 18, 0, 0),
            };

            if (cancelText != null)
            {
                var cancel = new Button
                {
                    Content = cancelText,
                    Style = ghost,
                    Padding = new Thickness(16, 5, 16, 5),
                    IsCancel = true,
                };
                cancel.Click += (_, _) => win.DialogResult = false;
                row.Children.Add(cancel);
            }

            var ok = new Button
            {
                Content = okText,
                Style = primary,
                Padding = new Thickness(16, 5, 16, 5),
                Margin = new Thickness(cancelText == null ? 0 : 10, 0, 0, 0),
                IsDefault = true,
            };
            if (danger) ok.SetResourceReference(Control.ForegroundProperty, "Bad");
            ok.Click += (_, _) => win.DialogResult = true;
            row.Children.Add(ok);

            panel.Children.Add(row);
            return win;
        }

        private static Window BuildWithActions(Window owner, string message, string title, bool danger,
            (string key, string text, bool primary)[] actions, Action<string> onPick)
        {
            var (win, panel) = BuildShell(owner, message, title);
            var primary = Application.Current?.TryFindResource("Primary") as Style;
            var ghost = Application.Current?.TryFindResource("Ghost") as Style;

            var row = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                Margin = new Thickness(0, 18, 0, 0),
            };

            var first = true;
            foreach (var action in actions ?? Array.Empty<(string, string, bool)>())
            {
                var button = new Button
                {
                    Content = action.text,
                    Style = action.primary ? primary : ghost,
                    Padding = new Thickness(16, 5, 16, 5),
                    Margin = new Thickness(first ? 0 : 10, 0, 0, 0),
                };
                if (action.primary && danger) button.SetResourceReference(Control.ForegroundProperty, "Bad");
                var key = action.key;
                button.Click += (_, _) => { onPick?.Invoke(key); win.DialogResult = true; };
                row.Children.Add(button);
                first = false;
            }

            panel.Children.Add(row);
            return win;
        }
    }
}
