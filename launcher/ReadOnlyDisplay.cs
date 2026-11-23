using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace WhaleLauncher.Views
{
    /// <summary>
    /// 只读展示件：只回答「怎么画」，不取数、不定刷新节奏、不碰日志权限。
    ///
    /// 抽这两块是因为它们真的重复了：
    ///   · 状态页的三张卡（内核/桥接/微信）在 XAML 里整套抄了三遍，Apply 里又逐控件赋值；
    ///   · 状态页「最近动态」和诊断页「内核日志」各自写了一份完全相同的扁平列表容器样式，
    ///     只差每项的内边距。
    /// 诊断页的自检行（✓/✕ + 名称 + 灰字）只有这一个用点，不算重复，所以留在页面里。
    /// </summary>
    public static class ReadOnlyDisplay
    {
        /// <summary>按资源键取画刷；资源缺失返回 null，让调用方保留上一个状态，而不是把整页弄崩。</summary>
        public static Brush Brush(FrameworkElement owner, string key)
        {
            if (owner == null || string.IsNullOrEmpty(key)) return null;
            try { return owner.FindResource(key) as Brush; }
            catch { return null; }
        }

        /// <summary>
        /// 扁平只读列表：透明背景、无列表边框、每项只留一条可配内边距的 Border。
        /// 视觉与原来 XAML 里的 ItemContainerStyle 一致（Background=Transparent + Border + ContentPresenter），
        /// 只是把两个页面各一份的复制收成一处；虚拟化、滚动仍由 ListBox 自身负责。
        /// </summary>
        public static void StyleFlatList(ListBox list, Thickness itemPadding)
        {
            if (list == null) return;
            var content = new FrameworkElementFactory(typeof(ContentPresenter));
            var border = new FrameworkElementFactory(typeof(Border));
            border.SetValue(Border.BackgroundProperty, Brushes.Transparent);
            border.SetValue(Border.PaddingProperty, itemPadding);
            border.AppendChild(content);

            var template = new ControlTemplate(typeof(ListBoxItem)) { VisualTree = border };
            var style = new Style(typeof(ListBoxItem));
            style.Setters.Add(new Setter(Control.TemplateProperty, template));
            list.ItemContainerStyle = style;
        }
    }

    /// <summary>
    /// 状态卡：圆点 + 名称 +（可选）尾注，下面一行大字结论、一行灰字说明。
    /// 结构、间距、字号都照搬 StatusPage 原来那三张卡，所以默认外观不变。
    /// </summary>
    public sealed class StatusCard : Border
    {
        private readonly Ellipse _dot;
        private readonly TextBlock _label;
        private readonly TextBlock _meta;
        private readonly TextBlock _main;
        private readonly TextBlock _sub;

        public StatusCard()
        {
            Padding = new Thickness(18, 16, 18, 16);
            SetResourceReference(StyleProperty, "Card");

            _dot = new Ellipse { Width = 9, Height = 9, VerticalAlignment = VerticalAlignment.Center };
            _dot.SetResourceReference(Shape.FillProperty, "Idle");

            _label = new TextBlock { Margin = new Thickness(7, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            _label.SetResourceReference(StyleProperty, "Label");

            _meta = new TextBlock { Margin = new Thickness(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            _meta.SetResourceReference(StyleProperty, "Small");

            var header = new StackPanel { Orientation = Orientation.Horizontal };
            header.Children.Add(_dot);
            header.Children.Add(_label);
            header.Children.Add(_meta);

            _main = new TextBlock
            {
                FontSize = 22,
                FontWeight = FontWeights.SemiBold,
                Margin = new Thickness(0, 9, 0, 0),
                Text = "未启动"
            };
            _main.SetResourceReference(TextBlock.ForegroundProperty, "Text");

            _sub = new TextBlock
            {
                Margin = new Thickness(0, 5, 0, 0),
                TextWrapping = TextWrapping.Wrap,
                TextTrimming = TextTrimming.CharacterEllipsis,
                Text = "—"
            };
            _sub.SetResourceReference(StyleProperty, "Small");

            var stack = new StackPanel();
            stack.Children.Add(header);
            stack.Children.Add(_main);
            stack.Children.Add(_sub);
            Child = stack;
        }

        /// <summary>卡片标题，例如「内核」「桥接」「微信」。</summary>
        public string Label
        {
            get => _label.Text;
            set => _label.Text = value ?? "";
        }

        /// <summary>右上角那点小字（已跑时长 / 心跳）。关掉时整块不占位，和原来没有这个 TextBlock 的卡片一致。</summary>
        public bool ShowMeta
        {
            get => _meta.Visibility == Visibility.Visible;
            set => _meta.Visibility = value ? Visibility.Visible : Visibility.Collapsed;
        }

        public string MainText
        {
            get => _main.Text;
            set => _main.Text = value ?? "";
        }

        public string MetaText
        {
            get => _meta.Text;
            set => _meta.Text = value ?? "";
        }

        public string SubText
        {
            get => _sub.Text;
            set => _sub.Text = value ?? "";
        }

        /// <summary>只换圆点颜色（Ok / Warn / Idle / Bad），文字不动。</summary>
        public void SetTone(string brushKey)
        {
            var brush = ReadOnlyDisplay.Brush(this, brushKey);
            if (brush != null) _dot.Fill = brush;
        }

        /// <summary>一次刷完一张卡：颜色 + 结论 + 尾注 + 说明。</summary>
        public void SetStatus(string toneKey, string main, string meta, string sub)
        {
            SetTone(toneKey);
            MainText = main;
            MetaText = meta;
            SubText = sub;
        }
    }
}
