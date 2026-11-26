using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using WhaleLauncher;

// 真实插件市场页的布局回归（STA、进程内加载启动器源码，不显示主窗口、不联网、不启动微信）：
//   - 四行卡片结构与标准高度；
//   - 按实际可用宽度分列（阈值上下、来回 resize、滚动条出现、零/少量条目）；
//   - 简介按 Unicode 文本元素截断且省略号计入 20；
//   - 点卡片能进详情、点卡片里的按钮不会顺带进详情；
//   - 从详情返回时恢复列表滚动位置。
// PluginMarketPage / PluginInfo 是 internal，用反射构造；没有新增产品可见接口。

internal static class Program
{
    private static int _pass;
    private static int _fail;
    private static object _page;
    private static Type _pageType;
    private static FrameworkElement _pageElement;
    private static Grid _cards;
    private static DockPanel _listPanel;
    private static DockPanel _detailPanel;
    private static ScrollViewer _marketScroll;

    [STAThread]
    private static int Main()
    {
        try
        {
            var app = new App { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            app.InitializeComponent();
            BuildPage();

            FourRowStructure();
            ResponsiveColumns();
            ResponsiveColumnsByLayoutEvents();
            ResizeRoundTrip();
            ScrollbarWidthIsNotDoubleSubtracted();
            FewItemsKeepTheirSlot();
            ZeroItemsShowEmptyState();
            EmojiDescription();
            CardClickExcludesButtons();
            BackRestoresScroll();
        }
        catch (Exception ex)
        {
            Console.WriteLine("HARNESS ERROR: " + ex);
            return 2;
        }

        Console.WriteLine();
        Console.WriteLine($"MarketPageChecks: {_pass} passed, {_fail} failed");
        return _fail == 0 ? 0 : 1;
    }

    private static void BuildPage()
    {
        var asm = typeof(App).Assembly;
        _pageType = asm.GetType("WhaleLauncher.Views.PluginMarketPage", throwOnError: true);
        var marketType = asm.GetType("WhaleLauncher.PluginMarket", throwOnError: true);
        // 沙箱可能拒绝写系统临时目录；放进本次构建输出目录，跑完留在 artifacts 下便于复现。
        var root = Path.Combine(AppContext.BaseDirectory, "fixture-data", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var market = Activator.CreateInstance(marketType,
            BindingFlags.Instance | BindingFlags.NonPublic, null, new object[] { root }, null);
        var supervisor = new RuntimeSupervisor(root);
        _page = Activator.CreateInstance(_pageType,
            BindingFlags.Instance | BindingFlags.NonPublic, null, new object[] { market, "4.3.0", supervisor }, null);
        _pageElement = (FrameworkElement)_page;
        _cards = (Grid)_pageElement.FindName("Cards");
        _listPanel = (DockPanel)_pageElement.FindName("ListPanel");
        _detailPanel = (DockPanel)_pageElement.FindName("DetailPanel");
        _marketScroll = (ScrollViewer)_pageElement.FindName("MarketScroll");
        if (_cards == null || _listPanel == null || _detailPanel == null || _marketScroll == null)
            throw new InvalidOperationException("市场页缺少预期的 XAML 元素");
    }

    private static void FourRowStructure()
    {
        SetCatalog(12);
        Layout(1044, 2000);
        var cards = CardBorders();
        Check(cards.Count == 12, "12 个目录条目生成 12 张卡", cards.Count);

        foreach (var card in cards)
        {
            var body = card.Child as Grid;
            Check(body != null, "卡片内容是 Grid");
            if (body == null) continue;
            Check(body.RowDefinitions.Count == 5, "卡片 4 行内容 + 1 个弹性占位", body.RowDefinitions.Count);

            var title = body.Children.OfType<TextBlock>().Single(t => Grid.GetRow(t) == 0);
            var author = body.Children.OfType<TextBlock>().Single(t => Grid.GetRow(t) == 1);
            var description = body.Children.OfType<TextBlock>().Single(t => Grid.GetRow(t) == 2);
            Check(title.TextWrapping == TextWrapping.NoWrap && title.TextTrimming == TextTrimming.CharacterEllipsis,
                "标题单行截断");
            Check(author.Text.Contains("·  v1.0.0", StringComparison.Ordinal), "作者行包含版本", author.Text);
            Check(author.TextWrapping == TextWrapping.NoWrap && author.TextTrimming == TextTrimming.CharacterEllipsis,
                "作者+版本单行截断");
            Check(description.TextWrapping == TextWrapping.NoWrap && description.TextTrimming == TextTrimming.CharacterEllipsis,
                "简介单行截断");
            Check(TextElements(description.Text) <= 20, "简介不超过 20 个文本元素", description.Text);

            var actions = body.Children.OfType<Grid>().Single(g => Grid.GetRow(g) == 4);
            Check(actions.Children.OfType<StackPanel>().Count() == 2, "底行有活动区和主操作区",
                actions.Children.Count);
            var panels = actions.Children.OfType<StackPanel>().ToArray();
            Check(panels[0].ActualWidth + panels[1].ActualWidth <= actions.ActualWidth + 0.5,
                "底行按钮不挤出卡片", $"{panels[0].ActualWidth}+{panels[1].ActualWidth}/{actions.ActualWidth}");
        }

        var heights = cards.Select(c => c.Height).Distinct().ToList();
        Check(heights.Count == 1, "所有卡片标准高度一致", string.Join(",", heights));
        var actualHeights = cards.Select(c => c.ActualHeight).Distinct().ToList();
        Check(actualHeights.Count == 1, "布局后卡片实际高度一致", string.Join(",", actualHeights));
        Check(cards[0].Height >= 150 && cards[0].Height <= 170, "默认卡高接近 156", cards[0].Height);
    }

    private static void ResponsiveColumns()
    {
        SetCatalog(12);
        Layout(1044, 2000); // Cards 可用宽 984
        CheckClose(_cards.ActualWidth, 984, "1044px 页面时卡片区可用宽");
        ExpectColumns(3, 984, "默认三列");
        Layout(1043, 2000); // 983 -> 两列
        CheckClose(_cards.ActualWidth, 983, "1043px 页面时卡片区可用宽");
        ExpectColumns(2, 983, "降到阈值下变两列");
        Layout(1100, 2000);
        ExpectColumns(3, 1040, "放大回到三列");
        Layout(1660, 2000); // 1600 -> 4 列
        ExpectColumns(4, 1600, "宽窗口四列");
    }

    private static void ResponsiveColumnsByLayoutEvents()
    {
        // 不手动调 ApplyCardGrid：只改窗口尺寸并跑 WPF 布局，验证视口事件真的接线了。
        SetCatalog(12);
        Layout(1044, 2000);
        foreach (var pageWidth in new[] { 1100.0, 1043.0, 700.0, 1660.0, 1044.0 })
        {
            Resize(pageWidth, 2000);
            CheckClose(_cards.ActualWidth, _marketScroll.ViewportWidth,
                $"{pageWidth}px 事件驱动卡片区=视口宽");
            var columns = Math.Max(1, (int)Math.Floor((_cards.ActualWidth + 12) / 332));
            ExpectColumns(columns, _cards.ActualWidth, $"{pageWidth}px 事件驱动列数");
        }
    }

    private static void Resize(double width, double height)
    {
        _pageElement.Width = width;
        _pageElement.Height = height;
        _pageElement.Measure(new Size(width, height));
        _pageElement.Arrange(new Rect(0, 0, width, height));
        _pageElement.UpdateLayout();
    }

    private static void ResizeRoundTrip()
    {
        SetCatalog(12);
        var widths = new[] { 1044.0, 1043.0, 1044.0, 1100.0, 700.0, 1660.0, 1044.0 };
        foreach (var pageWidth in widths)
        {
            Layout(pageWidth, 2000);
            // 滚动条出现时视口会比 page-60 再窄；卡片区必须正好等于真实视口，不能再多减一次。
            CheckClose(_cards.ActualWidth, _marketScroll.ViewportWidth, $"{pageWidth}px 页面卡片区=视口宽");
            var expectedColumns = Math.Max(1, (int)Math.Floor((_cards.ActualWidth + 12) / 332));
            ExpectColumns(expectedColumns, _cards.ActualWidth, $"{pageWidth}px 页面列数");
        }
    }

    private static void ScrollbarWidthIsNotDoubleSubtracted()
    {
        SetCatalog(12);
        Layout(1044, 420); // 内容超出，垂直滚动条出现
        var pageWidth = 1044.0;
        Check(_marketScroll.ScrollableHeight > 0, "内容可滚动", _marketScroll.ScrollableHeight);
        // Cards 宽度由 ScrollViewer 视口给出；不能再手动减一次滚动条宽度。
        Check(_cards.ActualWidth < pageWidth - 60, "滚动条占用了可用宽", _cards.ActualWidth);
        CheckClose(SumColumnWidths(), _cards.ActualWidth, "滚动条出现后列宽合计仍等于实际可用宽");

        var cards = CardBorders();
        var last = cards[^1];
        var right = last.TranslatePoint(new Point(last.ActualWidth, 0), _cards).X;
        Check(right <= _cards.ActualWidth + 0.01, "滚动条出现后最后一张卡不越界", right);
        // 一张卡占满最后一个槽位，不能留下“又减了一次滚动条”的空槽。
        CheckClose(right, _cards.ActualWidth, "最后一张卡填满最后列");
    }

    private static void FewItemsKeepTheirSlot()
    {
        SetCatalog(1);
        Layout(1660, 800); // Cards 1600 -> 4 列；1 条只占第一槽
        var card = CardBorders().Single();
        CheckClose(_cards.ActualWidth, 1600, "少量条目时可用宽");
        ExpectColumns(4, 1600, "少量条目仍按列数排版");
        CheckClose(card.ActualWidth, (1600 - 3 * 12) / 4.0, "少量条目不拉伸卡宽");
        Check(card.ActualWidth < 800, "少量条目不会占半行", card.ActualWidth);
    }

    private static void ZeroItemsShowEmptyState()
    {
        SetCatalog(0);
        Layout(1660, 800);
        Check(_cards.Children.Count == 1 && _cards.Children[0] is TextBlock, "零条目只显示空状态", _cards.Children.Count);
        var message = _cards.Children[0] as TextBlock;
        Check(message != null && Grid.GetColumnSpan(message) == 4, "空状态跨全部列", message == null ? -1 : Grid.GetColumnSpan(message));
    }

    private static void EmojiDescription()
    {
        const string family = "👨‍👩‍👧‍👦";
        var full = string.Concat(Enumerable.Repeat(family, 21)) + "tail";
        SetCatalog(1, full);
        Layout(1044, 1200);
        var card = CardBorders().Single();
        var body = (Grid)card.Child;
        var description = body.Children.OfType<TextBlock>().Single(t => Grid.GetRow(t) == 2);
        Check(TextElements(description.Text) == 20, "emoji 简介截到 20 个文本元素", description.Text);
        Check(description.Text.EndsWith('…'), "emoji 简介带省略号");
        Check(CountOccurrences(description.Text, family) == 19, "emoji 家庭不被劈开",
            CountOccurrences(description.Text, family));
        Check(Equals(description.ToolTip, full), "Tooltip 保留完整简介", description.ToolTip);
    }

    private static void CardClickExcludesButtons()
    {
        SetCatalog(12);
        Layout(1044, 420);
        var card = CardBorders()[0];
        Check(_detailPanel.Visibility == Visibility.Collapsed, "初始不显示详情");

        var button = Descendants(card).OfType<Button>().FirstOrDefault();
        Check(button != null, "卡片里存在按钮");
        SetBooleanField("_busy", true); // 防止按钮动作真的发网络请求
        RaiseLeftUp(button);
        Check(_detailPanel.Visibility == Visibility.Collapsed, "点卡片里的按钮不进入详情");
        SetBooleanField("_busy", false);

        var title = Descendants(card).OfType<TextBlock>().First(t => Grid.GetRow(t) == 0);
        RaiseLeftUp(title);
        Check(_detailPanel.Visibility == Visibility.Visible, "点卡片正文进入详情");
    }

    private static void BackRestoresScroll()
    {
        // 上一条用例故意停在详情里；先回列表，保证这里测的是「从列表进入详情再返回」。
        if (_detailPanel.Visibility == Visibility.Visible)
        {
            PrivateMethod("OnBack").Invoke(_page, new object[] { _page, new RoutedEventArgs() });
            Pump();
        }
        SetCatalog(12);
        Layout(1044, 420);
        _marketScroll.ScrollToVerticalOffset(300);
        _pageElement.UpdateLayout();
        Check(_marketScroll.VerticalOffset > 100, "列表已滚动", _marketScroll.VerticalOffset);
        var offset = _marketScroll.VerticalOffset;

        var card = CardBorders()[0];
        var title = Descendants(card).OfType<TextBlock>().First(t => Grid.GetRow(t) == 0);
        RaiseLeftUp(title);
        Check(_detailPanel.Visibility == Visibility.Visible, "进入详情");

        PrivateMethod("OnBack").Invoke(_page, new object[] { _page, new RoutedEventArgs() });
        Pump();
        Check(_detailPanel.Visibility == Visibility.Collapsed, "返回列表");
        Check(Math.Abs(_marketScroll.VerticalOffset - offset) < 1.0, "返回后恢复滚动位置",
            $"{offset} -> {_marketScroll.VerticalOffset}");
    }

    // ---------- 构造与反射 ----------

    private static MethodInfo PrivateMethod(string name, int parameterCount = -1) =>
        _pageType.GetMethods(BindingFlags.Instance | BindingFlags.NonPublic)
            .Single(m => m.Name == name && (parameterCount < 0 || m.GetParameters().Length == parameterCount));

    private static void SetCatalog(int count, params string[] descriptions)
    {
        var asm = _pageType.Assembly;
        var infoType = asm.GetType("WhaleLauncher.PluginInfo", throwOnError: true);
        var ctor = infoType.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .OrderByDescending(c => c.GetParameters().Length).First();
        var providerType = asm.GetType("WhaleLauncher.PluginProvider", throwOnError: true);
        var dictType = typeof(Dictionary<,>).MakeGenericType(typeof(string), providerType);
        var array = Array.CreateInstance(infoType, count);
        for (var i = 0; i < count; i++)
        {
            var description = descriptions.Length > i ? descriptions[i]
                : "第 " + i + " 个演示插件简介，用来验证卡片四行布局不会因为长文本撑高。";
            var provides = Activator.CreateInstance(dictType);
            // 按参数名绑定而不是按位置：PluginInfo 是位置记录，宿主每加一个字段都会让位置对齐失效，
            // 这里再按位置传就会变成「参数个数不符」的伪装失败，看不出是夹具停在旧签名上。
            var values = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["Id"] = "demo-" + i,
                ["Name"] = "演示插件 " + i,
                ["Author"] = "演示作者",
                ["Version"] = "1.0.0",
                ["MinAppVersion"] = "4.1.2",
                ["Description"] = description,
                ["Api"] = 5,
                ["Kind"] = "plugin",
                ["DiscussionIssue"] = 7,
                ["ExecutionTimeoutMs"] = 30000,
                ["IntervalSeconds"] = 60,
                ["Provides"] = provides,
                ["Calls"] = Array.Empty<string>(),
                ["Level"] = 1,
            };
            var args = ctor.GetParameters().Select(parameter =>
                values.TryGetValue(parameter.Name ?? string.Empty, out var bound)
                    ? bound
                    : parameter.HasDefaultValue ? parameter.DefaultValue
                    : parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType)
                    : null).ToArray();
            array.SetValue(ctor.Invoke(args), i);
        }
        _pageType.GetField("_catalog", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(_page, array);
        PrivateMethod("Render", 0).Invoke(_page, null);
    }

    private static void Layout(double width, double height)
    {
        _pageElement.Width = width;
        _pageElement.Height = height;
        _pageElement.Measure(new Size(width, height));
        _pageElement.Arrange(new Rect(0, 0, width, height));
        _pageElement.UpdateLayout();
        if (_marketScroll.ViewportWidth > 0)
        {
            // 离屏布局里 ScrollViewer 的事件可能合并；显式按真实视口调一次，内部会按宽度去重。
            PrivateMethod("ApplyCardGrid").Invoke(_page, new object[] { _marketScroll.ViewportWidth });
            _pageElement.UpdateLayout();
        }
    }

    private static void ExpectColumns(int expected, double availableWidth, string what)
    {
        Check(_cards.ColumnDefinitions.Count == expected, what + " 列数",
            _cards.ColumnDefinitions.Count);
        CheckClose(SumColumnWidths(), availableWidth, what + " 列宽合计");
        var cards = CardBorders();
        if (cards.Count > 0)
        {
            var cardWidth = (availableWidth - (expected - 1) * 12) / expected;
            CheckClose(cards[0].ActualWidth, cardWidth, what + " 卡宽");
        }
    }

    private static void RaiseLeftUp(UIElement element)
    {
        if (element == null) return;
        // MouseLeftButtonUp 本身是 Direct 事件；真实的输入系统会沿 MouseUp 的冒泡路径逐层补发。
        // 离屏 harness 里用冒泡的 MouseUp 模拟，才能覆盖卡片 Border 上的处理器。
        element.RaiseEvent(new MouseButtonEventArgs(Mouse.PrimaryDevice, Environment.TickCount, MouseButton.Left)
        {
            RoutedEvent = Mouse.MouseUpEvent,
        });
    }

    private static void SetBooleanField(string name, bool value) =>
        _pageType.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).SetValue(_page, value);

