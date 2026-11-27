using System;
using System.Collections.Generic;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Shapes;

namespace WhaleLauncher.Views
{
    /// <summary>
    /// 公告历史面板：列出本机可见的全部公告（含已读），未读带圆点。
    /// 和 VersionHistoryPanel 一样是 StackPanel 子类，由 AppDialog.ShowContent 塞进弹层，
    /// 不额外开系统窗口。
    /// </summary>
    internal sealed class NoticeCenter : StackPanel
    {
        public NoticeCenter(IReadOnlyList<Announcement> items, IReadOnlyCollection<string> readIds,
            Action<Announcement> onAction)
        {
            Margin = new Thickness(0, 4, 0, 0);
            var read = new HashSet<string>(readIds ?? Array.Empty<string>(), StringComparer.Ordinal);

            var count = 0;
            var unread = 0;
            if (items != null)
            {
                foreach (var item in items)
                {
                    count++;
                    if (!read.Contains(item.Id)) unread++;
                }
            }

            var summary = new TextBlock
            {
                Text = count == 0
                    ? "暂时没有公告。有新消息时会在这里显示。"
                    : "共 " + count + " 条" + (unread > 0 ? " · 未读 " + unread + " 条" : ""),
                Margin = new Thickness(0, 0, 0, 10),
                TextWrapping = TextWrapping.Wrap,
            };
            summary.SetResourceReference(TextBlock.StyleProperty, "Small");
            Children.Add(summary);
            if (count == 0) return;

            var list = new StackPanel();
            foreach (var item in items) list.Children.Add(Card(item, !read.Contains(item.Id), onAction));
            Children.Add(new ScrollViewer
            {
                MaxHeight = 420,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Content = list,
            });
        }

        private static Border Card(Announcement item, bool unread, Action<Announcement> onAction)
        {
            var border = new Border { Margin = new Thickness(0, 0, 0, 8), Padding = new Thickness(14, 12, 14, 12) };
            border.SetResourceReference(FrameworkElement.StyleProperty, "Card");
            var stack = new StackPanel();

            var head = new DockPanel { LastChildFill = true };
            var date = new TextBlock
            {
                Text = FormatDate(item.PublishedAt),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(8, 0, 0, 0),
            };
            date.SetResourceReference(TextBlock.StyleProperty, "Small");
            DockPanel.SetDock(date, Dock.Right);
            head.Children.Add(date);

            if (unread)
            {
                var dot = new Ellipse
                {
                    Width = 7,
                    Height = 7,
                    Margin = new Thickness(0, 0, 8, 0),
                    VerticalAlignment = VerticalAlignment.Center,
                };
                dot.SetResourceReference(Shape.FillProperty, LevelBrush(item.Level));
                head.Children.Add(dot);
            }

            var title = new TextBlock
            {
                Text = item.Title,
                FontWeight = FontWeights.SemiBold,
                TextWrapping = TextWrapping.Wrap,
                VerticalAlignment = VerticalAlignment.Center,
            };
            title.SetResourceReference(TextBlock.ForegroundProperty, "Text");
            head.Children.Add(title);
            stack.Children.Add(head);

            var body = new TextBlock
            {
                Text = item.Body,
                TextWrapping = TextWrapping.Wrap,
                LineHeight = 19,
                Margin = new Thickness(0, 6, 0, 0),
            };
            body.SetResourceReference(TextBlock.ForegroundProperty, "Text2");
            stack.Children.Add(body);

            var label = ActionLabel(item.Action);
            if (label != null)
            {
                var button = new Button
                {
                    Content = label,
                    Margin = new Thickness(0, 8, 0, 0),
                    HorizontalAlignment = HorizontalAlignment.Left,
                };
                button.SetResourceReference(FrameworkElement.StyleProperty, "Ghost");
                button.Click += (_, _) => onAction?.Invoke(item);
                stack.Children.Add(button);
            }

            border.Child = stack;
            return border;
        }

        private static string ActionLabel(string action)
        {
            switch (action)
            {
                case "open_url": return "打开链接";
                case "check_update": return "检查更新";
                default: return null;
            }
        }

        private static string LevelBrush(string level)
        {
            switch (level)
            {
                case "critical": return "Bad";
                case "warn": return "Warn";
                default: return "Accent";
            }
        }

        private static string FormatDate(string value)
            => DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var when)
                ? when.ToLocalTime().ToString("yyyy-MM-dd") : "";
    }
}
