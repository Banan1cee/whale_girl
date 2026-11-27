using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace WhaleLauncher
{
    /// <summary>
    /// 开发用离屏渲染：把主窗口按 data/launcher-ui.json 的配置画成 PNG。
    /// 调外观时不用真开窗口、不用手动截图，也不抢焦点：
    ///   WhaleLauncher.exe --render-preview out.png [scale]
    /// </summary>
    public static class PreviewRenderer
    {
        private static readonly string TracePath =
            Path.Combine(AppContext.BaseDirectory, "data", "render-preview.log");

        private static void Trace(string text)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(TracePath) ?? AppContext.BaseDirectory);
                File.AppendAllText(TracePath, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + text + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        public static async Task RunAsync(string output, double scale, int navIndex)
        {
            Trace("start output=" + output + " scale=" + scale + " nav=" + navIndex);
            try
            {
                Appearance.Load();
                Trace("loaded theme=" + Appearance.Theme + " backdrop=" + Appearance.Backdrop + " has=" + Appearance.HasBackdrop);
                Appearance.ApplyTheme();
                Trace("theme applied");

                var win = new MainWindow
                {
                    WindowStartupLocation = WindowStartupLocation.Manual,
                    Left = -20000,
                    Top = -20000,
                    ShowActivated = false,
                };
                Trace("window created");
                win.Show();
                Trace("window shown");

                // Loaded 之后页面会异步拉一次数据；给它一点时间把卡片和输入框填出来。
                await Task.Delay(1200);
                if (navIndex >= 0 && navIndex < win.Nav.Items.Count) win.Nav.SelectedIndex = navIndex;
                await Task.Delay(900);
                win.UpdateLayout();
                Trace("layout " + win.ActualWidth + "x" + win.ActualHeight);

                var w = win.ActualWidth > 0 ? win.ActualWidth : win.Width;
                var h = win.ActualHeight > 0 ? win.ActualHeight : win.Height;
                var dpi = 96 * scale;
                var bmp = new RenderTargetBitmap(
                    (int)Math.Round(w * scale), (int)Math.Round(h * scale), dpi, dpi, PixelFormats.Pbgra32);
                bmp.Render(win);
                Trace("rendered");

                var enc = new PngBitmapEncoder();
                enc.Frames.Add(BitmapFrame.Create(bmp));
                var full = Path.GetFullPath(output);
                Directory.CreateDirectory(Path.GetDirectoryName(full) ?? ".");
                using (var fs = File.Create(full)) enc.Save(fs);
                Trace("saved " + full);

                win.Close();
                Application.Current.Shutdown();
            }
            catch (Exception ex)
            {
                Trace("FAILED: " + ex);
                Application.Current?.Shutdown(3);
            }
        }

        /// <summary>
        /// 开发用：把一条公告弹窗（AppDialog）画成 PNG，发布前检查文案和排版。
        ///   WhaleLauncher.exe --render-notice out.png [scale]
        /// 先排截图回调、再开模态：AppDialog 内部用 PushFrame 抽消息，回调会在弹层显示后执行。
        /// </summary>
        public static async Task RunNoticeAsync(string output, double scale)
        {
            Trace("notice start output=" + output);
            try
            {
                Appearance.Load();
                Appearance.ApplyTheme();
                var win = new MainWindow
                {
                    WindowStartupLocation = WindowStartupLocation.Manual,
                    Left = -20000,
                    Top = -20000,
                    ShowActivated = false,
                };
                win.Show();
                await Task.Delay(1500);   // 等主题、页面和顶栏铃铛都布局完
                win.UpdateLayout();

                _ = win.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() =>
                {
                    try
                    {
                        Save(win, output, scale);
                        Trace("notice rendered " + output);
                    }
                    catch (Exception error)
                    {
                        Trace("notice render failed: " + error);
                    }
                    CloseTopOverlay(win);
                }));

                AppDialog.Show(win,
                    "从 4.2.0 起，版本提示、官网域名变更和临时维护都会通过公告通知。\n点顶栏铃铛可以回看历史公告。",
                    "公告功能已上线");

                win.Close();
                Application.Current.Shutdown();
            }
            catch (Exception error)
            {
                Trace("FAILED: " + error);
                Application.Current?.Shutdown(3);
            }
        }

        private static void Save(Window window, string output, double scale)
        {
            var width = window.ActualWidth > 0 ? window.ActualWidth : window.Width;
            var height = window.ActualHeight > 0 ? window.ActualHeight : window.Height;
            var dpi = 96 * scale;
            var bitmap = new RenderTargetBitmap(
                (int)Math.Round(width * scale), (int)Math.Round(height * scale), dpi, dpi, PixelFormats.Pbgra32);
            bitmap.Render(window);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            var full = Path.GetFullPath(output);
            Directory.CreateDirectory(Path.GetDirectoryName(full) ?? ".");
            using var stream = File.Create(full);
            encoder.Save(stream);
        }

        /// <summary>弹层关闭：找到 AppDialog 右上角的 × 并点掉，让模态返回。</summary>
        private static void CloseTopOverlay(Window window)
        {
            if (window.Content is not Grid root) return;
            for (var i = root.Children.Count - 1; i >= 0; i--)
            {
                if (root.Children[i] is not Grid overlay) continue;
                foreach (var button in Descendants<Button>(overlay))
                {
                    if (!Equals(button.Content, "×")) continue;
                    button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    return;
                }
            }
        }

        private static IEnumerable<T> Descendants<T>(DependencyObject parent) where T : DependencyObject
        {
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
            {
                var child = VisualTreeHelper.GetChild(parent, i);
                if (child is T match) yield return match;
                foreach (var item in Descendants<T>(child)) yield return item;
            }
        }
    }
}
