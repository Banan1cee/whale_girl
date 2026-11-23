using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using WhaleLauncher;

// 页区块显隐/排序的最小行为回归（WPF 实对象，不启动主窗口）：
//   直接编译 launcher/LauncherPageProfile.cs + PageAppearance.cs，
//   用伪页面驱动真实的 Visibility / Children 变化。
// 覆盖 task-24 复核确认的 10 条行为：只撤销本模块施加的隐藏、按引用精确还原原值、
// 多容器保留显隐所有权、单元素替换不丢其它区块状态、旧元素不回流容器。

internal sealed class FakePage : Grid, IPageSectionHost
{
    public Border A = new Border();
    public Border B = new Border();
    public Border C = new Border();

    public FakePage(bool includeExtra = false)
    {
        Children.Add(A);
        Children.Add(B);
        Children.Add(C);
        if (includeExtra) Children.Add(new TextBlock());
    }

    public string PageId => "settings";
    public IReadOnlyList<PageSectionDescriptor> SectionDescriptors => new[]
    {
        new PageSectionDescriptor("a", "A"),
        new PageSectionDescriptor("b", "B"),
        new PageSectionDescriptor("fixed", "C", canHide: false),
    };
    public IReadOnlyList<PageSectionBinding> SectionBindings => new[]
    {
        new PageSectionBinding("a", A),
        new PageSectionBinding("b", B),
        new PageSectionBinding("fixed", C),
    };
}

/// <summary>区块分散在两个容器里：只支持显隐；排序必须忽略，但隐藏所有权仍要能恢复。</summary>
internal sealed class FakeMultiPage : Grid, IPageSectionHost
{
    public StackPanel P1 = new StackPanel();
    public StackPanel P2 = new StackPanel();
    public Border A = new Border();
    public Border B = new Border();
    public Border C = new Border();

    public FakeMultiPage()
    {
        P1.Children.Add(A);
        P2.Children.Add(B);
        P2.Children.Add(C);
        Children.Add(P1);
        Children.Add(P2);
    }

    public string PageId => "settings";
    public IReadOnlyList<PageSectionDescriptor> SectionDescriptors => new[]
    {
        new PageSectionDescriptor("a", "A"),
        new PageSectionDescriptor("b", "B"),
        new PageSectionDescriptor("fixed", "C", canHide: false),
    };
    public IReadOnlyList<PageSectionBinding> SectionBindings => new[]
    {
        new PageSectionBinding("a", A),
        new PageSectionBinding("b", B),
        new PageSectionBinding("fixed", C),
    };
}

internal static class Program
{
    private static int _pass;
    private static int _fail;

    private static void Check(string name, Action action)
    {
        try { action(); _pass++; Console.WriteLine("PASS " + name); }
        catch (Exception ex) { _fail++; Console.WriteLine("FAIL " + name + ": " + ex.Message); }
    }

    private static void True(bool value, string message) { if (!value) throw new Exception(message); }
    private static void Same(object expected, object actual, string message) { if (!ReferenceEquals(expected, actual)) throw new Exception(message); }
    private static void Is(Visibility expected, UIElement element, string message)
    {
        if (element.Visibility != expected) throw new Exception(message + "（实际 " + element.Visibility + "）");
    }

    private static void Use(string json)
    {
        var profile = LauncherPageProfiles.Parse(Encoding.UTF8.GetBytes(json));
        True(PageAppearance.SetProfile(profile, out var error), "设置配置失败：" + error);
    }

    private static void Clear()
    {
        True(PageAppearance.ClearProfile(out var error), "停用配置失败：" + error);
    }

