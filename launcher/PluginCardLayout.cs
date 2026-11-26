using System;
using System.Collections.Generic;
using System.Globalization;

namespace WhaleLauncher
{
    /// <summary>
    /// 插件卡片网格的纯计算：列数、卡宽、每列宽度和简介截断。
    /// 不引用 WPF，页面只负责把结果套到 Grid 上；这样阈值与 emoji 截断可以单独跑行为测试。
    ///
    /// 布局规则（和需求里的公式一致）：
    ///   n = max(1, floor((W + gap) / (baseWidth + gap)))
    ///   cardWidth = (W - (n - 1) * gap) / n
    /// 每列宽度是「卡宽 + 列间隙」，最后一列只放卡宽，合计严格等于 W：
    /// 不能只给卡片设 Margin，否则 Grid 列宽仍然是 *, 会多出一列间隙并横向溢出。
    /// </summary>
    internal static class PluginCardLayout
    {
        /// <summary>标准卡宽。1320 宽窗口的三列卡片约 340，320 能保持默认三列、缩小时先变两列。</summary>
        internal const double BaseCardWidth = 320;

        /// <summary>卡片之间的固定间隙。</summary>
        internal const double Gap = 12;

        /// <summary>四行卡片（标题 / 作者+版本 / 简介 / 底行动作）的标准高度。</summary>
        internal const double StandardCardHeight = 156;

        /// <summary>简介最多显示的 Unicode 文本元素数，省略号也占一个。</summary>
        internal const int DescriptionLimit = 20;

        internal readonly record struct CardGrid(int Columns, double CardWidth, double[] ColumnWidths);

        /// <summary>
        /// 按实际可用宽度算网格。宽度非法（NaN/Infinity/0/负数）时返回单列 0 宽，
        /// 让调用方先不排版，等 SizeChanged 给出真实宽度；绝不返回负数列宽或横向溢出。
        /// </summary>
        internal static CardGrid Compute(double availableWidth)
        {
            if (!double.IsFinite(availableWidth) || availableWidth <= 0)
                return new CardGrid(1, 0, [0]);

            var width = availableWidth;
            var columns = (int)Math.Floor((width + Gap) / (BaseCardWidth + Gap));
            if (columns < 1) columns = 1;

            var cardWidth = (width - (columns - 1) * Gap) / columns;
            if (!double.IsFinite(cardWidth) || cardWidth <= 0)
            {
                columns = 1;
                cardWidth = width;
            }

            var widths = new double[columns];
            for (var i = 0; i < columns - 1; i++) widths[i] = cardWidth + Gap;
            widths[columns - 1] = cardWidth;
            return new CardGrid(columns, cardWidth, widths);
        }

        /// <summary>卡片行数。零条目也算 0 行，避免空状态被塞进一行卡片槽。</summary>
        internal static int Rows(int itemCount, int columns) =>
            itemCount <= 0 || columns <= 0 ? 0 : (int)Math.Ceiling(itemCount / (double)columns);

        /// <summary>
        /// 卡片标准高度随主题字号缩放。默认字号（11）返回 156；
        /// 缩放上限 2.5 倍，避免极端主题把卡片拉到占满整页。
        /// </summary>
        internal static double CardHeight(double fontScale)
        {
            var scale = double.IsFinite(fontScale) ? Math.Clamp(fontScale, 1.0, 2.5) : 1.0;
            return Math.Round(StandardCardHeight * scale);
        }

        /// <summary>
        /// 简介最多 limit 个 Unicode 文本元素（grapheme cluster），超出时用省略号「…」，
        /// 省略号本身计入 limit。emoji 组合（ZWJ 家庭、肤色、旗帜、组合重音）不能被劈开。
        /// </summary>
        internal static string Describe(string text, int limit = DescriptionLimit)
        {
            if (string.IsNullOrEmpty(text) || limit <= 0) return "";
            var enumerator = StringInfo.GetTextElementEnumerator(text);
            var elements = new List<string>(Math.Min(limit, 32));
            while (elements.Count < limit && enumerator.MoveNext())
                elements.Add(enumerator.GetTextElement());

            // 元素数没到上限，说明整段都能放下。
            if (elements.Count < limit) return text;
            // 恰好 limit 个元素：不截断，避免给刚好 20 个元素的简介硬加省略号。
            if (!enumerator.MoveNext()) return text;

            return string.Concat(elements.GetRange(0, limit - 1)) + "…";
        }
    }
}
