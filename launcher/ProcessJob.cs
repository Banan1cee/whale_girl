using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace WhaleLauncher
{
    /// <summary>
    /// 把启动器拉起的子进程放进同一个 Job Object，并打开
    /// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：只要 Job 句柄被关闭，系统就会结束
    /// 整个 Job 里的进程树。
    ///
    /// 只靠窗口 Closed 里调 StopAll 不够——启动器崩溃、被任务管理器结束或
    /// 更新脚本强杀时，那段清理代码根本不会执行，内核 node 会一直占着端口。
    /// Job 由内核托管，进程无论怎么死，句柄都会关闭，子进程跟着收掉。
    /// </summary>
    public sealed class ProcessJob : IDisposable
    {
        private const int JobObjectExtendedLimitInformationClass = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x2000;

        private IntPtr _handle;
        private readonly object _lock = new object();

        public ProcessJob()
        {
            try
            {
                _handle = CreateJobObject(IntPtr.Zero, null);
                if (_handle == IntPtr.Zero) return;

                var info = new JobObjectExtendedLimitInformationStruct();
                info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                var length = Marshal.SizeOf<JobObjectExtendedLimitInformationStruct>();
                var buffer = Marshal.AllocHGlobal(length);
                try
                {
                    Marshal.StructureToPtr(info, buffer, false);
                    if (!SetInformationJobObject(_handle, JobObjectExtendedLimitInformationClass, buffer, (uint)length))
                    {
                        CloseHandle(_handle);
                        _handle = IntPtr.Zero;
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            catch
            {
                if (_handle != IntPtr.Zero) CloseHandle(_handle);
                _handle = IntPtr.Zero;
            }
        }

        public bool IsAvailable
        {
            get { lock (_lock) return _handle != IntPtr.Zero; }
        }

        /// <summary>把已启动的进程加入 Job。失败只返回 false，不影响进程本身。</summary>
        public bool Assign(Process process)
        {
            if (process == null) return false;
            lock (_lock)
            {
                if (_handle == IntPtr.Zero) return false;
                try
                {
                    if (process.HasExited) return false;
                    return AssignProcessToJobObject(_handle, process.Handle);
                }
                catch
                {
                    return false;
                }
            }
        }

        public void Dispose()
        {
            lock (_lock)
            {
                if (_handle == IntPtr.Zero) return;
                // KILL_ON_JOB_CLOSE：关闭句柄会结束 Job 中仍存活的进程。
                CloseHandle(_handle);
                _handle = IntPtr.Zero;
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformationStruct
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
    }
}
