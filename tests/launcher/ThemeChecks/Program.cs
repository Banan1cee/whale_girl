using System;
using System.IO;
using System.Text;
using System.Text.Json;

// 直接编译并执行真实的启动器主题包解析器（launcher/LauncherTheme.cs），
// 只补一个程序入口：这里不引用 WPF，也不启动界面。
namespace WhaleLauncher
{
    internal static class Program
    {
        private static int _passed;
        private static int _failed;

        private static void Check(string name, Action check)
        {
            try { check(); _passed++; Console.WriteLine("PASS " + name); }
            catch (Exception ex) { _failed++; Console.WriteLine("FAIL " + name + ": " + ex.Message); }
        }

        private static void Equal<T>(T expected, T actual)
        {
            if (!object.Equals(expected, actual)) throw new Exception("expected " + expected + ", actual " + actual);
        }

        private static void Throws(string fragment, Action action)
        {
            try { action(); }
            catch (InvalidDataException ex)
            {
                if (!ex.Message.Contains(fragment, StringComparison.Ordinal))
                    throw new Exception("异常消息不含「" + fragment + "」：" + ex.Message);
                return;
            }
            throw new Exception("预期抛 InvalidDataException，但没有抛");
        }

        private static byte[] Bytes(string json) => Encoding.UTF8.GetBytes(json);

        private const string Valid = @"{
  ""schema"": 1,
  ""id"": ""mint"",
  ""name"": ""薄荷"",
  ""author"": ""测试"",
  ""version"": ""1.0.0"",
  ""colors"": {
    ""accent"": ""#6FD6C0"",
    ""background"": ""#07120F"",
    ""surface"": ""#101B18"",
    ""text"": ""#F2FAF7""
  },
  ""font"": { ""family"": ""Microsoft YaHei UI"", ""scale"": 1.05 },
  ""metrics"": { ""corner"": 12, ""spacing"": 1.05 },
  ""dialog"": { ""surface"": ""#101B18"", ""border"": ""#243140"", ""corner"": 12 }
}";

