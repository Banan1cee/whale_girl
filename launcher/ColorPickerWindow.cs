using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WhaleLauncher
{
    /// <summary>
    /// 轻量 RGB 调色窗：三根滑轨 + 预览 + 色值。不引入第三方颜色选择器，
    /// 手选结果直接写进 launcher-ui.json。
    /// </summary>
    public sealed class ColorPickerWindow : Window
    {
        private readonly Slider _r;
        private readonly Slider _g;
        private readonly Slider _b;
        private readonly Border _preview;
        private readonly TextBlock _hex;
        private bool _ready;

        public Color SelectedColor { get; private set; }

        public ColorPickerWindow(string title, Color initial, Style sliderStyle)
        {
            SelectedColor = initial;
            Title = "调色 · " + title;
            Width = 430;
            SizeToContent = SizeToContent.Height;
            ResizeMode = ResizeMode.NoResize;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            SetResourceReference(BackgroundProperty, "Bg");
            SetResourceReference(ForegroundProperty, "Text");
            FontSize = 12.5;

            var root = new StackPanel { Margin = new Thickness(18, 16, 18, 14) };
            Content = root;

            _preview = new Border
            {
                Height = 54,
                CornerRadius = new CornerRadius(10),
                BorderThickness = new Thickness(1),
            };
            _preview.SetResourceReference(Border.BorderBrushProperty, "CardBorder");
            root.Children.Add(_preview);

            _hex = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                Margin = new Thickness(0, 6, 0, 12),
            };
            root.Children.Add(_hex);

            _r = AddSlider(root, "R", sliderStyle);
            _g = AddSlider(root, "G", sliderStyle);
            _b = AddSlider(root, "B", sliderStyle);

            _r.Value = initial.R;
            _g.Value = initial.G;
            _b.Value = initial.B;
            _r.ValueChanged += (_, __) => RefreshPreview();
            _g.ValueChanged += (_, __) => RefreshPreview();
            _b.ValueChanged += (_, __) => RefreshPreview();
            _ready = true;
            RefreshPreview();

            var buttons = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                Margin = new Thickness(0, 16, 0, 0),
            };
            var ok = new Button { Content = "确定", Style = (Style)FindResource("Primary"), MinWidth = 82, IsDefault = true };
            var cancel = new Button { Content = "取消", Style = (Style)FindResource("Ghost"), MinWidth = 82, IsCancel = true, Margin = new Thickness(8, 0, 0, 0) };
            ok.Click += (_, __) =>
            {
                SelectedColor = Current();
                DialogResult = true;
            };
            buttons.Children.Add(ok);
            buttons.Children.Add(cancel);
            root.Children.Add(buttons);
        }

        private Color Current() => Color.FromRgb((byte)Math.Round(_r.Value), (byte)Math.Round(_g.Value), (byte)Math.Round(_b.Value));

        private void RefreshPreview()
        {
            if (!_ready) return;
            var c = Current();
            _preview.Background = new SolidColorBrush(c);
            _hex.Text = Appearance.ToHex(c);
            if (_r.Tag is TextBlock rt) rt.Text = ((int)_r.Value).ToString();
            if (_g.Tag is TextBlock gt) gt.Text = ((int)_g.Value).ToString();
            if (_b.Tag is TextBlock bt) bt.Text = ((int)_b.Value).ToString();
        }

        private Slider AddSlider(Panel host, string label, Style style)
        {
            var row = new Grid { Margin = new Thickness(0, 0, 0, 8) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(26) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(46) });

            row.Children.Add(new TextBlock
            {
                Text = label,
                Style = (Style)FindResource("Label"),
                VerticalAlignment = VerticalAlignment.Center,
            });

            var slider = new Slider
            {
                Minimum = 0,
                Maximum = 255,
                Style = style,
                VerticalAlignment = VerticalAlignment.Center,
            };
            Grid.SetColumn(slider, 1);
            row.Children.Add(slider);

            var value = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center,
            };
            Grid.SetColumn(value, 2);
            row.Children.Add(value);
            slider.Tag = value;

            host.Children.Add(row);
            return slider;
        }
    }
}