    private static void Pump()
    {
        var frame = new DispatcherFrame();
        Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle,
            new Action(() => frame.Continue = false));
        Dispatcher.PushFrame(frame);
    }

    private static List<Border> CardBorders() =>
        _cards.Children.OfType<Border>().ToList();

    private static double SumColumnWidths()
    {
        var total = 0.0;
        foreach (var column in _cards.ColumnDefinitions) total += column.ActualWidth;
        return total;
    }

    private static IEnumerable<DependencyObject> Descendants(DependencyObject root)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(root))
        {
            if (child is not DependencyObject element) continue;
            yield return element;
            foreach (var descendant in Descendants(element)) yield return descendant;
        }
    }

    private static int TextElements(string text)
    {
        var count = 0;
        var enumerator = StringInfo.GetTextElementEnumerator(text ?? "");
        while (enumerator.MoveNext()) count++;
        return count;
    }

    private static int CountOccurrences(string text, string value)
    {
        var count = 0;
        var index = 0;
        while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += value.Length;
        }
        return count;
    }

    private static void Check(bool ok, string what, object actual = null)
    {
        if (ok) { _pass++; return; }
        _fail++;
        Console.WriteLine($"FAIL {what} (actual: {actual})");
    }

    private static void CheckClose(double actual, double expected, string what)
    {
        if (Math.Abs(actual - expected) < 0.01) { _pass++; return; }
        _fail++;
        Console.WriteLine($"FAIL {what}: expected {expected}, actual {actual}");
    }
}
