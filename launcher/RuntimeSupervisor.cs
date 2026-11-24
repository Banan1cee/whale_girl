using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace WhaleLauncher
{
    /// <summary>一行日志。Src：K=内核 B=桥接 L=启动器。</summary>
    public sealed class LogLine
    {
        public DateTime At { get; set; }
        public string Src { get; set; }
        public char Level { get; set; }
        public string Text { get; set; }
    }

    /// <summary>一次状态探测的结果。界面只读这个。</summary>
    public sealed class Snapshot
    {
        public bool NodeUp;
        public bool ExternalNode;
        public bool NodeReady;
        public bool NeedsKey;
        public bool BridgeUp;
        public int Port = 8787;
        public long UptimeSec;
        public string Provider = "";
        public string Model = "";
        public bool HasKey;
        public bool Mock;

        public bool BrOnline;
        public int BrLastSeenSec = -1;
        public bool BrUia;
        public bool BrListener;
        public bool BrFfmpeg;
        public bool BrRest;
        public bool BrAccountGuard;
        public bool BrAccountOk;
        public string BrAccount = "";
        public string BrAccountNick = "";
        public string BrAccountWhy = "";
        public string BrWindow = "";   // 心跳暂未上报窗口状态，留空显示「未知」

        public int StReceived;
        public int StReplied;
        public int StSent;
        public int StFailed;
        public long StLastMessageAt;
        public string StLastError = "";

        // 本轮用量（/api/status 的 budget.lastUsage）：只有真模型调过才有数
        public bool HasUsage;
        public int UsPromptTokens;
        public int UsCacheHitTokens;
        public int UsCompletionTokens;
        public double UsHitRate;
        public int UsEstimatedTokens;
        public double UsRatio;
        public string UsModel = "";
        // 只有 deepseek-flash / deepseek-v4.1-flash 有价目表；其它模型 HasCost=false，界面不显示金额
        public bool UsHasCost;
        public double UsCny;
        public string UsBand = "";
    }

    internal enum DataLockState { Idle, Busy, Stale, Unknown, Recovering, GuardStale, GuardUnknown }

    internal sealed class DataLockInfo
    {
        public DataLockState State;
        public int Pid;
        public string Purpose = "";
        public string Path = "";
        public string Detail = "";
        public string GuardPath = "";
        public int GuardPid;
        public long GuardStartedAt;
        public string GuardPurpose = "";
        public string GuardDetail = "";
    }

    /// <summary>升级维护脚本的只读 status 投影；字段与 Node 契约稳定对应。</summary>
    internal sealed class MemoryUpgradeStatus
    {
        public string Status = "";
        public int Version;
        public int TargetVersion;
        public bool CanAuto;
        public bool RunnerRequired;
        public bool RunnerCleanupEligible;
        public long LegacySources;
        public long Chats;
        public long Messages;
        public string ReceiptStage = "";
        public string Error = "";
        public string Message = "";
        public string BackupPath = "";
        public JsonElement Raw;
    }

    /// <summary>内核（Node）与桥接（Python）的起停、日志、状态探测。界面只调用这里。</summary>
    public sealed class RuntimeSupervisor : IDisposable
    {
        public string BaseDir { get; }
        // 启动检查完成前及强制态禁止所有业务启动入口，不能只靠主窗口按钮拦截。
        public bool UpdateBlocked { get; set; }
        // 更新流程开始后禁止再拿 data 目录做离线转换；与 MigrationLockActive 一起覆盖两个方向。
        public bool UpdateInProgress { get; set; }
        // 启动失败要能被按钮层立即呈现；只写历史日志会被 Refresh 的状态行覆盖。
        public string LastStartFailure { get; private set; } = "";
        private LocalConfiguration _localConfiguration;
        private int _observedExternalSettingsPort;
        internal bool SettingsServiceObserved => NodeRunning ||
            (_observedExternalSettingsPort != 0 && _observedExternalSettingsPort == Port);
        private readonly System.Threading.SemaphoreSlim _configurationWrites = new(1, 1);
        internal int PersonaRevision { get; private set; }
        internal void NotifyPersonaChanged() => PersonaRevision++;
        private ContactDirectory _contacts;
        /// <summary>联系人缓存 / 搜索的统一入口，各页面共用，避免重复请求和搜索规则漂移。</summary>
        public ContactDirectory Contacts => _contacts ??= new ContactDirectory(this);

        private const string DataLockFileName = ".data.lock";
        private const string DataLockGuardName = ".data.lock.recover";

        private sealed class RawLockInfo
        {
            public DataLockState State;
            public int Pid;
            public long StartedAt;
            public string Purpose = "";
            public string Detail = "";
        }

        /// <summary>只读解析一个锁/守卫文件；绝不删除、改名或杀进程。</summary>
        private static RawLockInfo ReadRawLock(string file)
        {
            var result = new RawLockInfo { State = DataLockState.Idle };
            string raw;
            try { raw = File.ReadAllText(file); }
            catch (FileNotFoundException) { return result; }
            catch (DirectoryNotFoundException) { return result; }
            catch (Exception ex) { result.State = DataLockState.Unknown; result.Detail = ex.GetType().Name; return result; }
            try
            {
                using var document = JsonDocument.Parse(raw);
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty("version", out var version) || !version.TryGetInt32(out var format) || format != 1
                    || !root.TryGetProperty("pid", out var pidElement) || !pidElement.TryGetInt32(out var pid) || pid <= 0
                    || !root.TryGetProperty("token", out var tokenElement) || tokenElement.ValueKind != JsonValueKind.String
                    || (tokenElement.GetString() ?? "").Length < 8
                    || !root.TryGetProperty("purpose", out var purposeElement) || purposeElement.ValueKind != JsonValueKind.String
                    || !root.TryGetProperty("host", out var hostElement) || hostElement.ValueKind != JsonValueKind.String
                    || !root.TryGetProperty("startedAt", out var startedElement) || !startedElement.TryGetInt64(out var started))
                {
                    result.State = DataLockState.Unknown; result.Detail = "invalid_metadata"; return result;
                }
                result.Pid = pid;
                result.Purpose = purposeElement.GetString() ?? "";
                result.StartedAt = started;
                if (!string.Equals(hostElement.GetString(), Environment.MachineName, StringComparison.OrdinalIgnoreCase))
                {
                    result.State = DataLockState.Unknown; result.Detail = "host_mismatch"; return result;
                }
                try
                {
                    using var process = Process.GetProcessById(pid);
                    result.State = process.HasExited ? DataLockState.Stale : DataLockState.Busy;
                }
                catch (ArgumentException) { result.State = DataLockState.Stale; }
                catch (Exception ex) { result.State = DataLockState.Unknown; result.Detail = ex.GetType().Name; }
                return result;
            }
            catch { result.State = DataLockState.Unknown; result.Detail = "invalid_metadata"; return result; }
        }

        /// <summary>
        /// 只读检查 data 目录锁与恢复守卫，不杀进程、不删/改名文件。
        /// 健康主锁优先：主锁持有者活着时，守卫残留不改变“正被占用”的结论。
        /// 守卫 live=recovering；守卫 pid 确认死亡=guard_stale；守卫坏/未知=guard_unknown；
        /// 这三种都 fail-closed，由用户按诊断手动处理，启动器不参与恢复。
        /// </summary>
        internal DataLockInfo InspectDataLock()
        {
            var info = new DataLockInfo
            {
                State = DataLockState.Idle,
                Path = Path.Combine(DataDir, DataLockFileName),
                GuardPath = Path.Combine(DataDir, DataLockGuardName),
            };
            var main = ReadRawLock(info.Path);
            info.Pid = main.Pid;
            info.Purpose = main.Purpose;
            info.Detail = main.Detail;
            if (main.State == DataLockState.Busy || main.State == DataLockState.Unknown)
            {
                info.State = main.State;
                return info;
            }
            var guard = ReadRawLock(info.GuardPath);
            info.GuardPid = guard.Pid;
            info.GuardStartedAt = guard.StartedAt;
            info.GuardPurpose = guard.Purpose;
            info.GuardDetail = guard.Detail;
            if (guard.State == DataLockState.Busy) { info.State = DataLockState.Recovering; return info; }
            if (guard.State == DataLockState.Stale) { info.State = DataLockState.GuardStale; return info; }
            if (guard.State == DataLockState.Unknown) { info.State = DataLockState.GuardUnknown; return info; }
            info.State = main.State; // Idle / Stale
            return info;
        }

        /// <summary>
        /// 关窗只需要躲开“真的在写数据”的进程；死守卫/坏守卫没有活动进程，
        /// 不应该让用户关不掉启动器，诊断留到启动/迁移入口再阻止。
        /// </summary>
        internal bool MigrationProcessActive(out string detail)
        {
            var info = InspectDataLock();
            detail = "";
            if (info.State == DataLockState.Recovering)
            {
                detail = "另一个进程正在恢复数据目录锁。";
                return true;
            }
            if (info.State == DataLockState.Busy && info.Purpose == "migration")
            {
                detail = "记忆转换工具正在运行。";
                return true;
            }
            return false;
        }

        /// <summary>更新入口只看迁移锁；server 正常持有 data 目录不算“转换中”。</summary>
        internal bool MigrationLockActive(out string detail)
        {
            var info = InspectDataLock();
            detail = "";
            if (info.State == DataLockState.Unknown
                || info.State == DataLockState.Recovering
                || info.State == DataLockState.GuardStale
                || info.State == DataLockState.GuardUnknown
                || (info.State == DataLockState.Busy && info.Purpose == "migration"))
            {
                detail = info.State switch
                {
                    DataLockState.Unknown => "无法确认数据目录锁的持有者。",
                    DataLockState.Recovering => "另一个进程正在恢复数据目录锁。",
                    DataLockState.GuardStale => "上次记忆恢复进程异常退出，需要手动清理锁文件。",
                    DataLockState.GuardUnknown => "无法确认数据目录恢复守卫。",
                    _ => "记忆转换工具正在运行。",
                };
                return true;
            }
            return false;
        }

        private async Task<string> ConfigurationServiceUrlAsync()
        {
            var port = Port;
            return NodeRunning || await ReadHealthyNodePidAsync(port) > 0
                ? $"http://127.0.0.1:{port}" : null;
        }

        public async Task<ApiResult> ReadConfigurationAsync(string path, bool forceRefresh = false)
        {
            var url = await ConfigurationServiceUrlAsync();
            return url != null ? await Api.Get(url, path)
                : await (_localConfiguration ??= new LocalConfiguration(BaseDir)).ReadAsync(path, forceRefresh);
        }

        internal async Task<ApiResult> PreviewPersonaPresetAsync(string id)
        {
            var url = await ConfigurationServiceUrlAsync();
            return url != null ? await Api.Get(url, "/api/persona/preset?id=" + Uri.EscapeDataString(id))
                : await (_localConfiguration ??= new LocalConfiguration(BaseDir)).PreviewPersonaPresetAsync(id);
        }

        internal async Task<(ApiResult Config, ApiResult Settings)> ReadSettingsSnapshotAsync(bool online)
        {
            const string configPath = "/api/config";
            const string settingsPath = "/api/settings";
            if (online)
            {
                // 状态轮询只提示何时值得刷新。实际在线请求仍确认内核身份。
                var url = await ConfigurationServiceUrlAsync();
                if (url == null)
                {
                    var unavailable = new ApiResult { Error = "内核未就绪" };
                    return (unavailable, unavailable);
                }

                var config = Api.Get(url, configPath, timeoutSeconds: 2);
                var settings = Api.Get(url, settingsPath, timeoutSeconds: 2);
                await Task.WhenAll(config, settings);
                return (await config, await settings);
            }

            var snapshot = await (_localConfiguration ??= new LocalConfiguration(BaseDir)).ReadSnapshotAsync();
            if (!snapshot.Ok) return (snapshot, snapshot);

            ApiResult Read(string path)
            {
                var value = snapshot.Prop(path);
                return value.ValueKind == JsonValueKind.Object
                    ? new ApiResult { Ok = true, StatusCode = 200, Root = value }
                    : new ApiResult { Error = "本地设置不完整" };
            }
            return (Read(configPath), Read(settingsPath));
        }

        public async Task<ApiResult> SaveConfigurationAsync(string path, object body)
        {
            await _configurationWrites.WaitAsync();
            try
            {
                var url = await ConfigurationServiceUrlAsync();
                return url != null ? await Api.PostJson(url, path, body)
                    : await (_localConfiguration ??= new LocalConfiguration(BaseDir)).SaveAsync(path, body);
            }
            finally { _configurationWrites.Release(); }
        }

        internal bool MemoryMigrationRunning { get; private set; }
        private bool _memoryMigrationExitUnconfirmed;

        internal async Task<ApiResult> RunOfflineMemoryMigrationAsync(bool apply)
        {
            ApiResult Failure(string error) => new ApiResult { Error = error };
            await _configurationWrites.WaitAsync();
            try
            {
                if (_disposed || UpdateBlocked) return Failure("请完成更新检查后再转换记忆。");
                if (UpdateInProgress) return Failure("正在更新，请等更新结束后再转换记忆。");
                var lockInfo = InspectDataLock();
                if (lockInfo.State == DataLockState.Recovering)
                    return Failure("另一个进程正在恢复数据目录锁，请等它结束后再转换记忆。");
                if (lockInfo.State == DataLockState.GuardStale)
                    return Failure(DataLockGuardStaleMessage(lockInfo));
                if (lockInfo.State == DataLockState.GuardUnknown)
                    return Failure(DataLockGuardUnknownMessage(lockInfo));
                if (lockInfo.State == DataLockState.Busy || lockInfo.State == DataLockState.Unknown)
                {
                    return Failure(lockInfo.State == DataLockState.Unknown
                        ? "无法确认数据目录锁的持有者，请确认没有其他启动器或转换进程后再试。"
                        : lockInfo.Purpose == "server"
                            ? "内核仍占用数据目录，请先停止内核再转换记忆。"
                            : "另一个记忆转换进程正在运行，请等它结束。");
                }
                if (!apply && lockInfo.State == DataLockState.Stale)
                    return Failure("上次记忆转换没有正常结束，请直接开始转换以安全恢复。");
                if (_memoryMigrationExitUnconfirmed) return Failure("找不到上次转换进程的退出证明，请确认已退出后重新打开启动器。");
                if (NodeRunning || BridgeRunning || await ReadHealthyNodePidAsync(Port) > 0)
                    return Failure("请先停止内核和桥接，再转换记忆。");
                if (_disposed) return Failure("启动器正在关闭。");
                var script = Path.Combine(BaseDir, "scripts", "migrate-memory.js");
                if (!File.Exists(script)) return Failure("安装目录缺少记忆转换工具，请重新安装完整版本。");
                var start = new ProcessStartInfo(NodeExecutable)
                {
                    WorkingDirectory = BaseDir,
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
                };
                foreach (var arg in new[] { script, "--json", "--from-store", "--data", DataDir })
                    start.ArgumentList.Add(arg);
                if (apply) start.ArgumentList.Add("--apply");
                MemoryMigrationRunning = true;
                var run = await ProcessRunner.RunAsync(start, null, TimeSpan.FromMinutes(apply ? 10 : 1));
                if (run.Started && !run.TerminationConfirmed)
                {
                    _memoryMigrationExitUnconfirmed = true;
                    return Failure("无法确认转换进程已退出。请关闭该进程后再重新打开启动器。");
                }
                if (run.TimedOut) return Failure("记忆转换工具超时，请检查数据目录与备份后重试。");
                var busy = MigrationBusyMessage(run.Output);
                if (busy != null) return Failure(busy);
                if (!run.Success) return Failure("记忆转换工具失败，请检查数据目录权限和备份。");
                using var document = JsonDocument.Parse(run.Output);
                var result = new ApiResult { Root = document.RootElement.Clone() };
                return result.Bool("ok") && (result.Str("status") == "idle"
                    || result.Str("status") == (apply ? "done" : "pending"))
                    ? new ApiResult { Ok = true, Root = result.Root } : Failure("记忆转换工具返回无效结果。");
            }
            catch (JsonException) { return Failure("记忆转换工具返回无效结果。"); }
            finally
            {
                MemoryMigrationRunning = false;
                _configurationWrites.Release();
            }
        }

        private string DataLockGuardStaleMessage(DataLockInfo info)
        {
            var started = info.GuardStartedAt > 0
                ? DateTimeOffset.FromUnixTimeMilliseconds(info.GuardStartedAt).UtcDateTime.ToString("o")
                : "未知";
            return "上次数据目录锁恢复进程异常退出（pid=" + info.GuardPid + "，startedAt=" + started + "）。"
                + "请先停止鲸鲸和所有转换重试，确认没有相关进程后手动删除："
                + info.GuardPath + "（恢复守卫）；仅当主锁 " + info.Path + " 记录的 pid 也已退出时，再删除主锁。程序不会自动删除。";
        }

        private static string DataLockGuardUnknownMessage(DataLockInfo info)
        {
            return "无法确认数据目录恢复守卫的持有者（" + info.GuardPath + "）。"
                + "请先停止鲸鲸和所有转换重试，确认没有相关进程后手动删除该守卫文件；程序不会自动删除。";
        }

        private static string MigrationBusyMessage(string output)
        {
            if (string.IsNullOrWhiteSpace(output)) return null;
            try
            {
                using var document = JsonDocument.Parse(output);
                var root = document.RootElement;
                if (root.ValueKind == JsonValueKind.Object
                    && root.TryGetProperty("status", out var status)
                    && status.ValueKind == JsonValueKind.String
                    && status.GetString() == "busy")
                {
                    return root.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String
                        ? message.GetString() : "数据目录正被另一个进程使用。";
                }
            }
            catch { /* 非 JSON 时沿用普通失败话术 */ }
            return null;
        }

        // 记忆格式目标版本与 src/memory/formatVersion 保持一致；启动前由 Node 维护脚本再确认一次。
        private const int MemoryFormatTarget = 3;
        private const string AutoUpgradeFlag = "--auto-upgrade";
        private string MaintenanceScript => Path.Combine(BaseDir, "scripts", "migrate", "upgrade-maintenance.js");
        private string MigrationRunner => Path.Combine(BaseDir, "scripts", "migrate-memory.js");

        private async Task<ProcessRunResult> RunUpgradeToolAsync(string script, string action, TimeSpan timeout)
        {
            if (string.IsNullOrWhiteSpace(script) || !File.Exists(script)) return new ProcessRunResult();
            var start = new ProcessStartInfo(NodeExecutable)
            {
                WorkingDirectory = BaseDir,
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            };
            start.ArgumentList.Add(script);
            if (action == AutoUpgradeFlag)
            {
                start.ArgumentList.Add(action);
                start.ArgumentList.Add("--json");
            }
            else
            {
                start.ArgumentList.Add("--json");
                if (!string.IsNullOrWhiteSpace(action)) start.ArgumentList.Add(action);
            }
            start.ArgumentList.Add("--data");
            start.ArgumentList.Add(DataDir);
            return await ProcessRunner.RunAsync(start, null, timeout);
        }

        private static MemoryUpgradeStatus ParseUpgradeStatus(string output)
        {
            if (string.IsNullOrWhiteSpace(output)) return null;
            try
            {
                using var document = JsonDocument.Parse(output);
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return null;
                var status = new MemoryUpgradeStatus
                {
                    Raw = root.Clone(),
                    Status = Str(root, "status"),
                    Version = (int)Long(root, "version"),
                    TargetVersion = (int)Long(root, "targetVersion"),
                    CanAuto = Bool(root, "canAuto"),
                    RunnerRequired = Bool(root, "runnerRequired"),
                    RunnerCleanupEligible = Bool(root, "runnerCleanupEligible"),
                    LegacySources = Long(root, "legacySources"),
                    Chats = Long(root, "chats"),
                    Messages = Long(root, "messages"),
                    Error = Str(root, "error"),
                    Message = Str(root, "message"),
                    BackupPath = Str(root, "backupPath"),
                };
                if (root.TryGetProperty("receipt", out var receipt) && receipt.ValueKind == JsonValueKind.Object)
                    status.ReceiptStage = Str(receipt, "stage");
                return status;
            }
            catch { return null; }
        }

        private int CountOldSources()
        {
            var names = new[] { "store.json", "store.json.journal", "memory.json", "memory.json.journal" };
            var count = 0;
            foreach (var name in names)
            {
                try { if (File.Exists(Path.Combine(DataDir, name))) count++; } catch { /* 只读判断 */ }
            }
            return count;
        }

        /// <summary>
        /// 维护脚本缺失时的保守回退：manifest 已是 v3 或真正空库才允许启动；
        /// 有旧数据/旧源但判断不了 → pending，交给上层阻止启动。
        /// </summary>
        private MemoryUpgradeStatus InspectFallbackUpgradeStatus()
        {
            var memory = Path.Combine(DataDir, "memory");
            var manifest = Path.Combine(memory, "manifest.json");
            var version = 0;
            var hasManifest = File.Exists(manifest);
            if (hasManifest)
            {
                try
                {
                    using var document = JsonDocument.Parse(File.ReadAllText(manifest));
                    if (document.RootElement.ValueKind == JsonValueKind.Object
                        && document.RootElement.TryGetProperty("formatVersion", out var field)
                        && field.TryGetInt32(out var parsed)) version = parsed;
                }
                catch { /* 坏 manifest 按未知/待处理 */ }
            }
            var oldSources = CountOldSources();
            var hasMemory = Directory.Exists(memory);
            var legacyLeft = Directory.Exists(Path.Combine(memory, "legacy"));
            var receiptPending = HasIncompleteUpgradeReceipt();
            var status = new MemoryUpgradeStatus
            {
                TargetVersion = MemoryFormatTarget,
                Version = version,
                CanAuto = File.Exists(MigrationRunner),
                RunnerRequired = !File.Exists(MigrationRunner),
                LegacySources = oldSources,
            };
            // 维护脚本缺失时不能只凭 manifest 猜：legacy 残留/未完成 receipt 说明
            // 清理或转换仍未完成，必须 fail-closed，等维护工具恢复后再启动。
            if (!hasMemory && oldSources == 0 && !hasManifest && !legacyLeft && !receiptPending)
            {
                status.Status = "idle";
                return status;
            }
            if (version == MemoryFormatTarget && oldSources == 0 && !legacyLeft && !receiptPending)
            {
                status.Status = "idle";
                return status;
            }
            status.Status = "pending";
            return status;
        }

        private bool HasIncompleteUpgradeReceipt()
        {
            var file = Path.Combine(DataDir, "memory-upgrade-receipt.json");
            if (!File.Exists(file)) return false;
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(file));
                var stage = Str(document.RootElement, "stage");
                return string.IsNullOrWhiteSpace(stage) || stage != "done";
            }
            catch { return true; }
        }

        private static bool HasInstallerMarker(string baseDir)
        {
            var marker = Path.Combine(baseDir, ".whale-installed.json");
            if (!File.Exists(marker)) return false;
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(marker));
                var root = document.RootElement;
                return root.ValueKind == JsonValueKind.Object
                    && Long(root, "schemaVersion") == 1
                    && Str(root, "installer") == "whale-girl";
            }
            catch { return false; }
        }

        /// <summary>
        /// 只有可验证的安装布局才删除 runner：源码目录有 .git 一律保留；
        /// 安装态优先认 installer-owned marker，其次认根目录 Inno uninstaller 签名。
        /// 单纯的“没有 .git”不够，导出 zip/源码包也可能没有 .git。
        /// </summary>
        private bool IsInstalledLayout()
        {
            var git = Path.Combine(BaseDir, ".git");
            if (File.Exists(git) || Directory.Exists(git)) return false;
            if (HasInstallerMarker(BaseDir)) return true;
            var uninstaller = Path.Combine(BaseDir, "unins000.exe");
            var uninstallerData = Path.Combine(BaseDir, "unins000.dat");
            if (!File.Exists(uninstaller) || !File.Exists(uninstallerData)) return false;
            try
            {
                var version = FileVersionInfo.GetVersionInfo(uninstaller);
                return !string.IsNullOrWhiteSpace(version.ProductName)
                    && version.ProductName.Contains("鲸鲸")
                    && !string.IsNullOrWhiteSpace(version.ProductVersion);
            }
            catch { return false; }
        }

        private static bool IsReparsePoint(string path)
        {
            try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
            catch { return true; }
        }

        /// <summary>
        /// 只有 durable receipt/status 明确 done 且 runnerCleanupEligible 才删一次性 runner；
        /// 退出码 0 本身不够。reparse-point 的 scripts 父目录或 runner 一律不删。
        /// 删除失败只提示/下次重试，不阻断已经验证过格式的新库启动。
        /// </summary>
        private void RemoveRunnerIfEligible(MemoryUpgradeStatus status)
        {
            if (status == null || !status.RunnerCleanupEligible) return;
            if (!File.Exists(MigrationRunner)) return;
            if (!IsInstalledLayout())
            {
                SayWarn("记忆已转换，但当前目录不是可验证的安装布局；保留一次性转换工具");
                return;
            }
            var parent = Path.GetDirectoryName(MigrationRunner);
            if (string.IsNullOrEmpty(parent) || IsReparsePoint(parent) || IsReparsePoint(MigrationRunner))
            {
                SayWarn("记忆已转换，但 scripts 目录/转换工具是重解析点；为安全保留，不自动删除");
                return;
            }
            try
            {
                File.Delete(MigrationRunner);
                Say("已移除一次性记忆转换工具");
            }
            catch (Exception ex)
            {
                SayWarn("记忆已转换，但一次性工具删除失败；下次启动会重试（" + ex.GetType().Name + "）");
            }
        }

        private async Task MaintainBackupsAsync()
        {
            if (!File.Exists(MaintenanceScript)) return;
            try
            {
                var run = await RunUpgradeToolAsync(MaintenanceScript, "retention", TimeSpan.FromSeconds(30));
                if (run.Started && !run.Success)
                    SayWarn("记忆备份维护未完成（不影响启动）");
            }
            catch (Exception ex)
            {
                SayWarn("记忆备份维护异常（不影响启动）：" + ex.GetType().Name);
            }
        }

        private static string AutoUpgradeFailureMessage(ProcessRunResult run, MemoryUpgradeStatus status)
        {
            if (run != null && run.TimedOut) return "自动转换超时；备份保留，下次启动会重试。";
            if (status != null)
            {
                if (status.Status == "busy")
                    return string.IsNullOrWhiteSpace(status.Message) ? "数据目录被另一个进程占用。" : status.Message;
                if (status.Status == "future") return "记忆格式来自更高版本，不能自动降级；请升级启动器。";
                if (status.Status == "invalid" || status.Status == "unreadable")
                    return "记忆格式无法读取或已损坏；已停止自动升级，请检查备份。";
                if (status.Status == "failed" || status.Status == "backup_failed" || status.Status == "cleanup_pending")
                    return "自动转换未完成（备份已保留），下次启动会重试。";
            }
            if (run != null && run.ExitCode == 2) return "数据目录被另一个进程占用。";
            if (run != null && run.ExitCode == 3) return "记忆格式无法自动升级；已停止，请检查备份。";
            return "自动转换失败（退出码 " + (run?.ExitCode?.ToString() ?? "?") + "）；内核和桥接不会启动。";
        }

        /// <summary>
        /// 启动前自动流程（调用方必须已持有 _configurationWrites）：
        /// retention(best effort) → maintenance status → 必要时 --auto-upgrade；
        /// 只有 durable status=idle 才放行内核；pending 一律 auto+runner，不再因 version==target 走在线导入。
        /// </summary>
        internal async Task<ApiResult> AutoForStartCoreAsync()
        {
            ApiResult Failure(string error) => new ApiResult { Error = error };
            ApiResult Ok(MemoryUpgradeStatus status)
                => new ApiResult { Ok = true, Root = status != null && status.Raw.ValueKind != JsonValueKind.Undefined ? status.Raw : default };
            if (_disposed) return Failure("启动器正在关闭。");
            if (UpdateBlocked) return Failure("正在检查更新或当前版本必须更新，暂不能启动服务。");
            if (UpdateInProgress) return Failure("正在更新，请等更新结束后再启动服务。");
            if (NodeRunning || BridgeRunning) return Failure("请先停止内核和桥接，再检查记忆格式。");
            MemoryMigrationRunning = true;
            try
            {
                await MaintainBackupsAsync();
                var status = await QueryUpgradeStatusAsync();
                if (status == null)
                {
                    status = InspectFallbackUpgradeStatus();
                    if (status.Status == "pending")
                        return Failure("记忆维护工具不可用，且检测到待处理旧记忆；请重新安装完整版本后再启动。");
                    SayWarn("未找到记忆维护工具，按 manifest 判断已就绪");
                }
                if (status.Status == "idle")
                {
                    RemoveRunnerIfEligible(status);
                    return Ok(status);
                }
                if (status.Status != "pending")
                    return Failure("记忆格式状态为 " + status.Status + "，不能自动升级；内核和桥接不会启动。");
                // pending 一律走自动转换：current v3+混合旧源、cleanup_pending 清理重试都必须在启动前完成；
                // runner 已删/CanAuto=false 时不能退回“在线导入”否则旧源会一直留在磁盘上。
                if (!status.CanAuto || !File.Exists(MigrationRunner))
                    return Failure("发现待转换旧记忆，但安装目录缺少自动转换工具；请重新安装完整版本。");
                Say($"发现旧版记忆，正在自动转换（{status.Chats} 个会话 / {status.Messages} 条原文）…");
                var run = await RunUpgradeToolAsync(MigrationRunner, AutoUpgradeFlag, TimeSpan.FromMinutes(10));
                if (run.Started && !run.TerminationConfirmed)
                {
                    _memoryMigrationExitUnconfirmed = true;
                    return Failure("无法确认自动转换进程已退出；请关闭该进程后重新打开启动器。");
                }
                var result = ParseUpgradeStatus(run.Output);
                if (run.Success && result != null && (result.Status == "done" || result.Status == "idle"))
                {
                    // 退出码 0 不足以下结论：必须以 durable status 为 idle 才能放行内核；
                    // done 后 durable 未完成/未知一律阻止，避免“报告成功但收据没写”启动半成品。
                    var durable = await QueryUpgradeStatusAsync();
                    if (durable == null || durable.Status != "idle")
                    {
                        return Failure("自动转换报告完成，但维护状态不是 idle（无法确认完成收据）；内核和桥接不会启动。");
                    }
                    if (result.Status == "done")
                        Say($"旧记忆已自动转换（{result.Chats} 个会话 / {result.Messages} 条原文），备份已归档并保留 30 天");
                    // 删除失败只是 warning；已由 durable idle 验证的新库可以继续启动。
                    RemoveRunnerIfEligible(durable);
                    return result.Status == "done" ? Ok(result) : Ok(durable);
                }
                return Failure(AutoUpgradeFailureMessage(run, result));
            }
            catch (Exception ex)
            {
                return Failure("自动转换异常（" + ex.GetType().Name + "）；内核和桥接不会启动。");
            }
            finally
            {
                MemoryMigrationRunning = false;
            }
        }

        private async Task<MemoryUpgradeStatus> QueryUpgradeStatusAsync()
        {
            if (!File.Exists(MaintenanceScript)) return null;
            var run = await RunUpgradeToolAsync(MaintenanceScript, "status", TimeSpan.FromSeconds(30));
            if (!run.Success) return null;
            return ParseUpgradeStatus(run.Output);
        }

        /// <summary>设置页“重新检查”用；内部同样走自动流程，不弹确认。</summary>
        internal async Task<ApiResult> RunAutoMemoryUpgradeAsync()
        {
            if (!_configurationWrites.Wait(0))
                return new ApiResult { Error = "启动器正在保存配置或转换记忆，请稍后再试。" };
            try { return await AutoForStartCoreAsync(); }
            finally { _configurationWrites.Release(); }
        }

        public Task<ApiResult> PatchConfigurationAsync(System.Collections.Generic.IDictionary<string, object> patch)
            => SaveConfigurationAsync("/api/config", new { patch });

        public string DataDir { get; }
        public string LogPath { get; }
        public event Action<LogLine> Line;

        private readonly object _processLock = new object();
        private bool _bridgeWanted;
        private bool _disposed;
        private int _restartGeneration;
        private int _restartCount;
        private DateTime _bridgeStartedAt;
        // 重启风暴刹车：不是「进程活了 60 秒就清零」，而是看最近 10 分钟重启了几次。
        // 视频号/链接预览会让 UIA 卡住 → 看门狗 exit 7 → 3 秒重启，循环起来拦不住。
        private readonly List<DateTime> _bridgeRestarts = new List<DateTime>();
        private const int BridgeRestartCap = 5;
        private static readonly TimeSpan BridgeRestartWindow = TimeSpan.FromMinutes(10);
        private Process _node;
        private Process _bridge;
        // 启动器无论怎么退出都要带走内核和桥接：正常关窗靠 StopAll，进程被强杀
        // 只能靠 Job 句柄关闭时由系统结束整棵进程树。
        private readonly ProcessJob _job = new ProcessJob();
        private readonly HttpClient _http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(2)
        };

        private readonly List<LogLine> _history = new List<LogLine>();
        private readonly object _histLock = new object();
        private const int HistoryCap = 3000;

        public RuntimeSupervisor(string baseDir)
        {
            BaseDir = baseDir;
            try { ConfigurationPath.Migrate(baseDir); }
            catch (Exception) { /* 迁移失败保留原文件，加载器继续兼容旧路径。 */ }
            DataDir = Path.Combine(baseDir, "data");
            RotateLogs();
            LogPath = Path.Combine(DataDir, "launcher.log");
            foreach (var k in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy" })
                try { Environment.SetEnvironmentVariable(k, null); } catch { }
            if (!_job.IsAvailable)
                SayWarn("无法创建进程 Job：启动器被强杀时可能残留内核进程");
        }

        /// <summary>
        /// 每次启动把上一轮的日志归档到 data/logs/run-时间戳/，只保留最近 5 次。
        /// 「导出最近三次启动的日志」靠的就是这些归档；直接覆盖会把现场冲掉。
        /// </summary>
        private void RotateLogs()
        {
            try
            {
                var logsRoot = Path.Combine(DataDir, "logs");
                Directory.CreateDirectory(logsRoot);
                // 崩溃/卡死/UIA 这几个也得跟着归档：导出「上次启动」时它们才是重点
                var current = new[]
                    {
                        "launcher.log", "bridge.log", "kernel.log", "whale.log",
                        "crash.log", "bridge-crash.log", "bridge-hang.log", "bridge-boot.log",
                        "uia-fault.log", "uia-selftest.log", "wechat-bridge-4x.log",
                    }
                    .Select(f => Path.Combine(DataDir, f))
                    .Where(f => File.Exists(f) && new FileInfo(f).Length > 0)
                    .ToList();
                if (current.Count > 0)
                {
                    var dir = Path.Combine(logsRoot, "run-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"));
                    Directory.CreateDirectory(dir);
                    foreach (var src in current)
                    {
                        try { File.Move(src, Path.Combine(dir, Path.GetFileName(src))); }
                        catch { /* 被占用就跳过，别耽误启动 */ }
                    }
                }
                foreach (var old in Directory.GetDirectories(logsRoot, "run-*")
                             .OrderByDescending(d => d).Skip(5))
                {
                    try { Directory.Delete(old, true); } catch { }
                }
            }
            catch { /* 归档失败不能挡住启动 */ }
        }

        // ── 日志 ────────────────────────────────────────────────
        private static readonly Regex TimePrefix = new Regex(@"^\[(\d{2}:\d{2}:\d{2})\]\s?", RegexOptions.Compiled);
        // 内核/桥接现在会打显式级别（[12:00:00] WARN [engine:3115] ...）。
        // 有级别就照抄，别再靠关键词猜——猜的结果直接决定「只看错误」筛得准不准。
        private static readonly Regex LevelPrefix = new Regex(@"^(DEBUG|INFO|WARN|ERROR)\s+", RegexOptions.Compiled);

        private static char InferLevel(string s)
        {
            if (string.IsNullOrEmpty(s)) return 'i';
            if (s.IndexOf("Traceback", StringComparison.Ordinal) >= 0) return 'e';
            if (s.StartsWith("E ") || s.StartsWith("[E]") || s.StartsWith("[!]")) return 'w';
            if (s.IndexOf("错误", StringComparison.Ordinal) >= 0 || s.IndexOf("失败", StringComparison.Ordinal) >= 0) return 'w';
            if (s.IndexOf("Error", StringComparison.Ordinal) >= 0 || s.IndexOf("Exception", StringComparison.Ordinal) >= 0) return 'e';
            return 'i';
        }

        private static char LevelOfToken(string token)
            => token == "ERROR" ? 'e' : token == "WARN" ? 'w' : token == "INFO" ? 'i' : 'd';

        private void Emit(string src, string raw, char? forced = null)
        {
            SecretRedactor.Refresh(BaseDir);
            var text = LogSanitizer.SanitizeLog(raw, SecretRedactor.Redact);
            var at = DateTime.Now;
            var m = TimePrefix.Match(text);
            if (m.Success)
            {
                if (TimeSpan.TryParse(m.Groups[1].Value, out var ts)) at = DateTime.Today.Add(ts);
                text = text.Substring(m.Length);
            }
            char? explicitLevel = forced;
            var lm = LevelPrefix.Match(text);
            if (lm.Success)
            {
                explicitLevel ??= LevelOfToken(lm.Groups[1].Value);
                text = text.Substring(lm.Length);
            }
            var line = new LogLine { At = at, Src = src, Level = explicitLevel ?? InferLevel(text), Text = text };

            lock (_histLock)
            {
                _history.Add(line);
                if (_history.Count > HistoryCap) _history.RemoveRange(0, _history.Count - HistoryCap);
            }

            AppendFile(LogPath, line);
            if (src == "B") AppendFile(Path.Combine(DataDir, "bridge.log"), line);
            else if (src == "K") AppendFile(Path.Combine(DataDir, "kernel.log"), line);

            Line?.Invoke(line);
        }

        private static void AppendFile(string path, LogLine line)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                var info = new FileInfo(path);
                if (info.Exists && info.Length > 5 * 1024 * 1024)
                {
                    var bak = path + ".1";
                    try { if (File.Exists(bak)) File.Delete(bak); } catch { }
                    try { File.Move(path, bak); } catch { }
                }
                var row = $"{line.At:HH:mm:ss} {line.Src} {line.Level}  {line.Text}{Environment.NewLine}";
                File.AppendAllText(path, row, Encoding.UTF8);
            }
            catch { /* 日志写不了不影响运行 */ }
        }

        public void Say(string text) => Emit("L", text);

        /// <summary>已降级/已自愈，但值得记一笔。诊断页「只看错误」会把它算进去。</summary>
        public void SayWarn(string text) => Emit("L", text, 'w');

        /// <summary>这次功能真的坏了（进程起不来、连续崩溃、找不到运行时）。</summary>
        public void SayError(string text) => Emit("L", text, 'e');

        public List<LogLine> History(int max = 5000)
        {
            lock (_histLock)
            {
                var n = Math.Min(max, _history.Count);
                return _history.GetRange(_history.Count - n, n);
            }
        }

        public int HistoryCount { get { lock (_histLock) return _history.Count; } }

        // ── 进程 ────────────────────────────────────────────────
        public bool NodeRunning => _node != null && !_node.HasExited;
        public bool BridgeRunning => _bridge != null && !_bridge.HasExited;

        public int Port
        {
            get
            {
                try
                {
                    var f = Path.Combine(DataDir, "server-port.txt");
                    if (File.Exists(f) && int.TryParse(File.ReadAllText(f).Trim(), out var p) && p > 0 && p < 65536) return p;
                }
                catch { }
                return 8787;
            }
        }

        public string Url => $"http://127.0.0.1:{Port}";

        private async Task<int> ReadHealthyNodePidAsync(int port)
        {
            try
            {
                using var response = await _http.GetAsync($"http://127.0.0.1:{port}/healthz");
                if (!response.IsSuccessStatusCode) return 0;
                using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                var health = body.RootElement;
                var pid = Long(health, "pid");
                return Str(health, "service") == "whale-girl" && Bool(health, "up") && pid > 0 && pid <= int.MaxValue
                    ? (int)pid : 0;
            }
            catch { return 0; }
        }

        private string NodeExecutable
        {
            get
            {
                var bundled = Path.Combine(BaseDir, "runtime", "node.exe");
                return File.Exists(bundled) ? bundled : "node";
            }
        }

        // 低层测试/诊断 seam；生产入口全部走 StartAllAsync（自动升级在启动内核前）。
        internal void StartNode()
        {
            if (!_configurationWrites.Wait(0))
            {
                SayWarn("启动器正在保存配置或转换记忆，请稍后再启动服务");
                return;
            }
            try { StartNodeCore(); }
            finally { _configurationWrites.Release(); }
        }

        private void StartNodeCore()
        {
            if (UpdateBlocked) { SayWarn("正在检查更新或当前版本必须更新，暂不能启动服务"); return; }
            if (_disposed || _memoryMigrationExitUnconfirmed || NodeRunning) return;
            var lockInfo = InspectDataLock();
            switch (lockInfo.State)
            {
                case DataLockState.Busy:
                    SayWarn(lockInfo.Purpose == "migration"
                        ? "记忆正在转换，暂不能启动内核"
                        : "数据目录正被另一个实例占用，暂不能启动内核");
                    return;
                case DataLockState.Unknown:
                    SayWarn("无法确认数据目录锁（可能元数据损坏）；请先停止鲸鲸和转换重试，再检查 data\\.data.lock；程序不会自动删除");
                    return;
                case DataLockState.Recovering:
                    SayWarn("另一个进程正在恢复数据目录锁，请稍后再启动内核");
                    return;
                case DataLockState.GuardStale:
                case DataLockState.GuardUnknown:
                    SayWarn("数据目录锁需要人工恢复：请先停止鲸鲸和所有转换重试，再按设置页提示处理；程序不会自动删除锁文件");
                    return;
                case DataLockState.Stale:
                    SayWarn("上次记忆转换没有正常结束；启动内核时会自动恢复");
                    break;
            }
            _node = Launch(NodeExecutable, "server.js --no-browser", "K", "内核");
        }

        public async Task<bool> WaitForNodeAsync()
        {
            for (var attempt = 0; attempt < 40; attempt++)
            {
                if (!NodeRunning) return false;
                try
                {
                    var node = _node;
                    var pid = await ReadHealthyNodePidAsync(Port);
                    if (pid > 0 && node != null && node == _node && node.Id == pid && !node.HasExited) return true;
                }
                catch { }
                await Task.Delay(250);
            }
            SayWarn("内核尚未就绪，请查看诊断日志");
            return false;
        }

        public void StartBridge()
        {
            if (UpdateBlocked) { SayWarn("正在检查更新或当前版本必须更新，暂不能启动桥接"); return; }
            lock (_processLock)
            {
                if (_disposed || BridgeRunning) return;
                if (!NodeRunning) { SayWarn("内核尚未启动，请先启动服务"); return; }
                var exe = Path.Combine(BaseDir, "runtime", "python", "python.exe");
                if (!File.Exists(exe)) { SayError("找不到内置 Python，桥接起不来，请检查安装包"); return; }
                try { File.Delete(Path.Combine(DataDir, "bridge-ready.json")); } catch { }
                try { File.Delete(Path.Combine(DataDir, "PAUSED")); } catch { }
                _bridgeWanted = true;
                _bridgeStartedAt = DateTime.UtcNow;
                _bridge = Launch(exe, "-u examples\\wechatauto_bridge.py", "B", "桥接");
            }
        }

        private async Task RecoverBridgeAsync(Process exited, int generation)
        {
            int code;
            try { code = exited.ExitCode; } catch { return; }
            // 缺依赖、账号/数据库配置错误不反复重启；崩溃和配置切换才恢复。
            if (code == 0 || code == 1 || code == 2) return;
            await Task.Delay(3000);
            lock (_processLock)
            {
                if (_disposed || !_bridgeWanted || generation != _restartGeneration
                    || !ReferenceEquals(_bridge, exited) || !NodeRunning
                    || File.Exists(Path.Combine(DataDir, "PAUSED"))) return;
                if ((DateTime.UtcNow - _bridgeStartedAt).TotalSeconds >= 60) _restartCount = 0;
                if (++_restartCount > 3) { _bridgeWanted = false; SayError("桥接连续异常退出，已停止自动重启，请查看诊断"); return; }
                // 窗口计数：60 秒的「存活清零」会把「3 秒崩一次」也当成健康，
                // 所以刹车只看最近 10 分钟重启次数，跟单次活了多久无关。
                var nowUtc = DateTime.UtcNow;
                _bridgeRestarts.RemoveAll((t) => nowUtc - t > BridgeRestartWindow);
                if (_bridgeRestarts.Count >= BridgeRestartCap)
                {
                    _bridgeWanted = false;
                    SayError("桥接 10 分钟内反复退出 " + _bridgeRestarts.Count + " 次，已停止自动重启（不是无限重启）。看「诊断」里的桥接日志，关掉视频号/链接预览窗口后再点启动。");
                    return;
                }
                _bridgeRestarts.Add(nowUtc);
                Emit("L", code == 7 ? "桥接请求重新连接，正在重启…" : "桥接异常退出，正在自动恢复…", 'w');
                _bridge = null;
                StartBridge();
            }
        }

        public async Task StartAllAsync(bool clearRestartHistory = true)
        {
            LastStartFailure = "";
            if (UpdateBlocked)
            {
                LastStartFailure = "正在检查更新或当前版本必须更新，请先完成更新";
                SayWarn(LastStartFailure);
                return;
            }
            if (UpdateInProgress)
            {
                LastStartFailure = "正在更新，请等更新结束后再启动服务";
                SayWarn(LastStartFailure);
                return;
            }
            // 主窗口原来不清零，诊断入口原来清零；复用启动顺序不能顺带改变重启刹车。
            if (clearRestartHistory)
            {
                lock (_processLock) _bridgeRestarts.Clear();
            }
            await _configurationWrites.WaitAsync();
            try
            {
                if (_memoryMigrationExitUnconfirmed)
                {
                    LastStartFailure = "无法确认记忆转换进程已退出，请手动确认后重新打开启动器";
                    SayWarn(LastStartFailure);
                    return;
                }
                void StartBlocked(string message)
                {
                    LastStartFailure = message;
                    SayWarn(message);
                }
                if (!NodeRunning && await ReadHealthyNodePidAsync(Port) > 0)
                {
                    Say("内核已在后台运行，请用原来的方式管理它");
                    return;
                }
                // 已在跑就不做离线迁移（迁移要求无内核）；保持原有重启/补桥接语义。
                if (NodeRunning)
                {
                    if (await WaitForNodeAsync()) StartBridge();
                    return;
                }
                var lockInfo = InspectDataLock();
                if (lockInfo.State == DataLockState.Busy)
                {
                    StartBlocked(lockInfo.Purpose == "migration"
                        ? "记忆正在转换，暂不能启动服务"
                        : "数据目录正被另一个实例占用，暂不能启动服务");
                    return;
                }
                if (lockInfo.State == DataLockState.Unknown)
                {
                    StartBlocked("无法确认数据目录锁（可能元数据损坏）；请先停止鲸鲸和转换重试，再检查 data\\.data.lock；程序不会自动删除");
                    return;
                }
                if (lockInfo.State == DataLockState.Recovering)
                {
                    StartBlocked("另一个进程正在恢复数据目录锁，请稍后再启动服务");
                    return;
                }
                if (lockInfo.State == DataLockState.GuardStale || lockInfo.State == DataLockState.GuardUnknown)
                {
                    StartBlocked("数据目录锁需要人工恢复：请先停止鲸鲸和所有转换重试，再按设置页提示处理；程序不会自动删除锁文件");
                    return;
                }
                // 启动按钮/重启/诊断入口统一走这里：自动检查并转换旧记忆，失败绝不启动内核和桥接。
                var upgrade = await AutoForStartCoreAsync();
                if (!upgrade.Ok)
                {
                    LastStartFailure = "记忆自动升级失败，内核和桥接不会启动：" + Api.Message(upgrade);
                    SayError(LastStartFailure);
                    return;
                }
                StartNodeCore();
                if (await WaitForNodeAsync()) StartBridge();
                else
                {
                    LastStartFailure = "内核启动失败，请查看诊断日志；桥接不会启动";
                    SayError(LastStartFailure);
                }
            }
            finally { _configurationWrites.Release(); }
        }

        public void RestartBridge()
        {
            lock (_processLock)
            {
                _bridgeWanted = false;
                _restartGeneration++;
                _restartCount = 0;
                _bridgeRestarts.Clear();                       // 用户手动重启 = 重新计数
                Kill(_bridge, "B", "桥接");
                _bridge = null;
                StartBridge();
            }
        }

        public async Task<string> RestartWeChatAsync()
        {
            using var current = Process.GetCurrentProcess();
            var candidates = Process.GetProcessesByName("Weixin").Concat(Process.GetProcessesByName("WeChat")).ToArray();
            try
            {
                var sessionClients = candidates.Where(process => process.SessionId == current.SessionId && !process.HasExited).ToArray();
                var clients = sessionClients.Length == 1 ? sessionClients :
                    sessionClients.Where(process => process.MainWindowHandle != IntPtr.Zero).ToArray();
                if (clients.Length != 1)
                    return clients.Length == 0 ? "电脑上未找到微信主窗口。" : "检测到多个微信实例，请在电脑上选择后再重启。";
                var client = clients[0];
                var executable = client.MainModule?.FileName;
                if (string.IsNullOrEmpty(executable) || !File.Exists(executable)) return "无法确认当前微信的程序路径。";
                // 重启由提权的启动器执行。锁定并验证正在使用的安装文件，防止路径被调包。
                using var executableLock = File.Open(executable, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (!WechatSignature.Verify(executable)) return "当前微信程序未通过腾讯签名校验，请在电脑上检查安装。";

                bool restartBridge;
                lock (_processLock)
                {
                    restartBridge = BridgeRunning;
                    _bridgeWanted = false;
                    _restartGeneration++;
                    Kill(_bridge, "B", "桥接");
                    _bridge = null;
                }
                try
                {
                    if (!client.HasExited && client.CloseMainWindow())
                    {
                        using var graceful = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                        try { await client.WaitForExitAsync(graceful.Token); }
                        catch (OperationCanceledException) { }
                    }
                    if (!client.HasExited)
                    {
                        client.Kill();
                        using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                        await client.WaitForExitAsync(wait.Token);
                    }
                    using var started = Process.Start(new ProcessStartInfo(executable)
                    {
                        UseShellExecute = true,
                        WorkingDirectory = Path.GetDirectoryName(executable),
                    });
                    return started == null ? "Windows 未能重新打开微信。" : null;
                }
                finally
                {
                    if (restartBridge && NodeRunning) StartBridge();
                }
            }
            catch (Exception ex)
            {
                SayWarn("手机请求重启微信失败：" + ex.GetType().Name);
                return "无法重启微信，请查看诊断。";
            }
            finally
            {
                foreach (var candidate in candidates) candidate.Dispose();
            }
        }

        private Process Launch(string exe, string args, string src, string what)
        {
            try
            {
                var psi = new ProcessStartInfo(exe, args)
                {
                    WorkingDirectory = BaseDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                foreach (var k in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy" })
                    psi.Environment.Remove(k);
                psi.Environment["NO_PROXY"] = "127.0.0.1,localhost,::1";
                psi.Environment["PYTHONIOENCODING"] = "utf-8";
                psi.Environment["PYTHONUNBUFFERED"] = "1";
                psi.Environment["PYTHONUTF8"] = "1";
                // 内核/桥接都通过 stdin 管道感知启动器是否还活着：父进程崩溃或被
                // 强杀时管道只会关闭，它们读到 EOF 就自行退出，不留孤儿进程。
                psi.Environment["WHALE_CONTROL_STDIN"] = "1";
                psi.Environment["WHALE_PARENT_PID"] = Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture);

                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                // 进程崩掉时，真正的死因往往只在最后几行 stderr 里（Python traceback /
                // node 的 SyntaxError）。留一份，退出时补一条「退出前最后几行」。
                var errTail = new Queue<string>(4);
                p.OutputDataReceived += (_, e) => { if (e.Data != null) Emit(src, e.Data); };
                p.ErrorDataReceived += (_, e) =>
                {
                    if (e.Data == null) return;
                    lock (errTail)
                    {
                        errTail.Enqueue(e.Data);
                        while (errTail.Count > 3) errTail.Dequeue();
                    }
                    Emit(src, e.Data);
                };
                p.Exited += (_, __) =>
                {
                    var code = TryExitCode(p);
                    // 非 0 就是异常退出：标成 error，别让它在诊断页里混进 info 被过滤掉
                    Emit(src, $"{what}已退出（code={code}，pid={SafePid(p)}）", code == "0" ? (char?)'i' : 'e');
                    if (code != "0")
                    {
                        string[] tail;
                        lock (errTail) tail = errTail.ToArray();
                        if (tail.Length > 0)
                            Emit(src, $"{what}退出前 stderr 最后 {tail.Length} 行：" + string.Join(" ⏎ ", tail), 'e');
                    }
                    if (src == "B") _ = RecoverBridgeAsync(p, _restartGeneration);
                };
                p.Start();
                if (!_job.Assign(p))
                    SayWarn($"{what}未能加入启动器 Job，启动器被强杀时可能残留");
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                Say($"已启动{what}（pid={p.Id}）");
                return p;
            }
            catch (Exception ex)
            {
                Say($"启动{what}失败：{ex.Message}");
                return null;
            }
        }

        private static string TryExitCode(Process p)
        {
            try { return p.ExitCode.ToString(); } catch { return "?"; }
        }

        private static string SafePid(Process p)
        {
            try { return p.Id.ToString(); } catch { return "?"; }
        }

        public void StopAll()
        {
            lock (_processLock)
            {
                _bridgeWanted = false;
                _restartGeneration++;
                _restartCount = 0;
                Kill(_bridge, "B", "桥接");
                Kill(_node, "K", "内核");
                _bridge = null;
                _node = null;
            }
        }

        private void Kill(Process p, string src, string what)
        {
            if (p == null) return;
            try
            {
                if (!p.HasExited)
                {
                    // 内核先落盘退出；只有超时才强制结束。
                    if (src == "K")
                    {
                        try
                        {
                            p.StandardInput.WriteLine("shutdown");
                            p.StandardInput.Flush();
                            if (p.WaitForExit(5000))
                            {
                                Emit(src, $"已正常停止{what}");
                                return;
                            }
                        }
                        catch { /* 管道断开时回退到强制结束 */ }
                    }
                    p.Kill(entireProcessTree: true);
                    p.WaitForExit(3000);
                    Emit(src, $"已停止{what}");
                }
            }
            catch (Exception ex)
            {
                Say($"停止{what}时出错：{ex.Message}");
            }
        }

        // ── 探测 ────────────────────────────────────────────────
        public async Task<Snapshot> ProbeAsync()
        {
            var s = new Snapshot { NodeUp = NodeRunning, BridgeUp = BridgeRunning, Port = Port };
            if (!s.NodeUp && await ReadHealthyNodePidAsync(s.Port) > 0)
            {
                // 手动启动的内核也能提供状态，但不加入启动器的进程树。
                s.NodeUp = true;
                s.ExternalNode = true;
            }
            _observedExternalSettingsPort = s.ExternalNode ? s.Port : 0;

            if (s.NodeUp)
            {
                try
                {
                    var json = await _http.GetStringAsync($"http://127.0.0.1:{s.Port}/api/status");
                    using var doc = JsonDocument.Parse(json);
                    var root = doc.RootElement;
                    s.NodeReady = Bool(root, "ok");
                    s.NeedsKey = Bool(root, "needsKey");
                    s.UptimeSec = Long(root, "uptimeSec");
                    s.Provider = Str(root, "providerLabel");
                    if (string.IsNullOrEmpty(s.Provider)) s.Provider = Str(root, "provider");
                    s.Model = Str(root, "model");
                    s.HasKey = Bool(root, "hasKey");
                    s.Mock = Bool(root, "mock");

                    // 本轮用量：命中 / 输入 / 输出 / 命中率 / 估算（没有就保持 HasUsage=false，界面显示「—」）
                    if (root.TryGetProperty("budget", out var budget) && budget.ValueKind == JsonValueKind.Object
                        && budget.TryGetProperty("lastUsage", out var usage) && usage.ValueKind == JsonValueKind.Object)
                    {
                        s.HasUsage = true;
                        s.UsPromptTokens = (int)Long(usage, "promptTokens");
                        s.UsCacheHitTokens = (int)Long(usage, "cacheHitTokens");
                        s.UsCompletionTokens = (int)Long(usage, "completionTokens");
                        s.UsHitRate = Dbl(usage, "hitRate");
                        s.UsEstimatedTokens = (int)Long(usage, "estimatedPromptTokens");
                        s.UsRatio = Dbl(usage, "ratio");
                        if (usage.TryGetProperty("cost", out var cost) && cost.ValueKind == JsonValueKind.Object)
                        {
                            s.UsHasCost = cost.TryGetProperty("cny", out var cny) && cny.ValueKind == JsonValueKind.Number;
                            if (s.UsHasCost) s.UsCny = cny.GetDouble();
                            s.UsBand = Str(cost, "band");
                            s.UsModel = Str(cost, "model");
                        }
                        if (string.IsNullOrEmpty(s.UsModel)) s.UsModel = s.Model;
                    }

                    if (root.TryGetProperty("gateways", out var gws) && gws.ValueKind == JsonValueKind.Array && gws.GetArrayLength() > 0)
                    {
                        var gw = gws.EnumerateArray().FirstOrDefault(g => Str(g, "platform") == "wechat");
                        if (gw.ValueKind != JsonValueKind.Object) return s;
                        if (gw.TryGetProperty("stats", out var st) && st.ValueKind == JsonValueKind.Object)
                        {
                            s.StReceived = (int)Long(st, "received");
                            s.StReplied = (int)Long(st, "replied");
                            s.StSent = (int)Long(st, "sent");
                            s.StFailed = (int)Long(st, "failed");
                            s.StLastMessageAt = Long(st, "lastMessageAt");
                            s.StLastError = Str(st, "lastError");
                        }
                        if (gw.TryGetProperty("bridge", out var br) && br.ValueKind == JsonValueKind.Object)
                        {
                            s.BrOnline = Bool(br, "online");
                            s.BrLastSeenSec = (int)Long(br, "lastSeenSec");
                            s.BrUia = Bool(br, "uia");
                            s.BrListener = Bool(br, "listener");
                            s.BrFfmpeg = Bool(br, "ffmpeg");
                            s.BrRest = Bool(br, "rest");
                            s.BrAccount = Str(br, "account");
                            s.BrAccountNick = Str(br, "accountNick");
                            s.BrAccountOk = Bool(br, "accountOk");
                            s.BrAccountWhy = Str(br, "accountWhy");
                            s.BrAccountGuard = Bool(br, "accountGuard");
                            s.BrWindow = Str(br, "window");
                        }
                        s.BridgeUp = s.BridgeUp || s.BrOnline;
                    }
                }
                catch { s.StLastError = "内核进程在运行，但状态接口尚未就绪，请查看诊断"; }
            }

            return s;
        }

        private static string Str(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";

        private static bool Bool(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

        private static long Long(JsonElement e, string name)
        {
            if (!e.TryGetProperty(name, out var v)) return 0;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) return n;
            if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var m)) return m;
            return 0;
        }

        private static double Dbl(JsonElement e, string name)
        {
            if (!e.TryGetProperty(name, out var v)) return 0;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var n)) return n;
            return 0;
        }

        // ── 主动搭话状态（读桥接写的 care-state.json）────────────
        public sealed class CareState
        {
            public long LastTsMs;
            public int SentToday;
            public bool Due;
            public string Reason = "";
            public int WaitMinutes;
        }

        public CareState ReadCareState()
        {
            var outState = new CareState();
            try
            {
                var f = Path.Combine(DataDir, "care-state.json");
                if (File.Exists(f))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(f));
                    var root = doc.RootElement;
                    var ts = Long(root, "lastTs");
                    outState.LastTsMs = ts > 0 ? ts * 1000 : 0;
                    var day = Str(root, "day");
                    if (day == DateTime.Now.ToString("yyyy-MM-dd")) outState.SentToday = (int)Long(root, "count");
                }
            }
            catch { }
            return outState;
        }

        public async Task<CareState> QueryCareDueAsync(CareState st)
        {
            try
            {
                var url = $"{Url}/api/care/due?last={st.LastTsMs}&sentToday={st.SentToday}";
                var json = await _http.GetStringAsync(url);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                st.Due = Bool(root, "due");
                st.Reason = Str(root, "reason");
                st.WaitMinutes = (int)Long(root, "waitMinutes");
            }
            catch { }
            return st;
        }

        public void Dispose()
        {
            _disposed = true;
            StopAll();
            // 兜底：StopAll 失败、或还有 StopAll 不知道的子进程（node 再拉起的
            // 子进程），都随 Job 关闭一起结束。
            _job.Dispose();
            _http.Dispose();
        }
    }
}
