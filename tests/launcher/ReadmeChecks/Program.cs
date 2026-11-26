using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using WhaleLauncher;

// PluginReadmeView 的可复现行为检查（STA、进程内、不联网）：
//   - 真 GIF 用 GifBitmapDecoder 播放，关闭后计时器停止；
//   - 图片字节/像素/GIF 帧数上限、Markdown 块数上限都落到可见占位；
//   - Close 幂等、可取消在途加载、关闭后还能重新打开。
// 直接编译 launcher/PluginReadmeView.cs，不加载主程序/EXE，不启动微信。

internal static class Program
{
    private static int _pass;
    private static int _fail;

    [STAThread]
    private static int Main()
    {
        _ = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        try
        {
            GifPlaybackAndClose();
            OversizedBytes();
            OversizedDimensions();
            TooManyGifFrames();
            TooManyMarkdownBlocks();
            CloseCancelsPendingImage();
            EmptyAndNullContent();
            ReopenAfterClose();
        }
        catch (Exception ex)
        {
            Console.WriteLine("HARNESS ERROR: " + ex);
            return 2;
        }

        Console.WriteLine();
        Console.WriteLine($"ReadmeChecks: {_pass} passed, {_fail} failed");
        return _fail == 0 ? 0 : 1;
    }

    private static void GifPlaybackAndClose()
    {
        var view = new PluginReadmeView();
        var window = Host(view);
        try
        {
            var gif = File.ReadAllBytes(Fixture("two-frame.gif"));
            _ = view.ShowAsync(Content("![动图](demo.gif)", src => Task.FromResult(
                new PluginReadmeResource(gif, "image/gif", null))));
            Pump(200);
            var image = Visuals<Image>(view).FirstOrDefault();
            Check(image != null, "GIF 已渲染成 Image");
            if (image == null) return;
            Check(image.Source is BitmapFrame, "GIF 首帧是 BitmapFrame");
            var first = image.Source;
            Check(WaitUntil(() => image.Source != null && !ReferenceEquals(image.Source, first), 2000),
                "GIF 计时器推进到下一帧");
            var advanced = image.Source;

            view.Close();
            Check(image.Source == null, "Close 释放当前 GIF 帧");
            Pump(300);
            Check(ReferenceEquals(image.Source, null), "Close 后计时器不再推进", image.Source);
            Check(StackChildren(view).Count == 0, "Close 清空内容", StackChildren(view).Count);
            view.Close(); // 幂等
            Check(true, "重复 Close 不抛异常");
            _ = advanced;
        }
        finally
        {
            view.Close();
            window.Close();
        }
    }

    private static void OversizedBytes()
    {
        var view = new PluginReadmeView();
        var window = Host(view);
        try
        {
            _ = view.ShowAsync(Content("![大图](big.png)", _ => Task.FromResult(
                new PluginReadmeResource(new byte[PluginReadmeLimits.MaxImageBytes + 1], "image/png", null))));
            Check(WaitUntil(() => AllText(view).Contains("2 MiB", StringComparison.Ordinal), 2000),
                "超过 2 MiB 的图片显示占位", AllText(view));
        }
        finally { view.Close(); window.Close(); }
    }

    private static void OversizedDimensions()
    {
        var view = new PluginReadmeView();
        var window = Host(view);
        try
        {
            var png = PngOfWidth(PluginReadmeLimits.MaxImageDimension + 4);
            _ = view.ShowAsync(Content("![超宽](wide.png)", _ => Task.FromResult(
                new PluginReadmeResource(png, "image/png", null))));
            Check(WaitUntil(() => AllText(view).Contains("4096", StringComparison.Ordinal), 2000),
                "超过 4096 像素的图片显示占位", AllText(view));
        }
        finally { view.Close(); window.Close(); }
    }

    private static void TooManyGifFrames()
    {
        var view = new PluginReadmeView();
        var window = Host(view);
        try
        {
            var gif = File.ReadAllBytes(Fixture("301-frames.gif"));
            _ = view.ShowAsync(Content("![帧数过多](frames.gif)", _ => Task.FromResult(
                new PluginReadmeResource(gif, "image/gif", null))));
            Check(WaitUntil(() => AllText(view).Contains("帧数超过 300", StringComparison.Ordinal), 3000),
                "超过 300 帧的 GIF 显示占位", AllText(view));
        }
        finally { view.Close(); window.Close(); }
    }

    private static void TooManyMarkdownBlocks()
    {
        var view = new PluginReadmeView();
        var window = Host(view);
        try
        {
            var markdown = string.Join("\n\n", Enumerable.Range(0, PluginReadmeLimits.MaxBlocks + 1)
                .Select(i => "段落 " + i));
            _ = view.ShowAsync(Content(markdown, null));
            // 解析器到上限就停；查看器不会把第 2001 个区块渲染出来。
            Check(StackChildren(view).Count <= PluginReadmeLimits.MaxBlocks + 1,
                "超过 2000 个区块不再渲染", StackChildren(view).Count);
            Check(AllText(view).Contains("段落 0", StringComparison.Ordinal), "前 2000 个区块仍显示");
        }
        finally { view.Close(); window.Close(); }
    }

