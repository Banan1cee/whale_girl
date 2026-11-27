using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using WhaleLauncher;

internal static class SettingsLifecycleChecks
{
    private sealed class DraftPage : UserControl, IPendingSettings
    {
        internal TaskCompletionSource<bool> Save = new();
        internal int Calls;
        public Task<bool> SavePendingSettingsAsync()
        {
            Calls++;
            return Save.Task;
        }
    }

    [STAThread]
    public static void Main()
    {
        var app = new App { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.InitializeComponent();
        var window = new MainWindow();
        var nav = (ListBox)window.FindName("Nav");
        var host = (ContentControl)window.FindName("Host");
        var pages = (Dictionary<string, UserControl>)typeof(MainWindow)
            .GetField("_pages", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(window);
        var voice = new DraftPage();
        var next = new DraftPage();
        pages["语音发送"] = voice;
        pages["朋友圈"] = next;

        nav.SelectedItem = nav.Items.OfType<NavEntry>().Single(item => item.Key == "语音发送");
        Pump();
        Require(ReferenceEquals(host.Content, voice), "未打开语音页");
        var target = nav.Items.OfType<NavEntry>().Single(item => item.Key == "朋友圈");
        nav.SelectedItem = target;
        Require(voice.Calls == 1 && ReferenceEquals(host.Content, voice), "保存完成前切走了");
        voice.Save.SetResult(false);
        Pump();
        Require(ReferenceEquals(host.Content, voice) && !ReferenceEquals(nav.SelectedItem, target), "保存失败后没有保留表单");
        voice.Save = new();
        nav.SelectedItem = target;
        voice.Save.SetResult(true);
        Pump();
        Require(ReferenceEquals(host.Content, next), "保存成功后没有切页");

        var closed = false;
        window.Closed += (_, _) => closed = true;
        window.Close();
        Require(!closed && next.Calls == 1, "保存完成前关闭了窗口");
        next.Save.SetResult(true);
        Pump();
        Require(closed, "保存后没有关闭窗口");
        app.Shutdown();
        Console.WriteLine("切页、保存失败保留表单及退出等待检查通过");
    }

    private static void Pump()
    {
        var frame = new DispatcherFrame();
        Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() => frame.Continue = false));
        Dispatcher.PushFrame(frame);
    }

    private static void Require(bool ok, string message)
    {
        if (!ok) throw new InvalidOperationException(message);
    }
}
