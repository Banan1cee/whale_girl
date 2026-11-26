using System;
using System.Collections.Generic;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using WhaleLauncher;

// 插件卡片网格的纯行为检查（无窗口、无网络、不启动微信）：
//   1. 阈值上下 / 来回 resize 时列数、卡宽、列宽合计是否严格等于可用宽；
//   2. 真实 WPF Grid 测量下，卡片实际宽度与右边界不越界，少量条目不被拉成整行；
//   3. 简介按 Unicode 文本元素截断、省略号计入 20，emoji 组合不被劈开。
// 直接编译 launcher/PluginCardLayout.cs，不加载主程序，也不需要管理员权限。

internal static class Program
{
    private static int _pass;
    private static int _fail;

    [STAThread]
    private static int Main()
    {
        try
        {
            Thresholds();
            ResizeRoundTrip();
            InvalidWidths();
            RealGridDoesNotOverflow();
            FewItemsKeepTheirSlot();
            EmptyItems();
            DescriptionTruncation();
            CardHeightScaling();
        }
        catch (Exception ex)
        {
            Console.WriteLine("HARNESS ERROR: " + ex);
            return 2;
        }

        Console.WriteLine();
        Console.WriteLine($"CardLayoutChecks: {_pass} passed, {_fail} failed");
        return _fail == 0 ? 0 : 1;
    }

    private static void Thresholds()
    {
        // base=320, gap=12：983 -> 2 列，984 正好回到 3 列。
        var below = PluginCardLayout.Compute(983);
        Check(below.Columns == 2, "983px 应为 2 列", below.Columns);
        CheckClose(below.CardWidth, (983 - 12) / 2.0, "983px 卡宽");
        CheckClose(below.ColumnWidths[0], below.CardWidth + 12, "983px 首列含间隙");
        CheckClose(below.ColumnWidths[1], below.CardWidth, "983px 末列不含间隙");
        CheckClose(Sum(below.ColumnWidths), 983, "983px 列宽合计");

        var above = PluginCardLayout.Compute(984);
        Check(above.Columns == 3, "984px 应为 3 列", above.Columns);
        CheckClose(above.CardWidth, (984 - 24) / 3.0, "984px 卡宽");
        CheckClose(Sum(above.ColumnWidths), 984, "984px 列宽合计");

        // 每列宽度只能按「卡宽 + gap」累加一次，不能把 gap 当 Margin 再加一遍。
        var wide = PluginCardLayout.Compute(1320);
        Check(wide.Columns == 4, "1320px 应为 4 列", wide.Columns);
        CheckClose(Sum(wide.ColumnWidths), 1320, "1320px 列宽合计");
    }

    private static void ResizeRoundTrip()
    {
        var widths = new[] { 1320.0, 1100, 1044, 1000, 984, 983, 880, 700, 500, 340, 320, 319, 200, 1600, 1320 };
        foreach (var width in widths)
        {
            var grid = PluginCardLayout.Compute(width);
            var expectedColumns = Math.Max(1, (int)Math.Floor((width + 12) / (320 + 12)));
            Check(grid.Columns == expectedColumns, $"{width}px 列数公式", grid.Columns);
            CheckClose(Sum(grid.ColumnWidths), width, $"{width}px 列宽合计");
            Check(grid.CardWidth > 0 && grid.CardWidth <= width + 0.001, $"{width}px 卡宽在可用宽内", grid.CardWidth);
            var expectedCard = width < 320 ? width : (width - (grid.Columns - 1) * 12) / grid.Columns;
            CheckClose(grid.CardWidth, expectedCard, $"{width}px 卡宽均分");
        }

        // 来回 resize 必须可逆：同一宽度得到同一结果。
        var first = PluginCardLayout.Compute(1044);
        _ = PluginCardLayout.Compute(700);
        var again = PluginCardLayout.Compute(1044);
        Check(first.Columns == again.Columns && Math.Abs(first.CardWidth - again.CardWidth) < 1e-9,
            "resize 往返后结果一致", $"{first.Columns}/{again.Columns}");
    }

