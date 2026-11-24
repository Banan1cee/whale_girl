using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace WhaleLauncher;

public static class VbCablePackage
{
    internal static void OpenInstaller(string root)
    {
        const string installer = "VBCABLE_Setup_x64.exe";
        var exe = Path.Combine(root, "VB-CABLE虚拟声卡", installer);
        if (!File.Exists(exe)) exe = Path.Combine(root, "runtime", "vb-cable", installer);
        if (!File.Exists(exe)) throw new ArgumentException("找不到驱动安装程序：安装目录\\VB-CABLE虚拟声卡\\VBCABLE_Setup_x64.exe。也可从 https://vb-audio.com/Cable/ 下载。");
        using var installerLock = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.Read);
        Validate(Path.GetDirectoryName(exe));
        Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, Verb = "runas" });
    }

    public static string[] Problems(string directory)
    {
        using var resource = typeof(VbCablePackage).Assembly.GetManifestResourceStream("WhaleLauncher.VbCablePack45.json");
        var expected = JsonSerializer.Deserialize<Dictionary<string,string>>(resource);
        var problems = new List<string>();
        foreach (var entry in expected) {
            var file = Path.Combine(directory, entry.Key);
            if (!File.Exists(file)) { problems.Add("缺少 " + entry.Key); continue; }
            using var input = File.OpenRead(file);
            if (!Convert.ToHexString(SHA256.HashData(input)).Equals(entry.Value, StringComparison.OrdinalIgnoreCase))
                problems.Add("文件损坏或版本不符 " + entry.Key);
        }
        return problems.ToArray();
    }
    public static void Validate(string directory)
    {
        var problems = Problems(directory);
        if (problems.Length > 0) throw new InvalidOperationException("VB-CABLE 驱动包不完整：" + string.Join("；", problems)
            + "。请从 https://vb-audio.com/Cable/ 获取 Pack45，完整解压到同一目录后再安装。");
    }
}
