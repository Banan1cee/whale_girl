using System;
using System.Reflection;
using System.Text.Json.Nodes;
using WhaleLauncher.Views;

static class PrivacyExportChecks
{
    public static void Run()
    {
        // 调用诊断导出的实际脱敏入口，避免只验证启动日志而漏掉分享包。
        var scrub = typeof(DiagPage).GetMethod("RedactNode", BindingFlags.NonPublic | BindingFlags.Static);
        var node = JsonNode.Parse("""
            {"keys":{"provider":{"value":"fixture-provider"}},
             "apiKey":{"provider":"fixture-object"},
             "token":["fixture-first",{"value":"fixture-second"}],
             "Authorization":{"custom":"fixture-auth"},
             "normal":{"key":"fixture-nested","count":7}}
            """);
        scrub.Invoke(null, new object[] { node });
        var text = node.ToJsonString();
        if (text.Contains("fixture-")) throw new Exception("诊断导出遗漏嵌套密钥");
        if (node["normal"]["count"].GetValue<int>() != 7)
            throw new Exception("诊断导出损坏非敏感字段");
        Console.WriteLine("PASS diagnostic export removes provider, object, array and authorization secrets; preserves safe fields.");
    }
}
