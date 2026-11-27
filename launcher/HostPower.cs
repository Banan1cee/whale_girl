using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace WhaleLauncher
{
    /// <summary>
    /// 主机电源 / 登录会话状态。手机端要远程操作这台电脑，先得知道
    /// 「现在是不是锁着、会不会睡着、能不能替我在电脑上启动内核」——
    /// Windows 没有现成的汇总接口，只能把输入桌面、LogonUI 进程、前台窗口
    /// 和最后输入时间拼起来判断。全部走 P/Invoke，不为了一个睡眠标志拖进 WinForms。
    /// </summary>
    public sealed class HostPower : IDisposable
    {
        /// <summary>一次状态采集的结果。字段名对齐手机端 host-state 的 data。</summary>
        public sealed class HostStatus
        {
            public bool Locked;
            public string InputDesktop = "";
            public bool LogonUI;
            public long Foreground;
            public long IdleSeconds;
            public int SessionId;
            public string KeepAwake = "off";
            public bool RemoteProcessLaunch;
            public bool AutoStart;
            public bool ProcessLaunchAllowed;
            public string Hostname = "";
            public long UptimeSeconds;
            public string UserName = "";
            public bool IsLaptop;
            public bool DisplayOffBlocked;
            public string DisplayOffBlockedReason = "";
            public bool DisplayControl;
        }

        // data/host-remote.json 是手机端设置的落盘位置；开机自启另有注册表这个真源。
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValueName = "WhaleGirlLauncher";
        private const string ConfigFileName = "host-remote.json";

        // SetThreadExecutionState：ES_CONTINUOUS 是「保持住」，另外两个位分别申请系统/显示器别睡。
        private const uint EsContinuous = 0x80000000;
        private const uint EsSystemRequired = 0x00000001;
        private const uint EsDisplayRequired = 0x00000002;

        // 桌面访问位：不同 Windows 版本在锁屏时允许的位不一样，依次试，
        // 只要有一个能打开就说明输入桌面还属于用户（Default），别把能打开的误判成已锁。
        private const uint DesktopReadObjects = 0x0001;
        private const uint DesktopSwitchDesktop = 0x0100;
        private const uint DesktopWriteObjects = 0x0080;

        private const int UoiName = 2;
        private const uint WmSysCommand = 0x0112;
        private const int ScMonitorPower = 0xF170;
        private const long HwndBroadcast = 0xFFFF;

        private static readonly JsonSerializerOptions ConfigJson = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        };

        private readonly string _baseDir;
        private readonly string _dataDir;
        private readonly string _configPath;
        private readonly long _startedTick;
        private string _keepAwake = "off";
        private bool _remoteProcessLaunch;
        private bool _autoStart;
        // 远程开关屏幕是带物理影响的动作，默认关；开启后桌面/手机才出现亮屏与关屏按钮。
        private bool _displayControl;
        private bool _disposed;

        public HostPower(string baseDir)
        {
            _baseDir = baseDir;
            _dataDir = Path.Combine(baseDir, "data");
            _configPath = Path.Combine(_dataDir, ConfigFileName);
            _startedTick = Environment.TickCount64;
            LoadConfig();
            // 启动时就生效：用户上次选了防睡眠，不该等到手机再点一次才开始保活。
            // ES_* 是按线程记的，这里在界面线程调用，界面线程活到进程结束，语义正好。
            if (_keepAwake != "off") ApplyExecutionState(_keepAwake);
        }

        public static bool Handles(string action) => action is
            "host-state" or "host-keep-awake" or "host-wake-display" or "host-display-off" or "host-config";

        // 持久化授权仅对普通权限启动器生效。
        public bool ProcessLaunchAllowed => _remoteProcessLaunch && PhoneControl.IsStandardUser();

        public Task<object> RunAsync(string action, JsonElement payload) => Task.FromResult(Dispatch(action, payload));

        private object Dispatch(string action, JsonElement payload)
        {
            switch (action)
            {
                case "host-state": return new { ok = true, data = StateData() };
                case "host-keep-awake": return KeepAwakeAction(payload);
                case "host-wake-display": return WakeDisplayAction();
                case "host-display-off": return DisplayOffAction();
                case "host-config": return ConfigureAction(payload);
                default: return new { ok = false, error = "未知操作。" };
            }
        }

        // ── 状态采集 ────────────────────────────────────────────

        /// <summary>采集一次主机状态。状态页每 2 秒调一次，这里的每条查询都必须是只读且便宜的。</summary>
        public HostStatus ReadStatus()
        {
            var desktop = InputDesktopName(out var opened);
            var logonUi = LogonUiRunning();
            var foreground = GetForegroundWindow();
            var registryAutoStart = ReadAutoStart();
            if (registryAutoStart.HasValue) _autoStart = registryAutoStart.Value;
            return new HostStatus
            {
                // Win11 的锁屏是跑在 Default 桌面上的 LockApp CoreWindow（实测标题「Windows 默认锁屏界面」），
                // 不再是 Winlogon 安全桌面，所以「输入桌面是 Default」不能说明没锁。三路判定：
                //   1) 打不开输入桌面 / 不是 Default → 老式安全桌面锁屏或 UAC；
                //   2) 前台窗口属于 LockApp / LogonUI → Win11 锁屏界面；
                //   3) 其余按已登录。
                Locked = !IsDefaultDesktop(desktop, opened) || LockScreenOwnsForeground(),
                InputDesktop = desktop,
                LogonUI = logonUi,
                Foreground = foreground.ToInt64(),
                IdleSeconds = IdleSeconds(),
                SessionId = CurrentSessionId(),
                KeepAwake = _keepAwake,
                RemoteProcessLaunch = _remoteProcessLaunch,
                AutoStart = _autoStart,
                ProcessLaunchAllowed = ProcessLaunchAllowed,
                Hostname = Environment.MachineName,
                UptimeSeconds = Math.Max(0, (Environment.TickCount64 - _startedTick) / 1000),
                UserName = Environment.UserName,
                IsLaptop = HasSystemBattery(),
                DisplayOffBlocked = DisplayOffBlockedReason(out var displayOffReason),
                DisplayOffBlockedReason = displayOffReason,
                DisplayControl = _displayControl,
            };
        }

        /// <summary>
        /// 远程开关屏幕是否可用：需要用户在电脑端（或手机端）显式打开「允许远程开关屏幕」，
        /// 且不是笔记本。默认关闭——关屏是带物理影响的动作，不该默认暴露到手机上。
        /// </summary>
        internal bool CanControlDisplay => !HasSystemBattery() && _displayControl;

        /// <summary>
        /// 关屏在两种情况下会把会话锁上，远程关屏就失去意义：
        /// 1) 笔记本（有系统电池）：关屏在多数机型上等同进入现代待机，唤醒时按系统策略要求重新登录；
        /// 2) 电源设置「控制台锁定显示关闭超时」(CONSOLELOCK) &gt; 0：Windows 会在关屏后主动锁定。
        /// 台式机 + 该设置为 0 时才允许远程关屏。
        /// </summary>
        private static bool DisplayOffBlockedReason(out string reason)
        {
            if (HasSystemBattery())
            {
                reason = "笔记本上远程关屏通常等同进入待机，唤醒要重新登录（会看起来像锁屏），已禁用；请用合盖或电源键关屏。";
                return true;
            }
            var consoleLock = ConsoleLockSeconds();
            if (consoleLock > 0)
            {
                reason = "系统电源设置「控制台锁定显示关闭超时」= " + consoleLock + " 秒，关屏后会主动锁屏；请先在电源设置里把它设为 0。";
                return true;
            }
            reason = "";
            return false;
        }

        private static bool HasSystemBattery()
        {
            var status = new SystemPowerStatus { BatteryFlag = 255 };
            if (!GetSystemPowerStatus(ref status)) return false;
            // 128 = 无系统电池；255 = 读取失败/未知，按台式机处理，避免误禁用。
            return status.BatteryFlag != 128 && status.BatteryFlag != 255;
        }

        private static uint ConsoleLockSeconds()
        {
            Guid schemeGuid = Guid.Empty;
            IntPtr scheme = IntPtr.Zero;
            IntPtr active = IntPtr.Zero;
            try
            {
                if (PowerGetActiveScheme(IntPtr.Zero, out active) != 0 || active == IntPtr.Zero) return 0;
                schemeGuid = Marshal.PtrToStructure<Guid>(active);
                var sub = new Guid("fea3413e-7e05-4911-9a71-700331f1c294");
                var setting = new Guid("0e796bdb-100d-47d6-a2d5-f7d2daa51f51");
                return PowerReadACValueIndex(IntPtr.Zero, ref schemeGuid, ref sub, ref setting, out var value) == 0
                    ? value
                    : 0;
            }
            catch (Exception)
            {
                // 读不到就按「不会锁屏」放行，宁可少拦也不要因为一次 API 失败把功能锁死。
                return 0;
            }
            finally
            {
                if (active != IntPtr.Zero) LocalFree(active);
            }
        }

        private static bool IsDefaultDesktop(string name, bool opened) =>
            opened && string.Equals(name, "Default", StringComparison.OrdinalIgnoreCase);

        /// <summary>输入桌面名。打不开（安全桌面在活动）时返回空串，调用方按已锁处理。</summary>
        private static string InputDesktopName(out bool opened)
        {
            opened = false;
            var desktop = IntPtr.Zero;
            foreach (var access in new[] { DesktopReadObjects, DesktopSwitchDesktop, DesktopWriteObjects })
            {
                desktop = OpenInputDesktop(0, false, access);
                if (desktop != IntPtr.Zero) { opened = true; break; }
            }
            if (!opened) return "";

            try
            {
                // 先问需要多少字节，再按这个长度取名字（UOI_NAME 会是 "Default" / "Winlogon"）。
                if (!GetUserObjectInformation(desktop, UoiName, IntPtr.Zero, 0, out var needed) && needed == 0) return "";
                if (needed <= sizeof(char)) return "";
                var buffer = Marshal.AllocHGlobal((int)needed);
                try
                {
                    return GetUserObjectInformation(desktop, UoiName, buffer, needed, out _)
                        ? Marshal.PtrToStringUni(buffer) ?? ""
                        : "";
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            catch (Exception)
            {
                return "";
            }
            finally
            {
                CloseDesktop(desktop);
            }
        }

        private static bool LogonUiRunning()
        {
            Process[] processes = null;
            try
            {
                processes = Process.GetProcessesByName("LogonUI");
                return processes.Length > 0;
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                if (processes != null)
                    foreach (var process in processes) process.Dispose();
            }
        }

        /// <summary>
        /// 前台窗口是否属于锁屏界面本身。Win11 用 LockApp 承载锁屏 CoreWindow；
        /// 老式安全桌面锁屏/UAC 下前台句柄为 0，由「输入桌面」那一路判定，这里返回 false。
        /// </summary>
        private static bool LockScreenOwnsForeground()
        {
            var foreground = GetForegroundWindow();
            if (foreground == IntPtr.Zero) return false;
            try
            {
                GetWindowThreadProcessId(foreground, out var pid);
                if (pid == 0) return false;
                using var process = Process.GetProcessById((int)pid);
                return process.ProcessName is "LockApp" or "LogonUI";
            }
            catch (Exception)
            {
                // 进程可能正好退出；按「不是锁屏」处理，避免一次竞态把已登录报成锁屏。
                return false;
            }
        }

        private static long IdleSeconds()
        {
            var info = new LastInputInfo { cbSize = (uint)Marshal.SizeOf<LastInputInfo>() };
            if (!GetLastInputInfo(ref info)) return -1;
            var now = GetTickCount64();
            // dwTime 是 32 位 GetTickCount，跑满 49.7 天会回绕；拼回 64 位再算差，
            // 否则常开的机器上会算出巨大值或负数。
            var last = (now & ~0xFFFFFFFFUL) | info.dwTime;
            if (last > now) last -= 0x1_0000_0000UL;
            var seconds = (long)(now - last) / 1000;
            return seconds < 0 ? -1 : seconds;
        }

        private static int CurrentSessionId()
        {
            try
            {
                using var process = Process.GetCurrentProcess();
                return process.SessionId;
            }
            catch (Exception)
            {
                return -1;
            }
        }

        private object StateData()
        {
            var status = ReadStatus();
            return new
            {
                locked = status.Locked,
                inputDesktop = status.InputDesktop,
                logonUI = status.LogonUI,
                foreground = status.Foreground,
                idleSeconds = status.IdleSeconds,
                sessionId = status.SessionId,
                keepAwake = status.KeepAwake,
                remoteProcessLaunch = status.RemoteProcessLaunch,
                autoStart = status.AutoStart,
                displayControl = status.DisplayControl,
                processLaunchAllowed = status.ProcessLaunchAllowed,
                hostname = status.Hostname,
                uptimeSeconds = status.UptimeSeconds,
                isLaptop = status.IsLaptop,
                displayOffBlocked = status.DisplayOffBlocked,
                displayOffBlockedReason = status.DisplayOffBlockedReason,
            };
        }

        // ── 动作 ────────────────────────────────────────────────

        private object KeepAwakeAction(JsonElement payload)
        {
            var mode = Text(payload, "mode");
            if (mode is not ("off" or "system" or "display")) return new { ok = false, error = "保活模式无效。" };
            var error = TrySetKeepAwake(mode);
            return error == null
                ? new { ok = true, data = new { mode = _keepAwake } }
                : new { ok = false, error };
        }

        private object ConfigureAction(JsonElement payload)
        {
            bool? autoStart = null;
            bool? displayControl = null;
            if (payload.ValueKind == JsonValueKind.Object)
            {
                if (payload.TryGetProperty("remoteProcessLaunch", out _))
                    return new { ok = false, error = "请在电脑端更改「允许手机启动内核」。" };
                if (!TryOptionalBoolean(payload, "autoStart", out autoStart) ||
                    !TryOptionalBoolean(payload, "displayControl", out displayControl))
                    return new { ok = false, error = "主机设置无效。" };
            }
            else if (payload.ValueKind != JsonValueKind.Undefined)
            {
                return new { ok = false, error = "主机设置无效。" };
            }

            // 先写注册表再落盘：注册表写失败就整体不生效，别让界面显示「已开」而实际没开。
            if (autoStart is bool enabled)
            {
                if (!WriteAutoStart(enabled)) return new { ok = false, error = "开机自启设置失败，请检查系统权限。" };
                _autoStart = enabled;
            }
            if (displayControl is bool allowDisplay) _displayControl = allowDisplay;
            if (autoStart == null && displayControl == null) return new { ok = true, data = ConfigData() };
            if (!SaveConfig()) return new { ok = false, error = "保存主机设置失败，请检查安装目录权限。" };
            return new { ok = true, data = ConfigData() };
        }

        private object WakeDisplayAction()
        {
            var blocked = DisplayControlBlocked();
            if (blocked != null) return new { ok = false, error = blocked };
            // SC_MONITORPOWER -1 在 Win8+ 只有前台程序发才生效（实测：关屏能关、点亮点不亮），
            // 所以真正的唤醒手段是「合成一次 1 像素鼠标移动」+ ES_DISPLAY_REQUIRED，
            // 两者都按输入/电源请求处理，不依赖前台身份。
            BroadcastMonitorOn();
            _ = Task.Run(async () =>
            {
                try
                {
                    // 临时挡住熄屏，给显示器反应时间。ES_* 按线程记，复位也留在同一根线程上，
                    // 不碰界面线程正在用的保活模式。
                    SetThreadExecutionState(EsContinuous | EsSystemRequired | EsDisplayRequired);
                    for (var attempt = 0; attempt < 3; attempt++)
                    {
                        NudgeMouse();
                        await Task.Delay(400).ConfigureAwait(false);
                    }
                    await Task.Delay(1500).ConfigureAwait(false);
                    SetThreadExecutionState(FlagsFor(_keepAwake));
                }
                catch (Exception)
                {
                    // 唤醒失败不影响动作返回；下一次用户输入或保活设置会重新申请。
                }
            });
            return new { ok = true, message = "已尝试唤醒显示器。若屏幕仍黑，请检查显示器电源或直接在电脑上动一下鼠标。" };
        }

        /// <summary>
        /// 合成 1 像素鼠标移动再移回。这是让 DPMS 熄屏醒来的可靠手段：系统把它当真实输入，
        /// 在桌面分发之前就会点亮显示器；位移 1 像素不会把用户光标挪走。
        /// </summary>
        private static void NudgeMouse()
        {
            if (!GetCursorPos(out var origin)) return;
            mouse_event(MouseEventMove, 1, 0, 0, UIntPtr.Zero);
            Thread.Sleep(30);
            mouse_event(MouseEventMove, -1, 0, 0, UIntPtr.Zero);
            // 极端情况下缩放会让 1 像素往返留下偏移，兜底把光标放回原处。
            SetCursorPos(origin.X, origin.Y);
        }

        private static void BroadcastMonitorOn() =>
            PostMessage(new IntPtr(HwndBroadcast), WmSysCommand, new IntPtr(ScMonitorPower), new IntPtr(-1));

        /// <summary>
        /// 关显示器（不是锁屏）。只是广播系统命令，会话仍停留在已登录的 Default 桌面；
        /// 屏幕是否再自动亮起取决于电源计划里「屏幕关闭」超时和用户是否有输入。
        /// </summary>
        private object DisplayOffAction()
        {
            var error = RequestDisplayOff();
            return error == null
                ? new { ok = true, message = "已发送关屏指令。若屏幕仍亮，请检查显示器/电源设置的关闭超时。" }
                : new { ok = false, error };
        }

        // ── 供状态页直接调用（返回 null 表示成功，否则是给用户看的中文话术）──

        internal string TrySetKeepAwake(string mode)
        {
            _keepAwake = NormalizeMode(mode);
            ApplyExecutionState(_keepAwake);
            return SaveConfig() ? null : "保存主机设置失败，请检查安装目录权限。";
        }

        internal string TrySetRemoteProcessLaunch(bool enabled)
        {
            _remoteProcessLaunch = enabled;
            return SaveConfig() ? null : "保存主机设置失败，请检查安装目录权限。";
        }

        internal string TrySetAutoStart(bool enabled)
        {
            if (!WriteAutoStart(enabled)) return "开机自启设置失败，请检查系统权限。";
            _autoStart = enabled;
            return SaveConfig() ? null : "保存主机设置失败，请检查安装目录权限。";
        }

        internal string TrySetDisplayControl(bool enabled)
        {
            _displayControl = enabled;
            return SaveConfig() ? null : "保存主机设置失败，请检查安装目录权限。";
        }

        /// <summary>
        /// 远程开关屏幕的前置检查。返回 null 表示可用，否则是给用户看的中文原因。
        /// 顺序按「用户最可能踩到的原因」排：笔记本 &gt; 功能没开 &gt; 关屏锁定策略 &gt; 防关屏保活。
        /// </summary>
        private string DisplayControlBlocked()
        {
            if (HasSystemBattery())
                return "笔记本上不提供远程开关屏幕：关屏通常等同进入待机，唤醒要重新登录。";
            if (!_displayControl)
                return "远程开关屏幕未开启：请先在「主机」里勾选「允许远程开关屏幕」。";
            if (DisplayOffBlockedReason(out var blocked)) return blocked;
            return null;
        }

        /// <summary>
        /// 关显示器（不锁屏）。返回 null 表示已发送指令，否则是给界面直接显示的中文原因。
        /// 「防关屏」保活会一直申请 ES_DISPLAY_REQUIRED，此时关屏会被系统立刻恢复，
        /// 与其让用户以为按钮坏了，不如直接说清楚要先切模式。
        /// </summary>
        internal string RequestDisplayOff()
        {
            var blocked = DisplayControlBlocked();
            if (blocked != null) return blocked;
            if (_keepAwake == "display") return "当前是「防关屏」保活模式，屏幕不会关。请先切到「防睡眠」或「关」。";
            PostMessage(new IntPtr(HwndBroadcast), WmSysCommand, new IntPtr(ScMonitorPower), new IntPtr(2));
            return null;
        }

        private object ConfigData() => new
        {
            remoteProcessLaunch = _remoteProcessLaunch,
            autoStart = _autoStart,
            displayControl = _displayControl,
        };

        // ── 保活 ────────────────────────────────────────────────

        private static uint FlagsFor(string mode) => mode switch
        {
            "system" => EsContinuous | EsSystemRequired,
            "display" => EsContinuous | EsSystemRequired | EsDisplayRequired,
            _ => EsContinuous,
        };

        private static void ApplyExecutionState(string mode) => SetThreadExecutionState(FlagsFor(mode));

        // ── 持久化 ──────────────────────────────────────────────

        private sealed class HostRemoteConfig
        {
            public string KeepAwake { get; set; } = "off";
            public bool RemoteProcessLaunch { get; set; }
            public bool AutoStart { get; set; }
            public bool DisplayControl { get; set; }
        }

        private void LoadConfig()
        {
            var config = ReadConfigFile();
            _keepAwake = NormalizeMode(config.KeepAwake);
            _remoteProcessLaunch = config.RemoteProcessLaunch;
            _displayControl = config.DisplayControl;
            // 注册表才是「开机自启现在到底开没开」的真源：用户可能在任务管理器里关过。
            _autoStart = ReadAutoStart() ?? config.AutoStart;
        }

        private HostRemoteConfig ReadConfigFile()
        {
            try
            {
                if (!File.Exists(_configPath)) return new HostRemoteConfig();
                using var document = JsonDocument.Parse(File.ReadAllText(_configPath));
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return new HostRemoteConfig();
                var config = new HostRemoteConfig();
                if (root.TryGetProperty("keepAwake", out var keep) && keep.ValueKind == JsonValueKind.String)
                    config.KeepAwake = keep.GetString();
                if (root.TryGetProperty("remoteProcessLaunch", out var remote) &&
                    remote.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    config.RemoteProcessLaunch = remote.GetBoolean();
                if (root.TryGetProperty("autoStart", out var auto) && auto.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    config.AutoStart = auto.GetBoolean();
                if (root.TryGetProperty("displayControl", out var display) &&
                    display.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    config.DisplayControl = display.GetBoolean();
                return config;
            }
            catch (Exception)
            {
                // 文件缺失 / 半截 / 手改坏都按默认值走，不能因为一份设置让启动器起不来。
                return new HostRemoteConfig();
            }
        }

        private bool SaveConfig()
        {
            var temp = _configPath + "." + Environment.ProcessId + ".tmp";
            try
            {
                Directory.CreateDirectory(_dataDir);
                var config = new HostRemoteConfig
                {
                    KeepAwake = _keepAwake,
                    RemoteProcessLaunch = _remoteProcessLaunch,
                    AutoStart = _autoStart,
                    DisplayControl = _displayControl,
                };
                // 临时文件 + 移动覆盖：中途断电也不会留下一份读不出来的半截配置。
                File.WriteAllText(temp, JsonSerializer.Serialize(config, ConfigJson));
                File.Move(temp, _configPath, overwrite: true);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                try { if (File.Exists(temp)) File.Delete(temp); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }

        private static string NormalizeMode(string mode) => mode is "system" or "display" ? mode : "off";

        private static string Text(JsonElement body, string field)
        {
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty(field, out var value) &&
                value.ValueKind == JsonValueKind.String && value.GetString() is string text) return text.Trim();
            return "";
        }

        private static bool TryOptionalBoolean(JsonElement body, string field, out bool? value)
        {
            value = null;
            if (!body.TryGetProperty(field, out var element) || element.ValueKind == JsonValueKind.Null) return true;
            if (element.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
            value = element.GetBoolean();
            return true;
        }

        // ── 开机自启 ────────────────────────────────────────────

        private string AutoStartCommand => "\"" + Path.Combine(_baseDir, "WhaleLauncher.exe") + "\"";

        /// <summary>读真实注册状态；读失败返回 null，让调用方退回配置文件里的值。</summary>
        private bool? ReadAutoStart()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
                var value = key?.GetValue(RunValueName) as string;
                if (string.IsNullOrEmpty(value)) return false;
                // 路径对不上说明注册的是旧安装目录，不该对用户谎报「已开」。
                return string.Equals(value.Trim(), AutoStartCommand, StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private bool WriteAutoStart(bool enabled)
        {
            try
            {
                using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
                if (key == null) return false;
                if (enabled) key.SetValue(RunValueName, AutoStartCommand, RegistryValueKind.String);
                else key.DeleteValue(RunValueName, throwOnMissingValue: false);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        // ── P/Invoke ────────────────────────────────────────────

        [StructLayout(LayoutKind.Sequential)]
        private struct LastInputInfo
        {
            public uint cbSize;
            public uint dwTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SystemPowerStatus
        {
            public byte ACLineStatus;
            public byte BatteryFlag;
            public byte BatteryLifePercent;
            public byte SystemStatusFlag;
            public uint BatteryLifeTime;
            public uint BatteryFullLifeTime;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSystemPowerStatus(ref SystemPowerStatus status);

        [DllImport("powrprof.dll")]
        private static extern uint PowerGetActiveScheme(IntPtr userRootPowerKey, out IntPtr activePolicyGuid);

        [DllImport("powrprof.dll")]
        private static extern uint PowerReadACValueIndex(IntPtr rootPowerKey, ref Guid schemeGuid,
            ref Guid subGroupGuid, ref Guid powerSettingGuid, out uint valueIndex);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr handle);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint access);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseDesktop(IntPtr desktop);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetUserObjectInformation(IntPtr obj, int index, IntPtr info, uint length, out uint needed);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        [StructLayout(LayoutKind.Sequential)]
        private struct Point
        {
            public int X;
            public int Y;
        }

        private const uint MouseEventMove = 0x0001;

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetCursorPos(out Point point);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extraInfo);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetLastInputInfo(ref LastInputInfo info);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        private static extern ulong GetTickCount64();

        [DllImport("kernel32.dll")]
        private static extern uint SetThreadExecutionState(uint flags);

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            // 退出前必须显式清掉保活：ES_STATE 按线程记，进程没了也许没事，
            // 但正常关窗时还让系统以为有人需要防睡眠就不对了。
            SetThreadExecutionState(EsContinuous);
        }
    }
}
