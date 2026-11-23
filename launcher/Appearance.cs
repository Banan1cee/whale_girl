using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;

namespace WhaleLauncher
{
    /// <summary>
    /// 启动器自己的外观设置：深浅色 + 背景图。
    /// 只写到 data/launcher-ui.json，不碰 config.json，也不影响内核和桥接。
    /// </summary>
    public static class Appearance
    {
        private static readonly string SettingsPath =
            Path.Combine(AppContext.BaseDirectory, "data", "launcher-ui.json");
        private static string _themeOwner = "";
        internal static string ThemeOwner => _themeOwner;

        static Appearance()
        {
            PluginMarket.ThemeValidator = bytes => LauncherThemes.Parse(bytes).Id;
        }

        internal static bool SetThemeOwner(string pluginId)
        {
            if (_theme == null || string.IsNullOrEmpty(pluginId) || !LauncherThemes.Save(ThemeFilePath, _theme, pluginId)) return false;
            _themeOwner = pluginId;
            return true;
        }

        public static string Theme { get; private set; } = "dark";
        public static string Backdrop { get; private set; } = "";
        public static bool IsDark => !string.Equals(Theme, "light", StringComparison.OrdinalIgnoreCase);
        public static bool HasBackdrop => !string.IsNullOrWhiteSpace(Backdrop) && File.Exists(Backdrop);

        /// <summary>背景图模糊半径（0–60），直接喂给 BlurEffect。</summary>
        public static double BackdropBlur { get; private set; } = 12;

        /// <summary>背景图不透明度（0–1）。1 = 图片最清楚，0 = 只剩主题底色。</summary>
        public static double BackdropOpacity { get; private set; } = 0.88;

        /// <summary>面板 / 卡片的不透明度（0–1）。0 = 文字框完全透明，只留描边。</summary>
        public static double SurfaceOpacity { get; private set; } = 0.45;

        /// <summary>背景图铺法：fill = 等比裁剪，stretch = 拉伸，uniform = 等比完整。</summary>
        public static string BackdropFit { get; private set; } = "fill";

        public static Stretch BackdropStretch => BackdropFit switch
        {
            "stretch" => Stretch.Fill,
            "uniform" => Stretch.Uniform,
            _ => Stretch.UniformToFill,
        };

        /// <summary>是否从背景图自动取色（莫奈 / Material You 思路）。</summary>
        public static bool MonetEnabled { get; private set; } = true;

        /// <summary>文字描边开关：觉得发光就关掉，靠自定义文字颜色保证可读。</summary>
        public static bool TextHaloEnabled { get; private set; } = true;

        // 空字符串 = 跟随莫奈 / 主题；非空 = 用户手选的颜色（#RRGGBB）。
        public static string AccentOverride { get; private set; } = "";
        public static string TintOverride { get; private set; } = "";
        public static string TextOverride { get; private set; } = "";

        public static event Action Changed;

        // ── 主题包（纯 JSON，见 LauncherTheme.cs）──────────────────
        // 主题只叠加颜色和尺寸，不接管顶栏、系统标题栏和任何安全信号色。
        //
        // 启用规则只有一条：每次重建配色都用同一套最终对比度判定，
        // 判定通过才整包生效（颜色 + 字体 + 圆角 + 弹窗），不通过就整包回到内置外观，
        // 并把原因记在 ThemeUnavailableReason 里。启动、应用、以及用户改配色 / 背景 /
        // 取色 / 明暗之后的重建都走这条规则，所以不会出现“运行时半套、下次启动才拒掉”。
        private static LauncherTheme _theme;
        private static bool _themeActive;
        private static string _themeReason = "";

        /// <summary>主题是否正在生效（选中但当前不可用时为 false）。</summary>
        public static bool HasTheme => _theme != null && _themeActive;

        /// <summary>是否选中了主题包（哪怕它当前不可用）。停用按钮用这个判断。</summary>
        public static bool HasThemePackage => _theme != null;

        /// <summary>主题不可用的原因；正在生效或没有主题时为空。</summary>
        public static string ThemeUnavailableReason => _theme != null && !_themeActive ? _themeReason : "";

        public static string ActiveThemeName => _theme?.Name ?? "";
        public static string ThemeFilePath => Path.Combine(AppContext.BaseDirectory, "data", LauncherThemes.FileName);
        /// <summary>当前已加载的主题（可能因对比度约束暂未生效）；插件卡片用它判断是否处于启用态。</summary>
        internal static LauncherTheme ActiveTheme => _theme;

        /// <summary>内置字体族：和 MainWindow.xaml 的 Window.FontFamily 保持同一份默认值。</summary>
        public const string DefaultFontFamily = "Microsoft YaHei UI, Segoe UI";

        /// <summary>内置基准字号：和 MainWindow.xaml 的 Window.FontSize 保持同一份默认值。</summary>
        public const double DefaultFontSize = 12.5;

        public static string UiFontFamily => HasTheme && _theme.FontFamily.Length > 0 ? _theme.FontFamily : DefaultFontFamily;
        public static double FontScale => HasTheme ? _theme.FontScale : 1.0;
        public static double BaseFontSize => DefaultFontSize * FontScale;
        public static double SpacingScale => HasTheme ? _theme.Spacing : 1.0;

        /// <summary>普通弹窗（非授权 / 更新 / 安全确认）的圆角、底色和描边。</summary>
        public static int DialogCornerRadius => HasTheme && _theme.DialogCorner >= 0 ? _theme.DialogCorner : 14;
        public static Color DialogSurfaceColor => HasTheme && _theme.DialogSurface.Length > 0
            ? ParseColor(_theme.DialogSurface) : BaseColor("Bg");
        public static Color DialogBorderColor => HasTheme && _theme.DialogBorder.Length > 0
            ? ParseColor(_theme.DialogBorder) : BaseColor("Line");
        public static bool HasThemeDialogColors => HasTheme
            && (_theme.DialogSurface.Length > 0 || _theme.DialogBorder.Length > 0);

