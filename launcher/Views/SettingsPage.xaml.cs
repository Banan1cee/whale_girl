using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using Microsoft.Win32;

namespace WhaleLauncher.Views
{
    /// <summary>一个可编辑的配置项。启动器是唯一界面，所以这里就是「全部设置」的清单。</summary>
    public sealed class FieldSpec
    {
        public string Path;
        public string Label;
        public string Kind = "text";      // bool / num / text / secret / select / multiline / slider / sliderInput
        public string Hint = "";
        public double Min = double.NaN;
        public double Max = double.NaN;
        // sliderInput 专用：右边输入框自己的范围（可以比滑块宽，比如滑块 2000–20000、输入框 1000–不设上限）
        public double InputMin = double.NaN;
        public double InputMax = double.NaN;
        public string[] Options;
        public bool IsInt = true;
        public string Unit = "";          // 拖动条右侧读数后缀，比如「 条/分钟」
    }

    public sealed class SectionSpec
    {
        public string Title;
        public string Note = "";
        public List<FieldSpec> Fields = new List<FieldSpec>();
    }

    public sealed class ProviderItem
    {
        public string Key { get; set; }
        public string Label { get; set; }
        public override string ToString() => Label ?? Key ?? "";
    }

    public partial class SettingsPage : UserControl, IRefreshable
    {
        private readonly RuntimeSupervisor _sup;
        private readonly ConfigSaver _saver;
        private readonly PageOperationLifetime _pageLifetime = new PageOperationLifetime();
        private readonly List<Action> _refreshBudgetHints = new List<Action>();
        private long _configurationRevision;
        private readonly Dictionary<string, Action<JsonElement>> _loaders = new Dictionary<string, Action<JsonElement>>();
        private Action<JsonElement, Dictionary<string, JsonElement>> _loadModel;
        private Action<JsonElement> _loadVision;
        private TextBlock _adminSpellStatus;
        private Dictionary<string, JsonElement> _providers;
        private bool _loading;
        private bool _configLoaded;      // 已经成功全量回填过一次（M30：周期刷新据此判断要不要补）
        private bool _loadedOnline;
        private bool _loadingConfig;     // 全量回填在途，防止载入和定时器双跑
        private DateTime _lastLoad = DateTime.MinValue;
        public SettingsPage(RuntimeSupervisor sup)
        {
            InitializeComponent();
            _sup = sup;
            _saver = new ConfigSaver(sup);
            BuildOnce();
            Loaded += async (_, __) =>
            {
                _pageLifetime.Activate();
                var generation = _pageLifetime.Capture();
                MainScroll.ScrollToTop();
                await RefreshAsync();
                if (_pageLifetime.IsCurrent(generation))
                    foreach (var refresh in _refreshBudgetHints) refresh();
            };
            Unloaded += (_, __) => _pageLifetime.Deactivate();
        }

        // ── 全部设置清单（启动器是唯一界面）────────────────────────
        private static List<SectionSpec> Specs() => new List<SectionSpec>
        {
            new SectionSpec { Title = "群聊", Fields =
            {
                new FieldSpec { Path = "group.requireAt", Label = "必须 @ 她才回", Kind = "bool", Hint = "关掉 = 群里不 @ 也会接，但按下面的插话概率抽，不是每条都回" },
                new FieldSpec { Path = "group.freeChat", Label = "允许她自己插话", Kind = "bool", Hint = "开着时没点名的消息也按概率抽一句；@ 她的不受影响" },
                new FieldSpec { Path = "group.freeChatChance", Label = "插话概率", Kind = "num", Min = 0, Max = 1, IsInt = false, Hint = "没点名的消息按这个概率接一句；0.06 = 百分之六，约 16 条回 1 条；填 1 = 每条都回，仍受冷却和每分钟上限约束" },
                new FieldSpec { Path = "group.cooldownSec", Label = "两次回复冷却(秒)", Kind = "num", Min = 0, Max = 3600 },
                new FieldSpec { Path = "group.maxRepliesPerMinute", Label = "每分钟最多回几条", Kind = "slider", Min = 5, Max = 30, Unit = " 条/分钟", Hint = "推荐 10–20 条" },
                new FieldSpec { Path = "group.masterAlwaysReply", Label = "主人在群里说话永远回", Kind = "bool" },
                new FieldSpec { Path = "group.engagedMinutes", Label = "接话后保持参与(分钟)", Kind = "num", Min = 1, Max = 1440 },
                new FieldSpec { Path = "group.silentMinutes", Label = "冷场多久算结束(分钟)", Kind = "num", Min = 1, Max = 10080 },
                new FieldSpec { Path = "group.muteDefaultMinutes", Label = "免打扰默认时长(分钟)", Kind = "num", Min = 1, Max = 1440 },
            }},
            new SectionSpec { Title = "微信 · 数据与管道", Fields =
            {
                new FieldSpec { Path = "wechat.dbDir", Label = "微信文件保存位置", Kind = "text", Hint = "留空 = 自动找；填到 xwechat_files 这一层" },
                new FieldSpec { Path = "wechat.staleAfterSec", Label = "多久没消息算去忙(秒)", Kind = "num", Min = 60, Max = 86400 },
                new FieldSpec { Path = "wechat.ignoreSenders", Label = "这些会话永不回复", Kind = "multiline", Hint = "一行一个（微信团队、订阅号…）" },
                new FieldSpec { Path = "wechat.pipelineWorkers", Label = "同时处理几个会话", Kind = "num", Min = 1, Max = 8 },
                new FieldSpec { Path = "wechat.pipelineQueueLimit", Label = "单个会话最多积压几条", Kind = "num", Min = 1, Max = 32, Hint = "超出就丢掉最早的一条；默认 8" },
            }},
            new SectionSpec { Title = "联网与链接", Fields =
            {
                new FieldSpec { Path = "websearch.enabled", Label = "联网搜索", Kind = "bool" },
                new FieldSpec { Path = "websearch.city", Label = "搜索城市", Kind = "text" },
                new FieldSpec { Path = "websearch.timeoutMs", Label = "搜索超时(毫秒)", Kind = "num", Min = 1000, Max = 30000 },
                new FieldSpec { Path = "links.enabled", Label = "解析聊天里的链接", Kind = "bool" },
                new FieldSpec { Path = "links.timeoutMs", Label = "链接超时(毫秒)", Kind = "num", Min = 1000, Max = 30000 },
                new FieldSpec { Path = "links.cacheMinutes", Label = "链接缓存(分钟)", Kind = "num", Min = 0, Max = 1440 },
            }},
            new SectionSpec { Title = "高级", Note = "改完要重启的项都在这里（对话预算和时区例外，改完立刻生效）。", Fields =
            {
                new FieldSpec { Path = "memory.dialogueBudget", Label = "对话预算(token)", Kind = "sliderInput", Min = 2000, Max = 20000, InputMin = 1000, Hint = "每轮带多少对话内容（不含人设）：默认 5,500。记忆和原文按比例分，预算越大带得越多；滑块 2,000–20,000，下面四个胶囊是一键跳档，右边输入框可以填到 1,000 以上。" },
                new FieldSpec { Path = "env.timezone", Label = "时区", Kind = "text", Hint = "IANA 时区，如 Asia/Shanghai；留空 = 系统时区。日记时间、主动搭话时间段、提醒、朋友圈夜间判断和聊天时间戳都按它算。" },
                new FieldSpec { Path = "server.host", Label = "监听地址", Kind = "text", Hint = "只建议 127.0.0.1；同 WiFi 访问只对桥接和接口有效，没有网页界面（改完重启）" },
                new FieldSpec { Path = "server.port", Label = "本机端口", Kind = "selectnum", Options = new[] { "8787", "9191", "1919", "7878" }, Hint = "默认 8787；只在这四个里选，改完重启内核生效" },
                new FieldSpec { Path = "log.level", Label = "日志级别", Kind = "select", Options = new[] { "debug", "info", "error" }, Hint = "界面 / 控制台用哪一档；日志文件始终记 debug 全量（data/whale.log、data/wechat-bridge-4x.log），改完重启生效" },
                new FieldSpec { Path = "storage.mediaKeepDays", Label = "媒体缓存保留几天", Kind = "num", Min = 0, Max = 90 },
                new FieldSpec { Path = "storage.mediaMaxMB", Label = "媒体缓存上限(MB)", Kind = "num", Min = 0, Max = 10000 },
            }},
        };

        private void BuildOnce()
        {
            SectionsHost.Children.Clear();

            AddSection(BuildModelSection());
            AddSection(BuildAdminSpellSection());
            AddSection(BuildAdvancedSection());
            AddSection(BuildAppearanceSection());
        }

        /// <summary>卡片直接按顺序堆进单列滚动区。</summary>
        private void AddSection(Border card)
        {
            card.Margin = new Thickness(0, 0, 0, 14);
            SectionsHost.Children.Add(card);
        }

        private Border BuildAdminSpellSection()
        {
            var card = Card("管理员魔咒", "主人在微信私聊发魔咒后，可在同一私聊发送「禁言 群名」或「解除禁言 群名」。默认有效 30 分钟。", out var body);
            _adminSpellStatus = new TextBlock { Style = (Style)FindResource("Small") };
            body.Children.Add(_adminSpellStatus);
            var password = new PasswordBox();
            body.Children.Add(Row("管理员口令", password, "设置后只显示是否已设置。", false, 150));
            body.Children.Add(BuildField(new FieldSpec { Path = "admin.minutes", Label = "有效期（分钟）", Kind = "num", Min = 1, Max = 1440 }));
            var actions = new WrapPanel { Margin = new Thickness(0, 8, 0, 0) };
            var save = new Button { Content = "保存魔咒", Style = (Style)FindResource("Ghost") };
            var clear = new Button { Content = "清除魔咒", Style = (Style)FindResource("Ghost") };
            save.Click += async (_, __) =>
            {
                var spell = password.Password.Trim();
                if (spell.Length == 0) return;
                if (await PatchAsync("admin.spell", spell))
                {
                    password.Clear();
                    _adminSpellStatus.Text = "已设置";
                }
            };
            clear.Click += async (_, __) =>
            {
                if (await PatchAsync("admin.spell", ""))
                {
                    password.Clear();
                    _adminSpellStatus.Text = "未设置";
                }
            };
            actions.Children.Add(save);
            actions.Children.Add(clear);
            body.Children.Add(actions);
            return card;
        }

        /// <summary>
        /// 高级模式：四个胶囊页签直接摆出来，点了才展开那一组；再点同一个页签收起。
        /// 没有「展开高级设置」这种中间按钮，少一次点击。
        /// </summary>
        private Border BuildAdvancedSection()
        {
            var card = Card("高级模式", "群聊、微信数据与管道、联网与链接、服务端口。平时不用动，点一下对应页签再改。", out var body);

            var strip = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 0) };
            body.Children.Add(strip);

            var specs = Specs();
            var tabs = new Button[specs.Count];
            var panels = new StackPanel[specs.Count];
            var active = -1;

            void Select(int idx)
            {
                if (active == idx)
                {
                    panels[idx].Visibility = Visibility.Collapsed;
                    MarkTab(tabs[idx], false);
                    active = -1;
                    return;
                }
                for (var i = 0; i < panels.Length; i++)
                {
                    panels[i].Visibility = i == idx ? Visibility.Visible : Visibility.Collapsed;
                    MarkTab(tabs[i], i == idx);
                }
                active = idx;
            }

            for (var i = 0; i < specs.Count; i++)
            {
                var spec = specs[i];
                var tab = MakeTab(spec.Title, out var _);
                var panel = new StackPanel { Visibility = Visibility.Collapsed, Margin = new Thickness(0, 12, 0, 0) };
                if (!string.IsNullOrEmpty(spec.Note))
                    panel.Children.Add(new TextBlock
                    {
                        Text = spec.Note,
                        Style = (Style)FindResource("Small"),
                        TextWrapping = TextWrapping.Wrap,
                        Margin = new Thickness(0, 0, 0, 8),
                    });
                foreach (var f in spec.Fields) panel.Children.Add(BuildField(f));
                // 高级 → 记忆：旧版（3.x）记忆的一键入账，放在「高级」这一组最后。
                // 启动时其实已经自动迁移，这里是给「服务已经在跑、用户又拖了一份 data 进来」补的入口。
                if (spec.Title == "高级") panel.Children.Add(BuildMemoryImportBlock());

                // 这一组「恢复默认」：只写回这个页签里的字段，默认值由内核给
                var foot = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
                var resetTab = new Button { Content = "这一组恢复默认", Style = (Style)FindResource("Ghost") };
                resetTab.Click += async (s, e) => await ResetFieldsAsync(spec.Title, spec.Fields.Select(f => f.Path));
                foot.Children.Add(resetTab);
                panel.Children.Add(foot);
                tabs[i] = tab;
                panels[i] = panel;
                strip.Children.Add(tab);
                body.Children.Add(panel);
                var idx = i;
                tab.Click += (s, e) => Select(idx);
            }