        private static int Main()
        {
            Check("合法主题包解析并规范化颜色", () =>
            {
                var theme = LauncherThemes.Parse(Bytes(Valid));
                Equal("mint", theme.Id);
                Equal("薄荷", theme.Name);
                Equal(4, theme.Colors.Count);
                Equal("#FF6FD6C0", theme.Colors["accent"]);
                Equal("Microsoft YaHei UI", theme.FontFamily);
                Equal(12, theme.Corner);
                Equal(12, theme.DialogCorner);
                Equal(1.05, theme.FontScale);
                Equal(1.05, theme.Spacing);
            });

            Check("规范形式可再次解析（持久化往返）", () =>
            {
                var theme = LauncherThemes.Parse(Bytes(Valid));
                var canonical = LauncherThemes.ToJsonBytes(theme);
                var again = LauncherThemes.Parse(canonical);
                Equal(theme.Id, again.Id);
                Equal(theme.Colors["accent"], again.Colors["accent"]);
                Equal(theme.Corner, again.Corner);
                Equal(theme.DialogCorner, again.DialogCorner);
                Equal(theme.FontScale, again.FontScale);
            });

            Check("未知顶层字段整包拒绝（不能借主题包声明执行体/能力）", () =>
            {
                foreach (var extra in new[] { @"""entry"": ""plugin.js""", @"""provides"": {}", @"""calls"": []", @"""settings"": {}" })
                {
                    var json = Valid.TrimEnd().TrimEnd('}') + "," + extra + "}";
                    Throws("不支持的字段", () => LauncherThemes.Parse(Bytes(json)));
                }
            });

            Check("主题不能改写安全色（ok/warn/bad 等不在语义白名单）", () =>
            {
                foreach (var key in new[] { "ok", "warn", "bad", "primaryBg", "topBtnHover" })
                {
                    var json = Valid.Replace(@"""text"": ""#F2FAF7""", @"""text"": ""#F2FAF7"", """ + key + @""": ""#FF0000""");
                    Throws("不支持的字段", () => LauncherThemes.Parse(Bytes(json)));
                }
            });

            Check("未知 font/metrics/dialog 字段拒绝", () =>
            {
                Throws("不支持的字段", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""scale"": 1.05", @"""scale"": 1.05, ""weight"": 700"))));
                Throws("不支持的字段", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""corner"": 12,", @"""corner"": 12, ""margin"": 8,"))));
                Throws("不支持的字段", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""corner"": 12 }", @"""corner"": 12, ""shadow"": 1 }"))));
            });

            Check("字体族只认白名单", () =>
            {
                Throws("白名单", () => LauncherThemes.Parse(Bytes(Valid.Replace("Microsoft YaHei UI", "Comic Sans MS"))));
                Throws("白名单", () => LauncherThemes.Parse(Bytes(Valid.Replace("Microsoft YaHei UI", "../../evil.ttf"))));
            });

            Check("schema 不是 1 拒绝", () =>
                Throws("schema", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""schema"": 1", @"""schema"": 2")))));

            Check("id 不能带路径或大写（主题包不会用 id 拼路径）", () =>
            {
                Throws("id", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""id"": ""mint""", @"""id"": ""../evil"""))));
                Throws("id", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""id"": ""mint""", @"""id"": ""Mint"""))));
                Throws("id", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""id"": ""mint""", @"""id"": ""-mint"""))));
            });

            Check("颜色必须是 #RRGGBB / #AARRGGBB", () =>
            {
                foreach (var bad in new[] { "#12345", "red", "rgb(1,2,3)", "#GGGGGG", "#123456789" })
                    Throws("颜色", () => LauncherThemes.Parse(Bytes(Valid.Replace("#6FD6C0", bad))));
            });

            Check("缩放与圆角有硬范围", () =>
            {
                Throws("font.scale", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""scale"": 1.05", @"""scale"": 9"))));
                Throws("metrics.spacing", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""spacing"": 1.05", @"""spacing"": 0.1"))));
                Throws("metrics.corner", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""corner"": 12,", @"""corner"": 99,"))));
                Throws("dialog.corner", () => LauncherThemes.Parse(Bytes(Valid.Replace(@"""corner"": 12 }", @"""corner"": -1 }"))));
            });

            Check("对比度过低的配色整包拒绝", () =>
            {
                void Expect(string json)
                {
                    try { LauncherThemes.Parse(Bytes(json)); }
                    catch (InvalidDataException ex)
                    {
                        if (ex.Message.Contains("对比度", StringComparison.Ordinal)) return;
                        throw new Exception("异常消息不含「对比度」：" + ex.Message + "\nJSON=\n" + json);
                    }
                    throw new Exception("预期抛 InvalidDataException，但没有抛\nJSON=\n" + json);
                }
                Expect(Valid.Replace(@"""text"": ""#F2FAF7""", @"""text"": ""#101010"""));
                Expect(Valid.Replace(@"""accent"": ""#6FD6C0""", @"""accent"": ""#08110E"""));
                Expect(Valid.Replace(@"""surface"": ""#101B18"", ""border"": ""#243140"", ""corner"": 12",
                    @"""surface"": ""#FBFBFB"", ""border"": ""#243140"", ""corner"": 12"));
            });

            Check("根节点不是对象、非法 JSON、超限、空文件都拒绝", () =>
            {
                Throws("JSON 对象", () => LauncherThemes.Parse(Bytes("[1,2,3]")));
                Throws("JSON", () => LauncherThemes.Parse(Bytes("{ not json")));
                Throws("空文件", () => LauncherThemes.Parse(Array.Empty<byte>()));
                var huge = new string(' ', LauncherThemes.MaxBytes + 1);
                Throws("64 KiB", () => LauncherThemes.Parse(Bytes(huge)));
            });

            Check("没有任何可生效 token 的主题拒绝", () =>
                Throws("token", () => LauncherThemes.Parse(Bytes(@"{""schema"":1,""id"":""empty"",""name"":""空""}"))));

            Check("控制字符和双向文本标记从展示名里去掉", () =>
            {
                var theme = LauncherThemes.Parse(Bytes(Valid.Replace(@"""薄荷""", "\"薄\u202E荷\\u0000\"")));
                Equal("薄荷", theme.Name);
            });

            Check("文件读取失败只返回错误，不产生主题对象", () =>
            {
                var missing = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".json");
                Equal(false, LauncherThemes.TryLoadFile(missing, out var theme, out var error));
                Equal(null, theme);
                if (!error.Contains("找不到", StringComparison.Ordinal)) throw new Exception("错误文本不够具体：" + error);
            });

            Check("持久化往返：保存后能读回，坏文件当没有", () =>
            {
                var dir = Path.Combine(Path.GetTempPath(), "whale-theme-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(dir);
                var path = Path.Combine(dir, LauncherThemes.FileName);
                try
                {
                    var theme = LauncherThemes.Parse(Bytes(Valid));
                    Equal(true, LauncherThemes.Save(path, theme));
                    var loaded = LauncherThemes.LoadActive(path);
                    Equal("mint", loaded.Id);
                    Equal("#FF6FD6C0", loaded.Colors["accent"]);

                    File.WriteAllText(path, "{ broken");
                    Equal(null, LauncherThemes.LoadActive(path));

                    File.WriteAllText(path, Valid.Replace("Microsoft YaHei UI", "Comic Sans MS"));
                    Equal(null, LauncherThemes.LoadActive(path));

                    Equal(true, LauncherThemes.Save(path, theme));
                    Equal(true, LauncherThemes.Remove(path));
                    Equal(false, File.Exists(path));
                }
                finally
                {
                    try { Directory.Delete(dir, true); } catch { }
                }
            });

            Check("保存不会写到 id 指定的文件名（id 不参与路径）", () =>
            {
                var dir = Path.Combine(Path.GetTempPath(), "whale-theme-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(dir);
                var path = Path.Combine(dir, "fixed-name.json");
                try
                {
                    var theme = LauncherThemes.Parse(Bytes(Valid));
                    LauncherThemes.Save(path, theme);
                    var files = Directory.GetFiles(dir);
                    Equal(1, files.Length);
                    Equal("fixed-name.json", Path.GetFileName(files[0]));
                    Equal(false, File.Exists(Path.Combine(dir, "mint.json")));
                }
                finally
                {
                    try { Directory.Delete(dir, true); } catch { }
                }
            });

            Check("文件删不掉时 Remove 返回 false（停用失败必须能被 UI 如实报告）", () =>
            {
                var dir = Path.Combine(Path.GetTempPath(), "whale-theme-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(dir);
                var path = Path.Combine(dir, LauncherThemes.FileName);
                try
                {
                    var theme = LauncherThemes.Parse(Bytes(Valid));
                    Equal(true, LauncherThemes.Save(path, theme));
                    using (var hold = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                        Equal(false, LauncherThemes.Remove(path));
                    Equal(true, File.Exists(path));
                    Equal(true, LauncherThemes.Remove(path));
                    Equal(false, File.Exists(path));
                }
                finally
                {
                    try { Directory.Delete(dir, true); } catch { }
                }
            });

            Console.WriteLine();
            Console.WriteLine($"通过 {_passed}，失败 {_failed}");
            return _failed == 0 ? 0 : 1;
        }
    }
}