        /// <summary>
        /// 字号 / 圆角 / 内边距这类尺寸不能是 App.xaml 里的字面量，否则切主题时已经建好的控件不会跟着变。
        /// 这里统一写进 Application.Resources，App.xaml 用 DynamicResource 引用；默认值等于原来的字面量。
        /// 键名清单同时被 tests/launcher-ui.test.js 用来和 App.xaml 对照。
        /// </summary>
        internal static readonly string[] ChromeKeys =
        {
            "FontSizeH1", "FontSizeH2", "FontSizeLabel", "FontSizeSmall", "FontSizeValue",
            "FontSizeBody", "FontSizeControl", "FontSizeField",
            "RadiusChip", "RadiusCard", "RadiusButton", "RadiusTopButton", "RadiusField",
            "RadiusNav", "RadiusComboItem",
            "PadChip", "PadPrimary", "PadGhost", "PadTopBtn",
        };

        // 拖滑块会高频触发 Changed，背景图只解码一次，别每次都重新读 1920px 的图。
        private static BitmapImage _bitmapCache;
        private static string _bitmapCachePath = "";

        // 莫奈取色缓存：换图才重新统计；明暗两套配色提前算好，切主题时直接换表。
        private static string _monetPath = "";
        private static double _monetHue = 215;
        private static double _monetLum = 0.5;
        private static bool _monetReady;

        private static Dictionary<string, Color> _lightPalette;
        private static Dictionary<string, Color> _darkPalette;
        private static Color _lightTint;
        private static Color _darkTint;
        private static Color _lightHalo;
        private static Color _darkHalo;
        private static bool _paletteReady;

        private static readonly Dictionary<string, string> Light = new Dictionary<string, string>
        {
            ["Bg"] = "#FFF4F6F9",
            ["BgDeep"] = "#FFEEF1F6",
            ["BgNav"] = "#E6F4F6F9",
            ["BgTop"] = "#F2FFFFFF",
            ["BgFoot"] = "#F2FFFFFF",
            ["BgContent"] = "#FFF4F6F9",
            ["CardBg"] = "#FFFFFFFF",
            ["CardBorder"] = "#FFD8E0EA",
            ["Line"] = "#FFE4E9F0",
            ["LineSoft"] = "#FFEDF1F6",
            ["Text"] = "#FF121722",
            ["Text2"] = "#FF465164",
            ["Muted"] = "#FF5E6A7C",
            ["Dim"] = "#FF6F7B8D",
            ["Accent"] = "#FF3B6EF6",
            ["AccentDim"] = "#FFEDF2FF",
            ["AccentSoft"] = "#FFEDF2FF",
            ["Ok"] = "#FF12B76A",
            ["Warn"] = "#FFF79009",
            ["Bad"] = "#FFF04438",
            ["Idle"] = "#FFB3BCCB",
            ["PrimaryBg"] = "#FF111827",
            ["PrimaryFg"] = "#FFFFFFFF",
            ["PrimaryHover"] = "#FF1F2937",
            ["GhostBg"] = "#FFFFFFFF",
            ["GhostHover"] = "#FFF1F4F8",
            ["Hover"] = "#FFF1F4F8",
            ["FieldBg"] = "#FFF7F9FC",
            ["FieldBorder"] = "#FFC9D3E0",
            ["PopupBg"] = "#FFFFFFFF",
            ["ChipBg"] = "#FFFFFFFF",
            ["Surface3"] = "#FFF1F4F8",
            ["TopBtnHover"] = "#FFF1F4F8",
            ["ScrollThumb"] = "#FFCBD3DF",
            ["BackdropTint"] = "#F0F4F6F9",
        };

        private static readonly Dictionary<string, string> Dark = new Dictionary<string, string>
        {
            ["Bg"] = "#FF080C12",
            ["BgDeep"] = "#FF05080D",
            ["BgNav"] = "#E6080C12",
            ["BgTop"] = "#F20C121A",
            ["BgFoot"] = "#F20C121A",
            ["BgContent"] = "#FF080C12",
            ["CardBg"] = "#FF0F151E",
            ["CardBorder"] = "#FF243140",
            ["Line"] = "#FF202B38",
            ["LineSoft"] = "#FF1A2430",
            ["Text"] = "#FFF4F7FA",
            ["Text2"] = "#FFC3CDDA",
            ["Muted"] = "#FF98A6B8",
            ["Dim"] = "#FF7E8CA0",
            ["Accent"] = "#FF86ADFF",
            ["AccentDim"] = "#FF1A2A47",
            ["AccentSoft"] = "#FF1A2A47",
            ["Ok"] = "#FF48E3A1",
            ["Warn"] = "#FFFFC266",
            ["Bad"] = "#FFFF7B7B",
            ["Idle"] = "#FF5E6C80",
            ["PrimaryBg"] = "#FFF2F5F9",
            ["PrimaryFg"] = "#FF0A0F16",
            ["PrimaryHover"] = "#FFFFFFFF",
            ["GhostBg"] = "#FF131B26",
            ["GhostHover"] = "#FF1B2634",
            ["Hover"] = "#FF1A2431",
            ["FieldBg"] = "#FF141C27",
            ["FieldBorder"] = "#FF2A3748",
            ["PopupBg"] = "#FF131B26",
            ["ChipBg"] = "#FF121A24",
            ["Surface3"] = "#FF1A2431",
            ["TopBtnHover"] = "#FF1A2431",
            ["ScrollThumb"] = "#FF35465A",
            ["BackdropTint"] = "#AD080C12",
        };

