using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace WhaleLauncher
{
    /// <summary>
    /// 插件 README 的受限 Markdown 内容。图片与链接都由调用方注入：
    /// 查看器自己不联网、不碰文件系统，只负责把已经拿到的字节解码成控件。
    /// </summary>
    internal sealed class PluginReadmeContent
    {
        public string Markdown { get; set; } = "";
        public string SourceLabel { get; set; } = "";

        /// <summary>按图片标识（Markdown 里写的地址）取字节；返回 null/异常都由查看器降级成占位。</summary>
        public Func<string, CancellationToken, Task<PluginReadmeResource>> LoadImage { get; set; }

        /// <summary>只对 https 链接调用；查看器不会自己打开浏览器。</summary>
        public Action<string> OpenLink { get; set; }
    }

    /// <summary>图片加载结果：有 Error 就显示占位，Bytes 为空也按失败处理。</summary>
    internal sealed record PluginReadmeResource(byte[] Bytes, string ContentType, string Error)
    {
        public static PluginReadmeResource Failure(string error) => new(null, null, error);
    }

    /// <summary>资源与规模上限。超限一律显示占位，不抛给调用方。</summary>
    internal static class PluginReadmeLimits
    {
        internal const int MaxMarkdownBytes = 512 * 1024;
        internal const int MaxBlocks = 2000;
        internal const int MaxImageBytes = 2 * 1024 * 1024;
        internal const int MaxImageDimension = 4096;
        internal const long MaxImagePixels = 4096L * 4096L;
        internal const int MaxGifFrames = 300;
        internal const int DefaultGifDelayMs = 100;
    }

    internal enum PluginReadmeBlockKind { Heading, Paragraph, List, Code }

    internal sealed class PluginReadmeBlock
    {
        public PluginReadmeBlockKind Kind;
        public int Level;
        public string Text = "";
        public bool Ordered;
        public readonly List<string> Items = new List<string>();
    }

    /// <summary>
    /// 只认下面这几样语法，剩下的按纯文本渲染：
    /// 标题、段落、有序/无序列表、行内代码、代码块、加粗、斜体、https 链接、图片。
    /// 为什么自己写：不能引入 Markdown 库（零依赖），也不想为一张 README 塞 WebView。
    /// </summary>
    internal static class PluginReadmeMarkdown
    {
        private static readonly Regex HeadingPattern = new Regex(@"^(#{1,6})\s+(.*)$", RegexOptions.Compiled);
        private static readonly Regex BulletPattern = new Regex(@"^\s{0,3}[-*+]\s+(.*)$", RegexOptions.Compiled);
        private static readonly Regex OrderedPattern = new Regex(@"^\s{0,3}(\d{1,3})[.)]\s+(.*)$", RegexOptions.Compiled);

        internal static List<PluginReadmeBlock> Parse(string markdown)
        {
            var blocks = new List<PluginReadmeBlock>();
            if (string.IsNullOrWhiteSpace(markdown)) return blocks;

            var text = markdown.Replace("\r\n", "\n").Replace('\r', '\n');
            if (Encoding.UTF8.GetByteCount(text) > PluginReadmeLimits.MaxMarkdownBytes)
                text = TruncateToBytes(text, PluginReadmeLimits.MaxMarkdownBytes);

            var paragraph = new StringBuilder();
            PluginReadmeBlock list = null;

            void FlushParagraph()
            {
                if (paragraph.Length == 0) return;
                blocks.Add(new PluginReadmeBlock
                {
                    Kind = PluginReadmeBlockKind.Paragraph,
                    Text = paragraph.ToString().Trim(),
                });
                paragraph.Clear();
            }

            void FlushList()
            {
                if (list == null) return;
                if (list.Items.Count > 0) blocks.Add(list);
                list = null;
            }

            var lines = text.Split('\n');
            for (var i = 0; i < lines.Length && blocks.Count < PluginReadmeLimits.MaxBlocks; i++)
            {
                var line = lines[i];
                var trimmed = line.Trim();

                if (trimmed.StartsWith("```", StringComparison.Ordinal))
                {
                    FlushParagraph();
                    FlushList();
                    var code = new StringBuilder();
                    i++;
                    while (i < lines.Length && !lines[i].Trim().StartsWith("```", StringComparison.Ordinal))
                    {
                        code.AppendLine(lines[i]);
                        i++;
                    }
                    blocks.Add(new PluginReadmeBlock
                    {
                        Kind = PluginReadmeBlockKind.Code,
                        Text = code.ToString().TrimEnd('\n'),
                    });
                    continue;
                }

                if (trimmed.Length == 0)
                {
                    FlushParagraph();
                    FlushList();
                    continue;
                }

                var heading = HeadingPattern.Match(line);
                if (heading.Success)
                {
                    FlushParagraph();
                    FlushList();
                    blocks.Add(new PluginReadmeBlock
                    {
                        Kind = PluginReadmeBlockKind.Heading,
                        Level = heading.Groups[1].Value.Length,
                        Text = heading.Groups[2].Value.Trim(),
                    });
                    continue;
                }

                var ordered = OrderedPattern.Match(line);
                if (ordered.Success)
                {
                    FlushParagraph();
                    if (list == null || !list.Ordered)
                    {
                        FlushList();
                        list = new PluginReadmeBlock { Kind = PluginReadmeBlockKind.List, Ordered = true };
                    }
                    list.Items.Add(ordered.Groups[2].Value.Trim());
                    continue;
                }

                var bullet = BulletPattern.Match(line);
                if (bullet.Success)
                {
                    FlushParagraph();
                    if (list == null || list.Ordered)
                    {
                        FlushList();
                        list = new PluginReadmeBlock { Kind = PluginReadmeBlockKind.List, Ordered = false };
                    }
                    list.Items.Add(bullet.Groups[1].Value.Trim());
                    continue;
                }

                FlushList();
                if (paragraph.Length > 0) paragraph.Append(' ');
                paragraph.Append(trimmed);
            }

            FlushParagraph();
            FlushList();
            return blocks;
        }

        /// <summary>按 UTF-8 字节数截断：超长说明只渲染前半部分，避免大文档拖住 UI 线程。</summary>
        private static string TruncateToBytes(string text, int maxBytes)
        {
            var bytes = 0;
            var index = 0;
            while (index < text.Length)
            {
                var size = Encoding.UTF8.GetByteCount(text.Substring(index, 1));
                if (bytes + size > maxBytes) break;
                bytes += size;
                index++;
            }
            return text.Substring(0, index);
        }
    }

    /// <summary>
    /// 受限 Markdown / 图片查看器：WPF 原生控件，不执行 HTML、不跑脚本、不联网。
    /// 生命周期按「打开一次 = 一代」处理：ShowAsync 开新代并取消上一代，Close 取消在途、
    /// 停 GIF 计时器、清空控件，重复调用安全。
    /// </summary>
    internal sealed class PluginReadmeView : UserControl
    {
        private static readonly Regex ImagePattern = new Regex(@"!\[([^\]]*)\]\(([^)\s]+)\)", RegexOptions.Compiled);
        private static readonly Regex LinkPattern = new Regex(@"\[([^\]]+)\]\(([^)\s]+)\)", RegexOptions.Compiled);

        private readonly ScrollViewer _scroll;
        private readonly StackPanel _stack;
        private readonly List<GifPlayer> _players = new List<GifPlayer>();
        private CancellationTokenSource _generation;
        private Action<string> _openLink;
        private bool _closed;

        public PluginReadmeView()
        {
            _stack = new StackPanel { Margin = new Thickness(2, 0, 6, 8) };
            _scroll = new ScrollViewer
            {
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Content = _stack,
            };
            Content = _scroll;
            IsVisibleChanged += (_, __) => SyncPlayers();
            Unloaded += (_, __) => StopPlayers();
        }

        /// <summary>渲染一份 README。失败只显示占位文案，不向调用方抛异常。</summary>
        public Task ShowAsync(PluginReadmeContent content)
        {
            try
            {
                BeginGeneration();
                _openLink = content?.OpenLink;
                var markdown = content?.Markdown ?? "";
                var label = content?.SourceLabel ?? "";
                if (!string.IsNullOrWhiteSpace(label))
                {
                    var caption = new TextBlock
                    {
                        Text = label,
                        Opacity = 0.65,
                        FontSize = 11,
                        Margin = new Thickness(0, 0, 0, 8),
                        TextWrapping = TextWrapping.Wrap,
                    };
                    _stack.Children.Add(caption);
                }

                if (string.IsNullOrWhiteSpace(markdown))
                {
                    _stack.Children.Add(Note("这份说明是空的。"));
                    return Task.CompletedTask;
                }

                if (Encoding.UTF8.GetByteCount(markdown) > PluginReadmeLimits.MaxMarkdownBytes)
                {
                    _stack.Children.Add(Note("说明超过 512 KiB 上限，只显示前半部分。"));
                }

                var blocks = PluginReadmeMarkdown.Parse(markdown);
                if (blocks.Count == 0)
                {
                    _stack.Children.Add(Note("这份说明没有可显示的内容。"));
                    return Task.CompletedTask;
                }

                var rendered = 0;
                foreach (var block in blocks)
                {
                    if (rendered++ >= PluginReadmeLimits.MaxBlocks)
                    {
                        _stack.Children.Add(Note("内容过多，后面的部分已省略。"));
                        break;
                    }
                    try
                    {
                        RenderBlock(block, content);
                    }
                    catch (Exception ex)
                    {
                        _stack.Children.Add(Note("这一块没能显示：" + ex.Message));
                    }
                }
            }
            catch (Exception ex)
            {
                try
                {
                    _stack.Children.Clear();
                    _stack.Children.Add(Note("说明无法显示：" + ex.Message));
                }
                catch { /* 界面已经不可用，不再二次抛错 */ }
            }
            return Task.CompletedTask;
        }

        /// <summary>取消在途、停表、清控件；重复调用安全。</summary>
        public void Close()
        {
            if (_closed) return;
            _closed = true;
            try { _generation?.Cancel(); } catch { /* 已释放 */ }
            StopPlayers();
            try
            {
                foreach (var child in _stack.Children)
                    if (child is Image image) image.Source = null;
                _stack.Children.Clear();
            }
            catch { /* 视觉树已被拆掉 */ }
        }

        private void BeginGeneration()
        {
            _closed = false;
            try { _generation?.Cancel(); } catch { }
            _generation?.Dispose();
            _generation = new CancellationTokenSource();
            StopPlayers();
            _stack.Children.Clear();
        }

        private void RenderBlock(PluginReadmeBlock block, PluginReadmeContent content)
        {
            switch (block.Kind)
            {
                case PluginReadmeBlockKind.Heading:
                    {
                        var text = new TextBlock
                        {
                            FontSize = HeadingSize(block.Level),
                            FontWeight = FontWeights.SemiBold,
                            TextWrapping = TextWrapping.Wrap,
                            Margin = new Thickness(0, block.Level <= 2 ? 14 : 10, 0, 6),
                        };
                        AppendInline(text, block.Text);
                        _stack.Children.Add(text);
                        break;
                    }
                case PluginReadmeBlockKind.Code:
                    {
                        var box = new Border
                        {
                            Background = ThemeBrush("Surface3", Color.FromRgb(0x1B, 0x1F, 0x23)),
                            BorderBrush = ThemeBrush("Line", Color.FromRgb(0x2C, 0x33, 0x3A)),
                            BorderThickness = new Thickness(1),
                            CornerRadius = new CornerRadius(6),
                            Padding = new Thickness(10, 8, 10, 8),
                            Margin = new Thickness(0, 4, 0, 8),
                            Child = new TextBlock
                            {
                                Text = block.Text,
                                FontFamily = MonoFont(),
                                FontSize = 12,
                                TextWrapping = TextWrapping.Wrap,
                            },
                        };
                        _stack.Children.Add(box);
                        break;
                    }
                case PluginReadmeBlockKind.List:
                    {
                        var panel = new StackPanel { Margin = new Thickness(0, 2, 0, 6) };
                        for (var i = 0; i < block.Items.Count; i++)
                        {
                            var row = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 2) };
                            row.Inlines.Add(new Run(block.Ordered ? (i + 1) + ". " : "• ") { FontWeight = FontWeights.SemiBold });
                            AppendInline(row, block.Items[i]);
                            panel.Children.Add(row);
                        }
                        _stack.Children.Add(panel);
                        break;
                    }
                default:
                    RenderParagraph(block.Text, content);
                    break;
            }
        }

        private void RenderParagraph(string text, PluginReadmeContent content)
        {
            // 图片单独成块，避免 InlineUIContainer 在长段落里把行高撑乱。
            var last = 0;
            foreach (Match match in ImagePattern.Matches(text))
            {
                var before = text.Substring(last, match.Index - last).Trim();
                if (before.Length > 0)
                {
                    var paragraph = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 6) };
                    AppendInline(paragraph, before);
                    _stack.Children.Add(paragraph);
                }
                RenderImage(match.Groups[1].Value.Trim(), match.Groups[2].Value.Trim(), content);
                last = match.Index + match.Length;
            }
            var tail = text.Substring(last).Trim();
            if (tail.Length == 0) return;
            var block = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 6) };
            AppendInline(block, tail);
            _stack.Children.Add(block);
        }

        private void RenderImage(string alt, string target, PluginReadmeContent content)
        {
            var caption = string.IsNullOrWhiteSpace(alt) ? "图片" : alt;
            var host = new Border
            {
                Background = ThemeBrush("Surface3", Color.FromRgb(0x18, 0x1C, 0x20)),
                BorderBrush = ThemeBrush("Line", Color.FromRgb(0x2C, 0x33, 0x3A)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Padding = new Thickness(10, 8, 10, 8),
                Margin = new Thickness(0, 4, 0, 8),
                HorizontalAlignment = HorizontalAlignment.Left,
                MaxWidth = 720,
                Child = new TextBlock
                {
                    Text = "正在加载图片…（" + caption + "）",
                    TextWrapping = TextWrapping.Wrap,
                    Opacity = 0.75,
                    FontSize = 12,
                },
            };
            _stack.Children.Add(host);
            _ = LoadImageAsync(target, caption, host, content);
        }

        private async Task LoadImageAsync(string target, string caption, Border host, PluginReadmeContent content)
        {
            var token = _generation;
            try
            {
                var loader = content?.LoadImage;
                if (loader == null)
                {
                    ShowImagePlaceholder(host, caption, "这个页面没有提供图片加载器。");
                    return;
                }
                if (string.IsNullOrWhiteSpace(target))
                {
                    ShowImagePlaceholder(host, caption, "图片地址是空的。");
                    return;
                }

                var resource = await loader(target, token?.Token ?? CancellationToken.None);
                if (token == null || token.IsCancellationRequested || _closed) return;
                if (resource == null)
                {
                    ShowImagePlaceholder(host, caption, "没有拿到图片数据。");
                    return;
                }
                if (!string.IsNullOrWhiteSpace(resource.Error))
                {
                    ShowImagePlaceholder(host, caption, resource.Error);
                    return;
                }
                var bytes = resource.Bytes;
                if (bytes == null || bytes.Length == 0)
                {
                    ShowImagePlaceholder(host, caption, "图片数据是空的。");
                    return;
                }
                if (bytes.Length > PluginReadmeLimits.MaxImageBytes)
                {
                    ShowImagePlaceholder(host, caption, "图片超过 2 MiB 上限，已跳过。");
                    return;
                }

                if (IsGif(bytes)) ShowGif(bytes, caption, host);
                else ShowStill(bytes, caption, host);
            }
            catch (OperationCanceledException) { /* 关闭或换代，正常路径 */ }
            catch (Exception ex)
            {
                if (token == null || token.IsCancellationRequested || _closed) return;
                ShowImagePlaceholder(host, caption, "图片无法显示：" + ex.Message);
            }
        }

        private void ShowStill(byte[] bytes, string caption, Border host)
        {
            var bitmap = new BitmapImage();
            using (var stream = new MemoryStream(bytes, false))
            {
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.StreamSource = stream;
                bitmap.EndInit();
            }
            if (TooLarge(bitmap.PixelWidth, bitmap.PixelHeight))
            {
                ShowImagePlaceholder(host, caption, "图片尺寸超过 4096×4096 上限，已跳过。");
                return;
            }
            bitmap.Freeze();
            host.Padding = new Thickness(4);
            host.Child = new Image
            {
                Source = bitmap,
                Stretch = Stretch.Uniform,
                MaxWidth = 704,
                MaxHeight = 480,
                ToolTip = caption,
            };
        }

        private void ShowGif(byte[] bytes, string caption, Border host)
        {
            GifBitmapDecoder decoder;
            using (var stream = new MemoryStream(bytes, false))
            {
                decoder = new GifBitmapDecoder(
                    stream,
                    BitmapCreateOptions.PreservePixelFormat | BitmapCreateOptions.IgnoreImageCache,
                    BitmapCacheOption.OnLoad);
            }

            var frames = decoder.Frames;
            if (frames.Count == 0)
            {
                ShowImagePlaceholder(host, caption, "GIF 里没有可用的帧。");
                return;
            }
            if (frames.Count > PluginReadmeLimits.MaxGifFrames)
            {
                ShowImagePlaceholder(host, caption, "GIF 帧数超过 300 上限，已跳过。");
                return;
            }
            for (var i = 0; i < frames.Count; i++)
            {
                if (TooLarge(frames[i].PixelWidth, frames[i].PixelHeight))
                {
                    ShowImagePlaceholder(host, caption, "GIF 帧尺寸超过 4096×4096 上限，已跳过。");
                    return;
                }
            }

            var image = new Image
            {
                Stretch = Stretch.Uniform,
                MaxWidth = 704,
                MaxHeight = 480,
                ToolTip = caption + "（GIF）",
                Source = frames[0],
            };
            host.Padding = new Thickness(4);
            host.Child = image;

            var player = new GifPlayer
            {
                Image = image,
                Frames = frames,
                Delays = ReadGifDelays(frames),
                Index = 0,
            };
            player.Timer = new DispatcherTimer(DispatcherPriority.Background, Dispatcher)
            {
                Interval = TimeSpan.FromMilliseconds(player.Delays[0]),
            };
            player.Timer.Tick += (_, __) => Advance(player);
            _players.Add(player);
            if (IsVisible) player.Timer.Start();
        }

        private void Advance(GifPlayer player)
        {
            if (_closed || player.Frames.Count == 0) return;
            player.Index = (player.Index + 1) % player.Frames.Count;
            try { player.Image.Source = player.Frames[player.Index]; }
            catch { return; }
            player.Timer.Interval = TimeSpan.FromMilliseconds(player.Delays[player.Index]);
        }

        private static int[] ReadGifDelays(ReadOnlyCollection<BitmapFrame> frames)
        {
            var delays = new int[frames.Count];
            for (var i = 0; i < frames.Count; i++)
            {
                var delay = PluginReadmeLimits.DefaultGifDelayMs;
                try
                {
                    if (frames[i].Metadata is BitmapMetadata metadata)
                    {
                        var raw = metadata.GetQuery("/grctlext/Delay");
                        if (raw is ushort value && value > 0)
                            delay = Math.Clamp(value * 10, 20, 1000);
                    }
                }
                catch { /* 帧没有延时元数据：用默认值 */ }
                delays[i] = delay;
            }
            return delays;
        }

        private void SyncPlayers()
        {
            if (_closed) return;
            foreach (var player in _players)
            {
                try
                {
                    if (IsVisible)
                    {
                        if (!player.Timer.IsEnabled) player.Timer.Start();
                    }
                    else player.Timer.Stop();
                }
                catch { /* 计时器已停 */ }
            }
        }

        private void StopPlayers()
        {
            foreach (var player in _players)
            {
                try { player.Timer.Stop(); } catch { }
                try { player.Image.Source = null; } catch { }
                try { player.Frames = null; } catch { }
            }
            _players.Clear();
        }

        private void ShowImagePlaceholder(Border host, string caption, string reason)
        {
            if (host == null) return;
            host.Padding = new Thickness(10, 8, 10, 8);
            host.Child = new TextBlock
            {
                Text = "［图片未显示］" + caption + "\n" + reason,
                TextWrapping = TextWrapping.Wrap,
                Opacity = 0.75,
                FontSize = 12,
            };
        }

        private static bool IsGif(byte[] bytes)
            => bytes.Length >= 3 && bytes[0] == (byte)'G' && bytes[1] == (byte)'I' && bytes[2] == (byte)'F';

        private static bool TooLarge(int width, int height)
        {
            if (width <= 0 || height <= 0) return true;
            if (width > PluginReadmeLimits.MaxImageDimension || height > PluginReadmeLimits.MaxImageDimension) return true;
            return (long)width * height > PluginReadmeLimits.MaxImagePixels;
        }

        private static double HeadingSize(int level)
        {
            switch (level)
            {
                case 1: return 22;
                case 2: return 19;
                case 3: return 17;
                case 4: return 15.5;
                default: return 14;
            }
        }

        private static FontFamily MonoFont()
        {
            try { return new FontFamily("Consolas, Cascadia Mono, Courier New"); }
            catch { return new FontFamily("Courier New"); }
        }

        private Brush ThemeBrush(string resourceKey, Color fallback)
        {
            try
            {
                if (TryFindResource(resourceKey) is Brush brush) return brush;
            }
            catch { /* 资源字典没加载 */ }
            var solid = new SolidColorBrush(fallback);
            solid.Freeze();
            return solid;
        }

        private static TextBlock Note(string text) => new TextBlock
        {
            Text = text,
            TextWrapping = TextWrapping.Wrap,
            Opacity = 0.7,
            FontSize = 12,
            Margin = new Thickness(0, 6, 0, 6),
        };

        /// <summary>行内文本 → Inlines，只认 `code`、**粗**、*斜*、[文字](https 链接)。</summary>
        private void AppendInline(TextBlock target, string text)
        {
            if (target == null || string.IsNullOrEmpty(text)) return;
            AppendInlineInto(target.Inlines, text, 0);
        }

        private void AppendInlineInto(InlineCollection inlines, string text, int depth)
        {
            if (inlines == null || string.IsNullOrEmpty(text)) return;
            if (depth > 3)
            {
                inlines.Add(new Run(text));
                return;
            }

            var buffer = new StringBuilder();
            void FlushText()
            {
                if (buffer.Length == 0) return;
                inlines.Add(new Run(buffer.ToString()));
                buffer.Clear();
            }

            for (var i = 0; i < text.Length;)
            {
                var ch = text[i];

                if (ch == '`')
                {
                    var end = text.IndexOf('`', i + 1);
                    if (end > i + 1)
                    {
                        FlushText();
                        inlines.Add(new Run(text.Substring(i + 1, end - i - 1))
                        {
                            FontFamily = MonoFont(),
                            FontSize = 12,
                        });
                        i = end + 1;
                        continue;
                    }
                }

                if (ch == '*' && i + 1 < text.Length && text[i + 1] == '*')
                {
                    var end = text.IndexOf("**", i + 2, StringComparison.Ordinal);
                    if (end > i + 2)
                    {
                        FlushText();
                        var bold = new Bold();
                        AppendInlineInto(bold.Inlines, text.Substring(i + 2, end - i - 2), depth + 1);
                        inlines.Add(bold);
                        i = end + 2;
                        continue;
                    }
                }

                if (ch == '*')
                {
                    var end = text.IndexOf('*', i + 1);
                    if (end > i + 1)
                    {
                        FlushText();
                        var italic = new Italic();
                        AppendInlineInto(italic.Inlines, text.Substring(i + 1, end - i - 1), depth + 1);
                        inlines.Add(italic);
                        i = end + 1;
                        continue;
                    }
                }

                if (ch == '[')
                {
                    var link = LinkPattern.Match(text, i);
                    if (link.Success && link.Index == i)
                    {
                        FlushText();
                        AddLink(inlines, link.Groups[1].Value, link.Groups[2].Value);
                        i += link.Length;
                        continue;
                    }
                }

                buffer.Append(ch);
                i++;
            }
            FlushText();
        }

        private void AddLink(InlineCollection inlines, string label, string url)
        {
            if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps)
            {
                var link = new Hyperlink(new Run(label)) { NavigateUri = uri, ToolTip = url };
                link.Click += (_, __) =>
                {
                    try { _openLink?.Invoke(url); } catch { /* 回调失败不影响界面 */ }
                };
                inlines.Add(link);
                return;
            }
            // 非 https 不可点，但仍把地址显示出来，读者能自己判断要不要复制。
            inlines.Add(new Run(label + "（非 HTTPS 链接，不可点击）")
            {
                Foreground = ThemeBrush("Muted", Color.FromRgb(0x9A, 0xA3, 0xAD)),
            });
        }
        private sealed class GifPlayer
        {
            public Image Image;
            public ReadOnlyCollection<BitmapFrame> Frames;
            public int[] Delays;
            public int Index;
            public DispatcherTimer Timer;
        }
    }
}




