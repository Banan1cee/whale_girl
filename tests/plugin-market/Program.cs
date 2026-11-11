using System.IO.Compression;
using System.Text.Json;
using WhaleLauncher;

var dir = Directory.CreateTempSubdirectory("whale-market-checks-").FullName;
try
{
    var module = Convert.FromHexString("0061736d010000000105016000017f021401057768616c650a696e7075745f73697a650000030201000707010372756e00010a0601040010000b");
    var info = new PluginInfo("text-counter", "文本工具箱", "测试", "1.0.0", "4.1.0", "统计输入", "字节数", 1);
    byte[] Pack(PluginInfo item, string moduleName = "plugin.wasm", byte[] code = null)
    {
        using var bytes = new MemoryStream();
        using (var zip = new ZipArchive(bytes, ZipArchiveMode.Create, leaveOpen: true))
        {
            using (var meta = zip.CreateEntry("plugin.json").Open()) JsonSerializer.Serialize(meta, item);
            using var wasm = zip.CreateEntry(moduleName).Open();
            wasm.Write(code ?? module);
        }
        return bytes.ToArray();
    }
    void Check(bool valid) { if (!valid) throw new Exception("插件回归检查失败"); }
    void Reject(Action action)
    {
        try { action(); }
        catch (InvalidDataException) { return; }
        throw new Exception("预期拒绝无效插件");
    }

    Reject(() => PluginMarket.ReadPackage(Pack(info with { Id = "../escape" })));
    Reject(() => PluginMarket.ReadPackage(Pack(info, "../plugin.wasm")));
    Reject(() => PluginMarket.ReadPackage(Pack(info with { Id = "nul" })));
    var market = new PluginMarket(dir);
    var package = Path.Combine(dir, "sample.zip");
    File.WriteAllBytes(package, Pack(info with { MinAppVersion = "5.0.0" }));
    Reject(() => market.InstallLocal(package));
    File.WriteAllBytes(package, Pack(info));
    Check(!market.InstallLocal(package, (incoming, current) =>
    {
        Check(incoming == info && current == null);
        return false;
    }));
    Check(!Directory.Exists(Path.Combine(dir, "data")));
    market.InstallLocal(package);
    Check(market.Installed().Single() == info);
    Check(!market.Enabled(info.Id));
    market.SetEnabled(info.Id, true);
    Check(market.Enabled(info.Id));
    var localUpdate = info with { Version = "1.1.0" };
    File.WriteAllBytes(package, Pack(localUpdate));
    Check(!market.InstallLocal(package, (incoming, current) =>
    {
        Check(incoming == localUpdate && current == info);
        return false;
    }));
    Check(market.Installed().Single() == info && market.Enabled(info.Id));
    if (args.Length > 0)
    {
        var runtime = Directory.CreateDirectory(Path.Combine(dir, "runtime"));
        File.Copy(args[0], Path.Combine(runtime.FullName, "node.exe"));
        Check(await market.RunAsync(info.Id, "鲸A") == "4");
        // 未开放的导入应被拒绝，哪怕 WebAssembly 本身有效。
        var foreign = (byte[])module.Clone();
        foreign[19] = (byte)'x';
        File.WriteAllBytes(package, Pack(info with { Version = "1.1.0" }, code: foreign));
        market.InstallLocal(package);
        try
        {
            await market.RunAsync(info.Id, "测试");
            throw new Exception("未拒绝未知导入");
        }
        catch (InvalidDataException) { }
    }
    else
    {
        File.WriteAllBytes(package, Pack(info with { Version = "1.1.0" }));
        market.InstallLocal(package);
    }
    Check(market.Installed().Single().Version == "1.1.0" && market.Enabled(info.Id));
    market.Uninstall(info.Id);
    Check(market.Installed().Length == 0 && !market.Enabled(info.Id));
    var persona = new PluginInfo("gentle-chat", "温和聊天", "测试", "1.0.0", "4.1.0", "示例", null, 1,
        Kind: "persona", MaxAppVersion: "4.1.9");
    Check(PluginMarket.Compatible(persona, "4.1.0"));
    Check(PluginMarket.Compatible(persona, "4.1.9"));
    Check(!PluginMarket.Compatible(persona, "4.2.0"));
    Check(!PluginMarket.Compatible(persona, "4.0.8"));
    File.WriteAllBytes(package, Pack(persona, "persona.json",
        System.Text.Encoding.UTF8.GetBytes("""{"customPrompt":"温和自然","personaName":"不可覆盖"}""")));
    market.InstallLocal(package);
    Check(!market.Enabled(persona.Id));
    market.SetEnabled(persona.Id, true);
    var preset = Path.Combine(dir, "data", "plugins", "gentle-chat.persona.json");
    using (var json = JsonDocument.Parse(File.ReadAllBytes(preset)))
    {
        Check(json.RootElement.GetProperty("customPrompt").GetString() == "温和自然");
        Check(!json.RootElement.TryGetProperty("personaName", out _));
    }
    market.SetEnabled(persona.Id, false);
    Check(!File.Exists(preset) && market.Installed().Length == 1);
    market.Uninstall(persona.Id);
    Check(market.Installed().Length == 0);
    if (args.Length > 1 && args[1] != "--live")
    {
        market.InstallLocal(args[1]);
        const string summaryId = "chat-summary-demo";
        market.SetEnabled(summaryId, true);
        var summary = market.Installed().Single();
        Check(summary.Api == 2 && summary.HostAction == PluginMarket.DigestAction);
        try
        {
            await market.RunAsync(summaryId, "today");
            throw new Exception("未授权的宿主能力可以调用");
        }
        catch (InvalidOperationException) { }
        var called = 0;
        var report = await market.RunAsync(summaryId, "yesterday", PluginMarket.DigestAction, range =>
        {
            Check(range == "yesterday");
            called++;
            return Task.FromResult("昨日汇总\n测试通过");
        });
        Check(called == 1 && report == "昨日汇总\n测试通过");
        var known = summary with { Download = "https://example.invalid/plugin.zip", Sha256 = new string('a', 64) };
        Check(PluginMarket.ParseCatalog(JsonSerializer.SerializeToUtf8Bytes(new[] { known, known with { Api = 99 } }))
            .Single() == known);
        market.Uninstall(summaryId);
    }
    var messageInfo = info with { Id = "message-demo", Api = 3, Kind = "message", MinAppVersion = "4.1.0", Hooks = ["chat.pre_reply"], Permissions = [] };
    Reject(() => PluginMarket.ReadPackage(Pack(messageInfo with { MinAppVersion = "4.0.8" })));
    Reject(() => PluginMarket.ReadPackage(Pack(messageInfo with { Hooks = ["unknown"] })));
    Reject(() => PluginMarket.ReadPackage(Pack(messageInfo with { Permissions = ["filesystem"] })));
    File.WriteAllBytes(package, Pack(messageInfo));
    market.InstallLocal(package);
    Check(!market.Enabled(messageInfo.Id));
    market.SetEnabled(messageInfo.Id, true);
    market.SetMessageSettings(messageInfo.Id, "{\"turns\":3}");
    Check(market.MessageSettings(messageInfo.Id).Contains("3"));
    var grantFile = Path.Combine(dir, "data", "plugins", "message-demo.flow-grant.json");
    Check(File.Exists(grantFile));
    if (args.Length > 2)
    {
        var start = new System.Diagnostics.ProcessStartInfo(args[0]) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
        start.ArgumentList.Add("-e");
        start.ArgumentList.Add("const {MessagePlugins}=require(process.argv[1]); console.log(new MessagePlugins({dataDir:process.argv[2]}).installed().map(p=>p.id).join(','));");
        start.ArgumentList.Add(args[2]);
        start.ArgumentList.Add(Path.Combine(dir, "data"));
        using var node = System.Diagnostics.Process.Start(start);
        var output = await node.StandardOutput.ReadToEndAsync();
        await node.WaitForExitAsync();
        Check(node.ExitCode == 0 && output.Contains(messageInfo.Id));
    }
    market.SetEnabled(messageInfo.Id, false);
    Check(!File.Exists(grantFile));
    market.SetEnabled(messageInfo.Id, true);
    Check(market.MessageSettings(messageInfo.Id).Contains("3"));
    File.WriteAllBytes(package, Pack(messageInfo with { Version = "1.1.0" }));
    market.InstallLocal(package);
    Check(!market.Enabled(messageInfo.Id) && !File.Exists(grantFile));
    market.Uninstall(messageInfo.Id);
    if (args.Length > 1 && args[1] == "--live")
    {
        var listed = (await PluginMarket.CatalogAsync()).Single(x => x.Id == info.Id);
        await market.InstallAsync(listed);
        market.SetEnabled(info.Id, true);
        Check(await market.RunAsync(info.Id, "鲸A") == "4");
    }
    Console.WriteLine("插件市场回归通过");
}
finally { Directory.Delete(dir, recursive: true); }

namespace WhaleLauncher
{
    internal static class UpdateManifestService
    {
        internal static string LocalVersion(string _) => "4.1.0";
    }
}
