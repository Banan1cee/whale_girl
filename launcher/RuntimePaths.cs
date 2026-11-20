using System;
using System.IO;

namespace WhaleLauncher
{
    /// <summary>
    /// 统一解析启动器要调用的运行时路径。
    /// 正式安装包只带 runtime\node.exe 与 runtime\python\python.exe，必须先命中内置版本，
    /// 保证升级/诊断行为与以前一致；开发机没有 node.exe 时再退到 Bun（runtime\bun.exe 或 PATH），
    /// 这样只装 Bun 也能跑内核 / 本地脚本。所有探测都吞掉异常：路径为空、环境变量没设、
    /// 目录无权限都只当作「没有」，由调用方给出原有错误提示。
    /// </summary>
    internal static class RuntimePaths
    {
        /// <summary>内核和本地 Node 脚本使用的可执行文件：内置 node.exe → 内置 bun.exe → PATH node → PATH bun → "node"。</summary>
        public static string NodeLikeExe(string baseDir)
        {
            var node = Combine(baseDir, "runtime", "node.exe");
            if (Exists(node)) return node;

            var bun = Combine(baseDir, "runtime", "bun.exe");
            if (Exists(bun)) return bun;

            if (OnPath("node")) return "node";
            if (OnPath("bun")) return "bun";
            return "node";
        }

        /// <summary>Python 只用内置版本；开发/CI 可用 WHALE_PYTHON 指向本机解释器。</summary>
        public static string PythonExe(string baseDir)
        {
            var bundled = Combine(baseDir, "runtime", "python", "python.exe");
            if (Exists(bundled)) return bundled;

            var dev = Env("WHALE_PYTHON");
            if (dev.Length > 0 && Exists(dev)) return dev;

            // 故意不回退到系统 Python：正式包缺内置运行时时必须报「请检查安装包」，
            // 静默借用户机器的 Python 会掩盖打包错误并引入版本差异。
            return bundled;
        }

        /// <summary>文件名里含 bun（bun / bun.exe）就按 Bun 处理，版本探测等参数可能不同。</summary>
        public static bool IsBun(string exe)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(exe)) return false;
                var name = Path.GetFileName(exe.Trim());
                return !string.IsNullOrEmpty(name)
                    && name.IndexOf("bun", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch { return false; }
        }

        /// <summary>命令是否能在 PATH 里找到（用于区分「兜底的 node」和真的装了 Node）。</summary>
        public static bool OnPath(string command)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(command)) return false;
                // 只认真实的 .exe：ProcessStartInfo.UseShellExecute=false 不能直接跑 .cmd/.bat 垫片。
                if (Path.IsPathRooted(command) || command.IndexOf(Path.DirectorySeparatorChar) >= 0
                    || command.IndexOf(Path.AltDirectorySeparatorChar) >= 0)
                    return File.Exists(command);

                var path = Environment.GetEnvironmentVariable("PATH");
                if (string.IsNullOrWhiteSpace(path)) return false;

                foreach (var dir in path.Split(new[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var trimmed = dir.Trim().Trim('"');
                    if (trimmed.Length == 0) continue;
                    try
                    {
                        if (File.Exists(Path.Combine(trimmed, command + ".exe"))) return true;
                    }
                    catch { }
                }
            }
            catch { }
            return false;
        }

        private static string Combine(string baseDir, params string[] parts)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(baseDir)) return "";
                var path = baseDir;
                foreach (var part in parts) path = Path.Combine(path, part);
                return path;
            }
            catch { return ""; }
        }

        private static bool Exists(string path)
        {
            try { return !string.IsNullOrWhiteSpace(path) && File.Exists(path); }
            catch { return false; }
        }

        private static string Env(string name)
        {
            try
            {
                var value = Environment.GetEnvironmentVariable(name);
                return string.IsNullOrWhiteSpace(value) ? "" : value.Trim().Trim('"');
            }
            catch { return ""; }
        }
    }
}
