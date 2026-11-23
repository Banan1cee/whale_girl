using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using WhaleLauncher;

void Check(bool value, string name) { if (!value) throw new Exception(name); }
void Reject(Action action, string name)
{
    try { action(); }
    catch (InvalidDataException) { return; }
    throw new Exception("预期拒绝：" + name);
}
byte[] Pack(byte[] manifest, string filename, byte[] payload)
{
    using var output = new MemoryStream();
    using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
    {
        using (var file = zip.CreateEntry("plugin.json").Open()) file.Write(manifest);
        using var entry = zip.CreateEntry(filename).Open();
        entry.Write(payload);
    }
    return output.ToArray();
}
string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

var temp = Path.Combine(Environment.GetEnvironmentVariable("WHALE_TEST_TMP") ?? Path.GetTempPath(), "whale-market-checks-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(temp);
try
{
    const string id = "unified-tool";
    const string baseline = """
        {"format":"whale-plugin/1","level":4,"id":"unified-tool","name":"工具","author":"测试","version":"1.0.0",
         "minAppVersion":"4.1.5","description":"测试","runtime":"node-full","entry":"plugin.js",
         "provides":{"tool.run@1":{"mode":"tool","scope":"manual"}},"calls":["status.read@1","message.submit@1"],
         "settingsSchema":{"type":"object","properties":{"flag":{"type":"boolean"}},"additionalProperties":false}}
        """;
    var script = Encoding.UTF8.GetBytes("exports.providers = {'tool.run@1': input => input};");
    var manifest = Encoding.UTF8.GetBytes(baseline);
    var archive = Pack(manifest, "plugin.js", script);
    var zipPath = Path.Combine(temp, "sample.zip");
    File.WriteAllBytes(zipPath, archive);
    var validated = PluginMarket.ValidateLocal(zipPath, "4.1.5");
    Check(validated.Info.Id == id && validated.Info.Provides.ContainsKey("tool.run@1"), "统一协议只读校验");
    Check(!Directory.Exists(Path.Combine(temp, "data")), "只读校验不修改数据目录");
    Reject(() => PluginMarket.ValidateLocal(zipPath, "4.1.4"), "版本下限");
    Reject(() => PluginMarket.ValidateLocal(zipPath, "4.1.5", 2), "默认只声明旧代");
    var dual = Encoding.UTF8.GetBytes(baseline.Replace("\"description\"", "\"appCompatibility\":[{\"appEpoch\":1,\"minAppVersion\":\"4.1.5\"},{\"appEpoch\":2,\"minAppVersion\":\"1.0.0\",\"maxAppVersion\":\"1.0.9\"}],\"description\""));
    var dualInfo = PluginMarket.ReadPackage(Pack(dual, "plugin.js", script)).Info;
    Check(PluginMarket.Compatible(dualInfo, "1.0.0", 2) && !PluginMarket.Compatible(dualInfo, "1.1.0", 2), "新插件明示双代兼容性");

    foreach (var (oldValue, newValue) in new[] {
        ("whale-plugin/1", "whale-plugin/2"), ("node-full", "node-sandbox"), ("tool.run@1", "tool.run@999"),
        ("\"mode\":\"tool\"", "\"mode\":\"replace\""), ("\"scope\":\"manual\"", "\"scope\":\"all\""),
        ("\"scope\":\"manual\"", "\"scope\":\"manual\",\"intervalSeconds\":60"),
        ("status.read@1", "legacy.api"), ("\"status.read@1\"", "\"status.read@1\",\"status.read@1\""),
        ("additionalProperties", "patternProperties"), ("\"entry\":\"plugin.js\"", "\"entry\":\"plugin.js\",\"Api\":4") })
    {
        var bad = Encoding.UTF8.GetBytes(baseline.Replace(oldValue, newValue, StringComparison.Ordinal));
        Reject(() => PluginMarket.ReadPackage(Pack(bad, "plugin.js", script)), newValue);
    }
    // settingsSchema 的 title/description 只影响展示；长度与控制字符策略来自共享注册表。
    byte[] Annotated(string annotations) => Encoding.UTF8.GetBytes(
        baseline.Replace("\"settingsSchema\":{", "\"settingsSchema\":{" + annotations + ",", StringComparison.Ordinal));
    Check(PluginMarket.ReadPackage(Pack(Annotated("\"title\":\"设置\",\"description\":\"宿主说明\""), "plugin.js", script)).Info.Id == id,
        "接受 settingsSchema 标题与说明注解");
    var fieldAnnotated = Encoding.UTF8.GetBytes(baseline.Replace(
        "\"properties\":{\"flag\":{\"type\":\"boolean\"}}",
        "\"properties\":{\"flag\":{\"type\":\"boolean\",\"title\":\"开关\",\"description\":\"子项说明\"}}", StringComparison.Ordinal));
    Check(PluginMarket.ReadPackage(Pack(fieldAnnotated, "plugin.js", script)).Info.Id == id,
        "接受字段级标题与说明注解");
    foreach (var (annotations, name) in new[] {
        ("\"title\":\"\"", "拒绝空 title"),
        ("\"title\":\"" + new string('t', 41) + "\"", "拒绝超长 title"),
        ("\"description\":\"" + new string('d', 201) + "\"", "拒绝超长 description"),
        ("\"title\":\"a\\u0001b\"", "拒绝 title 控制字符"),
        ("\"description\":5", "拒绝非字符串 description") })
    {
        Reject(() => PluginMarket.ReadPackage(Pack(Annotated(annotations), "plugin.js", script)), name);
    }

    byte[] ScheduledManifest(string descriptor) => Encoding.UTF8.GetBytes(baseline.Replace(        "\"tool.run@1\":{\"mode\":\"tool\",\"scope\":\"manual\"}", "\"task.tick@1\":" + descriptor, StringComparison.Ordinal));
    var scheduledEntry = Encoding.UTF8.GetBytes("exports.providers = {'task.tick@1': () => null};");
    var scheduled = PluginMarket.ReadPackage(Pack(ScheduledManifest("""{"mode":"schedule","scope":"all","intervalSeconds":30}"""), "plugin.js", scheduledEntry));
    Check(scheduled.Info.Provides["task.tick@1"].IntervalSeconds == 30, "读取合法的定时周期");
    Reject(() => PluginMarket.ReadPackage(Pack(ScheduledManifest("""{"mode":"schedule","scope":"all"}"""), "plugin.js", scheduledEntry)), "定时周期必填");
    Reject(() => PluginMarket.ReadPackage(Pack(ScheduledManifest("""{"mode":"schedule","scope":"all","intervalSeconds":86401}"""), "plugin.js", scheduledEntry)), "拒绝越界周期");
    Reject(() => PluginMarket.ReadPackage(Pack(manifest, "../plugin.js", script)), "禁止 ZIP 路径穿越");
    Reject(() => PluginMarket.ReadPackage(Pack(manifest, "plugin.js", [0xff, 0xfe])), "入口必须是 UTF-8");

    var market = new PluginMarket(temp);
    Check(!market.InstallLocal(zipPath, (_, _) => false) && !Directory.Exists(Path.Combine(temp, "data")), "取消安装不写数据");
    Check(market.InstallLocal(zipPath), "安装有效插件");
    var data = Path.Combine(temp, "data");
    var plugins = Path.Combine(data, "plugins");
    var installed = Path.Combine(plugins, id);
    var grantPath = Path.Combine(installed, "grant.json");
    var entryPath = Path.Combine(installed, "plugin.js");
    Check(market.Installed().Single().Id == id && !File.Exists(grantPath) && !market.Enabled(id), "安装未授权");
    Reject(() => market.SetEnabled(id, true), "启用必须明确确认完整权限");
    Reject(() => market.SetMessageSettings(id, "{\"flag\":\"true\"}"), "设置须符合作者 schema");
    market.SetMessageSettings(id, "{\"flag\":true}");
    Check(!File.Exists(grantPath), "停用时保存设置不授权");
    market.SetEnabled(id, true, fullAccessApproved: true);
    Check(market.Enabled(id), "授权后已启用");
    var first = JsonNode.Parse(File.ReadAllText(grantPath));
    Check(first["level"].GetValue<int>() == 4 && first["enabled"].GetValue<bool>() && first["fullAccess"].GetValue<bool>()
        && first["nodeFullConfirmed"].GetValue<bool>() && !first["chatConfirmed"].GetValue<bool>(), "4 级授权字段");
    Check(first["packageHash"].GetValue<string>() == Sha(archive) && first["manifestHash"].GetValue<string>() == Sha(manifest)
        && first["entryHash"].GetValue<string>() == Sha(script), "绑定原 ZIP 和拆包原始字节");
    Check(first["approvedProviders"][0].GetValue<string>() == "tool.run@1" && first["approvedCalls"].AsArray().Count == 1
        && first["approvedCalls"][0].GetValue<string>() == "status.read@1", "绑定能力但不授权禁用调用");
    market.SetMessageSettings(id, "{\"flag\":false}");
    var next = JsonNode.Parse(File.ReadAllText(grantPath));
    Check(first["epoch"].GetValue<string>() != next["epoch"].GetValue<string>() && !next["settings"]["flag"].GetValue<bool>(), "修改设置重签授权代次");
    if (args.Length > 0)
    {
        var runtime = Path.GetFullPath(Path.Combine("src", "services", "unifiedPluginRuntime.js"));
        var start = new ProcessStartInfo(args[0]) { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add("-e");
        start.ArgumentList.Add("const { UnifiedPluginRuntime } = require(process.argv[1]); const plugin = new UnifiedPluginRuntime({dataDir:process.argv[2]}).read('unified-tool'); if (!plugin || !plugin.provides['tool.run@1'] || plugin.settings.flag !== false) process.exit(1);");
        start.ArgumentList.Add(runtime);
        start.ArgumentList.Add(data);
        using var node = Process.Start(start);
        await node.WaitForExitAsync();
        Check(node.ExitCode == 0, "真实 Node runtime 接受 C# 安装与授权");
    }
    File.WriteAllText(entryPath, "exports.providers = {};");
    Check(!market.Enabled(id), "拆包文件被改动时不再认可授权");
    Reject(() => market.SetEnabled(id, true, fullAccessApproved: true), "不能直接为已篡改的文件授权");
    var newer = Encoding.UTF8.GetBytes(baseline.Replace("1.0.0", "1.1.0"));
    File.WriteAllBytes(zipPath, Pack(newer, "plugin.js", script));
    Check(market.InstallLocal(zipPath) && !File.Exists(grantPath) && !market.Enabled(id), "更新时撤回授权");
    Check(market.MessageSettings(id).Contains("false"), "同作者更新保留设置");
    market.Uninstall(id);
    Check(market.Installed().Length == 0 && !File.Exists(grantPath) && !File.Exists(entryPath), "卸载移除可执行文件与授权");

    // 启动器只验证 Wasm 文件头；模块完整性、导入及 ABI 交由执行器验证。
    byte[] wasm = [0, 97, 115, 109, 1, 0, 0, 0];
    byte[] Restricted(int level, string providers = "\"tool.run@1\":{\"mode\":\"tool\",\"scope\":\"manual\"}", string calls = "[]", string version = "1.0.0") =>
        Encoding.UTF8.GetBytes($$"""
            {"format":"whale-plugin/1","level":{{level}},"id":"unified-tool","name":"工具","author":"测试","version":"{{version}}",
             "minAppVersion":"4.1.5","description":"测试","runtime":"wasm-restricted","entry":"plugin.wasm",
             "provides":{ {{providers}} },"calls":{{calls}}}
            """);
    const string chat = "\"chat.reply@1\":{\"mode\":\"enhance\",\"scope\":\"all\"}";
    var chatManifest = Encoding.UTF8.GetString(Restricted(3, chat)).TrimEnd();
    var chatWithDataAccess = Encoding.UTF8.GetBytes(chatManifest[..^1]
        + ",\"dataAccess\":[\"chat.history\",\"model.prompt\"]}");
    File.WriteAllBytes(zipPath, Pack(chatWithDataAccess, "plugin.wasm", wasm));
    Check(market.InstallLocal(zipPath) && !File.Exists(grantPath), "声明额外聊天数据的插件安装时不授权");
    Reject(() => market.SetEnabled(id, true), "额外聊天数据和当前消息一起确认");
    Check(!File.Exists(grantPath), "未确认时无授权记录");
    market.SetEnabled(id, true, chatAccessApproved: true);
    using (var dataGrant = JsonDocument.Parse(File.ReadAllBytes(grantPath)))
    {
        Check(dataGrant.RootElement.GetProperty("chatConfirmed").GetBoolean()
            && dataGrant.RootElement.GetProperty("approvedDataAccess").EnumerateArray().Select(item => item.GetString())
                .SequenceEqual(new[] { "chat.history", "model.prompt" }), "只记录确认的额外聊天数据");
    }
    market.Uninstall(id);

    Reject(() => PluginMarket.ReadPackage(Pack(Encoding.UTF8.GetBytes(baseline.Replace("\"level\":4,", "")), "plugin.js", script)), "必须声明等级");
    Reject(() => PluginMarket.ReadPackage(Pack(Encoding.UTF8.GetBytes(baseline.Replace("\"level\":4", "\"level\":2")), "plugin.js", script)), "低等级不能运行 Node");
    Reject(() => PluginMarket.ReadPackage(Pack(Restricted(0), "plugin.wasm", wasm)), "拒绝未知等级");
    Reject(() => PluginMarket.ReadPackage(Pack(Restricted(2, chat), "plugin.wasm", wasm)), "2 级不可声明聊天处理");
    Reject(() => PluginMarket.ReadPackage(Pack(Restricted(3, calls: "[\"status.read@1\"]"), "plugin.wasm", wasm)), "3 级不可声明宿主调用");
    Reject(() => PluginMarket.ReadPackage(Pack(Restricted(1), "plugin.js", wasm)), "Wasm 必须使用正确文件名");
    Reject(() => PluginMarket.ReadPackage(Pack(Restricted(1), "plugin.wasm", script)), "入口必须是 Wasm");
    var oversizedWasm = new byte[524289];
    wasm.CopyTo(oversizedWasm, 0);
    Reject(() => PluginMarket.ReadPackage(Pack(Restricted(2), "plugin.wasm", oversizedWasm)), "按等级限制 Wasm 入口大小");

    for (var level = 1; level <= 3; level++)
    {
        File.WriteAllBytes(zipPath, Pack(level == 3 ? Restricted(level, chat) : Restricted(level), "plugin.wasm", wasm));
        Check(market.InstallLocal(zipPath) && market.Installed().Single().Level == level, $"安装 {level} 级");
        var wasmPath = Path.Combine(installed, "plugin.wasm");
        Check(File.Exists(wasmPath) && !File.Exists(entryPath) && !File.Exists(grantPath), "安装对应入口但不授权");
        if (level == 3)
        {
            Reject(() => market.SetEnabled(id, true, fullAccessApproved: true), "3 级聊天需单独确认");
            market.SetMessageSettings(id, "{}");
            Check(!File.Exists(grantPath), "修改设置不产生聊天授权");
        }
        market.SetEnabled(id, true, chatAccessApproved: level == 3);
        var grant = JsonNode.Parse(File.ReadAllText(grantPath));
        Check(market.Enabled(id) && grant["level"].GetValue<int>() == level
            && !grant["fullAccess"].GetValue<bool>() && !grant["nodeFullConfirmed"].GetValue<bool>()
            && grant["chatConfirmed"].GetValue<bool>() == (level == 3) && grant["approvedCalls"].AsArray().Count == 0,
            "受限等级授权不能包含完整权限或宿主调用");
        if (level == 3)
        {
            market.SetMessageSettings(id, "{\"count\":1}");
            var revisedGrant = JsonNode.Parse(File.ReadAllText(grantPath));
            Check(revisedGrant["chatConfirmed"].GetValue<bool>() && revisedGrant["epoch"].GetValue<string>() != grant["epoch"].GetValue<string>(), "设置重签保留已有聊天确认");
            revisedGrant["chatConfirmed"] = false;
            File.WriteAllText(grantPath, revisedGrant.ToJsonString());
            Check(!market.Enabled(id), "聊天确认丢失时不认可授权");
            market.SetMessageSettings(id, "{}");
            Check(!market.Enabled(id), "修改设置不能补发聊天确认");

            var upgraded = Encoding.UTF8.GetBytes(baseline.Replace("1.0.0", "2.0.0"));
            File.WriteAllBytes(zipPath, Pack(upgraded, "plugin.js", script));
            Check(market.InstallLocal(zipPath) && !File.Exists(grantPath) && !File.Exists(wasmPath) && File.Exists(entryPath), "升级等级撤权并替换入口");
            Reject(() => market.SetEnabled(id, true, chatAccessApproved: true), "3 级确认不能授权 4 级");
        }
        market.Uninstall(id);
        Check(!File.Exists(wasmPath) && !File.Exists(entryPath), "卸载清除对应入口");
    }

    foreach (var number in new[] { 1, 2, 3, 4 })
    {
        var legacyId = $"old-api-{number}";
        var legacy = new PluginInfo(legacyId, "旧工具", "测试", "1.0.0", "4.1.2", "旧版", "结果", number);
        var legacyZip = Path.Combine(plugins, legacyId + ".zip");
        File.WriteAllBytes(legacyZip, Pack(JsonSerializer.SerializeToUtf8Bytes(legacy), number == 4 ? "plugin.js" : "plugin.wasm", script));
        File.WriteAllText(Path.Combine(plugins, legacyId + ".enabled"), "");
        Reject(() => PluginMarket.ValidateLocal(legacyZip, "4.1.5"), "旧版可执行 ZIP");
        Reject(() => market.SetEnabled(legacyId, true, fullAccessApproved: true), "旧版授权");
        Check(!market.Enabled(legacyId) && market.Installed().Single().Id == legacyId, "旧卡片只能显示和卸载");
        market.Uninstall(legacyId);
    }

    var persona = new PluginInfo("gentle-chat", "温和聊天", "测试", "1.0.0", "4.1.0", "示例", null, 1,
        Kind: "persona", AppCompatibility: [new(1, "4.1.0", "4.1.9"), new(2, "1.0.0", "1.0.9")]);
    Check(PluginMarket.Compatible(persona, "4.1.5", 1) && PluginMarket.Compatible(persona, "1.0.0", 2)
        && !PluginMarket.Compatible(persona, "1.0.0", 1), "人设仍支持两代版本范围");
    var listing = persona with { Download = "https://github.com/example/plugin.zip", Sha256 = new string('a', 64) };
    var catalog = JsonSerializer.SerializeToUtf8Bytes(new[] { listing, listing with { Api = 4, Kind = "tool" } });
    Check(PluginCatalog.ParseCatalog(catalog, 1, "persona").Single().Id == persona.Id, "无签名人设目录仍可读且不混入可执行插件");
    File.WriteAllBytes(zipPath, Pack(JsonSerializer.SerializeToUtf8Bytes(persona), "persona.json", Encoding.UTF8.GetBytes("""{"customPrompt":"温和自然","personaName":"独立人设"}""")));
    Check(market.InstallLocal(zipPath), "人设可以从本地安装");
    market.SetEnabled(persona.Id, true);
    using (var preview = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(plugins, persona.Id + ".persona.json"))))
        Check(preview.RootElement.GetProperty("personaName").GetString() == "独立人设" && market.Enabled(persona.Id), "人设保留数据路径");
    market.Uninstall(persona.Id);
    Check(!market.Enabled(persona.Id), "人设可以停用卸载");

    using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    PluginTrust.UsePublicKeysForTests(Convert.ToBase64String(key.ExportSubjectPublicKeyInfo()));
    var sig = Convert.ToBase64String(key.SignData(catalog, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence));
    Check(!PluginMarket.MarketSignatureEnabled && PluginCatalog.ParseSignedCatalog(catalog, sig).Single().Id == persona.Id, "不启用市场验签，但保留验签原语");
    Reject(() => PluginCatalog.ParseSignedCatalog(catalog, sig + "x"), "无效签名");
    Console.WriteLine("插件市场回归通过");
}
finally
{
    for (var attempt = 0; ; attempt++)
    {
        try { Directory.Delete(temp, recursive: true); break; }
        catch (IOException) when (attempt < 5) { await Task.Delay(100 * (attempt + 1)); }
    }
}

namespace WhaleLauncher
{
    internal static class UpdateManifestService
    {
        internal static string LocalVersion(string _) => "4.1.5";
        internal static int LocalEpoch(string _) => 1;
    }
}
