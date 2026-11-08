using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

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
    }
}
