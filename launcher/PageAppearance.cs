using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WhaleLauncher
{
    /// <summary>某个页面当前的页级样式快照。值的含义：1.0 = 跟随全局。</summary>
    internal readonly struct PageAppearanceSnapshot
    {
        internal PageAppearanceSnapshot(string pageId, bool hasOverride, double density, double fontScale)
        {
            PageId = pageId;
            HasOverride = hasOverride;
            Density = density;
            FontScale = fontScale;
        }

        /// <summary>宿主稳定页面 ID（不是界面显示名称）。</summary>
        internal string PageId { get; }

        /// <summary>该页是否在页级配置里显式声明了样式。</summary>
        internal bool HasOverride { get; }

        /// <summary>间距缩放；未覆盖时 1.0。</summary>
        internal double Density { get; }

        /// <summary>字号缩放；未覆盖时 1.0。</summary>
        internal double FontScale { get; }
    }

    /// <summary>
    /// 页面可选实现：页级样式在"改配置 / 停用 / 切主题 / 切明暗"后被重算时收到通知。
    /// P2 的区块任务也走这一个回调，不另外发明通知机制。
    /// </summary>
    internal interface IHostPage
    {
        string PageId { get; }
        void OnPageAppearanceChanged(PageAppearanceSnapshot snapshot);
    }

    /// <summary>页面把一个区块元素交给宿主：Id 必须是页面元数据里声明过的稳定 ID。</summary>
    internal readonly struct PageSectionBinding
    {
        internal PageSectionBinding(string id, FrameworkElement element)
        {
            Id = id ?? "";
            Element = element;
        }

        internal string Id { get; }
        internal FrameworkElement Element { get; }
    }

    /// <summary>
    /// P2 页面接入点：声明可选区块的元数据，并把区块元素暴露给宿主。
    /// 未实现本接口的页面完全不受区块配置影响（默认外观与顺序）。
    /// </summary>
    internal interface IPageSectionHost
    {
        string PageId { get; }
        IReadOnlyList<PageSectionDescriptor> SectionDescriptors { get; }
        IReadOnlyList<PageSectionBinding> SectionBindings { get; }
    }

    /// <summary>
    /// 页级样式（P1）：把宿主页面的密度与字号缩放挂到**页根**的 ResourceDictionary 上。
    ///
    /// 约束（与 task-9 的 P1 方案一致）：
    ///   · 只写尺寸 token（字号、控件内边距），不写画刷，因此 Ok/Warn/Bad、主按钮色、
    ///     顶栏、蒙版、文字描边等保护资源不可能被页级配置覆盖；
    ///   · 只改页根的 Resources，绝不写 Application.Resources；弹窗与更新横幅挂在
    ///     MainWindow 根 Grid 上（不在页面子树里），因此不会继承页级样式；
    ///   · 每次重算都取"当前全局值 × 页面缩放"，主题切换、明暗切换、主题不可用回退
    ///     之后都会重算，页面缓存（切走再切回）保持同一份结果；
    ///   · 没有配置文件 = 不挂任何本地资源 = 默认外观与行为完全不变。
    ///
    /// ── P2 接续接口（区块任务只读这些，不要自己解析 data/launcher-pages.json）──
    ///   PageAppearance.PageIdFor(navKey)      显示名 → 稳定页面 ID
    ///   PageAppearance.HasProfile             是否启用了页级配置
    ///   PageAppearance.ConfiguredPageIds      哪些页面有覆盖
    ///   PageAppearance.Snapshot(pageId)       该页当前 Density / FontScale
    ///   IHostPage.OnPageAppearanceChanged     配置/主题变化后的回调
    /// </summary>
    internal static class PageAppearance
    {
        /// <summary>
        /// 允许下发到页根的尺寸 token 白名单。新增 token 必须先加到这里；
        /// 这里永远不放颜色键，避免页级配置碰到保护资源（安全信号色、主按钮、顶栏）。
        /// </summary>
        internal static readonly string[] TokenKeys =
        {
            "FontSizeH1", "FontSizeH2", "FontSizeLabel", "FontSizeSmall", "FontSizeValue",
            "FontSizeBody", "FontSizeControl", "FontSizeField",
            "PadChip", "PadPrimary", "PadGhost", "PadTopBtn",
        };

        /// <summary>字号缩放的最终安全区间（页配置 × 主题字号后仍不会把界面撑坏）。</summary>
        private const double MinFontSize = 6;
        private const double MaxFontSize = 60;

        private static LauncherPageProfile _profile;
        private static bool _loaded;

        // 页根 → 我们写过的键；以及写入前的原值（页面自己定义过的资源要能还原）。
        private static readonly Dictionary<string, FrameworkElement> Roots = new(StringComparer.Ordinal);
        private static readonly Dictionary<string, HashSet<string>> Applied = new(StringComparer.Ordinal);
        private static readonly Dictionary<string, Dictionary<string, object>> Originals = new(StringComparer.Ordinal);

        // 区块：最近一次重算里被忽略的配置（未知 id / 不可隐藏 / 不可排序 / 跨容器），
        // 只用于面板提示和诊断，不影响页面。
        private static readonly List<string> SectionWarningList = new List<string>();
        internal static IReadOnlyList<string> SectionWarnings => SectionWarningList;

        private static readonly Dictionary<string, SectionState> SectionStates = new Dictionary<string, SectionState>(StringComparer.Ordinal);

        /// <summary>本模块对单个元素的本地覆盖：只记"我们确实改过的那一次"的原值，撤销时精确还原（Hidden 也还原成 Hidden）。</summary>
        private sealed class ElementOverride
        {
            internal FrameworkElement Element;
            internal Visibility Original;
        }

        /// <summary>
        /// 页面的区块状态：隐藏所有权逐元素记录，与容器数量无关（多 Panel 也能恢复）；
        /// 顺序基线只针对"所有区块同属一个 Panel"的情况，和隐藏状态互相独立。
        /// 某个元素被页面替换时只更新该元素对应的记录，其它区块的隐藏/顺序不受影响。
        /// </summary>
        private sealed class SectionState
        {
            internal readonly Dictionary<string, ElementOverride> Hidden = new Dictionary<string, ElementOverride>(StringComparer.Ordinal);
            internal Panel OrderParent;
            internal readonly List<string> OrderIds = new List<string>();
            internal bool OrderApplied;
        }
        /// <summary>是否存在生效的页级配置（文件缺失 / 非法时为 false，外观完全不变）。</summary>
        internal static bool HasProfile => _profile != null && _profile.Pages.Count > 0;

        internal static string ProfileFilePath
            => Path.Combine(AppContext.BaseDirectory, "data", LauncherPageProfiles.FileName);

        /// <summary>当前配置里声明了样式的页面 ID（按宿主顺序）。</summary>
        internal static IReadOnlyList<string> ConfiguredPageIds
        {
            get
            {
                var ids = new List<string>();
                if (_profile == null) return ids;
                foreach (var id in LauncherPageProfiles.PageIds)
                    if (_profile.Pages.ContainsKey(id)) ids.Add(id);
                return ids;
            }
        }

        /// <summary>P2/区块任务读取某页样式的唯一入口；未覆盖时返回 1.0/1.0 且 HasOverride=false。</summary>
        internal static PageAppearanceSnapshot Snapshot(string pageId)
        {
            if (pageId != null && _profile != null && _profile.Pages.TryGetValue(pageId, out var style))
            {
                return new PageAppearanceSnapshot(pageId, true,
                    style.HasDensity ? style.Density : 1.0,
                    style.HasFontScale ? style.FontScale : 1.0);
            }
            return new PageAppearanceSnapshot(pageId ?? "", false, 1.0, 1.0);
        }

        /// <summary>宿主显示名 → 稳定页面 ID。映射是宿主私有知识，界面文案改了也不影响配置。</summary>
        internal static string PageIdFor(string navKey) => navKey switch
        {
            "状态" => "status",
            "人设" => "persona",
            "表情包" => "stickers",
            "语音发送" => "voice",
            "朋友圈" => "moments",
            "主动与提醒" => "reminders",
            "微信桥接" => "bridge",
            "诊断" => "diagnostics",
            "插件市场" => "plugins",
            "设置" => "settings",
            _ => null,
        };

        /// <summary>启动/预览入口调用：读回配置。只解析文件，不碰界面。</summary>
        internal static void Load()
        {
            if (_loaded) return;
            _loaded = true;
            _profile = LauncherPageProfiles.LoadActive(ProfileFilePath);
        }

        /// <summary>应用并保存页级配置：先原子写盘，成功后才提交内存并重算已挂页面。</summary>
        internal static bool SetProfile(LauncherPageProfile profile, out string error)
        {
            error = "";
            if (profile == null || profile.Pages.Count == 0)
            {
                error = "没有可应用的页级样式。";
                return false;
            }
            if (!LauncherPageProfiles.Save(ProfileFilePath, profile))
            {
                error = "没能写进 data 目录，已保持原样式；请检查目录权限或磁盘空间。";
                return false;
            }
            _profile = profile;
            RefreshAll();
            return true;
        }

        /// <summary>停用：先删持久化文件，删成功才撤销内存配置（删不掉就如实失败，重启后它仍在）。</summary>
        internal static bool ClearProfile(out string error)
        {
            error = "";
            if (_profile == null && !File.Exists(ProfileFilePath)) return true;
            if (!LauncherPageProfiles.Remove(ProfileFilePath))
            {
                error = "删不掉 data\\" + LauncherPageProfiles.FileName + "，重启后页级样式仍会生效；请手动删除或关闭占用程序。";
                return false;
            }
            _profile = null;
            RefreshAll();
            return true;
        }

        /// <summary>宿主在页面创建后调用一次；重复调用是安全的。</summary>
        internal static void Attach(string pageId, FrameworkElement root)
        {
            if (string.IsNullOrEmpty(pageId) || root == null) return;
            Roots[pageId] = root;
            // 页面实例/容器可能被替换：旧基线里的元素与父容器不能再被引用。
            SectionStates.Remove(pageId);
            ApplyTo(pageId, root);
            if (root is IPageSectionHost) ApplySections(pageId, root);
            else if (_profile != null && _profile.Pages.TryGetValue(pageId, out var styled) && styled.HasSections)
                Warn(pageId, "页面尚未接入区块接口，区块配置已忽略。");
        }

        /// <summary>配置/主题/明暗/全局尺寸变化后由宿主调用，重算所有已挂页面的资源与区块。</summary>
        internal static void RefreshAll()
        {
            SectionWarningList.Clear();
            foreach (var pair in Roots)
            {
                ApplyTo(pair.Key, pair.Value);
                ApplySections(pair.Key, pair.Value);
            }
        }

        private static void ApplyTo(string pageId, FrameworkElement root)
        {
            if (root == null) return;
            var resources = root.Resources ?? (root.Resources = new ResourceDictionary());
            RestorePrevious(pageId, resources);

            var snapshot = Snapshot(pageId);
            var applied = new HashSet<string>(StringComparer.Ordinal);
            var originals = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var pair in BuildScope(snapshot))
            {
                if (resources.Contains(pair.Key) && !originals.ContainsKey(pair.Key))
                    originals[pair.Key] = resources[pair.Key];
                resources[pair.Key] = pair.Value;
                applied.Add(pair.Key);
            }
            Applied[pageId] = applied;
            if (originals.Count > 0)
                Originals[pageId] = originals;
            else
                Originals.Remove(pageId);

            if (root is IHostPage host && string.Equals(host.PageId, pageId, StringComparison.Ordinal))
                host.OnPageAppearanceChanged(snapshot);
        }

        /// <summary>撤销上一轮写进页根的 token：页面自己定义过的还原，其余移除，回落到全局值。</summary>
        private static void RestorePrevious(string pageId, ResourceDictionary resources)
        {
            if (!Applied.TryGetValue(pageId, out var previous)) return;
            Originals.TryGetValue(pageId, out var originals);
            foreach (var key in previous)
            {
                if (originals != null && originals.TryGetValue(key, out var original))
                    resources[key] = original;
                else
                    resources.Remove(key);
            }
            Applied.Remove(pageId);
            Originals.Remove(pageId);
        }

        /// <summary>页面/后续区块任务读取某区块是否被配置隐藏（宿主已应用同一结果）。</summary>
        internal static bool IsSectionHidden(string pageId, string sectionId)
        {
            if (_profile == null || pageId == null || sectionId == null) return false;
            if (!_profile.Pages.TryGetValue(pageId, out var style)) return false;
            foreach (var section in style.Sections)
                if (string.Equals(section.Id, sectionId, StringComparison.Ordinal)) return !section.Visible;
            return false;
        }

        /// <summary>
        /// P2 应用：按页面声明的元数据应用显隐与顺序。只动元素本身，不重建、不新增控件。
        /// 关键约束：
        ///   · 只撤销本模块自己加过的隐藏，并且精确还原到覆盖前的原值（Visible / Hidden 都可能）；
        ///   · 默认 / 不可隐藏 / 无配置区块不写 Visibility，页面自己的动态状态不受影响；
        ///   · 隐藏所有权按元素记录，多容器页面也能完整恢复；
        ///   · 元素被替换时只接管该元素，不丢其它区块的隐藏状态；
        ///   · 顺序只对"单容器且容器只装这些区块"的页面生效，多容器保留显隐但不排序。
        /// </summary>
        private static void ApplySections(string pageId, FrameworkElement root)
        {
            if (root is not IPageSectionHost host) return;
            if (!string.Equals(host.PageId, pageId, StringComparison.Ordinal))
            {
                Warn(pageId, "页面声明的 ID 与宿主不一致，区块配置已忽略。");
                return;
            }
            var bindings = host.SectionBindings;
            if (bindings == null || bindings.Count == 0) return;

            var descriptors = new Dictionary<string, PageSectionDescriptor>(StringComparer.Ordinal);
            foreach (var descriptor in host.SectionDescriptors ?? Array.Empty<PageSectionDescriptor>())
                if (descriptor != null && descriptor.Id.Length > 0) descriptors[descriptor.Id] = descriptor;

            var current = new Dictionary<string, FrameworkElement>(StringComparer.Ordinal);
            foreach (var binding in bindings)
            {
                if (binding.Element == null || binding.Id.Length == 0) continue;
                if (!current.TryAdd(binding.Id, binding.Element)) Warn(pageId, "页面重复声明区块：" + binding.Id);
            }
            if (current.Count == 0) return;

            LauncherPageStyle style = null;
            _profile?.Pages.TryGetValue(pageId, out style);
            var configs = style?.Sections ?? (IReadOnlyList<LauncherPageSection>)Array.Empty<LauncherPageSection>();

            // 1) 本模块"应当隐藏"的集合：不可隐藏 / 未声明 / 未知一律不采纳。
            var shouldHide = new HashSet<string>(StringComparer.Ordinal);
            foreach (var config in configs)
            {
                if (!current.ContainsKey(config.Id))
                {
                    Warn(pageId, "未知区块 id：" + config.Id + "（已忽略）");
                    continue;
                }
                if (config.Visible) continue;
                if (!descriptors.TryGetValue(config.Id, out var descriptor) || !descriptor.CanHide)
                {
                    Warn(pageId, "区块不可隐藏：" + config.Id + "（已忽略）");
                    continue;
                }
                shouldHide.Add(config.Id);
            }

            if (!SectionStates.TryGetValue(pageId, out var state))
            {
                state = new SectionState();
                SectionStates[pageId] = state;
            }

            // 2) 撤销本模块以前加过的隐藏：按元素引用核对，精确还原旧值（包括原本就是 Hidden 的元素）。
            foreach (var id in state.Hidden.Keys.ToArray())
            {
                if (shouldHide.Contains(id)) continue;
                var record = state.Hidden[id];
                if (current.TryGetValue(id, out var element) && ReferenceEquals(element, record.Element))
                    element.Visibility = record.Original;
                state.Hidden.Remove(id);
            }

            // 3) 施加新的隐藏：只接管"确实由我们改过"的元素；页面自己收起的元素不抢所有权。
            foreach (var id in shouldHide)
            {
                if (!current.TryGetValue(id, out var element)) continue;
                if (state.Hidden.TryGetValue(id, out var record))
                {
                    if (ReferenceEquals(record.Element, element))
                    {
                        element.Visibility = Visibility.Collapsed;
                        continue;
                    }
                    // 页面替换了这个区块的元素：丢弃旧元素记录，按新元素重新判断是否接管。
                    state.Hidden.Remove(id);
                }
                if (element.Visibility == Visibility.Collapsed) continue;
                state.Hidden[id] = new ElementOverride { Element = element, Original = element.Visibility };
                element.Visibility = Visibility.Collapsed;
            }

            // 4) 顺序：仅单容器页面；多容器页面只保留显隐所有权。
            var moves = new List<KeyValuePair<int, string>>();
            foreach (var config in configs)
            {
                if (!config.Order.HasValue) continue;
                if (!descriptors.TryGetValue(config.Id, out var descriptor) || !descriptor.CanMove)
                {
                    Warn(pageId, "区块不可调整顺序：" + config.Id + "（已忽略）");
                    continue;
                }
                if (current.ContainsKey(config.Id)) moves.Add(new KeyValuePair<int, string>(config.Order.Value, config.Id));
            }
            ApplyOrder(pageId, state, current, moves);
        }

        private static void ApplyOrder(string pageId, SectionState state, Dictionary<string, FrameworkElement> current,
            List<KeyValuePair<int, string>> moves)
        {
            var parent = DetectOrderParent(current);
            var idsChanged = !SameIds(state.OrderIds, current);

            // 元素集合变化时，先把旧基线恢复出来，避免把"已经应用过的顺序"当成新基线。
            if (idsChanged && state.OrderApplied) RestoreOrder(state, current);

            if (parent == null)
            {
                state.OrderParent = null;
                state.OrderIds.Clear();
                state.OrderApplied = false;
                if (moves.Count > 0) Warn(pageId, "区块不在同一个容器里，排序已忽略（只应用显隐）。");
                return;
            }
            if (idsChanged || !ReferenceEquals(state.OrderParent, parent))
            {
                state.OrderParent = parent;
                state.OrderIds.Clear();
                state.OrderIds.AddRange(OrderedIds(parent, current));
                state.OrderApplied = false;
            }
            if (moves.Count == 0)
            {
                if (state.OrderApplied) RestoreOrder(state, current);
                return;
            }
            if (state.OrderIds.Count != current.Count)
            {
                Warn(pageId, "区块结构已变化，排序已忽略（只应用显隐）。");
                return;
            }

            var order = new List<string>(state.OrderIds);
            foreach (var move in moves.OrderBy(pair => pair.Key))
            {
                var at = order.IndexOf(move.Value);
                if (at < 0) continue;
                order.RemoveAt(at);
                order.Insert(Math.Min(move.Key, order.Count), move.Value);
            }
            for (var index = 0; index < order.Count; index++)
            {
                // 元素可能已被页面替换：只移动当前绑定里仍存在的元素，绝不把旧元素塞回容器。
                if (!current.TryGetValue(order[index], out var element)) continue;
                if (!ReferenceEquals(element.Parent, state.OrderParent)) continue;
                if (state.OrderParent.Children.IndexOf(element) == index) continue;
                state.OrderParent.Children.Remove(element);
                state.OrderParent.Children.Insert(index, element);
            }
            state.OrderApplied = true;
        }

        /// <summary>只有"所有区块同属一个 Panel，且该 Panel 只装这些区块"时才允许排序。</summary>
        private static Panel DetectOrderParent(Dictionary<string, FrameworkElement> current)
        {
            var parent = current.Values.FirstOrDefault()?.Parent as Panel;
            if (parent == null) return null;
            if (!current.Values.All(element => ReferenceEquals(element.Parent, parent))) return null;
            if (parent.Children.Count != current.Count) return null;
            return parent;
        }

        private static List<string> OrderedIds(Panel parent, Dictionary<string, FrameworkElement> current)
        {
            var ids = new List<string>();
            foreach (UIElement child in parent.Children)
            {
                if (child is not FrameworkElement element) continue;
                var match = current.FirstOrDefault(pair => ReferenceEquals(pair.Value, element));
                if (match.Key != null) ids.Add(match.Key);
            }
            return ids;
        }

        private static bool SameIds(List<string> order, Dictionary<string, FrameworkElement> current)
            => order.Count == current.Count && current.Keys.All(order.Contains);

        /// <summary>恢复初始顺序：按 id 查当前元素；已被替换/移出容器的旧元素直接跳过，不重新塞回容器。</summary>
        private static void RestoreOrder(SectionState state, Dictionary<string, FrameworkElement> current)
        {
            state.OrderApplied = false;
            if (state.OrderParent == null || state.OrderIds.Count == 0) return;
            for (var index = 0; index < state.OrderIds.Count; index++)
            {
                if (!current.TryGetValue(state.OrderIds[index], out var element)) continue;
                if (!ReferenceEquals(element.Parent, state.OrderParent)) continue;
                var at = state.OrderParent.Children.IndexOf(element);
                if (at < 0 || at == index) continue;
                state.OrderParent.Children.Remove(element);
                state.OrderParent.Children.Insert(Math.Min(index, state.OrderParent.Children.Count), element);
            }
        }
        private static void Warn(string pageId, string message)
        {
            var text = pageId + "：" + message;
            if (!SectionWarningList.Contains(text)) SectionWarningList.Add(text);
        }

        /// <summary>
        /// 当前页需要的 token 子集。取全局值（Appearance 已算好主题缩放）× 页面缩放；
        /// 只处理白名单里的尺寸键，颜色键永远不会出现在这里。
        /// </summary>
        private static Dictionary<string, object> BuildScope(PageAppearanceSnapshot snapshot)
        {
            var scope = new Dictionary<string, object>(StringComparer.Ordinal);
            if (!snapshot.HasOverride) return scope;
            var density = snapshot.Density;
            var font = snapshot.FontScale;
            if (Math.Abs(density - 1) < 0.001 && Math.Abs(font - 1) < 0.001) return scope;

            var global = Application.Current?.Resources;
            if (global == null) return scope;

            foreach (var key in TokenKeys)
            {
                if (!global.Contains(key)) continue;
                switch (global[key])
                {
                    case double size:
                        scope[key] = Math.Round(Math.Clamp(size * font, MinFontSize, MaxFontSize), 2);
                        break;
                    case Thickness pad:
                        scope[key] = new Thickness(
                            Math.Round(Math.Clamp(pad.Left * density, 0, 60), 2),
                            Math.Round(Math.Clamp(pad.Top * density, 0, 60), 2),
                            Math.Round(Math.Clamp(pad.Right * density, 0, 60), 2),
                            Math.Round(Math.Clamp(pad.Bottom * density, 0, 60), 2));
                        break;
                }
            }
            return scope;
        }
    }
}