    private static void CloseCancelsPendingImage()
    {
        var view = new PluginReadmeView();
        var window = Host(view);
        try
        {
            var pending = new TaskCompletionSource<PluginReadmeResource>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            _ = view.ShowAsync(Content("![慢图](slow.png)", _ => pending.Task));
            Check(WaitUntil(() => AllText(view).Contains("正在加载图片", StringComparison.Ordinal), 2000),
                "图片加载中显示占位");
            view.Close();
            view.Close();
            pending.SetResult(new PluginReadmeResource(
                File.ReadAllBytes(Fixture("two-frame.gif")), "image/gif", null));
            Pump(300);
            Check(StackChildren(view).Count == 0, "Close 后在途加载不会回填内容", StackChildren(view).Count);
        }
        finally { view.Close(); window.Close(); }
    }

    private static void EmptyAndNullContent()
    {
        var view = new PluginReadmeView();
        var window = Host(view);
        try
        {
            _ = view.ShowAsync(null);
            Check(AllText(view).Contains("空的", StringComparison.Ordinal), "null 内容显示空说明", AllText(view));
            _ = view.ShowAsync(Content("", null));
            Check(AllText(view).Contains("空的", StringComparison.Ordinal), "空 Markdown 显示空说明", AllText(view));
        }
        finally { view.Close(); window.Close(); }
    }

    private static void ReopenAfterClose()
    {
        var view = new PluginReadmeView();
        var window = Host(view);
        try
        {
            _ = view.ShowAsync(Content("第一次", null));
            Check(AllText(view).Contains("第一次", StringComparison.Ordinal), "第一次内容");
            view.Close();
            _ = view.ShowAsync(Content("第二次", null));
            Check(AllText(view).Contains("第二次", StringComparison.Ordinal), "Close 后可重新打开");
        }
        finally { view.Close(); window.Close(); }
    }

    // ---------- 辅助 ----------

    private static PluginReadmeContent Content(string markdown,
        Func<string, Task<PluginReadmeResource>> loader) => new()
    {
        Markdown = markdown,
        SourceLabel = "README.md（测试）",
        LoadImage = (src, _) => loader == null
            ? Task.FromResult(PluginReadmeResource.Failure("没有加载器"))
            : loader(src),
        OpenLink = _ => { },
    };

    private static Window Host(PluginReadmeView view)
    {
        // 离屏窗口只为让 IsVisible 为 true，GIF 计时器才会启动；不会弹到用户桌面。
        var window = new Window
        {
            Content = view,
            Width = 520,
            Height = 420,
            WindowStyle = WindowStyle.None,
            ShowInTaskbar = false,
            Left = -10000,
            Top = -10000,
        };
        window.Show();
        window.UpdateLayout();
        return window;
    }

    private static string Fixture(string name) =>
        Path.Combine(AppContext.BaseDirectory, "fixtures", name);

    private static byte[] PngOfWidth(int width)
    {
        var bitmap = new WriteableBitmap(width, 1, 96, 96, PixelFormats.Bgra32, null);
        var pixels = new byte[width * 4];
        for (var i = 0; i < pixels.Length; i += 4)
        {
            pixels[i] = 0x40;
            pixels[i + 3] = 0xFF;
        }
        bitmap.WritePixels(new Int32Rect(0, 0, width, 1), pixels, width * 4, 0);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var stream = new MemoryStream();
        encoder.Save(stream);
        return stream.ToArray();
    }

    private static List<object> StackChildren(PluginReadmeView view) =>
        ((StackPanel)typeof(PluginReadmeView)
            .GetField("_stack", BindingFlags.Instance | BindingFlags.NonPublic)
            .GetValue(view)).Children.Cast<object>().ToList();

    private static string AllText(DependencyObject root) =>
        string.Join("\n", Visuals<TextBlock>(root).Select(TextOf));

    private static string TextOf(TextBlock block)
    {
        var text = new System.Text.StringBuilder(block.Text ?? "");
        AppendInlineText(block.Inlines, text);
        return text.ToString();
    }

    private static void AppendInlineText(System.Windows.Documents.InlineCollection inlines, System.Text.StringBuilder text)
    {
        foreach (var inline in inlines)
        {
            switch (inline)
            {
                case System.Windows.Documents.Run run:
                    text.Append(run.Text);
                    break;
                case System.Windows.Documents.Span span:
                    AppendInlineText(span.Inlines, text);
                    break;
            }
        }
    }

    private static IEnumerable<T> Visuals<T>(DependencyObject root) where T : DependencyObject
    {
        if (root == null) yield break;
        var count = VisualTreeHelper.GetChildrenCount(root);
        for (var i = 0; i < count; i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is T match) yield return match;
            foreach (var descendant in Visuals<T>(child)) yield return descendant;
        }
    }

    private static bool WaitUntil(Func<bool> condition, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            if (condition()) return true;
            Pump(20);
        }
        return condition();
    }

    private static void Pump(int milliseconds)
    {
        var frame = new DispatcherFrame();
        var timer = new DispatcherTimer(DispatcherPriority.Background)
        {
            Interval = TimeSpan.FromMilliseconds(Math.Max(1, milliseconds)),
        };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            frame.Continue = false;
        };
        timer.Start();
        Dispatcher.PushFrame(frame);
    }

    private static void Check(bool ok, string what, object actual = null)
    {
        if (ok) { _pass++; return; }
        _fail++;
        Console.WriteLine($"FAIL {what} (actual: {actual})");
    }
}