    private static void InvalidWidths()
    {
        foreach (var width in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity, 0, -20 })
        {
            var grid = PluginCardLayout.Compute(width);
            Check(grid.Columns == 1 && grid.CardWidth == 0 && grid.ColumnWidths.Length == 1,
                $"非法宽度 {width} 返回单列 0 宽", $"{grid.Columns}/{grid.CardWidth}");
        }
    }

    private static void RealGridDoesNotOverflow()
    {
        foreach (var width in new[] { 984.0, 1044, 1100, 700, 340 })
        {
            var layout = PluginCardLayout.Compute(width);
            var grid = BuildGrid(layout, 7, out var cards);
            grid.Measure(new Size(width, 2000));
            grid.Arrange(new Rect(0, 0, width, 2000));
            grid.UpdateLayout();

            CheckClose(grid.ActualWidth, width, $"{width}px 真实 Grid 宽");
            foreach (var card in cards)
                CheckClose(card.ActualWidth, layout.CardWidth, $"{width}px 真实卡宽");

            var last = cards[^1];
            var right = last.TranslatePoint(new Point(last.ActualWidth, 0), grid).X;
            Check(right <= width + 0.01, $"{width}px 最后一张卡不越界", right);
            CheckClose(Sum(layout.ColumnWidths), grid.ActualWidth, $"{width}px 列宽合计=实际 Grid 宽");
        }
    }

    private static void FewItemsKeepTheirSlot()
    {
        var layout = PluginCardLayout.Compute(1600);
        var grid = BuildGrid(layout, 1, out var cards);
        grid.Measure(new Size(1600, 800));
        grid.Arrange(new Rect(0, 0, 1600, 800));
        grid.UpdateLayout();
        CheckClose(cards[0].ActualWidth, layout.CardWidth, "单条目不拉伸卡宽");
        Check(cards[0].ActualWidth < 800, "单条目不应占半行", cards[0].ActualWidth);

        var right = cards[0].TranslatePoint(new Point(cards[0].ActualWidth, 0), grid).X;
        CheckClose(right, layout.CardWidth, "单条目只占一个槽位");
    }

    private static void EmptyItems()
    {
        Check(PluginCardLayout.Rows(0, 3) == 0, "零条目为 0 行", PluginCardLayout.Rows(0, 3));
        Check(PluginCardLayout.Rows(1, 3) == 1, "1 条目 1 行", PluginCardLayout.Rows(1, 3));
        Check(PluginCardLayout.Rows(3, 3) == 1, "3 条目 1 行", PluginCardLayout.Rows(3, 3));
        Check(PluginCardLayout.Rows(4, 3) == 2, "4 条目 2 行", PluginCardLayout.Rows(4, 3));
    }

    private static Grid BuildGrid(PluginCardLayout.CardGrid layout, int count, out List<Border> cards)
    {
        var grid = new Grid();
        foreach (var width in layout.ColumnWidths)
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(width) });
        var rows = PluginCardLayout.Rows(count, layout.Columns);
        for (var row = 0; row < rows; row++)
            grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(PluginCardLayout.StandardCardHeight + 12) });
        cards = new List<Border>();
        for (var i = 0; i < count; i++)
        {
            var card = new Border
            {
                Width = layout.CardWidth,
                Height = PluginCardLayout.StandardCardHeight,
                Margin = new Thickness(0, 0, 0, 12),
                HorizontalAlignment = HorizontalAlignment.Left,
            };
            Grid.SetColumn(card, i % layout.Columns);
            Grid.SetRow(card, i / layout.Columns);
            grid.Children.Add(card);
            cards.Add(card);
        }
        return grid;
    }

    private static void DescriptionTruncation()
    {
        Check(PluginCardLayout.Describe(null) == "", "null 简介为空");
        Check(PluginCardLayout.Describe("") == "", "空简介为空");
        var twenty = new string('a', 20);
        Check(PluginCardLayout.Describe(twenty) == twenty, "20 个 ASCII 不截断");
        var result = PluginCardLayout.Describe(new string('a', 21));
        Check(TextElements(result) == 20 && result.EndsWith('…'), "21 个 ASCII 截成 19+…", result);
        Check(result.StartsWith(new string('a', 19), StringComparison.Ordinal), "截断保留前 19 个", result);

        // emoji 组合：一个 ZWJ 家庭算一个 Unicode 文本元素。
        const string family = "👨‍👩‍👧‍👦";
        var families20 = string.Concat(System.Linq.Enumerable.Repeat(family, 20));
        Check(PluginCardLayout.Describe(families20) == families20, "20 个 ZWJ 家庭不截断", families20.Length);
        var families21 = string.Concat(System.Linq.Enumerable.Repeat(family, 21));
        var familyResult = PluginCardLayout.Describe(families21);
        Check(TextElements(familyResult) == 20 && familyResult.EndsWith('…'), "21 个 ZWJ 家庭截成 19+…", familyResult);
        Check(CountOccurrences(familyResult, family) == 19, "ZWJ 家庭没有被劈开", CountOccurrences(familyResult, family));

        // 组合重音、旗帜、变体选择符都按一个文本元素处理。
        var combining = "e" + "\u0301";
        var combining21 = string.Concat(System.Linq.Enumerable.Repeat(combining, 21));
        var combiningResult = PluginCardLayout.Describe(combining21);
        Check(TextElements(combiningResult) == 20 && combiningResult.EndsWith('…'), "组合重音截断", combiningResult);

        var flags = string.Concat(System.Linq.Enumerable.Repeat("🇨🇳", 21));
        Check(TextElements(PluginCardLayout.Describe(flags)) == 20, "旗帜按一个文本元素");

        var hearts = string.Concat(System.Linq.Enumerable.Repeat("❤️", 21));
        Check(TextElements(PluginCardLayout.Describe(hearts)) == 20, "变体选择符按一个文本元素");

        // 省略号本身计数：limit=1 时只剩省略号。
        Check(PluginCardLayout.Describe("ab", 1) == "…", "limit=1 只有省略号");
        Check(PluginCardLayout.Describe("a", 1) == "a", "1 个文本元素不截断");
        Check(PluginCardLayout.Describe("😀😀", 2) == "😀😀", "恰好等于上限不截断");
    }

    private static void CardHeightScaling()
    {
        CheckClose(PluginCardLayout.CardHeight(1), 156, "默认卡高");
        CheckClose(PluginCardLayout.CardHeight(0.5), 156, "小于 1 的缩放被夹到默认");
        CheckClose(PluginCardLayout.CardHeight(double.NaN), 156, "NaN 缩放回默认");
        CheckClose(PluginCardLayout.CardHeight(2.5), 390, "2.5 倍卡高");
        CheckClose(PluginCardLayout.CardHeight(4), 390, "超过 2.5 倍被夹住");
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

    private static double Sum(double[] values)
    {
        var total = 0.0;
        foreach (var value in values) total += value;
        return total;
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
