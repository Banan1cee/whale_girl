using System;
using System.Diagnostics;
using System.IO;
using System.Windows;

namespace WhaleLauncher
{
    internal static class PluginDeveloperLinks
    {
        internal const string Repository = "https://github.com/Banan1cee/whale-girl-plugins";
        internal const string Readme = Repository + "#readme";
        internal const string Examples = Repository + "/tree/main/examples";
        internal const string Issues = Repository + "/issues";
        internal const string Submit = Repository + "/pulls";

        internal static bool Open(string url, Window owner)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
                || uri.Scheme != Uri.UriSchemeHttps
                || uri.Host != "github.com"
                || !uri.AbsolutePath.StartsWith("/Banan1cee/whale-girl-plugins", StringComparison.Ordinal))
                throw new InvalidDataException("插件开发链接无效");
            try
            {
                Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
                return true;
            }
            catch (Exception ex)
            {
                AppDialog.Show(owner, "打开 GitHub 失败：\n" + ex.Message + "\n\n可以手动在浏览器打开：" + uri.AbsoluteUri, "插件开发者");
                return false;
            }
        }
    }
}