    [STAThread]
    private static int Main()
    {
        try { File.Delete(PageAppearance.ProfileFilePath); } catch { }

        Check("无配置时不碰页面动态显隐", () =>
        {
            var page = new FakePage();
            PageAppearance.Attach("settings", page);
            page.B.Visibility = Visibility.Collapsed;
            PageAppearance.RefreshAll();
            Is(Visibility.Collapsed, page.B, "页面动态隐藏被覆盖");
            Clear();
        });

        Check("CanHide=false 区块不被写入（动态状态保留）", () =>
        {
            Use("""{"schema":2,"pages":{"settings":{"sections":[{"id":"fixed","visible":false}]}}}""");
            var page = new FakePage();
            PageAppearance.Attach("settings", page);
            Is(Visibility.Visible, page.C, "不可隐藏区块被隐藏");
            page.C.Visibility = Visibility.Collapsed;
            PageAppearance.RefreshAll();
            Is(Visibility.Collapsed, page.C, "不可隐藏区块动态状态被覆盖");
            Clear();
        });

        Check("只撤销本模块施加的隐藏；页面自己的隐藏保持不变", () =>
        {
            Use("""{"schema":2,"pages":{"settings":{"sections":[{"id":"a","visible":false}]}}}""");
            var page = new FakePage();
            PageAppearance.Attach("settings", page);
            Is(Visibility.Collapsed, page.A, "配置隐藏未生效");
            page.B.Visibility = Visibility.Collapsed;
            Clear();
            PageAppearance.RefreshAll();
            Is(Visibility.Visible, page.A, "本模块隐藏未撤销");
            Is(Visibility.Collapsed, page.B, "撤销时误改页面自己的隐藏");
        });

        Check("配置仍要求隐藏时，页面临时显示会被重新收起", () =>
        {
            Use("""{"schema":2,"pages":{"settings":{"sections":[{"id":"a","visible":false}]}}}""");
            var page = new FakePage();
            PageAppearance.Attach("settings", page);
            page.A.Visibility = Visibility.Visible;
            PageAppearance.RefreshAll();
            Is(Visibility.Collapsed, page.A, "没有重新收起");
            Clear();
        });

        Check("排序：单容器可排序，停用恢复原顺序", () =>
        {
            Use("""{"schema":2,"pages":{"settings":{"sections":[{"id":"b","order":0}]}}}""");
            var page = new FakePage();
            PageAppearance.Attach("settings", page);
            Same(page.B, page.Children[0], "排序未生效");
            Clear();
            PageAppearance.RefreshAll();
            Same(page.A, page.Children[0], "停用后未恢复顺序");
        });

        Check("非单一区块容器：忽略排序，只应用显隐", () =>
        {
            Use("""{"schema":2,"pages":{"settings":{"sections":[{"id":"b","order":0},{"id":"a","visible":false}]}}}""");
            var page = new FakePage(includeExtra: true);
            PageAppearance.Attach("settings", page);
            Same(page.A, page.Children[0], "混有其它子元素时不应重排");
            Is(Visibility.Collapsed, page.A, "显隐仍应生效");
            Clear();
        });

        Check("多容器页面：隐藏所有权保留（刷新不丢、停用能恢复）", () =>
        {
            Use("""{"schema":2,"pages":{"settings":{"sections":[{"id":"a","visible":false},{"id":"b","visible":false},{"id":"c","order":0}]}}}""");
            var page = new FakeMultiPage();
            PageAppearance.Attach("settings", page);
            Is(Visibility.Collapsed, page.A, "多容器 A 未隐藏");
            Is(Visibility.Collapsed, page.B, "多容器 B 未隐藏");
            Same(page.B, page.P2.Children[0], "多容器不应重排");
            PageAppearance.RefreshAll();
            Is(Visibility.Collapsed, page.A, "刷新后多容器 A 隐藏丢失");
            Is(Visibility.Collapsed, page.B, "刷新后多容器 B 隐藏丢失");
            Clear();
            PageAppearance.RefreshAll();
            Is(Visibility.Visible, page.A, "停用后多容器 A 未恢复");
            Is(Visibility.Visible, page.B, "停用后多容器 B 未恢复");
        });

        Check("原本 Visibility=Hidden 的区块：隐藏后恢复成 Hidden 而不是 Visible", () =>
        {
            Use("""{"schema":2,"pages":{"settings":{"sections":[{"id":"a","visible":false}]}}}""");
            var page = new FakePage();
            page.A.Visibility = Visibility.Hidden;
            PageAppearance.Attach("settings", page);
            Is(Visibility.Collapsed, page.A, "未接管 Hidden 元素");
            Clear();
            PageAppearance.RefreshAll();
            Is(Visibility.Hidden, page.A, "恢复时写成 Visible，原 Hidden 丢失");
        });

        Check("替换 A 时 B 仍受本模块隐藏，停用后 B 恢复；旧元素不回流", () =>
        {
            Use("""{"schema":2,"pages":{"settings":{"sections":[{"id":"a","visible":false},{"id":"b","visible":false}]}}}""");
            var page = new FakePage();
            PageAppearance.Attach("settings", page);
            Is(Visibility.Collapsed, page.A, "A 未隐藏");
            Is(Visibility.Collapsed, page.B, "B 未隐藏");

            var oldA = page.A;
            page.A = new Border();
            page.Children.Clear();
            page.Children.Add(page.A);
            page.Children.Add(page.B);
            page.Children.Add(page.C);
            PageAppearance.RefreshAll();
            True(!page.Children.Contains(oldA), "旧元素被塞回容器");
            Is(Visibility.Collapsed, page.A, "替换后的 A 未继续隐藏");
            Is(Visibility.Collapsed, page.B, "替换 A 后 B 的隐藏丢失");

            Clear();
            PageAppearance.RefreshAll();
            Is(Visibility.Visible, page.A, "替换后的 A 停用后未恢复");
            Is(Visibility.Visible, page.B, "B 停用后未恢复（替换 A 时丢了所有权）");
            True(!page.Children.Contains(oldA), "恢复时旧元素回流");
        });

        Check("重新 Attach 新实例：旧基线不再被引用", () =>
        {
            Use("""{"schema":2,"pages":{"settings":{"sections":[{"id":"a","visible":false},{"id":"b","order":0}]}}}""");
            var first = new FakePage();
            PageAppearance.Attach("settings", first);
            var second = new FakePage();
            PageAppearance.Attach("settings", second);
            PageAppearance.RefreshAll();
            Is(Visibility.Collapsed, second.A, "新实例未应用隐藏");
            Same(second.B, second.Children[0], "新实例未应用排序");
            Is(Visibility.Visible, first.B, "旧实例被误改");
            Clear();
            PageAppearance.RefreshAll();
            Is(Visibility.Visible, second.A, "停用后新实例未恢复");
            Same(second.A, second.Children[0], "停用后新实例未恢复顺序");
        });

        try { File.Delete(PageAppearance.ProfileFilePath); } catch { }
        Console.WriteLine();
        Console.WriteLine($"通过 {_pass}，失败 {_fail}");
        return _fail == 0 ? 0 : 1;
    }
}