            return card;
        }

        // ── 外观：深浅色 + 背景图（只影响启动器）────────────────
        private Border BuildAppearanceSection()
        {
            var card = Card("外观", "只影响启动器界面：深浅色、背景图和它的模糊 / 透明效果。文字直接浮在背景上，自带反色描边；卡片和面板的遮罩可以拉到 0。不会写进 config.json，也不影响她的人设和聊天。", out var body);

            var dark = new CheckBox
            {
                Content = "深色模式（关掉就是浅色）",
                IsChecked = Appearance.IsDark,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center
            };
            dark.Click += (_, __) => Appearance.SetTheme(dark.IsChecked == true ? "dark" : "light");
            body.Children.Add(Row("主题", dark, "顶栏右上角的太阳 / 月亮也能快速切换"));

            var preview = new Border
            {
                Width = 216,
                Height = 116,
                CornerRadius = new CornerRadius(12),
                BorderThickness = new Thickness(1),
                ClipToBounds = true,
                HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 0, 0, 8)
            };
            preview.SetResourceReference(Border.BackgroundProperty, "Surface3");
            preview.SetResourceReference(Border.BorderBrushProperty, "CardBorder");
            var img = new Image { Stretch = Stretch.UniformToFill };
            var empty = new TextBlock
            {
                Text = "未设置背景图",
                Style = (Style)FindResource("Small"),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            var previewGrid = new Grid();
            previewGrid.Children.Add(img);
            previewGrid.Children.Add(empty);
            preview.Child = previewGrid;

            var pathText = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                TextWrapping = TextWrapping.Wrap,
                HorizontalAlignment = HorizontalAlignment.Left,
                MaxWidth = 560,
                Margin = new Thickness(0, 0, 0, 8)
            };
            var pick = new Button { Content = "选择图片…", Style = (Style)FindResource("Ghost") };
            var clear = new Button { Content = "清除背景", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };
            var actions = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Left };
            actions.Children.Add(pick);
            actions.Children.Add(clear);

            var hint = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 8, 0, 0)
            };

            var panel = new StackPanel();
            panel.Children.Add(preview);
            panel.Children.Add(pathText);
            panel.Children.Add(actions);
            panel.Children.Add(hint);
            body.Children.Add(Row("背景图片", panel,
                "支持 JPG / PNG / BMP。有图时顶栏、导航和卡片都会透出背景；文字自带反色柔光，亮图暗图都能看清。", true));

            var fit = new ComboBox { Width = 220, HorizontalAlignment = HorizontalAlignment.Left };
            fit.Items.Add("等比裁剪（铺满）");
            fit.Items.Add("拉伸铺满");
            fit.Items.Add("等比完整（留边）");
            fit.SelectedIndex = Appearance.BackdropFit switch { "stretch" => 1, "uniform" => 2, _ => 0 };
            fit.SelectionChanged += (_, __) =>
            {
                if (fit.SelectedIndex < 0) return;
                Appearance.SetBackdropFit(fit.SelectedIndex switch { 1 => "stretch", 2 => "uniform", _ => "fill" });
            };
            body.Children.Add(Row("背景填充", fit,
                "等比裁剪会裁掉多余边缘；拉伸会让画面变形；等比完整会在空出来的地方露出主题底色。", true));

            // 模糊 / 透明度滑块：值直接写进 launcher-ui.json，拖一下就能看到效果。
            var blurValue = ValueLabel();
            var blurSlider = new Slider
            {
                Style = (Style)FindResource("BudgetSlider"),
                Minimum = 0,
                Maximum = 60,
                Width = 300,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center,
            };
            blurSlider.Value = Appearance.BackdropBlur;
            blurValue.Text = Math.Round(Appearance.BackdropBlur) + " px";
            blurSlider.ValueChanged += (_, e) =>
            {
                var v = Math.Round(e.NewValue);
                blurValue.Text = v + " px";
                Appearance.SetBackdropBlur(v);
            };
            body.Children.Add(Row("背景模糊", SliderWithValue(blurSlider, blurValue),
                "0 = 清晰，60 = 最柔；只模糊背景图，文字和卡片保持锐利。", true));

            var opacityValue = ValueLabel();
            var opacitySlider = new Slider
            {
                Style = (Style)FindResource("BudgetSlider"),
                Minimum = 0,
                Maximum = 100,
                Width = 300,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center,
            };
            opacitySlider.Value = Math.Round((1 - Appearance.BackdropOpacity) * 100);
            opacityValue.Text = Math.Round(opacitySlider.Value) + "%";
            opacitySlider.ValueChanged += (_, e) =>
            {
                var v = Math.Round(e.NewValue);
                opacityValue.Text = v + "%";
                Appearance.SetBackdropOpacity(1 - v / 100.0);
            };
            body.Children.Add(Row("背景透明度", SliderWithValue(opacitySlider, opacityValue),
                "0% = 图片完全不透明，100% = 只看主题底色。图片越透明，底下的主题色越多。", true));

            var surfaceValue = ValueLabel();
            var surfaceSlider = new Slider
            {
                Style = (Style)FindResource("BudgetSlider"),
                Minimum = 0,
                Maximum = 100,
                Width = 300,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center,
            };
            surfaceSlider.Value = Math.Round(Appearance.SurfaceOpacity * 100);
            surfaceValue.Text = Math.Round(surfaceSlider.Value) + "%";
            surfaceSlider.ValueChanged += (_, e) =>
            {
                var v = Math.Round(e.NewValue);
                surfaceValue.Text = v + "%";
                Appearance.SetSurfaceOpacity(v / 100.0);
            };
            body.Children.Add(Row("面板不透明度", SliderWithValue(surfaceSlider, surfaceValue),
                "0% = 文字框完全透明，只留描边；100% = 更实的玻璃。文字自带描边，拉到 0 也能看清。", true));

            // ── 配色：莫奈取色 + 手动覆盖（顶栏固定，不参与）──
            var monetCheck = new CheckBox
            {
                Content = "从背景图自动取色（莫奈）",
                IsChecked = Appearance.MonetEnabled,
                VerticalAlignment = VerticalAlignment.Center,
            };
            monetCheck.Click += (_, __) => Appearance.SetMonet(monetCheck.IsChecked == true);
            var remonet = new Button { Content = "重新取色", Style = (Style)FindResource("Ghost"), Margin = new Thickness(10, 0, 0, 0) };
            remonet.Click += (_, __) => Appearance.RefreshMonet();
            var monetPanel = new WrapPanel();
            monetPanel.Children.Add(monetCheck);
            monetPanel.Children.Add(remonet);
            body.Children.Add(Row("莫奈取色", monetPanel,
                "从背景图挑主色生成主题色和低饱和遮罩色；下面手选的颜色优先。顶栏固定不参与。", true));

            body.Children.Add(Row("主题色", BuildColorRow("accent", "主题色"),
                "按钮、选中态和强调文字用的颜色。点「自动」就回到莫奈取色。", true));
            body.Children.Add(Row("遮罩色", BuildColorRow("tint", "遮罩色"),
                "压在背景图上的统一色调；觉得画面发灰时可以换一个颜色。", true));
            body.Children.Add(Row("文字色", BuildColorRow("text", "文字色"),
                "正文和说明文字的颜色；选完后注意和背景的明暗差。", true));

            var haloCheck = new CheckBox
            {
                Content = "文字描边（觉得发光可以关掉）",
                IsChecked = Appearance.TextHaloEnabled,
                VerticalAlignment = VerticalAlignment.Center,
            };
            haloCheck.Click += (_, __) => Appearance.SetTextHalo(haloCheck.IsChecked == true);
            body.Children.Add(Row("文字描边", haloCheck,
                "只在有背景图时生效；关掉后靠自定义文字色保证可读。", true));

            var resetPalette = new Button { Content = "恢复自动配色", Style = (Style)FindResource("Ghost") };
            resetPalette.Click += (_, __) => Appearance.ResetPalette();
            body.Children.Add(Row("配色重置", resetPalette,
                "主题色、遮罩色、文字色退回莫奈 / 主题默认，描边重新打开。", true));

            void Refresh()
            {
                dark.IsChecked = Appearance.IsDark;
                monetCheck.IsChecked = Appearance.MonetEnabled;
                haloCheck.IsChecked = Appearance.TextHaloEnabled;
                monetCheck.IsEnabled = Appearance.HasBackdrop;
                remonet.IsEnabled = Appearance.HasBackdrop;
                var bmp = Appearance.LoadBackdrop();
                img.Source = bmp;
                img.Opacity = Appearance.BackdropOpacity;
                if (bmp == null)
                {
                    img.Effect = null;
                }
                else
                {
                    // 复用同一个 BlurEffect：拖滑块时 Changed 会高频触发，别每次 new。
                    if (img.Effect is not BlurEffect blur)
                    {
                        blur = new BlurEffect { KernelType = KernelType.Gaussian, RenderingBias = RenderingBias.Performance };
                        img.Effect = blur;
                    }
                    blur.Radius = Appearance.BackdropBlur * 0.35;
                }
                img.Visibility = bmp == null ? Visibility.Collapsed : Visibility.Visible;
                empty.Visibility = bmp == null ? Visibility.Visible : Visibility.Collapsed;
                clear.IsEnabled = !string.IsNullOrEmpty(Appearance.Backdrop);
                blurSlider.IsEnabled = Appearance.HasBackdrop;
                opacitySlider.IsEnabled = Appearance.HasBackdrop;
                surfaceSlider.IsEnabled = Appearance.HasBackdrop;
                pathText.Text = string.IsNullOrEmpty(Appearance.Backdrop)
                    ? "当前使用纯色背景。"
                    : "当前：" + Appearance.Backdrop;
            }

            pick.Click += (_, __) =>
            {
                var dlg = new OpenFileDialog
                {
                    Title = "选择背景图片",
                    Filter = "图片文件|*.jpg;*.jpeg;*.png;*.bmp|所有文件|*.*",
                    CheckFileExists = true
                };
                if (dlg.ShowDialog() != true) return;
                if (Appearance.TrySetBackdrop(dlg.FileName, out var err))
                {
                    hint.Text = "已应用。";
                    hint.Foreground = (Brush)FindResource("Dim");
                }
                else
                {
                    hint.Text = err;
                    hint.Foreground = (Brush)FindResource("Bad");
                }
                Refresh();
            };

            clear.Click += (_, __) =>
            {
                Appearance.ClearBackdrop();
                hint.Text = "已恢复纯色背景。";
                hint.Foreground = (Brush)FindResource("Dim");
                Refresh();
            };

            Appearance.Changed += Refresh;
            Refresh();
            return card;
        }

        // ── 卡片与行 ────────────────────────────────────────────
        private Border Card(string title, string note, out StackPanel body)
        {
            var border = new Border
            {
                Style = (Style)FindResource("Card"),
                Padding = new Thickness(16, 14, 16, 14),
                Margin = new Thickness(0, 0, 0, 12)
            };
            var stack = new StackPanel();
            stack.Children.Add(new TextBlock { Text = title, Style = (Style)FindResource("H2") });
            if (!string.IsNullOrEmpty(note))
                stack.Children.Add(new TextBlock { Text = note, Style = (Style)FindResource("Small"), Margin = new Thickness(0, 6, 0, 0), TextWrapping = TextWrapping.Wrap });
            body = new StackPanel { Margin = new Thickness(0, 10, 0, 0) };
            stack.Children.Add(body);
            border.Child = stack;
            return border;
        }

        private TextBlock ValueLabel() => new TextBlock
        {
            Style = (Style)FindResource("Small"),
            MinWidth = 58,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(12, 0, 0, 0),
        };

        /// <summary>色块 + 当前色值 + 调色 / 自动。点「自动」清掉手选色，回到莫奈或主题默认。</summary>
        private FrameworkElement BuildColorRow(string kind, string label)
        {
            var swatch = new Border
            {
                Width = 38,
                Height = 22,
                CornerRadius = new CornerRadius(6),
                BorderThickness = new Thickness(1),
                VerticalAlignment = VerticalAlignment.Center,
            };
            swatch.SetResourceReference(Border.BorderBrushProperty, "CardBorder");
            var hex = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                VerticalAlignment = VerticalAlignment.Center,
                MinWidth = 76,
                Margin = new Thickness(8, 0, 0, 0),
            };
            var pick = new Button { Content = "调色…", Style = (Style)FindResource("Ghost"), Margin = new Thickness(10, 0, 0, 0) };
            var auto = new Button { Content = "自动", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };

            var row = new StackPanel { Orientation = Orientation.Horizontal };
            row.Children.Add(swatch);
            row.Children.Add(hex);
            row.Children.Add(pick);
            row.Children.Add(auto);

            bool IsCustom() => kind switch
            {
                "accent" => Appearance.AccentOverride.Length > 0,
                "tint" => Appearance.TintOverride.Length > 0,
                _ => Appearance.TextOverride.Length > 0,
            };

            void RefreshSwatch()
            {
                var c = Appearance.EffectiveColor(kind);
                swatch.Background = new SolidColorBrush(c);
                hex.Text = Appearance.ToHex(c);
                auto.IsEnabled = IsCustom();
            }

            pick.Click += (_, __) =>
            {
                var dlg = new ColorPickerWindow(label, Appearance.EffectiveColor(kind), (Style)FindResource("BudgetSlider"))
                {
                    Owner = Window.GetWindow(this),
                };
                if (dlg.ShowDialog() == true)
                    Appearance.SetPaletteColor(kind, Appearance.ToHex(dlg.SelectedColor));
            };
            auto.Click += (_, __) => Appearance.ClearPaletteColor(kind);
            Appearance.Changed += RefreshSwatch;
            RefreshSwatch();
            return row;
        }

        private static StackPanel SliderWithValue(Slider slider, TextBlock value)
        {
            var panel = new StackPanel { Orientation = Orientation.Horizontal };
            panel.Children.Add(slider);
            panel.Children.Add(value);
            return panel;
        }

        private Grid Row(string label, FrameworkElement control, string hint, bool top = false, double labelWidth = 150)
        {
            var grid = new Grid { Margin = new Thickness(0, 0, 0, 8) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(labelWidth) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.Children.Add(new TextBlock
            {
                Text = label,
                Style = (Style)FindResource("Label"),
                VerticalAlignment = top ? VerticalAlignment.Top : VerticalAlignment.Center,
                Margin = top ? new Thickness(0, 2, 0, 0) : new Thickness(0),
                TextWrapping = TextWrapping.Wrap
            });
            var right = new StackPanel { HorizontalAlignment = HorizontalAlignment.Stretch };
            right.Children.Add(control);
            if (!string.IsNullOrEmpty(hint))
                right.Children.Add(new TextBlock { Text = hint, Style = (Style)FindResource("Small"), Margin = new Thickness(0, 3, 0, 0), TextWrapping = TextWrapping.Wrap });
            Grid.SetColumn(right, 1);
            grid.Children.Add(right);
            return grid;
        }

        /// <summary>
        /// 高级 → 记忆：识别并转换 3.x 旧记忆（data\store.json / memory.json / 旧备份包）。
        /// 走内核的 /api/memory/import，已导入过的签名会跳过，所以反复点也不会重复。
        /// </summary>
        private FrameworkElement BuildMemoryImportBlock()
        {
            var box = new StackPanel { Margin = new Thickness(0, 14, 0, 0) };
            var divider = new Border { Height = 1, Margin = new Thickness(0, 0, 0, 12) };
            divider.SetResourceReference(Border.BackgroundProperty, "Line");
            box.Children.Add(divider);
            box.Children.Add(new TextBlock { Text = "旧版记忆（3.x）", Style = (Style)FindResource("Label") });

            var hint = new TextBlock
            {
                Text = "3.x 的 data\\store.json（含 .journal）/ memory.json / 旧备份包会转成现在的格式；"
                     + "同名聊天按时间合并，已经转过的不会重复导入。启动时也会自动检查一次。",
                Style = (Style)FindResource("Small"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 4, 0, 8),
            };
            box.Children.Add(hint);

            var btn = new Button
            {
                Content = "一键识别转换记忆",
                Style = (Style)FindResource("Ghost"),
                HorizontalAlignment = HorizontalAlignment.Left,
            };
            var result = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 6, 0, 0),
            };
            box.Children.Add(btn);
            box.Children.Add(result);

            btn.Click += async (s, e) =>
            {
                if (!_sup.NodeRunning)
                {
                    result.Text = "内核没在运行，先启动鲸鲸再试。";
                    return;
                }
                btn.IsEnabled = false;
                var original = btn.Content;
                btn.Content = "正在检查…";
                try
                {
                    var status = await Api.Get(_sup.Url, "/api/memory/import/status");
                    if (!status.Ok)
                    {
                        result.Text = "检查失败：" + Api.Message(status);
                        return;
                    }
                    if (!status.Bool("pending"))
                    {
                        result.Text = "没有发现待转换的旧版记忆（data 里没有 store.json / memory.json，或已经转过了）。";
                        return;
                    }
                    var plan = status.Prop("plan");
                    var imported = NestedLong(plan, "imported");
                    var merged = NestedLong(plan, "merged");
                    var messages = NestedLong(plan, "messages");
                    var notes = NestedLong(plan, "notes");
                    if (!AppDialog.Confirm(
                        Window.GetWindow(this),
                        "发现旧版记忆：\n\n"
                        + "· 新增 " + imported + " 个聊天\n"
                        + "· 合并 " + merged + " 个已有聊天\n"
                        + "· 补进 " + messages + " 条消息 / " + notes + " 条偏好\n\n"
                        + "开始转换吗？原文件会保留，转换前也会自动备份当前记忆。",
                        "转换旧版记忆", okText: "开始转换"))
                    {
                        result.Text = "已取消，什么都没改。";
                        return;
                    }

                    btn.Content = "正在转换…";
                    var res = await Api.Post(_sup.Url, "/api/memory/import", "{}");
                    if (!res.Ok)
                    {
                        result.Text = "转换失败：" + Api.Message(res);
                        return;
                    }
                    if (res.Bool("idle"))
                    {
                        result.Text = "没有需要转换的旧记忆。";
                        return;
                    }
                    result.Text = "完成：新增 " + res.Long("imported") + " 个聊天、合并 " + res.Long("merged")
                        + " 个，补进 " + res.Long("messages") + " 条消息 / " + res.Long("notes") + " 条偏好。";
                    AppDialog.Show(
                        Window.GetWindow(this),
                        "记忆已导入并转换格式。\n\n" + result.Text + "\n\n原文件保留在 data\\memory\\legacy\\。",
                        "记忆已导入");
                    await Api.Post(_sup.Url, "/api/memory/import/ack", "{}");
                }
                catch (Exception ex)
                {
                    result.Text = "出错：" + ex.Message;
                }
                finally
                {
                    btn.Content = original;
                    btn.IsEnabled = true;
                }
            };
            return box;
        }

        private static long NestedLong(JsonElement el, string name)
        {
            if (el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v)
                && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) return n;
            return 0;
        }

        // ── 单个字段 ────────────────────────────────────────────
        /// <param name="compact">两列并排时用的紧凑标签列</param>
        /// <param name="width">单独指定标签列宽（不传就按 compact 取默认值）</param>
        private FrameworkElement BuildField(FieldSpec f, bool compact = false, double width = double.NaN)
        {
            // 标签列别太宽：210 的时候标签和输入框中间空出半个屏幕，短标签尤其难看
            var labelWidth = !double.IsNaN(width) ? width : (compact ? 110.0 : 150.0);
            switch (f.Kind)
            {
                case "bool":
                {
                    var chk = new CheckBox { VerticalAlignment = VerticalAlignment.Center };
                    chk.Click += async (s, e) =>
                    {
                        if (_loading) return;
                        await PatchAsync(f.Path, ((CheckBox)s).IsChecked == true);
                    };
                    _loaders[f.Path] = v => { if (chk.IsKeyboardFocusWithin) return; _loading = true; chk.IsChecked = v.ValueKind == JsonValueKind.True; _loading = false; };
                    return Row(f.Label, chk, f.Hint, false, labelWidth);
                }
                case "select":
                {
                    var cmb = new ComboBox { Height = 26, ItemsSource = f.Options, MinWidth = 140, HorizontalAlignment = HorizontalAlignment.Left };
                    cmb.SelectionChanged += async (s, e) =>
                    {
                        if (_loading || cmb.SelectedItem == null) return;
                        await PatchAsync(f.Path, (string)cmb.SelectedItem);
                    };
                    _loaders[f.Path] = v =>
                    {
                        if (cmb.IsKeyboardFocusWithin) return;   // 正在编辑就不覆盖（M30）
                        _loading = true;
                        cmb.SelectedItem = v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                        _loading = false;
                    };
                    return Row(f.Label, cmb, f.Hint, false, labelWidth);
                }
                case "selectnum":
                {
                    // 端口这类「只能从固定几项里挑」的数字：下拉显示，写回仍是数字
                    var cmb = new ComboBox { Height = 26, ItemsSource = f.Options, MinWidth = 140, HorizontalAlignment = HorizontalAlignment.Left };
                    cmb.SelectionChanged += async (s, e) =>
                    {
                        if (_loading || cmb.SelectedItem == null) return;
                        if (int.TryParse((string)cmb.SelectedItem, out var port))
                            await PatchAsync(f.Path, port);
                    };
                    _loaders[f.Path] = v =>
                    {
                        if (cmb.IsKeyboardFocusWithin) return;
                        _loading = true;
                        var cur = v.ValueKind == JsonValueKind.Number ? v.GetInt32().ToString()
                            : (v.ValueKind == JsonValueKind.String ? v.GetString() : null);
                        if (cur != null && (f.Options ?? new string[0]).Contains(cur)) cmb.SelectedItem = cur;
                        _loading = false;
                    };
                    return Row(f.Label, cmb, f.Hint, false, labelWidth);
                }
                case "secret":
                {
                    var pwd = new PasswordBox();
                    var secret = new ConfigurationSecretState();
                    var clearing = false;
                    var generation = _pageLifetime.Capture();
                    var saves = new ConfigurationSaveState<ConfigurationSecretSnapshot>(
                        () => { generation = _pageLifetime.Capture(); return secret.Capture(pwd.Password); },
                        build => PatchResultAsync(f.Path, () => build().Value.Trim(), true),
                        (snapshot, result) =>
                        {
                            if (!_pageLifetime.IsCurrent(generation) || !result.Ok || !secret.IsCurrent(snapshot, pwd.Password)) return;
                            clearing = true;
                            try { pwd.Password = ""; }
                            finally { clearing = false; }
                        });
                    pwd.PasswordChanged += (s, e) =>
                    {
                        secret.Changed();
                        if (_loading || clearing) return;
                        _configurationRevision++;
                        saves.MarkDesired();
                    };
                    pwd.LostFocus += async (s, e) =>
                    {
                        if (_loading || pwd.Password.Length == 0) return;
                        await saves.SaveAsync();
                    };
                    return Row(f.Label, pwd, f.Hint, false, labelWidth);
                }
                case "multiline":
                {
                    var box = new TextBox { AcceptsReturn = true, MinHeight = 56, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
                    box.LostFocus += async (s, e) =>
                    {
                        if (_loading) return;
                        var lines = (box.Text ?? "").Split('\n').Select(x => x.Trim()).Where(x => x.Length > 0).ToArray();
                        await PatchAsync(f.Path, lines);
                    };
                    _loaders[f.Path] = v =>
                    {
                        if (box.IsKeyboardFocusWithin) return;   // 正在编辑就不覆盖（M30）
                        _loading = true;
                        box.Text = v.ValueKind == JsonValueKind.Array
                            ? string.Join("\n", v.EnumerateArray().Select(x => x.ToString()))
                            : (v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "");
                        _loading = false;
                    };
                    return Row(f.Label, box, f.Hint, false, labelWidth);
                }
                case "num":
                {
                    TextBox box;
                    if (f.IsInt)
                    {
                        var min = double.IsNaN(f.Min) ? int.MinValue : (int)Math.Ceiling(f.Min);
                        var max = double.IsNaN(f.Max) ? int.MaxValue : (int)Math.Floor(f.Max);
                        box = new NumberField
                        {
                            Width = 120,
                            HorizontalAlignment = HorizontalAlignment.Left,
                            Minimum = min,
                            Maximum = max,
                            EmptyUsesFallback = false,
                            Label = f.Label
                        };
                    }
                    else
                    {
                        box = new TextBox { Width = 120, HorizontalAlignment = HorizontalAlignment.Left };
                    }
                    box.LostFocus += async (s, e) =>
                    {
                        if (_loading) return;
                        if (box is NumberField number)
                        {
                            if (!number.TryRead(out var n))
                            {
                                StatusText.Text = number.ErrorText;
                                return;
                            }
                            number.Text = n.ToString();
                            await PatchAsync(f.Path, n);
                            return;
                        }
                        var text = (box.Text ?? "").Trim();
                        if (!double.TryParse(text, out var v) || !double.IsFinite(v))
                        {
                            StatusText.Text = f.Label + "：要填数字";
                            return;
                        }
                        // 以前越界会静默改成边界值，用户以为自己的输入生效了；现在直接说清楚。
                        if (!double.IsNaN(f.Min) && v < f.Min) { StatusText.Text = f.Label + " 不能小于 " + f.Min; return; }
                        if (!double.IsNaN(f.Max) && v > f.Max) { StatusText.Text = f.Label + " 不能大于 " + f.Max; return; }
                        await PatchAsync(f.Path, v);
                    };
                    _loaders[f.Path] = v =>
                    {
                        if (box.IsKeyboardFocusWithin) return;   // 正在编辑就不覆盖（M30）
                        _loading = true;
                        box.Text = v.ValueKind == JsonValueKind.Number
                            ? (f.IsInt ? Math.Round(v.GetDouble()).ToString() : v.GetDouble().ToString("0.###"))
                            : "";
                        _loading = false;
                    };
                    return Row(f.Label, box, f.Hint, false, labelWidth);
                }
                case "slider":
                {
                    // 拖动条：拖动时只更新右侧读数，停手 450ms 才写回（避免拖一次发几十个 PATCH）
                    var slider = new Slider
                    {
                        Minimum = double.IsNaN(f.Min) ? 0 : f.Min,
                        Maximum = double.IsNaN(f.Max) ? 100 : f.Max,
                        TickFrequency = 1,
                        IsSnapToTickEnabled = true,
                        Width = 220,
                        VerticalAlignment = VerticalAlignment.Center
                    };
                    var readout = new TextBlock
                    {
                        Style = (Style)FindResource("Small"),
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(12, 0, 0, 0)
                    };
                    var debounce = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(450) };
                    debounce.Tick += async (s, e) =>
                    {
                        debounce.Stop();
                        if (_loading) return;
                        await PatchAsync(f.Path, Math.Round(slider.Value));
                    };
                    void ShowValue() => readout.Text = Math.Round(slider.Value) + (f.Unit ?? "");
                    slider.ValueChanged += (s, e) =>
                    {
                        ShowValue();
                        if (_loading) return;
                        debounce.Stop();
                        debounce.Start();
                    };
                    _loaders[f.Path] = v =>
                    {
                        _loading = true;
                        if (v.ValueKind == JsonValueKind.Number)
                        {
                            var n = v.GetDouble();
                            if (!double.IsNaN(f.Min)) n = Math.Max(f.Min, n);
                            if (!double.IsNaN(f.Max)) n = Math.Min(f.Max, n);
                            slider.Value = Math.Round(n);
                        }
                        _loading = false;
                        ShowValue();
                    };
                    var panel = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Left };
                    panel.Children.Add(slider);
                    panel.Children.Add(readout);
                    return Row(f.Label, panel, f.Hint, false, labelWidth);
                }
                case "sliderInput":
                {
                    // 滑块管「常用范围」，右边输入框管「精确值 / 超出滑块范围的值」；
                    // 下面那行说明由 /api/budget/estimate 实时算（只读估算，不联网、不花钱）。
                    // 滑轨按真实比例画 4 个档位刻度（2,000 / 5,500 / 10,000 / 20,000 并不等距），
                    // 下面再给 4 个一键跳档的胶囊；拖到档位 ±5% 以内时对应胶囊高亮。
                    const double sliderWidth = 420;
                    var tiers = new[]
                    {
                        (Name: "极简", Value: 2000d), (Name: "默认", Value: 5500d),
                        (Name: "标准", Value: 10000d), (Name: "重度", Value: 20000d),
                    };
                    var slider = new Slider
                    {
                        Minimum = double.IsNaN(f.Min) ? 0 : f.Min,
                        Maximum = double.IsNaN(f.Max) ? 100 : f.Max,
                        TickFrequency = 100,
                        IsSnapToTickEnabled = true,
                        Width = sliderWidth,
                        VerticalAlignment = VerticalAlignment.Center,
                        Style = (Style)FindResource("BudgetSlider"),
                    };
                    var tickLayer = new Canvas { Width = sliderWidth, Height = 24, IsHitTestVisible = false };
                    foreach (var tier in tiers)
                    {
                        var ratio = (tier.Value - slider.Minimum) / Math.Max(1, slider.Maximum - slider.Minimum);
                        var tick = new System.Windows.Shapes.Rectangle
                        {
                            Width = 2,
                            Height = 10,
                            Fill = (Brush)FindResource("Muted"),
                            Opacity = 0.45,
                        };
                        Canvas.SetLeft(tick, 7 + ratio * (sliderWidth - 14) - 1);
                        Canvas.SetTop(tick, 8);
                        tickLayer.Children.Add(tick);
                    }
                    var trackGrid = new Grid { Width = sliderWidth, Height = 24, VerticalAlignment = VerticalAlignment.Center };
                    trackGrid.Children.Add(slider);
                    trackGrid.Children.Add(tickLayer);
                    var pillMap = new List<(Border Box, TextBlock Label, double Value)>();
                    var box = new TextBox
                    {
                        Width = 96,
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(12, 0, 0, 0),
                        TextAlignment = TextAlignment.Center
                    };
                    var unit = new TextBlock
                    {
                        Text = string.IsNullOrEmpty(f.Unit) ? " token" : f.Unit,
                        Style = (Style)FindResource("Small"),
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(6, 0, 0, 0)
                    };
                    var line = new TextBlock
                    {
                        Style = (Style)FindResource("Small"),
                        TextWrapping = TextWrapping.Wrap,
                        Margin = new Thickness(0, 6, 0, 0),
                        Text = f.Hint,
                    };
                    var bar = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Left };
                    bar.Children.Add(trackGrid);
                    bar.Children.Add(box);
                    bar.Children.Add(unit);

                    // 计时器要先声明：下面的胶囊和 Show/Schedule 都会捕获它们
                    var saveTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(450) };
                    var hintTimer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(180) };
                    var syncing = false;
                    var hintOperation = new PageOperation(_pageLifetime);
                    var saveGeneration = _pageLifetime.Capture();
                    ConfigurationSaveState<double> saves = null;
                    saves = new ConfigurationSaveState<double>(() => { saveGeneration = _pageLifetime.Capture(); return Current(); },
                        build => PatchResultAsync(f.Path, () => build()),
                        (snapshot, result) =>
                        {
                            if (result.Ok && saves.HasPendingChanges && _pageLifetime.IsCurrent(saveGeneration))
                                StatusText.Text = f.Path + " 正在保存新的修改…";
                        });
                    _refreshBudgetHints.Add(() =>
                    {
                        hintOperation.Invalidate();
                        hintTimer.Stop();
                        hintTimer.Start();
                    });

                    // 四档快捷按钮：点一下跳到该档，滑块照旧可以拖任意值
                    var pills = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 6, 0, 0) };
                    foreach (var tier in tiers)
                    {
                        var caption = new TextBlock
                        {
                            Text = tier.Name + " " + tier.Value.ToString("N0"),
                            FontSize = 11.5,
                            VerticalAlignment = VerticalAlignment.Center,
                        };
                        var pill = new Border
                        {
                            CornerRadius = new CornerRadius(12),
                            BorderThickness = new Thickness(1),
                            Padding = new Thickness(10, 0, 10, 0),
                            Height = 24,
                            Margin = new Thickness(0, 0, 6, 0),
                            Cursor = System.Windows.Input.Cursors.Hand,
                            Background = Brushes.Transparent,
                            BorderBrush = (Brush)FindResource("Line"),
                            Child = caption,
                        };
                        var jumpTo = tier.Value;
                        pill.MouseLeftButtonUp += (s, e) =>
                        {
                            if (_loading) return;
                            Show(jumpTo);
                            Schedule(true);
                        };
                        pills.Children.Add(pill);
                        pillMap.Add((pill, caption, jumpTo));
                    }

                    var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Stretch };
                    stack.Children.Add(bar);
                    stack.Children.Add(pills);
                    stack.Children.Add(line);

                    double Clamp(double v)
                    {
                        if (!double.IsNaN(f.InputMin)) v = Math.Max(f.InputMin, v);
                        if (!double.IsNaN(f.InputMax)) v = Math.Min(f.InputMax, v);
                        return Math.Round(v);
                    }

                    double Current()
                    {
                        var text = (box.Text ?? "").Trim();
                        return double.TryParse(text, out var v) ? Clamp(v) : Math.Round(slider.Value);
                    }

                    void PaintPills(double v)
                    {
                        foreach (var pill in pillMap)
                        {
                            // ±5% 以内算「就是这一档」，拖到别处就四个都不亮，避免错觉
                            var active = Math.Abs(v - pill.Value) <= Math.Max(150, pill.Value * 0.05);
                            pill.Box.Background = active ? (Brush)FindResource("AccentDim") : Brushes.Transparent;
                            pill.Box.BorderBrush = active ? (Brush)FindResource("Accent") : (Brush)FindResource("Line");
                            pill.Label.Foreground = active ? (Brush)FindResource("Text") : (Brush)FindResource("Text2");
                        }
                    }

                    void Show(double v)
                    {
                        syncing = true;
                        slider.Value = Math.Max(slider.Minimum, Math.Min(slider.Maximum, v));
                        if (!box.IsKeyboardFocusWithin) box.Text = Math.Round(v).ToString();
                        syncing = false;
                        PaintPills(Math.Round(v));
                    }

                    async void RefreshHint(double v)
                    {
                        var ticket = hintOperation.Begin();
                        try
                        {
                            var res = await Api.Get(_sup.Url, "/api/budget/estimate?dialogueBudget=" + Math.Round(v));
                            if (!hintOperation.IsCurrent(ticket)) return;
                            if (!res.Ok)
                            {
                                line.Text = f.Hint;
                                return;
                            }
                            var sys = res.Long("systemTokens");
                            var maxIn = res.Long("maxInputTokens");
                            var hard = res.Long("hardTotalTokens");
                            var room = Math.Max(0, hard - sys);
                            var over = res.Bool("overHardLimit");
                            // 只分三类：人设 / 记忆 / 对话（记忆 = 人物卡+摘要，对话 = 原文+余量）
                            var mem = (long)Num(res.Root, "split", "memory");
                            var dlg = (long)Num(res.Root, "split", "dialogue");
                            var first = Num(res.Prop("cost"), "idle", "first");
                            var steady = Num(res.Prop("cost"), "idle", "cached");
                            var hitRate = Num(res.Prop("cache"), "hitRate");
                            line.Text =
                                $"人设 {sys:N0} · 记忆 {mem:N0} · 对话 {dlg:N0} → 单轮最多 ≈ {maxIn:N0}（上限 {hard:N0}）\n"
                                + $"稳定期约 ¥{steady:0.0000} / 次（缓存命中 ≈{hitRate * 100:0}%，首轮 ¥{first:0.0000}）"
                                + (over ? $"\n⚠ 超过 {hard:N0} 上限：这个预算下每轮都会被拒绝，最多只能填 {room:N0}" : "");
                        }
                        catch
                        {
                            if (hintOperation.IsCurrent(ticket)) line.Text = f.Hint;
                        }
                    }

                    void Schedule(bool refreshHint)
                    {
                        if (_loading) return;
                        _configurationRevision++;
                        saves.MarkDesired();
                        hintOperation.Invalidate();
                        saveTimer.Stop();
                        saveTimer.Start();
                        if (!refreshHint) return;
                        hintTimer.Stop();
                        hintTimer.Start();
                    }

                    slider.ValueChanged += (s, e) =>
                    {
                        // 注意：这里要顺手刷胶囊高亮。以前只有 Show() 刷，
                        // 结果是「拖着滑块走，下面四个胶囊一直不亮」。
                        PaintPills(Math.Round(slider.Value));
                        if (syncing || _loading) return;
                        box.Text = Math.Round(slider.Value).ToString();
                        Schedule(true);
                    };

                    box.LostFocus += (s, e) =>
                    {
                        if (syncing || _loading) return;
                        var v = Current();
                        Show(v);
                        Schedule(true);
                    };
                    box.TextChanged += (s, e) =>
                    {
                        if (syncing || _loading || !box.IsKeyboardFocusWithin) return;
                        _configurationRevision++;
                        saves.MarkDesired();
                        hintOperation.Invalidate();
                    };
                    box.KeyDown += (s, e) =>
                    {
                        if (e.Key == System.Windows.Input.Key.Enter) System.Windows.Input.Keyboard.ClearFocus();
                    };

                    saveTimer.Tick += async (s, e) =>
                    {
                        saveTimer.Stop();
                        await saves.SaveAsync();
                    };

                    hintTimer.Tick += (s, e) =>
                    {
                        hintTimer.Stop();
                        RefreshHint(Current());
                    };

                    _loaders[f.Path] = v =>
                    {
                        if (box.IsKeyboardFocusWithin || saves.HasPendingChanges) return;
                        _loading = true;
                        if (v.ValueKind == JsonValueKind.Number)
                        {
                            var n = v.GetDouble();
                            Show(n);
                            saves.Initialize(Math.Round(n));
                        }
                        _loading = false;
                        RefreshHint(Current());
                    };

                    // 三行（滑轨 / 胶囊 / 说明）在上面，标签贴顶才不会落到胶囊那一行
                    return Row(f.Label, stack, "", true, labelWidth);
                }
                default:
                {
                    var box = new TextBox();
                    box.LostFocus += async (s, e) =>
                    {
                        if (_loading) return;
                        await PatchAsync(f.Path, (box.Text ?? "").Trim());
                    };
                    _loaders[f.Path] = v =>
                    {
                        if (box.IsKeyboardFocusWithin) return;   // 正在编辑就不覆盖（M30）
                        _loading = true;
                        box.Text = v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "")
                            : (v.ValueKind == JsonValueKind.Array ? string.Join(",", v.EnumerateArray().Select(x => x.ToString())) : "");
                        _loading = false;
                    };
                    return Row(f.Label, box, f.Hint, false, labelWidth);
                }
            }
        }

        /// <summary>按路径从 JSON 里取数字（拿不到就 0），给估算回包的嵌套字段用。</summary>
        private static double Num(JsonElement root, params string[] path)
        {
            var cur = root;
            foreach (var p in path)
            {
                if (cur.ValueKind != JsonValueKind.Object || !cur.TryGetProperty(p, out var next)) return 0;
                cur = next;
            }
            return cur.ValueKind == JsonValueKind.Number ? cur.GetDouble() : 0;
        }

        private async Task<bool> PatchAsync(string path, object value)
        {
            var res = await PatchResultAsync(path, () => value);
            return res.Ok;
        }

        private async Task<ApiResult> PatchResultAsync(string path, Func<object> build, bool secret = false)
        {
            _configurationRevision++;
            var generation = _pageLifetime.Capture();
            var res = secret ? await _saver.SaveSecretAsync(path, () => (string)build())
                : await _saver.SaveAsync(() => new Dictionary<string, object> { [path] = build() });
            if (_pageLifetime.IsCurrent(generation))
                StatusText.Text = res.Ok
                    ? path + " 已保存 " + DateTime.Now.ToString("HH:mm:ss")
                    : path + " 保存失败：" + Api.Message(res);
            return res;
        }

        private sealed class ModelSaveSnapshot
        {
            public object Body;
            public ConfigurationSecretSnapshot Secret;
            public long PageGeneration;
        }

        /// <summary>
        /// 「恢复默认」：把这些字段写回默认值。
        /// 默认值由内核按 DEFAULT_CONFIG 给（启动器不自己抄一份，抄的那份迟早和 config.js 对不上）。
        /// 只动这些字段：API Key 不重置，data\ 里的聊天记忆更不会碰。
        /// </summary>
        private async Task ResetFieldsAsync(string title, IEnumerable<string> paths)
        {
            var list = (paths ?? Enumerable.Empty<string>())
                .Where(p => !string.IsNullOrWhiteSpace(p))
                .Distinct()
                .ToList();
            if (list.Count == 0) return;

            if (!AppDialog.Confirm(
                Window.GetWindow(this),
                "把「" + title + "」改回默认值？\n\n只改这 " + list.Count + " 项；API Key 和聊天记忆不会被清掉。",
                "恢复默认", okText: "恢复默认"))
                return;

            var res = await _sup.SaveConfigurationAsync("/api/config/reset", new { paths = list });
            if (!res.Ok)
            {
                StatusText.Text = "恢复默认失败：" + Api.Message(res);
                return;
            }

            var unknown = res.Prop("unknown");
            var missed = unknown.ValueKind == JsonValueKind.Array ? unknown.GetArrayLength() : 0;
            StatusText.Text = "「" + title + "」已恢复默认（" + list.Count + " 项）"
                + (missed > 0 ? "，其中 " + missed + " 项不是可恢复项" : "");
            _lastLoad = DateTime.MinValue;   // 绕过节流，立刻把默认值刷回表单
            await LoadConfigAsync();
        }

        // ── 模型 / 看图（一张卡，两组用页签切换）────────────────────
        /// <summary>模型卡片里的标签都短，标签列收到 110 就够；再宽就是白条。</summary>
        private const double ModelLabel = 110;

        private Button MakeTab(string text, out TextBlock badge)
        {
            badge = new TextBlock { FontSize = 10, Margin = new Thickness(6, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            badge.SetResourceReference(TextBlock.ForegroundProperty, "Dim");
            var stack = new StackPanel { Orientation = Orientation.Horizontal };
            stack.Children.Add(new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center });
            stack.Children.Add(badge);
            return new Button
            {
                Height = 30,
                Padding = new Thickness(12, 0, 12, 0),
                Margin = new Thickness(0, 0, 6, 0),
                BorderThickness = new Thickness(1),
                Cursor = System.Windows.Input.Cursors.Hand,
                FocusVisualStyle = null,
                Content = stack,
                Style = (Style)FindResource("Ghost"),
            };
        }

        private static void MarkTab(Button btn, bool active)
        {
            btn.SetResourceReference(Button.BackgroundProperty, active ? "AccentSoft" : "Transparent");
            btn.SetResourceReference(Button.BorderBrushProperty, active ? "Accent" : "Line");
            btn.SetResourceReference(Button.ForegroundProperty, active ? "Accent" : "Muted");
            btn.FontWeight = active ? FontWeights.SemiBold : FontWeights.Normal;
        }

        /// <summary>
        /// 两列并排；right 为空时只占左半列。
        /// 左列定宽而不是各占一半：字段本身只有一百多像素宽，平均分两半会让右列
        /// 孤零零飘在卡片正中间，左边空出一大块（4.0 的采样区就是这样）。
        /// </summary>
        private static FrameworkElement TwoCol(FrameworkElement left, FrameworkElement right)
        {
            var g = new Grid();
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(330) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.Children.Add(left);
            if (right != null)
            {
                Grid.SetColumn(right, 2);
                g.Children.Add(right);
            }
            return g;
        }

        private Border BuildModelSection()
        {
            var card = Card("模型", "聊天、看图、语音分三页签。聊天模型自己能看图时，看图模型自动跟随；手动指定过就以手动为准；看图也可以选「自定义」，接口地址和模型都自己填（能一键从聊天复制）。", out var body);

            var chatTab = MakeTab("聊天（文本）", out var chatBadge);
            var visionTab = MakeTab("看图（视觉）", out var visionBadge);
            var voiceTab = MakeTab("语音（识别）", out var voiceBadge);
            var strip = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 14) };
            strip.Children.Add(chatTab);
            strip.Children.Add(visionTab);
            strip.Children.Add(voiceTab);
            body.Children.Add(strip);

            var chatPanel = new StackPanel();
            var visionPanel = new StackPanel { Visibility = Visibility.Collapsed };
            var voicePanel = new StackPanel { Visibility = Visibility.Collapsed };
            body.Children.Add(chatPanel);
            body.Children.Add(visionPanel);
            body.Children.Add(voicePanel);

            var tabs = new[] { chatTab, visionTab, voiceTab };
            var panels = new[] { chatPanel, visionPanel, voicePanel };
            void SelectTab(int idx)
            {
                for (var i = 0; i < panels.Length; i++)
                {
                    panels[i].Visibility = i == idx ? Visibility.Visible : Visibility.Collapsed;
                    MarkTab(tabs[i], i == idx);
                }
            }
            chatTab.Click += (s, e) => SelectTab(0);
            visionTab.Click += (s, e) => SelectTab(1);
            voiceTab.Click += (s, e) => SelectTab(2);
            SelectTab(0);

            // 两组控件先都建出来：换聊天模型时要同步刷新看图的提示和角标
            var suppressAuto = false;           // 程序化改控件时别触发自动保存
            ConfigurationSaveState<ModelSaveSnapshot> chatSaves = null;
            ConfigurationSaveState<ModelSaveSnapshot> visionSaves = null;
            var chatSecret = new ConfigurationSecretState();
            var visionSecret = new ConfigurationSecretState();
            var cmb = new ComboBox { Height = 28, DisplayMemberPath = "Label", MinWidth = 320, HorizontalAlignment = HorizontalAlignment.Left };
            var baseUrl = new TextBox();
            var model = new ComboBox { Height = 28, IsEditable = true, MinWidth = 320, HorizontalAlignment = HorizontalAlignment.Left };
            var key = new PasswordBox();
            // 深度思考：和 /api/settings 共用 data/settings.json 的 thinking（保存走 ModelRequest）。
            // 只在这里声明，Click 处理器等 AutoSaveChatAsync 定义好之后再挂（否则编译器会报
            // 「未赋值的局部变量」——那个函数捕获了后面才声明的控件）。
            var thinking = new CheckBox { VerticalAlignment = VerticalAlignment.Center };
            var chatResult = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };

            // 看图：和聊天页一样的「服务商 + 模型」两个下拉。
            // 服务商第一项是「自动跟随聊天模型」（默认），最后一项是「自定义」：
            // 选了自定义就自己填接口地址和模型名（中转站、自建视觉服务、同服务商换路径都能用），
            // 还可以一键「从聊天复制」把聊天那套地址/模型抄过来。
            var visionProviders = new List<ProviderItem>();
            var visionProvider = new ComboBox { Height = 28, DisplayMemberPath = "Label", MinWidth = 320, HorizontalAlignment = HorizontalAlignment.Left };
            // 预设服务商时只能从下拉里选（选项跟聊天模型同一份）；
            // 只有「自定义」才切成可编辑，好让用户填预设里没有的模型名
            var visionModel = new ComboBox { Height = 28, MinWidth = 320, HorizontalAlignment = HorizontalAlignment.Left };
            var visionUrl = new TextBox { MinWidth = 320 };
            var visionTip = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 3, 0, 0) };
            var visionBox = new StackPanel();
            visionBox.Children.Add(visionModel);
            visionBox.Children.Add(visionTip);
            var visionKey = new PasswordBox();
            var visionHint = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8) };
            var visionEndpoint = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8) };
            var visionResult = new TextBlock { Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };
            // 这些行要按「自动 / 手动」切显隐，所以在事件挂上之前先声明、下面再赋值。
            FrameworkElement visionModelRow = null;
            FrameworkElement visionUrlRow = null;
            FrameworkElement visionTimeoutRow = null;
            FrameworkElement visionKeyRow = null;
            Button vsave = null;
            Button vcopy = null;

            JsonElement currentPreset = default;   // 当前服务商预设（判断「聊天模型自己能不能看图」用）

            void FillChatOptions(JsonElement pv)
            {
                currentPreset = pv;
                var chat = new List<string>();
                if (pv.ValueKind == JsonValueKind.Object
                    && pv.TryGetProperty("models", out var arr) && arr.ValueKind == JsonValueKind.Array)
                    foreach (var it in arr.EnumerateArray())
                        if (it.ValueKind == JsonValueKind.String) chat.Add(it.GetString());
                model.ItemsSource = chat;
            }

            // 看图模型和聊天模型用同一份选项：当前服务商的 models + visionModels。
            // 选了哪家服务商，就列哪家的模型；「自动跟随」时不显示这一行。
            void FillVisionModels(string providerKey)
            {
                var list = new List<string>();
                if (_providers != null && !string.IsNullOrEmpty(providerKey)
                    && _providers.TryGetValue(providerKey, out var pv) && pv.ValueKind == JsonValueKind.Object)
                {
                    void Add(JsonElement arr)
                    {
                        if (arr.ValueKind != JsonValueKind.Array) return;
                        foreach (var it in arr.EnumerateArray())
                            if (it.ValueKind == JsonValueKind.String)
                            {
                                var s = it.GetString();
                                if (!string.IsNullOrWhiteSpace(s) && !list.Contains(s)) list.Add(s);
                            }
                    }
                    if (pv.TryGetProperty("models", out var arr)) Add(arr);
                    if (pv.TryGetProperty("visionModels", out var varr)) Add(varr);
                }
                var keep = visionModel.SelectedItem as string;
                visionModel.ItemsSource = list;
                if (!string.IsNullOrWhiteSpace(keep) && list.Contains(keep)) visionModel.SelectedItem = keep;
                else if (list.Count == 0) visionModel.SelectedItem = null;
                else visionModel.SelectedItem = list[0];
            }

            bool VisionIsAuto() => string.IsNullOrEmpty((visionProvider.SelectedItem as ProviderItem)?.Key);
            bool VisionIsCustom() => (visionProvider.SelectedItem as ProviderItem)?.Key == "custom";

            void SyncVisionTip()
            {
                var picked = model.SelectedItem as string ?? model.Text;
                if (VisionIsAuto())
                {
                    var fallbackModel = "";
                    if (currentPreset.ValueKind == JsonValueKind.Object
                        && currentPreset.TryGetProperty("visionModels", out var fv)
                        && fv.ValueKind == JsonValueKind.Array)
                        foreach (var it in fv.EnumerateArray())
                            if (it.ValueKind == JsonValueKind.String) { fallbackModel = it.GetString(); break; }
                    var capable = fallbackModel.Length > 0 && fallbackModel == picked;
                    visionTip.Text = capable
                        ? "自动跟随聊天模型：" + picked
                        : fallbackModel.Length > 0
                            ? "自动：聊天模型不能看图时用本服务商的看图模型 " + fallbackModel + "（复用同一把 Key）"
                            : "自动：聊天服务商没有看图模型时用默认视觉模型（glm-4.6v-flash）";
                    visionBadge.Text = capable ? "跟随中" : "自动";
                }
                else
                {
                    var prov = (visionProvider.SelectedItem as ProviderItem)?.Label ?? "";
                    if (VisionIsCustom())
                    {
                        var url = visionUrl.Text.Trim();
                        var vm = VisionValue();
                        visionTip.Text = url.Length > 0
                            ? "自定义接口：" + url + " · " + vm
                            : "自定义接口：先填接口地址和模型名（点「从聊天复制」也能直接把聊天的地址/模型搬过来）";
                        visionBadge.Text = "自定义";
                    }
                    else
                    {
                        visionTip.Text = "手动指定：" + prov + " · " + (visionModel.SelectedItem as string ?? "");
                        visionBadge.Text = "已指定";
                    }
                }
                chatBadge.Text = model.Text.Trim().Length > 0 ? "" : "";
            }

            // 老设置可能只存了 vision.model 没存 vision.provider：从模型名反推是哪家的。
            string OwnerProviderOf(string visionModelName)
            {
                if (_providers == null || string.IsNullOrWhiteSpace(visionModelName)) return "";
                foreach (var kv in _providers)
                {
                    var p = kv.Value;
                    if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("visionModels", out var arr)) continue;
                    if (arr.ValueKind != JsonValueKind.Array) continue;
                    foreach (var it in arr.EnumerateArray())
                        if (it.ValueKind == JsonValueKind.String && it.GetString() == visionModelName) return kv.Key;
                }
                return "";
            }

            // 聊天模型自己能不能识图：只有能，才允许把看图服务商选成「自动跟随」。
            bool ChatCanSeeImages()
            {
                var picked = (model.SelectedItem as string) ?? (model.Text ?? "").Trim();
                if (picked.Length == 0 || currentPreset.ValueKind != JsonValueKind.Object) return false;
                if (!currentPreset.TryGetProperty("visionModels", out var varr) || varr.ValueKind != JsonValueKind.Array) return false;
                foreach (var it in varr.EnumerateArray())
                    if (it.ValueKind == JsonValueKind.String && it.GetString() == picked) return true;
                return false;
            }

            bool ProviderHasVision(string key)
            {
                if (_providers == null || key.Length == 0 || !_providers.TryGetValue(key, out var p)) return false;
                return p.ValueKind == JsonValueKind.Object
                    && p.TryGetProperty("visionModels", out var varr)
                    && varr.ValueKind == JsonValueKind.Array
                    && varr.GetArrayLength() > 0;
            }

            // 看图服务商列表：聊天模型能识图时第一项才是「自动跟随」；只列真的有看图
            // 模型的服务商，免得选完模型下拉是空的。最后一项「自定义」不依赖预设，常驻。
            void RebuildVisionProviders()
            {
                var keepKey = (visionProvider.SelectedItem as ProviderItem)?.Key;
                // 同样换新实例：复用同一个 List 会被 WPF 的默认视图缓存住，选中的新对象匹配不上
                var list = new List<ProviderItem>();
                if (ChatCanSeeImages())
                    list.Add(new ProviderItem { Key = "", Label = "自动跟随聊天模型" });
                if (_providers != null)
                    foreach (var kv in _providers)
                        if (ProviderHasVision(kv.Key))
                            list.Add(new ProviderItem { Key = kv.Key, Label = JsonRead.Str(kv.Value, "label") + "（" + kv.Key + "）" });
                // 自定义永远在最后：不依赖任何预设，地址和模型都由用户填
                list.Add(new ProviderItem { Key = "custom", Label = "自定义（自己填接口地址和模型）" });
                visionProviders = list;
                visionProvider.ItemsSource = list;
                if (keepKey != null)
                {
                    var hit = list.FirstOrDefault(x => x.Key == keepKey);
                    if (hit != null) visionProvider.SelectedItem = hit;
                }
            }

            // 当前选择失效（比如刚把聊天模型换成不能识图的，自动项消失了）：落到聊天服务商或第一家。
            void EnsureVisionSelection()
            {
                if (visionProvider.SelectedItem is ProviderItem) return;
                var chatKey = (cmb.SelectedItem as ProviderItem)?.Key ?? "";
                var hit = visionProviders.FirstOrDefault(x => x.Key == chatKey) ?? visionProviders.FirstOrDefault();
                visionProvider.SelectedItem = hit;
                if (hit != null) FillVisionModels(hit.Key);
            }

            cmb.SelectionChanged += async (s, e) =>
            {
                if (_loading || suppressAuto || !(cmb.SelectedItem is ProviderItem p)) return;
                if (_providers != null && _providers.TryGetValue(p.Key, out var pv))
                {
                    var wasAuto = VisionIsAuto();
                    suppressAuto = true;
                    try
                    {
                        baseUrl.Text = JsonRead.Str(pv, "baseUrl");
                        FillChatOptions(pv);
                        model.Text = JsonRead.Str(pv, "model");
                        RebuildVisionProviders();   // 新服务商的聊天模型能不能识图，决定「自动跟随」还在不在
                        if (!wasAuto || !VisionIsAuto()) EnsureVisionSelection();
                        ApplyVisionMode();
                    }
                    finally { suppressAuto = false; }
                    await AutoSaveChatAsync();
                    if (wasAuto && !VisionIsAuto()) await AutoSaveVisionAsync();   // 自动失效，落成手动
                }
            };
            model.SelectionChanged += async (s, e) =>
            {
                if (_loading || suppressAuto) return;
                var wasAuto = VisionIsAuto();
                suppressAuto = true;
                try
                {
                    RebuildVisionProviders();
                    if (wasAuto && !VisionIsAuto()) EnsureVisionSelection();
                    ApplyVisionMode();
                }
                finally { suppressAuto = false; }
                SyncVisionTip();
                await AutoSaveChatAsync();
                if (wasAuto && !VisionIsAuto()) await AutoSaveVisionAsync();
            };
            visionProvider.SelectionChanged += async (s, e) =>
            {
                // suppressAuto 为真 = 程序在重建下拉（比如换了聊天模型），不是用户点的：
                // 以前这里会把外层设的 suppressAuto 冲成 false，然后一路自动保存 → 整页重读，
                // 结果「换模型服务后下拉框变空白」。
                if (_loading || suppressAuto || !_configLoaded) return;
                suppressAuto = true;
                try
                {
                    var key = (visionProvider.SelectedItem as ProviderItem)?.Key ?? "";
                    if (key.Length > 0) FillVisionModels(key);
                    if (key == "custom")
                    {
                        // 从「跟随 / 预设」切到自定义：先用聊天那套把地址和模型填好，用户再改。
                        // 这就是「抄一份过来」，不用从零敲。
                        visionModel.IsEditable = true;
                        if (visionUrl.Text.Trim().Length == 0) visionUrl.Text = baseUrl.Text.Trim();
                        if (VisionValue().Length == 0) visionModel.Text = (model.Text ?? "").Trim();
                    }
                    ApplyVisionMode();
                }
                finally { suppressAuto = false; }
                // 自定义还缺地址/模型时先别存：后端会拒绝，界面上提示就够了
                if (VisionIsCustom() && (visionUrl.Text.Trim().Length == 0 || VisionValue().Length == 0)) return;
                await AutoSaveVisionAsync();
            };
            visionModel.SelectionChanged += async (s, e) =>
            {
                if (_loading || suppressAuto) return;
                SyncVisionTip();
                await AutoSaveVisionAsync();
            };
            // 输入/选择完离开控件就自动保存；手点「保存」仍然可用（老习惯不用改）
            baseUrl.LostFocus += async (s, e) => await AutoSaveChatAsync();
            model.LostFocus += async (s, e) => await AutoSaveChatAsync();
            key.LostFocus += async (s, e) => { if (key.Password.Length > 0) await AutoSaveChatAsync(); };
            visionModel.LostFocus += async (s, e) => await AutoSaveVisionAsync();
            visionKey.LostFocus += async (s, e) => { if (visionKey.Password.Length > 0) await AutoSaveVisionAsync(); };

            // ── 聊天面板 ────────────────────────────────────────
            chatPanel.Children.Add(Row("模型服务", cmb, "", false, ModelLabel));
            chatPanel.Children.Add(Row("接口地址", baseUrl, "", false, ModelLabel));
            chatPanel.Children.Add(Row("模型名", model, "点下拉直接选；没有的型号也可以自己输入", false, ModelLabel));
            chatPanel.Children.Add(Row("API Key", key, "留空表示不改；已存的这里不会显示", false, ModelLabel));
            var connectionNote = new Border { CornerRadius = new CornerRadius(8), Padding = new Thickness(12, 10, 12, 10),
                Margin = new Thickness(0, 0, 0, 12), BorderThickness = new Thickness(1) };
            connectionNote.SetResourceReference(Border.BackgroundProperty, "Hover");
            connectionNote.SetResourceReference(Border.BorderBrushProperty, "Accent");
            connectionNote.Child = new TextBlock { Text = "连接小贴士：如果回复总是重复一句话、答非所问，或像在“装傻”，API 可能没有连接成功。没填 API Key 时会使用演示回复；填好后请点击“测试连接”，检查 Key、接口地址和模型名（本地免 Key 模型除外）。",
                Style = (Style)FindResource("Small"), TextWrapping = TextWrapping.Wrap };
            chatPanel.Children.Add(connectionNote);

            var chatDivider = new Border { Height = 1, Margin = new Thickness(0, 4, 0, 12) };
            chatDivider.SetResourceReference(Border.BackgroundProperty, "Line");
            chatPanel.Children.Add(chatDivider);
            chatPanel.Children.Add(new TextBlock { Text = "采样", Style = (Style)FindResource("Label"), Margin = new Thickness(0, 0, 0, 8) });
            chatPanel.Children.Add(TwoCol(
                BuildField(new FieldSpec { Path = "deepseek.temperature", Label = "温度", Kind = "num", Min = 0, Max = 2, IsInt = false, Hint = "越大越放得开（>1.2 容易跑偏）" }, true),
                BuildField(new FieldSpec { Path = "deepseek.maxTokens", Label = "最多 token", Kind = "num", Min = 16, Max = 32768, Hint = "默认 700" }, true)));
            chatPanel.Children.Add(TwoCol(
                BuildField(new FieldSpec { Path = "deepseek.frequencyPenalty", Label = "频率惩罚", Kind = "num", Min = -2, Max = 2, IsInt = false }, true),
                BuildField(new FieldSpec { Path = "deepseek.presencePenalty", Label = "在场惩罚", Kind = "num", Min = -2, Max = 2, IsInt = false }, true)));
            chatPanel.Children.Add(TwoCol(
                BuildField(new FieldSpec { Path = "deepseek.timeoutMs", Label = "请求超时(ms)", Kind = "num", Min = 1000, Max = 600000 }, true),
                null));
            // 深度思考：和 /api/settings 共用 data/settings.json 的 thinking，走 /api/settings 保存。
            // 以前这里是「语音」页签里的 deepseek.thinking：接口一保存 settings.thinking 就把它盖掉，
            // 在 exe 里改了也不生效。现在它属于聊天设置，和接口写的是同一个值。
            thinking.Click += async (s, e) =>
            {
                if (_loading) return;
                await AutoSaveChatAsync();
            };
            chatPanel.Children.Add(Row(
                "深度思考", thinking,
                "打开后会先想再答：更慢、更贵（思考 token 计入输出预算）",
                false, ModelLabel));

            var chatButtons = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) };
            var save = new Button { Content = "保存", Style = (Style)FindResource("Primary") };
            var test = new Button { Content = "测试连通", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };
            var resetSampling = new Button { Content = "采样恢复默认", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };
            resetSampling.Click += async (s, e) => await ResetFieldsAsync("采样参数", new[]
            {
                "deepseek.temperature", "deepseek.maxTokens",
                "deepseek.frequencyPenalty", "deepseek.presencePenalty",
                "deepseek.timeoutMs",
            });
            chatButtons.Children.Add(save);
            chatButtons.Children.Add(test);
            chatButtons.Children.Add(resetSampling);
            chatPanel.Children.Add(chatButtons);
            chatPanel.Children.Add(chatResult);

            // 看图取值：自动 = 服务商传空（服务端跟随聊天模型）；手动 = 服务商 + 模型。
            string VisionProviderValue() => (visionProvider.SelectedItem as ProviderItem)?.Key ?? "";
            string VisionValue()
            {
                if (VisionProviderValue().Length == 0) return "";
                // 自定义接口的模型是可编辑下拉：用户可能直接敲了一个预设里没有的名字
                var picked = visionModel.SelectedItem as string;
                return string.IsNullOrWhiteSpace(picked) ? (visionModel.Text ?? "").Trim() : picked;
            }

            object ModelRequest()
            {
                var prov = (cmb.SelectedItem as ProviderItem)?.Key ?? "";
                var req = new Dictionary<string, object>
                {
                    ["provider"] = prov,
                    ["baseUrl"] = baseUrl.Text.Trim(),
                    ["model"] = model.Text.Trim(),
                    ["visionProvider"] = VisionProviderValue(),
                    ["visionModel"] = VisionValue(),
                    ["mock"] = false,
                    ["thinking"] = thinking.IsChecked == true
                };
                if (VisionIsCustom()) req["visionBaseUrl"] = visionUrl.Text.Trim();
                if (key.Password.Length > 0) req["apiKey"] = key.Password.Trim();
                return req;
            }

            chatSaves = new ConfigurationSaveState<ModelSaveSnapshot>(
                () => new ModelSaveSnapshot { Body = ModelRequest(), Secret = chatSecret.Capture(key.Password), PageGeneration = _pageLifetime.Capture() },
                build => _saver.SaveSettingsAsync(() => build().Body),
                (snapshot, result) =>
                {
                    if (!_pageLifetime.IsCurrent(snapshot.PageGeneration)) return;
                    if (result.Ok && chatSecret.IsCurrent(snapshot.Secret, key.Password))
                    {
                        suppressAuto = true;
                        try { key.Password = ""; }
                        finally { suppressAuto = false; }
                    }
                    chatResult.Text = result.Ok
                        ? (chatSaves.HasPendingChanges ? "正在保存新的修改…" : "已自动保存。")
                        : "自动保存失败：" + Api.Message(result);
                });
            visionSaves = new ConfigurationSaveState<ModelSaveSnapshot>(
                CaptureVisionSnapshot,
                build => _saver.SaveSettingsAsync(() => build().Body),
                (snapshot, result) =>
                {
                    if (!_pageLifetime.IsCurrent(snapshot.PageGeneration)) return;
                    if (result.Ok && visionSecret.IsCurrent(snapshot.Secret, visionKey.Password))
                    {
                        suppressAuto = true;
                        try { visionKey.Password = ""; }
                        finally { suppressAuto = false; }
                    }
                    if (!result.Ok) visionResult.Text = "保存失败：" + Api.Message(result);
                });
            void Edited(bool vision)
            {
                if (suppressAuto || _loading || !_configLoaded) return;
                _configurationRevision++;
                if (vision) visionSaves.MarkDesired(); else chatSaves.MarkDesired();
                foreach (var refresh in _refreshBudgetHints) refresh();
            }
            baseUrl.TextChanged += (s, e) => Edited(false);
            model.AddHandler(TextBox.TextChangedEvent, new TextChangedEventHandler((s, e) => Edited(false)));
            key.PasswordChanged += (s, e) => { chatSecret.Changed(); Edited(false); };
            visionUrl.TextChanged += (s, e) => Edited(true);
            visionModel.AddHandler(TextBox.TextChangedEvent, new TextChangedEventHandler((s, e) => Edited(true)));
            visionKey.PasswordChanged += (s, e) => { visionSecret.Changed(); Edited(true); };

            // 自动保存：聊天/看图这些输入改完（失焦、换了选项、勾了开关）立刻写回，
            // 不用再记得点「保存」。手动按钮保留，老习惯照样能用。
            async Task AutoSaveChatAsync()
            {
                if (suppressAuto || _loading || !_configLoaded) return;
                Edited(false);
                await chatSaves.SaveAsync();
            }

            async Task AutoSaveVisionAsync()
            {
                if (suppressAuto || _loading || !_configLoaded) return;
                await SaveVisionAsync("");
            }

            save.Click += async (s, e) =>
            {
                var generation = _pageLifetime.Capture();
                Edited(false);
                var res = await chatSaves.SaveAsync();
                if (!_pageLifetime.IsCurrent(generation)) return;
                if (!res.Ok) { chatResult.Text = "保存失败：" + Api.Message(res); return; }
                chatResult.Text = "已保存。";
                // 服务端可能顺手改了看图模型（跟随/解除跟随），必须重新拉一次，
                // 否则「看图」页还显示保存前的旧模型。
                _lastLoad = DateTime.MinValue;
                await LoadConfigAsync();
            };
            test.Click += async (s, e) =>
            {
                chatResult.Text = "正在测…";
                    var res = await Api.PostJson(_sup.Url, "/api/settings/test", ModelRequest());
                chatResult.Text = res.Ok ? "连通正常。" : "测试没通过：" + Api.Message(res);
            };

            // ── 看图面板 ────────────────────────────────────────
            // 和聊天页一样的两个下拉：服务商（第一项是「自动跟随聊天模型」）+ 模型；
            // 最后一项「自定义」会多出一个接口地址输入框，模型也能自己敲。
            var visionProviderRow = Row("服务商", visionProvider, "自动跟随 = 用聊天模型同一家的看图模型和 Key；自定义 = 地址和模型都自己填", false, ModelLabel);
            visionModelRow = Row("模型", visionBox, "", false, ModelLabel);
            visionUrlRow = Row("接口地址", visionUrl, "自定义接口就填这里（例如 https://api.example.com/v1）；和聊天一样时直接复用聊天那把 Key", false, ModelLabel);
            visionTimeoutRow = BuildField(new FieldSpec { Path = "vision.timeoutMs", Label = "超时(毫秒)", Kind = "num", Min = 1000, Max = 300000 }, false, ModelLabel);
            visionKeyRow = Row("看图 Key", visionKey, "留空表示不改；和聊天同一地址会自动复用聊天 Key；本机 / 内网服务可以留空", false, ModelLabel);
            visionPanel.Children.Add(visionHint);
            visionPanel.Children.Add(visionProviderRow);
            visionPanel.Children.Add(visionUrlRow);
            visionPanel.Children.Add(visionModelRow);
            visionPanel.Children.Add(visionEndpoint);
            visionPanel.Children.Add(visionTimeoutRow);
            visionPanel.Children.Add(visionKeyRow);

            var visionButtons = new WrapPanel { Margin = new Thickness(0, 6, 0, 0) };
            vsave = new Button { Content = "保存看图设置", Style = (Style)FindResource("Ghost") };
            vcopy = new Button { Content = "从聊天复制", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0), ToolTip = "把聊天正在用的接口地址和能看图的模型抄到看图设置里" };
            var vtest = new Button { Content = "测一下", Style = (Style)FindResource("Ghost"), Margin = new Thickness(8, 0, 0, 0) };
            visionButtons.Children.Add(vsave);
            visionButtons.Children.Add(vcopy);
            visionButtons.Children.Add(vtest);
            visionPanel.Children.Add(visionButtons);
            visionPanel.Children.Add(visionResult);

            // 自动跟随：隐藏模型 / 接口地址 / 超时 / Key / 保存，只留「测一下」。
            void ApplyVisionMode()
            {
                if (visionModelRow == null) return;
                var auto = VisionIsAuto();
                var custom = VisionIsCustom();
                visionModel.IsEditable = custom;   // 只有自定义接口才允许自己敲模型名
                visionModelRow.Visibility = auto ? Visibility.Collapsed : Visibility.Visible;
                visionUrlRow.Visibility = custom ? Visibility.Visible : Visibility.Collapsed;
                visionEndpoint.Visibility = (!auto && !custom) ? Visibility.Visible : Visibility.Collapsed;
                visionTimeoutRow.Visibility = auto ? Visibility.Collapsed : Visibility.Visible;
                visionKeyRow.Visibility = auto ? Visibility.Collapsed : Visibility.Visible;
                visionHint.Visibility = auto ? Visibility.Collapsed : Visibility.Visible;
                vsave.Visibility = auto ? Visibility.Collapsed : Visibility.Visible;
                vcopy.Visibility = custom ? Visibility.Visible : Visibility.Collapsed;
                SyncVisionTip();
            }
            ApplyVisionMode();   // 默认：自动跟随（模型 / Key 等都先藏起来）

            // 保存这一页的全部内容：看图服务商 + 模型 + （自定义时的）接口地址 + 看图 Key。
            async Task<bool> SaveVisionAsync(string successText)
            {
                var generation = _pageLifetime.Capture();
                Edited(true);
                var res = await visionSaves.SaveAsync();
                if (!_pageLifetime.IsCurrent(generation)) return res.Ok;
                if (!res.Ok)
                {
                    visionResult.Text = "保存失败：" + Api.Message(res);
                    return false;
                }
                if (successText.Length > 0) visionResult.Text = successText;
                _lastLoad = DateTime.MinValue;
                await LoadConfigAsync();
                return true;
            }

            ModelSaveSnapshot CaptureVisionSnapshot()
            {
                var request = new Dictionary<string, object>
                {
                    ["visionProvider"] = VisionProviderValue(),
                    ["visionModel"] = VisionValue(),
                };
                if (VisionIsCustom()) request["visionBaseUrl"] = visionUrl.Text.Trim();
                if (visionKey.Password.Length > 0) request["visionApiKey"] = visionKey.Password.Trim();
                return new ModelSaveSnapshot { Body = request, Secret = visionSecret.Capture(visionKey.Password), PageGeneration = _pageLifetime.Capture() };
            }

            vsave.Click += async (s, e) => await SaveVisionAsync("看图设置已保存。");
            // 「从聊天复制」：服务端取聊天实际在用的地址 + 能看图的模型写进看图设置，
            // 比在界面上比对两遍下拉更省事（聊天模型不能看图时它会自动挑本家的视觉模型）。
            vcopy.Click += async (s, e) =>
            {
                visionResult.Text = "正在从聊天复制…";
                var generation = _pageLifetime.Capture();
                var res = await _saver.SaveSettingsAsync(() => new { visionCopyFromChat = true });
                if (!_pageLifetime.IsCurrent(generation)) return;
                if (!res.Ok)
                {
                    visionResult.Text = "复制失败：" + Api.Message(res);
                    return;
                }
                _lastLoad = DateTime.MinValue;
                await LoadConfigAsync();
                visionResult.Text = "已把聊天的接口地址和看图模型抄过来，还能继续改。";
            };
            visionUrl.LostFocus += async (s, e) => await AutoSaveVisionAsync();
            vtest.Click += async (s, e) =>
            {
                visionResult.Text = "正在测…";
                if (!await SaveVisionAsync("")) return;      // 先落盘，测的就是刚才填的模型/Key
                var res = await Api.Post(_sup.Url, "/api/vision/test", "{}");
                visionResult.Text = res.Ok ? "看图通了，它说：" + res.Str("sample") : "没通：" + Api.Message(res);
            };

            // ── 语音面板（原来单独一页，并到模型卡里）──────────
            var voiceHint = new TextBlock
            {
                Style = (Style)FindResource("Small"),
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 8),
                Text = "接收微信语音并识别成文字；发送语音请使用工作台「语音发送」。",
            };
            voicePanel.Children.Add(voiceHint);
            voicePanel.Children.Add(BuildField(new FieldSpec { Path = "voice.apiKey", Label = "语音接口 Key", Kind = "secret", Hint = "留空表示不改；留空则用主模型的 Key" }, false, ModelLabel));
            voicePanel.Children.Add(BuildField(new FieldSpec { Path = "voice.baseUrl", Label = "接口地址", Kind = "text" }, false, ModelLabel));
            voicePanel.Children.Add(BuildField(new FieldSpec { Path = "voice.model", Label = "语音模型", Kind = "text" }, false, ModelLabel));
            voicePanel.Children.Add(TwoCol(
                BuildField(new FieldSpec { Path = "voice.timeoutMs", Label = "识别超时(ms)", Kind = "num", Min = 1000, Max = 300000 }, true),
                BuildField(new FieldSpec { Path = "voice.maxSeconds", Label = "最长语音(秒)", Kind = "num", Min = 1, Max = 600 }, true)));
            // 「深度思考」已经挪到聊天页签（和 /api/settings 共用 thinking），这里不再重复放一个配置项。

            _loadModel = (set, provs) =>
            {
                _providers = provs;
                if (chatSaves.HasPendingChanges || visionSaves.HasPendingChanges) return;
                _loading = true;
                // 每次换一个新的 List 实例：WPF 会按「数据源实例」缓存默认视图，
                // 对同一个 List 清空再填充后，下拉的 Items 还是旧的那批对象，
                // SelectedItem 指向新对象就匹配不上 → 显示成空白（换模型服务后就这样）。
                var list = new List<ProviderItem>();
                foreach (var kv in provs)
                    list.Add(new ProviderItem { Key = kv.Key, Label = JsonRead.Str(kv.Value, "label") + "（" + kv.Key + "）" });
                var keepKey = (cmb.SelectedItem as ProviderItem)?.Key;
                cmb.ItemsSource = list;
                var cur = JsonRead.Str(set, "provider");
                // 以服务端值为准；万一认不出（服务刚重启、列表还没刷新）就退回上一次选中的，
                // 再不行取第一项。以前焦点在下拉里时干脆不恢复，列表一重建就空白。
                var picked = list.FirstOrDefault(x => x.Key == cur)
                    ?? list.FirstOrDefault(x => x.Key == keepKey)
                    ?? list.FirstOrDefault();
                cmb.SelectedItem = picked;
                FillChatOptions(picked != null && provs.TryGetValue(picked.Key, out var pv) ? pv : default);
                if (!baseUrl.IsKeyboardFocusWithin) baseUrl.Text = JsonRead.Str(set, "baseUrl");
                if (!model.IsKeyboardFocusWithin) model.Text = JsonRead.Str(set, "model");
                RebuildVisionProviders();   // 自动项是否出现取决于聊天模型能不能识图
                var vis = set.ValueKind == JsonValueKind.Object && set.TryGetProperty("vision", out var vv) ? vv : default;
                var vmodel = JsonRead.Str(vis, "model");
                var manual = vis.ValueKind == JsonValueKind.Object && vis.TryGetProperty("manual", out var mf) && mf.ValueKind == JsonValueKind.True;
                var vprov = JsonRead.Str(vis, "provider");
                if (!visionProvider.IsKeyboardFocusWithin && !visionModel.IsKeyboardFocusWithin)
                {
                    if (manual && vmodel.Length > 0)
                    {
                        var customSaved = vprov == "custom"
                            || (vis.ValueKind == JsonValueKind.Object && vis.TryGetProperty("custom", out var cf) && cf.ValueKind == JsonValueKind.True);
                        if (customSaved && vprov.Length == 0) vprov = "custom";   // 老数据只标了 custom 没存 provider
                        if (vprov.Length == 0 && !customSaved) vprov = OwnerProviderOf(vmodel);
                        var hit = visionProviders.FirstOrDefault(x => x.Key == vprov);
                        if (hit == null) hit = visionProviders.FirstOrDefault(x => x.Key == cur);   // 认不出就用聊天服务商，别把手动模型弄丢
                        visionProvider.SelectedItem = hit ?? visionProviders.FirstOrDefault();
                        if (!visionUrl.IsKeyboardFocusWithin) visionUrl.Text = JsonRead.Str(vis, "baseUrl");
                        if (hit != null && hit.Key == "custom")
                        {
                            // 自定义：模型名可能不在任何预设里，直接放进可编辑下拉的文本框
                            visionModel.IsEditable = true;
                            visionModel.ItemsSource = null;
                            visionModel.Text = vmodel;
                        }
                        else
                        {
                            if (hit != null && hit.Key.Length > 0) FillVisionModels(hit.Key);
                            var sight = visionModel.ItemsSource as List<string> ?? new List<string>();
                            if (!sight.Contains(vmodel)) { sight.Add(vmodel); visionModel.ItemsSource = null; visionModel.ItemsSource = sight; }
                            visionModel.SelectedItem = vmodel;
                        }
                    }
                    else
                    {
                        // 自动跟随：聊天模型能识图时才存在这一项；不能识图就落到聊天服务商。
                        var autoItem = visionProviders.FirstOrDefault(x => x.Key == "");
                        visionProvider.SelectedItem = autoItem;
                        EnsureVisionSelection();
                        if (visionProvider.SelectedItem is ProviderItem sel && sel.Key.Length > 0) FillVisionModels(sel.Key);
                    }
                }
                if (!thinking.IsKeyboardFocusWithin)
                    thinking.IsChecked = set.ValueKind == JsonValueKind.Object
                        && set.TryGetProperty("thinking", out var th) && th.ValueKind == JsonValueKind.True;
                ApplyVisionMode();
                SyncVisionTip();
                _loading = false;
            };

            _loadVision = (set) =>
            {
                var v = set.ValueKind == JsonValueKind.Object && set.TryGetProperty("vision", out var vv) ? vv : default;
                var curModel = JsonRead.Str(v, "model");
                var manual = v.ValueKind == JsonValueKind.Object && v.TryGetProperty("manual", out var mf) && mf.ValueKind == JsonValueKind.True;
                if (v.ValueKind == JsonValueKind.Object)
                {
                    var configured = v.TryGetProperty("configured", out var c) && c.ValueKind == JsonValueKind.True;
                    var masked = v.TryGetProperty("keyMasked", out var km) && km.ValueKind == JsonValueKind.String ? km.GetString() : "";
                    var follow = manual ? "" : "（自动）";
                    visionHint.Text = (configured ? "已配置：" + masked : "没配置。选「自动跟随」就用聊天那把 Key；本机/内网看图服务可以留空。")
                        + (curModel.Length > 0 ? " 当前看图模型：" + curModel + follow : "");
                    var ep = JsonRead.Str(v, "baseUrl");
                    var custom = v.ValueKind == JsonValueKind.Object && v.TryGetProperty("custom", out var cst) && cst.ValueKind == JsonValueKind.True;
                    visionEndpoint.Text = ep.Length > 0
                        ? "接口地址：" + ep + (custom ? "（自定义）" : manual ? "（手动指定）" : "（自动跟随聊天模型）")
                        : "";
                }
            };

            return card;
        }

        // ── 读写 ────────────────────────────────────────────────
        /// <summary>
        /// 周期刷新（MainWindow 2 秒定时器驱动）：只更新状态行，不动表单——
        /// 否则会把用户正在编辑的值冲掉，随后 LostFocus 又把旧值写回服务端（M30）。
        /// 全量回填只在页面载入（Loaded）做；表单还没载入过（比如内核后启动）时补一次。
        /// </summary>
        public async Task RefreshAsync()
        {
            if (_configLoaded && _loadedOnline != _sup.NodeRunning)
            {
                _configLoaded = false;
                _lastLoad = DateTime.MinValue;
            }
            KernelHint.Text = _sup.NodeRunning
                ? "改完立即写回 config.json（密钥留空表示不改）"
                : "可保存到本地，启动后生效。";
            if (!_configLoaded) await LoadConfigAsync();      // 还没回填过，补一次
        }

        /// <summary>全量回填：把服务端的值刷回所有表单控件（跳过正在编辑的）。</summary>
        private async Task LoadConfigAsync()
        {
            if ((DateTime.Now - _lastLoad).TotalSeconds < 5) return;   // 节流：≥5 秒一次（照 SettingsPage 原有做法）
            if (_loadingConfig) return;
            _loadingConfig = true;
            _lastLoad = DateTime.Now;
            var generation = _pageLifetime.Capture();
            var revision = _configurationRevision;
            try
            {
                var cfg = await _sup.ReadConfigurationAsync("/api/config");
                if (!_pageLifetime.IsCurrent(generation)) return;
                if (!cfg.Ok) { KernelHint.Text = cfg.Error; return; }
                var settings = await _sup.ReadConfigurationAsync("/api/settings");
                if (!_pageLifetime.IsCurrent(generation) || revision != _configurationRevision)
                {
                    _lastLoad = DateTime.MinValue;
                    return;
                }
                var config = cfg.Prop("config");
                var secrets = cfg.Prop("secrets");
                _adminSpellStatus.Text = secrets.ValueKind == JsonValueKind.Object &&
                    secrets.TryGetProperty("admin.spell", out var spell) && spell.ValueKind == JsonValueKind.True
                    ? "已设置" : "未设置";
                _loading = true;
                try
                {
                    foreach (var kv in _loaders)
                        kv.Value(GetPath(config, kv.Key));
                }
                finally { _loading = false; }

                if (settings.Ok)
                {
                    var provs = new Dictionary<string, JsonElement>();
                    var p = settings.Prop("providers");
                    if (p.ValueKind == JsonValueKind.Object)
                        foreach (var it in p.EnumerateObject()) provs[it.Name] = it.Value;
                    _loadModel?.Invoke(settings.Root, provs);
                    _loadVision?.Invoke(settings.Root);
                }
                _configLoaded = true;
                _loadedOnline = _sup.NodeRunning;
            }
            finally
            {
                _loadingConfig = false;
            }
        }

        private static JsonElement GetPath(JsonElement root, string dotted)
        {
            var cur = root;
            foreach (var part in dotted.Split('.'))
            {
                if (cur.ValueKind != JsonValueKind.Object || !cur.TryGetProperty(part, out var next)) return default;
                cur = next;
            }
            return cur;
        }
    }
}