        public static void Load()
        {
            try
            {
                if (!File.Exists(SettingsPath)) return;
                using var doc = JsonDocument.Parse(File.ReadAllText(SettingsPath));
                var root = doc.RootElement;
                if (root.TryGetProperty("theme", out var t) && t.ValueKind == JsonValueKind.String)
                {
                    var v = (t.GetString() ?? "").Trim().ToLowerInvariant();
                    if (v == "light" || v == "dark") Theme = v;
                }
                if (root.TryGetProperty("backdrop", out var b) && b.ValueKind == JsonValueKind.String)
                    Backdrop = b.GetString() ?? "";
                if (root.TryGetProperty("backdropBlur", out var blur) && blur.ValueKind == JsonValueKind.Number)
                    BackdropBlur = Math.Clamp(blur.GetDouble(), 0, 60);
                if (root.TryGetProperty("backdropOpacity", out var opacity) && opacity.ValueKind == JsonValueKind.Number)
                    BackdropOpacity = Math.Clamp(opacity.GetDouble(), 0, 1);
                if (root.TryGetProperty("surfaceOpacity", out var surface) && surface.ValueKind == JsonValueKind.Number)
                    SurfaceOpacity = Math.Clamp(surface.GetDouble(), 0, 1);
                if (root.TryGetProperty("backdropFit", out var fit) && fit.ValueKind == JsonValueKind.String)
                {
                    var v = (fit.GetString() ?? "").ToLowerInvariant();
                    if (v == "fill" || v == "stretch" || v == "uniform") BackdropFit = v;
                }
                if (root.TryGetProperty("monet", out var monet) && monet.ValueKind == JsonValueKind.False)
                    MonetEnabled = false;
                if (root.TryGetProperty("textHalo", out var halo) && halo.ValueKind == JsonValueKind.False)
                    TextHaloEnabled = false;
                if (root.TryGetProperty("accentColor", out var accent) && accent.ValueKind == JsonValueKind.String)
                    AccentOverride = NormalizeHex(accent.GetString());
                if (root.TryGetProperty("tintColor", out var tint) && tint.ValueKind == JsonValueKind.String)
                    TintOverride = NormalizeHex(tint.GetString());
                if (root.TryGetProperty("textColor", out var text) && text.ValueKind == JsonValueKind.String)
                    TextOverride = NormalizeHex(text.GetString());
            }
            catch
            {
                // 设置文件坏了就用默认深色，不要让启动器起不来
            }
        }

