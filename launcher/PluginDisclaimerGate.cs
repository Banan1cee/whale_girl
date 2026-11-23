using System;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace WhaleLauncher.Views
{
    /// <summary>
    /// 插件页免责声明阅读门禁（页内覆盖层）。
    ///
    /// 约束：
    /// - 只覆盖插件页自身；外壳导航、顶栏、其它页面不在本控件子树里，不受影响。
    /// - 没有关闭/取消/Esc/回车默认按钮/背景点击路径；只有「滚到底 + 单调 10 秒」
    ///   双条件满足后，确认按钮才可用，且必须保存成功才关闭门禁。
    /// - 保存失败时保持门禁打开并显示原因；不依赖内存里的「已读」标记。
    /// </summary>
    internal sealed class PluginDisclaimerGate : Grid
    {
        private static readonly TimeSpan RequiredReadTime = TimeSpan.FromSeconds(10);

        private readonly Func<Task<(bool Ok, string Error)>> _save;
        private readonly ScrollViewer _scroll;
        private readonly TextBlock _hint;
        private readonly Button _confirm;
        private readonly Stopwatch _clock = new();
        private readonly DispatcherTimer _timer;
        private bool _reachedBottom;
        private bool _closed;
        private bool _saving;
        private Window _owner;

        internal PluginDisclaimerGate(string body, Func<Task<(bool Ok, string Error)>> save)
        {
            _save = save ?? throw new ArgumentNullException(nameof(save));
            Background = new SolidColorBrush(Color.FromArgb(85, 0, 0, 0));
            Focusable = true;
            KeyboardNavigation.SetTabNavigation(this, KeyboardNavigationMode.Cycle);
            PreviewKeyDown += (_, e) =>
            {
                // 没有 Esc 关闭；也不允许把回车交给任何默认按钮。
                if (e.Key is Key.Escape or Key.Enter or Key.Return) e.Handled = true;
            };
            // 背景点击不属于任何关闭路径，但不让事件继续冒泡到页面。
            MouseLeftButtonDown += (_, e) => e.Handled = true;

            var layout = new Grid { Margin = new Thickness(24) };
            var card = new Border
            {
                Child = layout, Width = 640, Margin = new Thickness(16), CornerRadius = new CornerRadius(14),
                HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Stretch,
                Background = new SolidColorBrush(Appearance.BaseColor("Bg")),
            };
            foreach (var pair in Appearance.DialogSafeResources()) card.Resources[pair.Key] = pair.Value;
            layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            layout.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            layout.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var title = new TextBlock
            {
                Text = "插件免责声明",
                Style = ResStyle("H1"), TextWrapping = TextWrapping.Wrap,
            };
            Grid.SetRow(title, 0);
            layout.Children.Add(title);
            var intro = new TextBlock
            {
                Text = "进入插件市场前必须阅读。全文滚动到底部，并停留满 10 秒后，确认按钮才会出现可用状态；确认会保存到本机配置，保存失败不会放行。",
                Style = ResStyle("Small"), TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 8, 0, 12), Foreground = Brush("Text2", Brushes.Gray),
            };
            Grid.SetRow(intro, 1);
            layout.Children.Add(intro);
            _scroll = new ScrollViewer
            {
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Focusable = true,
                Content = new TextBlock
                {
                    Text = body ?? "", TextWrapping = TextWrapping.Wrap,
                    Style = ResStyle("Small"), Foreground = Brush("Text", Brushes.Black),
                },
            };
            _scroll.ScrollChanged += (_, _) => EvaluateScroll();
            _scroll.Loaded += (_, _) =>
            {
                EvaluateScroll();
                _scroll.Focus();
                UpdateState();
            };
            Grid.SetRow(_scroll, 2);
            layout.Children.Add(_scroll);
            _hint = new TextBlock
            {
                Style = ResStyle("Small"), TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 10, 0, 0), Foreground = Brush("Text2", Brushes.Gray),
            };
            Grid.SetRow(_hint, 3);
            layout.Children.Add(_hint);
            _confirm = new Button
            {
                Content = "确认已阅读并继续",
                Style = ResStyle("Primary"),
                IsDefault = false,
                IsEnabled = false,
                HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 12, 0, 0),
            };
            _confirm.Click += async (_, _) => await ConfirmAsync();
            Grid.SetRow(_confirm, 4);
            layout.Children.Add(_confirm);
            Children.Add(card);

            _timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(100) };
            _timer.Tick += (_, _) => UpdateState();
            // 计时只在门禁真正可见时累计：不在构造/预加载阶段起表。
            Loaded += (_, _) =>
            {
                _owner = Window.GetWindow(this);
                if (_owner != null) _owner.StateChanged += OwnerStateChanged;
                UpdateClock();
                EvaluateScroll();
                _scroll.Focus();
            };
            Unloaded += (_, _) =>
            {
                if (_owner != null) _owner.StateChanged -= OwnerStateChanged;
                _owner = null;
                _clock.Stop();
                _timer.Stop();
            };
            IsVisibleChanged += (_, _) => UpdateClock();
        }

        private void OwnerStateChanged(object sender, EventArgs e) => UpdateClock();

        private void UpdateClock()
        {
            if (IsLoaded && IsVisible && !_closed && _owner?.WindowState != WindowState.Minimized)
            {
                _clock.Start();
                _timer.Start();
                UpdateState();
            }
            else
            {
                _clock.Stop();
                _timer.Stop();
            }
        }

        internal bool IsOpen => !_closed;
        internal bool ConfirmEnabled => _confirm.IsEnabled;
        internal double ElapsedSeconds => _clock.Elapsed.TotalSeconds;
        internal string StatusText => _hint.Text;
        internal Button ConfirmButton => _confirm;
        internal ScrollViewer DisclaimerView => _scroll;

        internal void ScrollToBottom() => _scroll.ScrollToEnd();

        internal void Dispose()
        {
            _closed = true;
            _timer.Stop();
            _clock.Stop();
            IsHitTestVisible = false;
            Visibility = Visibility.Collapsed;
        }

        private async Task ConfirmAsync()
        {
            if (_closed || _saving || !_confirm.IsEnabled) return;
            _saving = true;
            _confirm.IsEnabled = false;
            _hint.Text = "正在保存阅读确认…";
            (bool Ok, string Error) result;
            try { result = await _save(); }
            catch (Exception ex) { result = (false, ex.Message); }
            if (!Dispatcher.CheckAccess())
            {
                _ = Dispatcher.BeginInvoke(new Action(() => ApplyConfirmResult(result)));
                return;
            }
            ApplyConfirmResult(result);
        }

        private void ApplyConfirmResult((bool Ok, string Error) result)
        {
            if (_closed) return;
            if (result.Ok)
            {
                _closed = true;
                _timer.Stop();
                _clock.Stop();
                Accepted?.Invoke();
                return;
            }
            _saving = false;
            _hint.Text = "保存失败，未放行：" + (string.IsNullOrWhiteSpace(result.Error) ? "未知原因" : result.Error);
            if (_reachedBottom && _clock.Elapsed >= RequiredReadTime) _confirm.IsEnabled = true;
        }

        internal event Action Accepted;

        private void EvaluateScroll()
        {
            if (_reachedBottom || _scroll.ViewportHeight <= 0) return;
            if (_scroll.ScrollableHeight <= 0 || _scroll.VerticalOffset >= _scroll.ScrollableHeight - 1)
            {
                _reachedBottom = true;
                UpdateState();
            }
        }

        private void UpdateState()
        {
            if (_closed) return;
            var remaining = RequiredReadTime - _clock.Elapsed;
            if (!_reachedBottom)
            {
                _hint.Text = "请先滚动到免责声明底部。";
                _confirm.IsEnabled = false;
                return;
            }
            if (remaining > TimeSpan.Zero)
            {
                _hint.Text = "已到底部；请继续停留至少 " + remaining.TotalSeconds.ToString("0.0") + " 秒。";
                _confirm.IsEnabled = false;
                return;
            }
            if (!_saving) _confirm.IsEnabled = true;
            _hint.Text = "阅读条件已满足，可以确认。";
            _timer.Stop();
        }

        private Style ResStyle(string key) => TryFindResource(key) as Style;

        private Brush Brush(string key, Brush fallback) => TryFindResource(key) as Brush ?? fallback;
    }
}
