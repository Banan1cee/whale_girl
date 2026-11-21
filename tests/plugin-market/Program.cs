using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using WhaleLauncher;

using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);

var dir = Directory.CreateDirectory(Path.Combine(Environment.GetEnvironmentVariable("WHALE_TEST_TMP") ?? Path.GetTempPath(), "whale-market-checks-" + Guid.NewGuid().ToString("N"))).FullName;
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

    var releaseInfo = info with { AppEpoch = 2, MinAppVersion = "1.0.0", MaxAppVersion = "1.0.9" };
    Check(!PluginMarket.Compatible(releaseInfo, "4.1.6.1", 1));
    Check(PluginMarket.Compatible(releaseInfo, "1.0.0", 2));
    Check(!PluginMarket.Compatible(releaseInfo, "0.9.9", 2));
    Check(!PluginMarket.Compatible(releaseInfo, "1.1.0", 2));
    Check(!PluginMarket.Compatible(info, "5.0.0", 2));
    Check(PluginMarket.Compatible(info, "4.1.6.1", 0));
    Check(PluginMarket.Compatible(info with { AppEpoch = 1 }, "4.1.6.1", 1));
    Check(PluginMarket.ReadPackage(Pack(releaseInfo)).Info.AppEpoch == 2);
    Check(JsonSerializer.Serialize(releaseInfo).Contains("\"appEpoch\":2"));
    Check(releaseInfo.CompatibilityLabel.Contains("正式版"));
    Reject(() => PluginMarket.ReadPackage(Pack(info with { AppEpoch = -1 })));
    Reject(() => PluginMarket.ReadPackage(Pack(info with { AppEpoch = 3 })));
    File.WriteAllBytes(Path.Combine(dir, "wrong-epoch.zip"), Pack(releaseInfo));
    Reject(() => new PluginMarket(dir).InstallLocal(Path.Combine(dir, "wrong-epoch.zip")));
    var bothInfo = info with { AppCompatibility = [
        new PluginAppRange(1, "4.1.0", "4.1.6.1"),
        new PluginAppRange(2, "1.0.0", "1.0.9")
    ] };
    Check(PluginMarket.Compatible(bothInfo, "4.1.6.1", 1));
    Check(PluginMarket.Compatible(bothInfo, "1.0.0", 2));
    Check(!PluginMarket.Compatible(bothInfo, "4.1.7", 1));
    Check(!PluginMarket.Compatible(bothInfo, "1.1.0", 2));
    Check(!PluginMarket.Compatible(bothInfo, "4.1.6.1", 2));
    Check(!PluginMarket.Compatible(bothInfo, "1.0.0", 1));
    Check(PluginMarket.ReadPackage(Pack(bothInfo)).Info.AppCompatibility.Length == 2);
    Check(bothInfo.CompatibilityLabel.Contains("正式版") && bothInfo.CompatibilityLabel.Contains("旧版"));
    Reject(() => PluginMarket.ReadPackage(Pack(bothInfo with { AppCompatibility = [] })));
    Reject(() => PluginMarket.ReadPackage(Pack(bothInfo with { AppCompatibility = [new(1, "4.1.0"), new(1, "4.1.2")] })));
    Reject(() => PluginMarket.ReadPackage(Pack(bothInfo with { AppCompatibility = [new(2, "1.1.0", "1.0.0")] })));

    // 先确认内置公钥能验证 Node crypto.sign 生成的 DER 签名。
    PluginTrust.ResetForTests();
    Check(PluginTrust.Verify(Encoding.UTF8.GetBytes("node-signed payload"),
        "MEUCIDBBfBa9vaCxzbY89r4pB+pPsbBGfVLsmd7o2REi6vJcAiEAynUtERoXG5E7MCTc5kSfQfVyynmZlOQqoUt52XpShwc="));
    PluginTrust.UsePublicKeysForTests(Convert.ToBase64String(signingKey.ExportSubjectPublicKeyInfo()));

    var signedBytes = Encoding.UTF8.GetBytes("signed payload");
    var signed = Convert.ToBase64String(signingKey.SignData(signedBytes, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence));
    Check(PluginTrust.Verify(signedBytes, signed));
    Check(!PluginTrust.Verify(signedBytes, signed + "x"));
    // 市场签名暂时隐藏：开关保持 false，但验签能力本身必须还在，恢复后无需重写。
    Check(!PluginMarket.MarketSignatureEnabled);
    Check(PluginMarket.SafeText("正常\n伪造", 80) == "正常 伪造");
    Check(!PluginMarket.SafeText("A\u202EB", 80).Contains('\u202E'));
    Check(PluginMarket.SafeMultiline("第一行\n第二行\u0000") == "第一行\n第二行");

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
    var foreignAuthor = info with { Version = "1.1.0", Author = "别人" };
    File.WriteAllBytes(package, Pack(foreignAuthor));
    Reject(() => market.InstallLocal(package));
    Check(market.Installed().Single() == info && market.Enabled(info.Id));
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
    var personaListing = persona with { Download = "https://github.com/example/plugin.zip", Sha256 = new string('a', 64),
        Signature = "catalog-signature-present" };
    var personaCatalog = JsonSerializer.SerializeToUtf8Bytes(new[] { personaListing });
    Check(PluginMarket.ParseCatalog(personaCatalog, 1, "persona").Length == 1);
    var countedUrl = PluginMarket.CountedDownloadUrl(personaListing);
    var countedAsset = new { browser_download_url = countedUrl, state = "uploaded",
        digest = "sha256:" + personaListing.Sha256, download_count = 42 };
    byte[] PackageRelease(bool draft, params object[] assets) => JsonSerializer.SerializeToUtf8Bytes(new
        { tag_name = "plugin-packages", draft, assets });
    Check(PluginMarket.ParseDownloadCounts(PackageRelease(false, countedAsset), new[] { personaListing })[countedUrl] == 42);
    Check(PluginMarket.ParseDownloadCounts(PackageRelease(false, countedAsset with { download_count = 0 }), new[] { personaListing })[countedUrl] == 0);
    Check(PluginMarket.ParseDownloadCounts(PackageRelease(true, countedAsset), new[] { personaListing }).Count == 0);
    Check(PluginMarket.ParseDownloadCounts(PackageRelease(false,
        countedAsset with { digest = "sha256:" + new string('b', 64) },
        countedAsset with { browser_download_url = "https://example.invalid/plugin.zip" },
        countedAsset with { download_count = -1 }), new[] { personaListing }).Count == 0);
    var favorites = PluginMarket.ParseFavoriteStates("""
        {"favorites":[{"id":"text-counter","count":2,"favorited":true},{"id":"notes","count":0,"favorited":false}]}
        """u8.ToArray());
    Check(favorites["text-counter"] == new MarketFavorite("text-counter", 2, true));
    Check(favorites["notes"].Count == 0 && !favorites["notes"].Favorited);
    Reject(() => PluginMarket.ParseFavoriteStates("""
        {"favorites":[{"id":"notes","count":0,"favorited":true}]}
        """u8.ToArray()));
    Check(PluginMarket.ParseCatalog(personaCatalog, 1, "tool").Length == 0);
    Check(PluginMarket.ParseCatalog(personaCatalog, 3, "message").Length == 0);
    // 回归：市场还没签名时，条目没有 Signature 也必须能解析，否则整个市场会被过滤成空的。
    var unsignedCatalog = JsonSerializer.SerializeToUtf8Bytes(new[] { personaListing with { Signature = null } });
    Check(PluginMarket.ParseCatalog(unsignedCatalog, 1, "persona").Length == 1);
    var codeCatalog = JsonSerializer.SerializeToUtf8Bytes(new[] { info with {
        Download = "https://github.com/example/plugin.zip", Sha256 = new string('a', 64),
        Signature = "catalog-signature-present" } });
    Check(PluginMarket.ParseCatalog(codeCatalog, 1, "persona").Length == 0);
    Check(PluginMarket.Compatible(persona, "4.1.0"));
    Check(PluginMarket.Compatible(persona, "4.1.9"));
    Check(!PluginMarket.Compatible(persona, "4.2.0"));
    Check(!PluginMarket.Compatible(persona, "4.0.8"));
    persona = persona with { MaxAppVersion = null };
    File.WriteAllBytes(package, Pack(persona, "persona.json",
        System.Text.Encoding.UTF8.GetBytes("""{"customPrompt":"温和自然","personaName":"不可覆盖"}""")));
    market.InstallLocal(package);
    Check(!market.Enabled(persona.Id));
    market.SetEnabled(persona.Id, true);
    var preset = Path.Combine(dir, "data", "plugins", "gentle-chat.persona.json");
    using (var json = JsonDocument.Parse(File.ReadAllBytes(preset)))
    {
        Check(json.RootElement.GetProperty("customPrompt").GetString() == "温和自然");
        Check(json.RootElement.GetProperty("personaName").GetString() == "不可覆盖");
    }
    market.SetEnabled(persona.Id, false);
    Check(!File.Exists(preset) && market.Installed().Length == 1);
    market.Uninstall(persona.Id);
    Check(market.Installed().Length == 0);
    var share = Path.Combine(dir, "shared-persona.zip");
    using (var document = JsonDocument.Parse("""
        {"schemaVersion":1,"personaName":"小鱼","customPrompt":"","personality":"沉静","ownerName":"老大",
         "aliases":["小鱼儿"],"masterRoast":true,"proactive":false,"opinions":false,
         "emoji":"少","emojiChance":0.8,"historyTurns":350,"maxBubbles":4,
         "master":{"wxids":["must-not-share"]},"apiKey":"must-not-share","permissions":["system.full"]}
        """))
    {
        PersonaPackage.Export(share, document.RootElement, "完整小鱼", "分享者", "portable-fish", "1.0.0");
    }
    using (var zip = ZipFile.OpenRead(share))
    {
        Check(zip.Entries.Count == 2);
        Check(zip.GetEntry("plugin.json") != null && zip.GetEntry("persona.json") != null);
    }
    var portablePackage = PluginMarket.ReadPackage(File.ReadAllBytes(share));
    Check(portablePackage.Info.MinAppVersion == "4.1.5" && portablePackage.Info.Kind == "persona");
    Check(PluginMarket.Compatible(portablePackage.Info, "4.1.5", 1));
    Check(PluginMarket.Compatible(portablePackage.Info, "1.0.0", 2));
    Check(!portablePackage.Persona.Contains("must-not-share") && !portablePackage.Persona.Contains("permissions"));
    Check(market.InstallLocal(share));
    market.SetEnabled("portable-fish", true);
    var installedPersona = Path.Combine(dir, "data/plugins/portable-fish.persona.json");
    using (var json = JsonDocument.Parse(File.ReadAllBytes(installedPersona)))
    {
        Check(json.RootElement.GetProperty("masterRoast").GetBoolean());
        Check(!json.RootElement.GetProperty("proactive").GetBoolean());
        Check(json.RootElement.GetProperty("emojiChance").GetDouble() == 0.8);
        Check(json.RootElement.GetProperty("historyTurns").GetInt32() == 350);
        Check(json.RootElement.GetProperty("customPrompt").GetString() == "");
        Check(json.RootElement.GetProperty("ownerName").GetString() == "老大");
    }
    market.SetEnabled("portable-fish", false);
    Check(!File.Exists(installedPersona));
    market.Uninstall("portable-fish");
    var promptShare = Path.Combine(dir, "prompt-only.zip");
    using (var document = JsonDocument.Parse("""
        {"customPrompt":"你是温和的图书管理员。","personaName":"不应分享","masterRoast":true,"emojiChance":0.8}
        """))
    {
        PersonaPackage.Export(promptShare, document.RootElement, "图书管理员", "分享者", "prompt-librarian", "1.0.0", promptOnly: true);
    }
    using (var zip = ZipFile.OpenRead(promptShare))
    {
        Check(zip.Entries.Count == 2 && zip.GetEntry("persona.json").Length <= 65536);
        using var json = JsonDocument.Parse(zip.GetEntry("persona.json").Open());
        Check(json.RootElement.EnumerateObject().Count() == 1);
        Check(json.RootElement.GetProperty("customPrompt").GetString() == "你是温和的图书管理员。");
    }
    Check(PluginMarket.ReadPackage(File.ReadAllBytes(promptShare)).Info.MinAppVersion == "4.1.0");
    market.InstallLocal(promptShare);
    market.SetEnabled("prompt-librarian", true);
    Check(File.Exists(Path.Combine(dir, "data/plugins/prompt-librarian.persona.json")));
    market.Uninstall("prompt-librarian");
    var previousZip = File.ReadAllBytes(promptShare);
    using (var emptyPrompt = JsonDocument.Parse("""{"customPrompt":"  "}"""))
        Reject(() => PersonaPackage.Export(promptShare, emptyPrompt.RootElement, "空", "分享者", "prompt-empty", "1.0.0", promptOnly: true));
    using (var largePrompt = JsonDocument.Parse(JsonSerializer.Serialize(new { customPrompt = new string('鱼', 24000) })))
        Reject(() => PersonaPackage.Export(promptShare, largePrompt.RootElement, "太长", "分享者", "prompt-large", "1.0.0", promptOnly: true));
    Check(File.ReadAllBytes(promptShare).SequenceEqual(previousZip));
    Reject(() => PluginMarket.ReadPackage(Pack(persona, "persona.json", Encoding.UTF8.GetBytes("""{"customPrompt":"a","masterRoast":"false"}"""))));
    Reject(() => PluginMarket.ReadPackage(Pack(persona, "persona.json", Encoding.UTF8.GetBytes("""{"customPrompt":"a","emojiChance":2}"""))));
    Reject(() => PluginMarket.ReadPackage(Pack(persona, "persona.json", Encoding.UTF8.GetBytes("""{"customPrompt":""}"""))));
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
        var known = summary with { Download = "https://example.invalid/plugin.zip", Sha256 = new string('a', 64), Signature = "test" };
        Check(PluginMarket.ParseCatalog(JsonSerializer.SerializeToUtf8Bytes(new[] { known, known with { Api = 99 } }))
            .Single() == known);
        var catalogBytes = JsonSerializer.SerializeToUtf8Bytes(new[] { known });
        var catalogSignature = Convert.ToBase64String(signingKey.SignData(catalogBytes, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence));
        Check(PluginMarket.ParseSignedCatalog(catalogBytes, catalogSignature).Single() == known);
        try
        {
            PluginMarket.ParseSignedCatalog(catalogBytes, catalogSignature + "x");
            throw new Exception("未拒绝无效目录签名");
        }
        catch (InvalidDataException) { }
        market.Uninstall(summaryId);
    }
    var messageInfo = info with { Id = "message-demo", Api = 3, Kind = "message", MinAppVersion = "4.1.0", Hooks = ["chat.pre_reply"], Permissions = [] };
    Check(PluginMarket.ReadPackage(Pack(messageInfo with { AppEpoch = 2, MinAppVersion = "1.0.0" })).Info.AppEpoch == 2);
    Reject(() => PluginMarket.ReadPackage(Pack(messageInfo with { AppEpoch = 2, MinAppVersion = "0.9.0" })));
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
    market.SetMessageSettings(messageInfo.Id, "{\"turns\":3}");
    Check(!File.Exists(grantFile) && !market.Enabled(messageInfo.Id));
    market.SetEnabled(messageInfo.Id, true);
    Check(market.MessageSettings(messageInfo.Id).Contains("3"));
    File.WriteAllBytes(package, Pack(messageInfo with { Version = "1.1.0" }));
    market.InstallLocal(package);
    Check(!market.Enabled(messageInfo.Id) && !File.Exists(grantFile));
    var settingsFile = Path.Combine(dir, "data", "plugins", "message-demo.flow-settings.json");
    var stateFile = Path.Combine(dir, "data", "plugins", "message-demo.0123456789abcdef.state.json");
    File.WriteAllText(stateFile, "{}");
    Check(File.Exists(settingsFile) && File.Exists(stateFile));
    market.Uninstall(messageInfo.Id);
    Check(!File.Exists(settingsFile) && !File.Exists(stateFile));
    var nativeInfo = info with { Id = "native-demo", Api = 4, MinAppVersion = "4.1.2", Kind = "tool",
        Hooks = ["tool.run", "chat.search"], Permissions = ["system.full"] };
    var script = Encoding.UTF8.GetBytes("module.exports.run = async () => ({text:'你好😀'});");
    Reject(() => PluginMarket.ReadPackage(Pack(nativeInfo with { MinAppVersion = "4.1.1" }, "plugin.js", script)));
    Check(PluginMarket.ReadPackage(Pack(nativeInfo with { AppEpoch = 2, MinAppVersion = "1.0.0" }, "plugin.js", script)).Info.AppEpoch == 2);
    Reject(() => PluginMarket.ReadPackage(Pack(nativeInfo with { Permissions = [] }, "plugin.js", script)));
    Reject(() => PluginMarket.ReadPackage(Pack(nativeInfo with { ExecutionTimeoutMs = 0 }, "plugin.js", script)));
    Reject(() => PluginMarket.ReadPackage(Pack(nativeInfo, "plugin.wasm", script)));
    Reject(() => PluginMarket.ReadPackage(Pack(nativeInfo, "plugin.js", [0xFF, 0xFE])));
    File.WriteAllBytes(package, Pack(nativeInfo, "plugin.js", script));
    market.InstallLocal(package);
    Reject(() => market.SetEnabled(nativeInfo.Id, true));
    Check(!market.Enabled(nativeInfo.Id));
    market.SetMessageSettings(nativeInfo.Id, "{\"mode\":\"保持😀\"}");
    var nativeGrant = Path.Combine(dir, "data", "plugins", "native-demo.flow-grant.json");
    Check(!File.Exists(nativeGrant));
    market.SetEnabled(nativeInfo.Id, true, fullAccessApproved: true);
    using (var grant = JsonDocument.Parse(File.ReadAllBytes(nativeGrant)))
        Check(grant.RootElement.GetProperty("fullAccess").GetBoolean());
    var nativeState = Path.Combine(dir, "data", "plugins", "native-demo.test.state.json");
    File.WriteAllText(nativeState, "{\"counter\":7}");
    File.WriteAllBytes(package, Pack(nativeInfo with { Version = "1.1.0" }, "plugin.js", script));
    market.InstallLocal(package);
    Check(!market.Enabled(nativeInfo.Id) && !File.Exists(nativeGrant));
    Check(market.MessageSettings(nativeInfo.Id).Contains("保持") && File.ReadAllText(nativeState).Contains("7"));
    market.SetMessageSettings(nativeInfo.Id, "{}");
    Check(!File.Exists(nativeGrant));
    market.Uninstall(nativeInfo.Id);
    if (args.Length > 1 && args[1] == "--live")
    {
        var listed = (await PluginMarket.CatalogAsync()).Single(x => x.Id == info.Id);
        await market.InstallAsync(listed);
        market.SetEnabled(info.Id, true);
        Check(await market.RunAsync(info.Id, "鲸A") == "4");
    }
    Console.WriteLine("插件市场回归通过");
}
finally
{
    for (var attempt = 0; ; attempt++)
    {
        try { Directory.Delete(dir, recursive: true); break; }
        // Windows 映像文件的短暂占用可在进程退出后释放，持续占用仍然报错。
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