        public static void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath) ?? AppContext.BaseDirectory);
                var json = JsonSerializer.Serialize(new
                {
                    theme = Theme,
                    backdrop = Backdrop,
                    backdropBlur = BackdropBlur,
                    backdropOpacity = BackdropOpacity,
                    surfaceOpacity = SurfaceOpacity,
                    backdropFit = BackdropFit,
                    monet = MonetEnabled,
                    textHalo = TextHaloEnabled,
                    accentColor = AccentOverride,
                    tintColor = TintOverride,
                    textColor = TextOverride,
                }, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(SettingsPath, json);
            }
            catch { }
        }

        public static bool SetTheme(string theme)
        {
            var next = string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase) ? "light" : "dark";
            if (next == Theme) return false;
            Theme = next;
            ApplyTheme();
            Save();
            Changed?.Invoke();
            return true;
        }

        /// <summary>
        /// 切主题只做「换表」：明暗两套完整配色在换图 / 改色 / 拖滑块时已经提前算好，
        /// 点太阳 / 月亮不再重新取色、重新混合，所以字色和面板是同一帧一起变的。
        /// </summary>
        public static void ApplyTheme()
        {
            if (Application.Current == null) return;
            if (!_paletteReady) BuildPalettes();

            var colors = IsDark ? _darkPalette : _lightPalette;
            foreach (var kv in colors)
            {
                var color = kv.Value;
                // 不能原地改：WPF 会把 Application.Resources 里的画刷冻结。
                // 直接换新实例，所有 DynamicResource 引用会跟着刷新。
                Application.Current.Resources[kv.Key] = new SolidColorBrush(color);
            }

            var tint = IsDark ? _darkTint : _lightTint;
            Application.Current.Resources["BackdropTint"] = new SolidColorBrush(tint);
            ApplyTextHalo(IsDark ? _darkHalo : _lightHalo);
            ApplyChromeResources();
        }

        private static void BuildPalettes()
        {
            TryGetMonet();

            // 统一决策点：每次重建都重新判定当前主题是否还能整包生效。
            // 判定只看“当前设置组合下的最终配色”，所以启动、应用、以及改配色 / 换背景 /
            // 切明暗之后的重建结果一致；不合格时连字体和圆角也不上，避免半套外观。
            if (_theme != null)
            {
                _themeReason = ValidateForApply(_theme);
                _themeActive = _themeReason.Length == 0;
            }
            else
            {
                _themeReason = "";
                _themeActive = false;
            }

            var theme = _themeActive ? _theme : null;
            _lightPalette = BuildPalette(false, theme, out _lightTint, out _lightHalo);
            _darkPalette = BuildPalette(true, theme, out _darkTint, out _darkHalo);
            _paletteReady = true;
        }

        private static Dictionary<string, Color> BuildPalette(bool dark, out Color tint, out Color halo)
            => BuildPalette(dark, _themeActive ? _theme : null, out tint, out halo);

        private static Dictionary<string, Color> BuildPalette(bool dark, LauncherTheme theme, out Color tint, out Color halo)
        {
            var map = dark ? Dark : Light;
            var colors = new Dictionary<string, Color>(map.Count);
            foreach (var kv in map) colors[kv.Key] = ParseColor(kv.Value);

            ApplyPalette(colors, dark);
            if (HasBackdrop) ApplyGlassSurfaces(colors, dark);
            ApplyTextPalette(colors, dark);

            // 主题包最后叠：颜色只覆盖语义 token 映射到的那几个键，
            // 顶栏、安全信号色（Ok/Warn/Bad）和主按钮色不在映射表里，改不到。
            // 这里不再做“悄悄丢颜色”的兜底：能不能用由 ValidateForApply 在提交状态前判定，
            // 一旦开始应用就整包生效，避免字体/圆角生效而配色被偷偷换回内置的半套外观。
            if (theme != null) colors = WithThemeColors(colors, theme, dark);

            tint = ResolveTint(colors, dark);
            halo = IsLight(colors["Text"]) ? Colors.Black : Colors.White;
            return colors;
        }

        /// <summary>
        /// 主题色 / 莫奈取色：有背景图时从图里挑一个主色，再把中性面板轻微染上同色相；
        /// 用户手选的主题色优先于莫奈结果。
        /// </summary>
        private static void ApplyPalette(Dictionary<string, Color> colors, bool dark)
        {
            var accent = ResolveAccent(colors, dark);
            colors["Accent"] = accent;
            var bg = colors["Bg"];
            colors["AccentSoft"] = Blend(bg, accent, dark ? 0.16 : 0.12);
            colors["AccentDim"] = Blend(bg, accent, dark ? 0.10 : 0.07);

            if (!HasBackdrop || !MonetEnabled) return;

            // 只染一点点，保留原来的深浅关系；顶栏会在 MainWindow 里单独还原成本色。
            colors["Bg"] = Blend(colors["Bg"], accent, 0.03);
            colors["BgDeep"] = Blend(colors["BgDeep"], accent, 0.03);
            colors["BgNav"] = Blend(colors["BgNav"], accent, 0.04);
            colors["BgTop"] = Blend(colors["BgTop"], accent, 0.04);
            colors["CardBg"] = Blend(colors["CardBg"], accent, 0.07);
            colors["GhostBg"] = Blend(colors["GhostBg"], accent, 0.05);
            colors["GhostHover"] = Blend(colors["GhostHover"], accent, 0.07);
            colors["ChipBg"] = Blend(colors["ChipBg"], accent, 0.05);
            colors["FieldBg"] = Blend(colors["FieldBg"], accent, 0.04);
            colors["PopupBg"] = Blend(colors["PopupBg"], accent, 0.04);
            colors["Surface3"] = Blend(colors["Surface3"], accent, 0.08);
            colors["Hover"] = Blend(colors["Hover"], accent, 0.08);
            colors["TopBtnHover"] = Blend(colors["TopBtnHover"], accent, 0.08);
            colors["Line"] = Blend(colors["Line"], accent, 0.10);
            colors["LineSoft"] = Blend(colors["LineSoft"], accent, 0.09);
            colors["CardBorder"] = Blend(colors["CardBorder"], accent, 0.10);
            colors["FieldBorder"] = Blend(colors["FieldBorder"], accent, 0.08);
            colors["ScrollThumb"] = Blend(colors["ScrollThumb"], accent, 0.10);
        }

        private static Color ResolveAccent(Dictionary<string, Color> colors, bool dark)
        {
            if (!string.IsNullOrEmpty(AccentOverride)) return ParseColor(AccentOverride);
            if (HasBackdrop && MonetEnabled && TryGetMonet()) return MonetAccent(dark);
            return colors["Accent"];
        }

        /// <summary>
        /// 文字色：用户手选优先；否则跟主题走——深色配亮字、浅色配暗字。
        /// 以前按背景图平均亮度翻转文字色，但面板 / 卡片始终是主题色，
        /// 亮图 + 深色主题就会变成「暗字压暗玻璃」，反而看不清。
        /// Text2 / Muted / Dim 朝正文的反色方向退，跟着自定义文字色一起变。
        /// </summary>
        private static void ApplyTextPalette(Dictionary<string, Color> colors, bool dark)
        {
            var hasOverride = !string.IsNullOrEmpty(TextOverride);
            if (!hasOverride && !HasBackdrop) return;

            var text = hasOverride ? ParseColor(TextOverride) : colors["Text"];
            var fade = IsLight(text) ? Colors.Black : Colors.White;

            // 有背景图时底是花的，灰字整体往正文方向收一档，别让说明文字糊进图里。
            var muted = HasBackdrop ? (dark ? 0.18 : 0.14) : 0.30;
            var dim = HasBackdrop ? (dark ? 0.28 : 0.18) : 0.44;

            colors["Text"] = text;
            colors["Text2"] = Blend(text, fade, 0.14);
            colors["Muted"] = Blend(text, fade, muted);
            colors["Dim"] = Blend(text, fade, dim);
        }

        /// <summary>
        /// 整窗蒙版：用户选了遮罩色就按用户的来，否则跟随莫奈。
        /// 厚度跟着背景图的平均亮度走——图越亮，深色主题压得越重；
        /// 浅色主题反过来，暗图多盖一点白，保证深色字始终有底。
        /// </summary>
        private static Color ResolveTint(Dictionary<string, Color> colors, bool dark)
        {
            var tint = colors["Bg"];
            if (!string.IsNullOrEmpty(TintOverride)) tint = ParseColor(TintOverride);
            else if (HasBackdrop && MonetEnabled && TryGetMonet()) tint = MonetTint(dark);

            if (!HasBackdrop)
            {
                tint.A = 0;
                return tint;
            }

            // 莫奈关掉也要统计亮度：蒙版厚度只跟图的明暗有关，跟取不取色无关。
            var lum = TryGetMonet() ? _monetLum : 0.5;
            var k = Math.Clamp((lum - 0.20) / 0.60, 0, 1);   // 0 = 很暗的图，1 = 很亮的图
            var alpha = dark
                ? 0.08 + 0.50 * k
                : 0.08 + 0.18 * (1 - k);
            tint.A = (byte)Math.Round(alpha * 255);
            return tint;
        }

        /// <summary>
        /// 文字描边：文字直接浮在背景图上时，没有底板兜底。把和正文反色的细边走一圈，
        /// 亮天空、暗夜空都能看清；已经调弱，觉得发光可以在设置里直接关掉。
        /// </summary>
        private static void ApplyTextHalo(Color haloColor)
        {
            if (!HasBackdrop || !TextHaloEnabled)
            {
                Application.Current.Resources.Remove("TextHalo");
                return;
            }
            var halo = new DropShadowEffect
            {
                Color = haloColor,
                ShadowDepth = 0,
                BlurRadius = 0.9,
                Opacity = 0.45,
                RenderingBias = RenderingBias.Performance,
            };
            halo.Freeze();
            Application.Current.Resources["TextHalo"] = halo;
        }

        /// <summary>
        /// 有背景图时，把面板 / 卡片 / 输入框改成半透明玻璃：文字仍然在背景上，
        /// 卡片只保留一点点染色和描边，真正挡住背景的只有输入框这种必须看清文字的地方。
        /// </summary>
        private static readonly (string Key, double Min, double Max)[] GlassSurfaces =
        {
            ("BgNav", 0.40, 0.94),
            ("BgTop", 0.55, 0.96),
            ("BgFoot", 0.55, 0.96),
            ("CardBg", 0.00, 0.86),
            ("CardBorder", 0.18, 0.90),
            ("ChipBg", 0.15, 0.88),
            ("GhostBg", 0.15, 0.86),
            ("GhostHover", 0.20, 0.92),
            ("FieldBg", 0.42, 0.92),
            ("FieldBorder", 0.55, 0.95),
            ("PopupBg", 0.90, 0.99),
            ("Surface3", 0.10, 0.82),
            ("Hover", 0.10, 0.82),
            ("TopBtnHover", 0.10, 0.82),
            ("AccentSoft", 0.18, 0.90),
            ("AccentDim", 0.18, 0.90),
            ("Line", 0.20, 0.78),
            ("LineSoft", 0.16, 0.72),
            ("ScrollThumb", 0.25, 0.86),
        };

        private static void ApplyGlassSurfaces(Dictionary<string, Color> colors, bool dark)
        {
            var ratio = Math.Clamp(SurfaceOpacity, 0, 1);
            // 浅色玻璃上的深色字比深色玻璃上的亮字更吃底子：同一档滑块，
            // 浅色主题多给一点不透明度，卡片才立得住，背景图也还透得出来。
            if (!dark) ratio = 0.26 + 0.74 * ratio;
            foreach (var (key, min, max) in GlassSurfaces)
            {
                if (!colors.TryGetValue(key, out var color)) continue;
                color.A = (byte)Math.Round((min + (max - min) * ratio) * 255);
                colors[key] = color;
            }

            // 浅色顶栏单独再透一点：白顶栏压在亮图上会变成一条纯白，跟下面的导航脱节。
            if (!dark && colors.TryGetValue("BgTop", out var topBar))
            {
                topBar.A = (byte)Math.Round(Math.Clamp(0.20 + 0.40 * ratio, 0, 0.90) * 255);
                colors["BgTop"] = topBar;
            }

            // 内容区纸面：桥接 / 设置这些页的正文直接压在图上，暗图 + 浅色主题根本看不清。
            // 纸面厚度跟图片明暗走：暗图盖厚一点，亮图薄一点，图还透得出来。
            if (colors.TryGetValue("BgContent", out var content))
            {
                var k = TryGetMonet() ? Math.Clamp((_monetLum - 0.20) / 0.60, 0, 1) : 0.5;
                var a = (dark ? 0.10 + 0.25 * k : 0.24 + 0.34 * (1 - k)) * (0.55 + 0.45 * ratio);
                content.A = (byte)Math.Round(a * 255);
                colors["BgContent"] = content;
            }
        }

        /// <summary>莫奈取色：统计色相直方图和平均亮度，明暗两套主题共用同一个色相。</summary>
        private static bool TryGetMonet()
        {
            if (!HasBackdrop) return false;
            if (_monetReady && _monetPath == Backdrop) return true;

            var bmp = LoadBackdrop();
            if (bmp == null) return false;

            var weights = new double[36];
            var found = false;
            var hue = 215.0;
            try
            {
                var scale = Math.Min(1.0, 72.0 / Math.Max(bmp.PixelWidth, bmp.PixelHeight));
                BitmapSource small = scale < 1
                    ? new TransformedBitmap(bmp, new ScaleTransform(scale, scale))
                    : bmp;
                if (small.Format != PixelFormats.Bgra32)
                    small = new FormatConvertedBitmap(small, PixelFormats.Bgra32, null, 0);

                int w = small.PixelWidth, h = small.PixelHeight;
                var pixels = new byte[w * h * 4];
                small.CopyPixels(pixels, w * 4, 0);

                double lumSum = 0;
                var lumCount = 0;
                for (var i = 0; i < pixels.Length; i += 4)
                {
                    double b = pixels[i] / 255.0, g = pixels[i + 1] / 255.0, r = pixels[i + 2] / 255.0;
                    lumSum += 0.299 * r + 0.587 * g + 0.114 * b;
                    lumCount++;

                    var max = Math.Max(r, Math.Max(g, b));
                    var min = Math.Min(r, Math.Min(g, b));
                    var delta = max - min;
                    if (max < 0.12 || delta < 0.04 || max <= 0) continue;

                    double hh;
                    if (max == r) hh = 60 * (((g - b) / delta) % 6);
                    else if (max == g) hh = 60 * (((b - r) / delta) + 2);
                    else hh = 60 * (((r - g) / delta) + 4);
                    if (hh < 0) hh += 360;

                    weights[Math.Min(35, (int)(hh / 10))] += (delta / max) * max;
                }

                double best = 0;
                var bestBin = -1;
                for (var i = 0; i < 36; i++)
                {
                    var v = weights[(i + 35) % 36] * 0.25 + weights[i] + weights[(i + 1) % 36] * 0.25;
                    if (v > best)
                    {
                        best = v;
                        bestBin = i;
                    }
                }
                found = bestBin >= 0 && best > 0.4;
                if (found) hue = bestBin * 10 + 5;
                _monetLum = lumCount > 0 ? lumSum / lumCount : 0.5;
            }
            catch { }

            _monetHue = found ? hue : 215;
            _monetPath = Backdrop;
            _monetReady = true;
            return true;
        }

        private static Color MonetAccent(bool dark) =>
            Hsv(_monetHue, dark ? 0.55 : 0.68, dark ? 0.95 : 0.60);

        private static Color MonetTint(bool dark) =>
            Hsv(_monetHue, 0.30, dark ? 0.10 : 0.94);

        private static Color Hsv(double hue, double sat, double val)
        {
            hue = ((hue % 360) + 360) % 360 / 60.0;
            var i = (int)Math.Floor(hue);
            var f = hue - i;
            var p = val * (1 - sat);
            var q = val * (1 - sat * f);
            var t = val * (1 - sat * (1 - f));
            double r, g, b;
            switch (i % 6)
            {
                case 0: r = val; g = t; b = p; break;
                case 1: r = q; g = val; b = p; break;
                case 2: r = p; g = val; b = t; break;
                case 3: r = p; g = q; b = val; break;
                case 4: r = t; g = p; b = val; break;
                default: r = val; g = p; b = q; break;
            }
            return Color.FromRgb((byte)Math.Round(r * 255), (byte)Math.Round(g * 255), (byte)Math.Round(b * 255));
        }

        private static bool IsLight(Color c) => (0.299 * c.R + 0.587 * c.G + 0.114 * c.B) > 140;

        private static Color Blend(Color a, Color b, double amountOfB)
        {
            var t = Math.Clamp(amountOfB, 0, 1);
            return Color.FromRgb(
                (byte)Math.Round(a.R + (b.R - a.R) * t),
                (byte)Math.Round(a.G + (b.G - a.G) * t),
                (byte)Math.Round(a.B + (b.B - a.B) * t));
        }

        private static Color ParseColor(string hex) => (Color)ColorConverter.ConvertFromString(hex);

        /// <summary>取主题本色（不含莫奈 / 自定义），给顶栏做「不跟随配色」的兜底。</summary>
        public static Color BaseColor(string key)
        {
            var map = IsDark ? Dark : Light;
            return map.TryGetValue(key, out var hex) ? ParseColor(hex) : Colors.Transparent;
        }

        /// <summary>
        /// 顶栏专用：颜色仍取主题本色（不跟莫奈染色），但透明度跟当前玻璃档位一致，
        /// 这样有背景图时顶栏也能透出图，而不是一条纯白 / 纯黑的实心带。
        /// </summary>
        public static Color TopBarColor(string key)
        {
            var c = BaseColor(key);
            if (!HasBackdrop) return c;
            var palette = IsDark ? _darkPalette : _lightPalette;
            if (palette != null && palette.TryGetValue(key, out var glass)) c.A = glass.A;
            return c;
        }

        /// <summary>
        /// 没有自选文字色时的默认值：跟主题走，不再按背景图亮度翻转。
        /// 面板和卡片是主题色的，字也跟着主题色才稳定。
        /// </summary>
        private static Color AutoTextColor(bool dark) =>
            dark ? Color.FromRgb(0xF4, 0xF7, 0xFA) : Color.FromRgb(0x0B, 0x12, 0x20);

        public static Color EffectiveColor(string kind)
        {
            var dark = IsDark;
            var map = dark ? Dark : Light;
            switch (kind)
            {
                case "accent":
                    if (!string.IsNullOrEmpty(AccentOverride)) return ParseColor(AccentOverride);
                    if (HasBackdrop && MonetEnabled && TryGetMonet()) return MonetAccent(dark);
                    return ParseColor(map["Accent"]);
                case "tint":
                    if (!string.IsNullOrEmpty(TintOverride)) return ParseColor(TintOverride);
                    if (HasBackdrop && MonetEnabled && TryGetMonet()) return MonetTint(dark);
                    return ParseColor(map["Bg"]);
                default:
                    if (!string.IsNullOrEmpty(TextOverride)) return ParseColor(TextOverride);
                    return AutoTextColor(dark);
            }
        }

        public static string ToHex(Color c) => $"#{c.R:X2}{c.G:X2}{c.B:X2}";

        private static string NormalizeHex(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            try
            {
                var c = ParseColor(value.Trim());
                return ToHex(c);
            }
            catch
            {
                return "";
            }
        }

        public static bool TrySetBackdrop(string path, out string error)
        {
            error = "";
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                error = "找不到这张图片。";
                return false;
            }
            BitmapImage bmp;
            try
            {
                bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
                bmp.UriSource = new Uri(path, UriKind.Absolute);
                bmp.DecodePixelWidth = 1920;
                bmp.EndInit();
                bmp.Freeze();
            }
            catch (Exception ex)
            {
                error = "这张图片读不了：" + ex.Message;
                return false;
            }

            // 校验时已经解码过，直接当缓存用，不再读第二遍。
            Backdrop = path;
            _bitmapCache = bmp;
            _bitmapCachePath = path;
            InvalidateMonet();
            ApplyTheme();
            Save();
            Changed?.Invoke();
            return true;
        }

        public static void ClearBackdrop()
        {
            if (string.IsNullOrEmpty(Backdrop)) return;
            Backdrop = "";
            _bitmapCache = null;
            _bitmapCachePath = "";
            InvalidateMonet();
            ApplyTheme();
            Save();
            Changed?.Invoke();
        }

        private static void InvalidateMonet()
        {
            _monetReady = false;
            _monetPath = "";
            _paletteReady = false;
        }

        private static void InvalidatePalette() => _paletteReady = false;

        // ── 主题包接入 ────────────────────────────────────────────

        /// <summary>
        /// 启动时读回上次保存的主题。只有文件坏 / 内容非法才当“没有主题”；
        /// 内容合法但当前设置组合下最终对比度不合格时，主题仍留在内存里（只是不生效），
        /// 由 BuildPalettes 记录原因，用户调回配色或背景后会自动恢复。
        /// </summary>
        public static void LoadThemePackage()
        {
            _theme = LauncherThemes.LoadActive(ThemeFilePath, out _themeOwner);
            _themeActive = false;
            _themeReason = "";
            _paletteReady = false;
        }

        /// <summary>
        /// 应用并保存主题。先在内存里把明暗两套最终配色都算一遍并验对比度，
        /// 通过后先把文件原子写盘，最后才提交内存状态：任何一步失败都保持原外观，
        /// 不存在“报告成功但只生效一半”或“重启后换了另一套”的情况。
        /// </summary>
        internal static bool SetThemePackage(LauncherTheme theme, out string error, string owner = "")
        {
            error = "";
            var problem = ValidateForApply(theme);
            if (problem.Length > 0)
            {
                error = problem;
                return false;
            }
            if (!LauncherThemes.Save(ThemeFilePath, theme, owner))
            {
                error = "没能写进 data 目录，已保持原外观；请检查目录权限或磁盘空间。";
                return false;
            }

            _theme = theme;
            _themeOwner = owner;
            InvalidatePalette();
            ApplyTheme();
            Changed?.Invoke();
            return true;
        }

        /// <summary>
        /// 停用主题包：先删持久化文件，删成功才切回内置外观。
        /// 删不掉就如实返回失败（重启后它会重新生效），不做“看起来停用了”的假动作。
        /// </summary>
        internal static bool ClearThemePackage(out string error)
        {
            error = "";
            var hadTheme = _theme != null;
            var hadFile = File.Exists(ThemeFilePath);
            if (!hadTheme && !hadFile) return true;
            if (!LauncherThemes.Remove(ThemeFilePath))
            {
                error = "删不掉 data\\" + LauncherThemes.FileName + "，主题在重启后仍会生效；请先关闭占用该文件的程序或手动删除。";
                return false;
            }

            _theme = null;
            _themeActive = false;
            _themeReason = "";
            _themeOwner = "";
            InvalidatePalette();
            ApplyTheme();
            Changed?.Invoke();
            return true;
        }

        /// <summary>
        /// 提交状态前的唯一验收点：主题自己声明的颜色对，加上叠进现有明暗 / 玻璃关系后的
        /// 最终配色，任何一套不清楚就整包拒绝。返回空串表示可以应用。
        /// </summary>
        private static string ValidateForApply(LauncherTheme theme)
        {
            if (theme == null) return "没有可应用的主题包。";
            var problem = LauncherThemes.ContrastProblem(theme);
            if (problem.Length > 0) return problem;
            foreach (var dark in new[] { true, false })
            {
                var colors = BuildPalette(dark, theme, out _, out _);
                if (!ContrastOk(colors)) return (dark ? "深色" : "浅色") + "下最终对比度不足，主题包未应用。";
            }
            return "";
        }

        /// <summary>
        /// 主题色叠加层。只写映射表里的键，返回新字典；原字典保持不变，
        /// 这样对比度闸不通过时可以整包丢弃。
        /// </summary>
        private static Dictionary<string, Color> WithThemeColors(Dictionary<string, Color> colors, LauncherTheme theme, bool dark)
        {
            var next = new Dictionary<string, Color>(colors);
            var accent = theme.HasColor("accent") ? ParseColor(theme.Colors["accent"]) : colors["Accent"];
            var background = theme.HasColor("background") ? ParseColor(theme.Colors["background"]) : colors["Bg"];
            var surface = theme.HasColor("surface") ? ParseColor(theme.Colors["surface"]) : colors["CardBg"];
            var text = theme.HasColor("text") ? ParseColor(theme.Colors["text"]) : colors["Text"];
            var border = theme.HasColor("border") ? ParseColor(theme.Colors["border"]) : colors["CardBorder"];
            var field = theme.HasColor("field") ? ParseColor(theme.Colors["field"]) : colors["FieldBg"];
            var fade = IsLight(text) ? Colors.Black : Colors.White;

            // 淡色 / 玻璃层沿用原配色的 alpha：主题只决定色相，不改变“透多少”。
            next["Accent"] = accent;
            next["AccentSoft"] = Blend(background, accent, dark ? 0.16 : 0.12);
            next["AccentDim"] = Blend(background, accent, dark ? 0.10 : 0.07);
            next["Bg"] = KeepAlpha(background, colors["Bg"]);
            next["BgDeep"] = KeepAlpha(Blend(background, dark ? Colors.Black : Colors.White, 0.10), colors["BgDeep"]);
            next["BgContent"] = KeepAlpha(background, colors["BgContent"]);
            next["BgNav"] = KeepAlpha(Blend(background, accent, 0.04), colors["BgNav"]);
            next["CardBg"] = KeepAlpha(surface, colors["CardBg"]);
            next["PopupBg"] = KeepAlpha(surface, colors["PopupBg"]);
            next["ChipBg"] = KeepAlpha(Blend(surface, background, 0.35), colors["ChipBg"]);
            next["GhostBg"] = KeepAlpha(Blend(surface, background, 0.25), colors["GhostBg"]);
            next["GhostHover"] = KeepAlpha(Blend(surface, accent, 0.10), colors["GhostHover"]);
            next["Surface3"] = KeepAlpha(Blend(surface, background, 0.15), colors["Surface3"]);
            next["Hover"] = KeepAlpha(Blend(surface, accent, 0.10), colors["Hover"]);
            next["Text"] = KeepAlpha(text, colors["Text"]);
            next["Text2"] = Blend(text, fade, 0.14);
            next["Muted"] = theme.HasColor("muted") ? ParseColor(theme.Colors["muted"]) : Blend(text, fade, 0.30);
            next["Dim"] = Blend(text, fade, 0.44);
            next["Line"] = KeepAlpha(border, colors["Line"]);
            next["LineSoft"] = KeepAlpha(Blend(border, background, 0.50), colors["LineSoft"]);
            next["CardBorder"] = KeepAlpha(border, colors["CardBorder"]);
            next["FieldBorder"] = KeepAlpha(border, colors["FieldBorder"]);
            next["FieldBg"] = KeepAlpha(field, colors["FieldBg"]);
            next["ScrollThumb"] = KeepAlpha(Blend(field, background, 0.35), colors["ScrollThumb"]);
            return next;
        }

        private static Color KeepAlpha(Color color, Color alphaFrom)
            => Color.FromArgb(alphaFrom.A, color.R, color.G, color.B);

        /// <summary>最终配色闸：正文 / 次要文字 / 强调色对底色都要够清楚。</summary>
        private static bool ContrastOk(Dictionary<string, Color> colors)
            => ContrastRatio(colors["Text"], colors["Bg"]) >= LauncherThemes.TextContrast
            && ContrastRatio(colors["Text2"], colors["Bg"]) >= LauncherThemes.AccentContrast
            && ContrastRatio(colors["Accent"], colors["Bg"]) >= LauncherThemes.AccentContrast
            && ContrastRatio(colors["Text"], colors["CardBg"]) >= LauncherThemes.TextContrast;

        private static double ContrastRatio(Color first, Color second)
            => LauncherThemes.Ratio(Rgb(first), Rgb(second));

        private static uint Rgb(Color color)
            => 0xFF000000u | ((uint)color.R << 16) | ((uint)color.G << 8) | color.B;

        /// <summary>
        /// 字号 / 圆角 / 内边距：App.xaml 里用 DynamicResource 引用这些键，
        /// 所以换主题时已经建好的页面也会跟着刷新。默认值取自 ChromeDefaults，
        /// 和 App.xaml 里那组资源是同一套数字。
        /// </summary>
        private static void ApplyChromeResources()
        {
            if (Application.Current == null) return;
            var resources = Application.Current.Resources;
            var font = FontScale;
            var spacing = SpacingScale;
            var cornerRatio = HasTheme && _theme.Corner >= 0 ? _theme.Corner / 18.0 : 1.0;

            foreach (var kv in ChromeDefaults())
            {
                resources[kv.Key] = kv.Value switch
                {
                    double size => size * font,
                    CornerRadius radius => new CornerRadius(ScaledCorner(radius.TopLeft, cornerRatio)),
                    Thickness pad => new Thickness(pad.Left * spacing, pad.Top * spacing,
                        pad.Right * spacing, pad.Bottom * spacing),
                    _ => kv.Value,
                };
            }
        }

        private static double ScaledCorner(double baseValue, double ratio)
            => Math.Round(Math.Clamp(baseValue * ratio, 0, 28), 1);

        /// <summary>
        /// 授权 / 更新 / 安全确认用的局部内置资源：把当前明暗主题的**本色**画刷和
        /// 尺寸 token 的默认值打包成一份 ResourceDictionary，挂到弹窗卡片上。
        /// 这样弹窗子树里所有 DynamicResource（字体字号、圆角、内边距、按钮 hover 态、
        /// 危险色）都会在这里命中，不再继承主题包的字体和尺寸。
        /// </summary>
        internal static Dictionary<string, object> DialogSafeResources()
        {
            var map = new Dictionary<string, object>(StringComparer.Ordinal);
            var colors = IsDark ? Dark : Light;
            foreach (var kv in colors) map[kv.Key] = new SolidColorBrush(ParseColor(kv.Value));
            foreach (var kv in ChromeDefaults()) map[kv.Key] = kv.Value;

            // 文字描边取色跟正文亮暗走，主题改过正文色时不能让确认框继续用主题的描边：
            // 正文是亮色就描黑边、暗色就描白边，和内置外观一致。用户关掉描边时不强加。
            var text = ParseColor(colors["Text"]);
            if (Application.Current?.Resources.Contains("TextHalo") == true)
            {
                var halo = new DropShadowEffect
                {
                    Color = LauncherThemes.Luminance(Rgb(text)) > 0.55 ? Colors.Black : Colors.White,
                    ShadowDepth = 0,
                    BlurRadius = 0.9,
                    Opacity = 0.7,
                    RenderingBias = RenderingBias.Performance,
                };
                halo.Freeze();
                map["TextHalo"] = halo;
            }
            return map;
        }

        /// <summary>尺寸 token 的默认值；必须和 App.xaml 里那组资源保持一致。</summary>
        private static Dictionary<string, object> ChromeDefaults() => new(StringComparer.Ordinal)
        {
            ["FontSizeH1"] = 30.0,
            ["FontSizeH2"] = 13.5,
            ["FontSizeLabel"] = 12.0,
            ["FontSizeSmall"] = 11.0,
            ["FontSizeValue"] = 13.5,
            ["FontSizeBody"] = 12.5,
            ["FontSizeControl"] = 12.0,
            ["FontSizeField"] = 12.5,
            ["RadiusChip"] = new CornerRadius(9),
            ["RadiusCard"] = new CornerRadius(18),
            ["RadiusButton"] = new CornerRadius(10),
            ["RadiusTopButton"] = new CornerRadius(8),
            ["RadiusField"] = new CornerRadius(8),
            ["RadiusNav"] = new CornerRadius(10),
            ["RadiusComboItem"] = new CornerRadius(7),
            ["PadChip"] = new Thickness(11, 0, 11, 0),
            ["PadPrimary"] = new Thickness(16, 9, 16, 9),
            ["PadGhost"] = new Thickness(14, 7, 14, 7),
            ["PadTopBtn"] = new Thickness(10, 5, 10, 5),
        };

        public static void SetBackdropBlur(double radius)
        {
            radius = Math.Clamp(radius, 0, 60);
            if (Math.Abs(radius - BackdropBlur) < 0.01) return;
            BackdropBlur = radius;
            Save();
            Changed?.Invoke();
        }

        public static void SetBackdropFit(string fit)
        {
            var next = fit switch
            {
                "stretch" => "stretch",
                "uniform" => "uniform",
                _ => "fill",
            };
            if (next == BackdropFit) return;
            BackdropFit = next;
            Save();
            Changed?.Invoke();
        }

        public static void SetBackdropOpacity(double opacity)
        {
            opacity = Math.Clamp(opacity, 0, 1);
            if (Math.Abs(opacity - BackdropOpacity) < 0.001) return;
            BackdropOpacity = opacity;
            InvalidatePalette();
            ApplyTheme();
            Save();
            Changed?.Invoke();
        }

        public static void SetSurfaceOpacity(double opacity)
        {
            opacity = Math.Clamp(opacity, 0, 1);
            if (Math.Abs(opacity - SurfaceOpacity) < 0.001) return;
            SurfaceOpacity = opacity;
            InvalidatePalette();
            ApplyTheme();
            Save();
            Changed?.Invoke();
        }

        public static void SetMonet(bool enabled)
        {
            if (enabled == MonetEnabled) return;
            MonetEnabled = enabled;
            InvalidatePalette();
            ApplyTheme();
            Save();
            Changed?.Invoke();
        }

        public static void SetTextHalo(bool enabled)
        {
            if (enabled == TextHaloEnabled) return;
            TextHaloEnabled = enabled;
            ApplyTheme();
            Save();
            Changed?.Invoke();
        }

        public static void RefreshMonet()
        {
            InvalidateMonet();
            ApplyTheme();
            Changed?.Invoke();
        }

        public static bool SetPaletteColor(string kind, string hex)
        {
            var normalized = NormalizeHex(hex);
            if (normalized.Length == 0) return false;
            switch (kind)
            {
                case "accent": AccentOverride = normalized; break;
                case "tint": TintOverride = normalized; break;
                case "text": TextOverride = normalized; break;
                default: return false;
            }
            InvalidatePalette();
            ApplyTheme();
            Save();
            Changed?.Invoke();
            return true;
        }

        public static void ClearPaletteColor(string kind)
        {
            switch (kind)
            {
                case "accent": AccentOverride = ""; break;
                case "tint": TintOverride = ""; break;
                case "text": TextOverride = ""; break;
                default: return;
            }
            InvalidatePalette();
            ApplyTheme();
            Save();
            Changed?.Invoke();
        }

        public static void ResetPalette()
        {
            AccentOverride = "";
            TintOverride = "";
            TextOverride = "";
            MonetEnabled = true;
            TextHaloEnabled = true;
            InvalidatePalette();
            ApplyTheme();
            Save();
            Changed?.Invoke();
        }

        public static BitmapImage LoadBackdrop()
        {
            if (!HasBackdrop) return null;
            if (_bitmapCache != null && _bitmapCachePath == Backdrop) return _bitmapCache;
            try
            {
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
                bmp.UriSource = new Uri(Backdrop, UriKind.Absolute);
                bmp.DecodePixelWidth = 1920;
                bmp.EndInit();
                bmp.Freeze();
                _bitmapCache = bmp;
                _bitmapCachePath = Backdrop;
                return bmp;
            }
            catch
            {
                return null;
            }
        }
    }
}
