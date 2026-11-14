using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Threading.Tasks;

// 只替代边界传输，编译并执行真实JsonRead、ConfigSaver及页面状态协调器。
namespace WhaleLauncher
{
    public sealed class ApiResult { public bool Ok; public string Error; }
    public static class Api { public static string FriendlyError(Exception ex) => ex.Message; }
    public sealed class RuntimeSupervisor
    {
        public sealed class Request
        {
            public string Path;
            public object Body;
            public readonly TaskCompletionSource<ApiResult> Completion = new TaskCompletionSource<ApiResult>();
        }
        public readonly List<Request> Requests = new List<Request>();
        public Task<ApiResult> SaveConfigurationAsync(string path, object body)
        {
            var request = new Request { Path = path, Body = body };
            Requests.Add(request);
            return request.Completion.Task;
        }
        public Task<ApiResult> PatchConfigurationAsync(IDictionary<string, object> patch)
            => SaveConfigurationAsync("/api/config", patch);
        public void Complete(int index, bool ok) => Requests[index].Completion.SetResult(new ApiResult { Ok = ok, Error = ok ? "" : "fixture failure" });
    }
}

namespace WhaleLauncher.JsonChecks
{
    public static class Program
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

        private static async Task CheckAsync(string name, Func<Task> check)
        {
            try { await check(); _passed++; Console.WriteLine("PASS " + name); }
            catch (Exception ex) { _failed++; Console.WriteLine("FAIL " + name + ": " + ex.Message); }
        }

        private static async Task Requests(RuntimeSupervisor sup, int count)
        {
            var deadline = DateTime.UtcNow.AddSeconds(2);
            while (sup.Requests.Count < count && DateTime.UtcNow < deadline) await Task.Delay(1);
            Equal(count, sup.Requests.Count);
        }

        private static async Task SaveChecks()
        {
            await CheckAsync("ConfigSaver builds queued independent fields only after taking the gate", async () =>
            {
                var sup = new RuntimeSupervisor(); var saver = new ConfigSaver(sup);
                var first = saver.SaveAsync(() => new Dictionary<string, object> { ["a"] = 1 });
                var value = 2;
                var second = saver.SaveAsync(() => new Dictionary<string, object> { ["b"] = value });
                var third = saver.SaveSettingsAsync(() => new { model = value });
                value = 3;
                Equal(1, sup.Requests.Count);
                sup.Complete(0, true); await Requests(sup, 2);
                Equal(3, ((IDictionary<string, object>)sup.Requests[1].Body)["b"]);
                Equal("/api/config", sup.Requests[1].Path);
                sup.Complete(1, true); await Requests(sup, 3);
                Equal("/api/settings", sup.Requests[2].Path);
                sup.Complete(2, true); await Task.WhenAll(first, second, third);
            });
            await CheckAsync("New desired revision drains after old success without overlapping requests", async () =>
            {
                var sup = new RuntimeSupervisor(); var saver = new ConfigSaver(sup); var desired = "A";
                var pendingOnSuccess = new List<bool>();
                ConfigurationSaveState<string> saves = null;
                saves = new ConfigurationSaveState<string>(() => desired, build => saver.SaveSettingsAsync(() => build()),
                    (snapshot, result) => { if (result.Ok) pendingOnSuccess.Add(saves.HasPendingChanges); });
                var first = saves.SaveAsync(); Equal(0L, saves.CommittedRevision);
                desired = "B"; saves.MarkDesired(); var second = saves.SaveAsync();
                Equal(true, object.ReferenceEquals(first, second)); Equal(1, sup.Requests.Count);
                sup.Complete(0, true); await Requests(sup, 2);
                Equal("B", sup.Requests[1].Body); Equal(true, saves.HasPendingChanges);
                Equal(true, pendingOnSuccess[0]);
                Equal(saves.DesiredRevision, saves.InFlightRevision);
                sup.Complete(1, true); await Task.WhenAll(first, second);
                Equal(saves.DesiredRevision, saves.CommittedRevision); Equal(false, saves.HasPendingChanges);
                Equal(false, pendingOnSuccess[1]);
            });
            await CheckAsync("Failure keeps committed watermark and identical value can retry", async () =>
            {
                var sup = new RuntimeSupervisor(); var saver = new ConfigSaver(sup); double desired = 6000;
                var saves = new ConfigurationSaveState<double>(() => desired,
                    build => saver.SaveAsync(() => new Dictionary<string, object> { ["budget"] = build() }));
                saves.Initialize(5500);
                var first = saves.SaveAsync(); sup.Complete(0, false); Equal(false, (await first).Ok);
                Equal(0L, saves.CommittedRevision); Equal(true, saves.HasPendingChanges); Equal(1, sup.Requests.Count);
                saves.Initialize(6000); // 失败后读到的旧服务器回填不能伪造成功水位。
                var retry = saves.SaveAsync(); await Requests(sup, 2); sup.Complete(1, true); await retry;
                Equal(saves.DesiredRevision, saves.CommittedRevision);
                await saves.SaveAsync(); Equal(2, sup.Requests.Count);
            });
            await CheckAsync("Failed old revision still submits a distinct newer edit, without retry spinning", async () =>
            {
                var sup = new RuntimeSupervisor(); var saver = new ConfigSaver(sup); var desired = "A";
                var saves = new ConfigurationSaveState<string>(() => desired, build => saver.SaveSettingsAsync(() => build()));
                var pending = saves.SaveAsync(); desired = "B"; saves.MarkDesired();
                sup.Complete(0, false); await Requests(sup, 2); Equal("B", sup.Requests[1].Body);
                sup.Complete(1, false); Equal(false, (await pending).Ok); Equal(2, sup.Requests.Count);
                Equal(0L, saves.CommittedRevision);
            });
            await CheckAsync("Only the exact committed secret revision clears, including identical retyping", async () =>
            {
                var sup = new RuntimeSupervisor(); var saver = new ConfigSaver(sup);
                var secret = new ConfigurationSecretState(); var input = "fixture-A"; secret.Changed();
                var saves = new ConfigurationSaveState<ConfigurationSecretSnapshot>(() => secret.Capture(input),
                    build => saver.SaveSettingsAsync(() => build().Value.Trim()),
                    (snapshot, result) => { if (result.Ok && secret.IsCurrent(snapshot, input)) { input = ""; secret.Changed(); } });
                var first = saves.SaveAsync(); input = "fixture-B"; secret.Changed(); saves.MarkDesired();
                sup.Complete(0, true); await Requests(sup, 2); Equal("fixture-B", input);
                sup.Complete(1, true); await first; Equal("", input);
                input = "same"; secret.Changed(); var snapshot = secret.Capture(input);
                secret.Changed(); Equal(false, secret.IsCurrent(snapshot, input));
            });
            await CheckAsync("Queued state captures the latest desired value and revision at execution", async () =>
            {
                var sup = new RuntimeSupervisor(); var saver = new ConfigSaver(sup);
                var blocking = saver.SaveSettingsAsync(() => "other-form"); var desired = "old";
                var saves = new ConfigurationSaveState<string>(() => desired, build => saver.SaveSettingsAsync(() => build()));
                var pending = saves.SaveAsync(); desired = "latest"; saves.MarkDesired();
                sup.Complete(0, true); await Requests(sup, 2); Equal("latest", sup.Requests[1].Body);
                sup.Complete(1, true); await Task.WhenAll(blocking, pending); Equal(2, sup.Requests.Count);
                Equal(saves.DesiredRevision, saves.CommittedRevision);
            });
            await CheckAsync("Throwing transport fails without advancing committed state or wedging retry", async () =>
            {
                var fail = true; var saves = new ConfigurationSaveState<int>(() => 1, build =>
                { build(); if (fail) throw new InvalidOperationException("fixture"); return Task.FromResult(new ApiResult { Ok = true }); });
                Equal(false, (await saves.SaveAsync()).Ok); Equal(0L, saves.CommittedRevision);
                fail = false; Equal(true, (await saves.SaveAsync()).Ok); Equal(false, saves.HasPendingChanges);
            });
            await CheckAsync("ConfigSaver preserves empty-secret no-change semantics after queue wait and releases gate on error", async () =>
            {
                var sup = new RuntimeSupervisor(); var saver = new ConfigSaver(sup); var secret = "fixture";
                var first = saver.SaveSettingsAsync(() => "other-form");
                var queued = saver.SaveSecretAsync("fixture.secret", () => secret);
                secret = ""; sup.Complete(0, true); await Task.WhenAll(first, queued);
                Equal(1, sup.Requests.Count);
                Equal(false, (await saver.SaveSettingsAsync(() => throw new InvalidOperationException("fixture"))).Ok);
                var retry = saver.SaveSettingsAsync(() => "valid"); await Requests(sup, 2);
                sup.Complete(1, true); Equal(true, (await retry).Ok);
            });
            await CheckAsync("Latest query wins; edit debounce, provider change, unload and reload invalidate old UI results", async () =>
            {
                var lifetime = new PageOperationLifetime(); lifetime.Activate(); var query = new PageOperation(lifetime); var text = "";
                var slow = new TaskCompletionSource<string>(); var fast = new TaskCompletionSource<string>();
                async Task Apply(Task<string> response)
                {
                    var ticket = query.Begin(); var value = await response;
                    if (query.IsCurrent(ticket)) text = value;
                }
                var old = Apply(slow.Task); var latest = Apply(fast.Task); fast.SetResult("new"); await latest;
                slow.SetResult("old"); await old; Equal("new", text);
                var debounce = query.Begin(); query.Invalidate(); Equal(false, query.IsCurrent(debounce));
                var provider = query.Begin(); query.Invalidate(); Equal(false, query.IsCurrent(provider));
                var unloaded = query.Begin(); lifetime.Deactivate(); Equal(false, query.IsCurrent(unloaded));
                lifetime.Activate(); Equal(false, query.IsCurrent(unloaded)); Equal(true, query.IsCurrent(query.Begin()));
            });
        }

        public static int Main()
        {
            foreach (var json in new[] { "{}", "[]", "null", "{\"n\":null}", "{\"n\":true}", "{\"n\":\"bad\"}", "{\"n\":2.5}", "{\"n\":9223372036854775808}" })
                Check("Int fallback " + json, () => { using var doc = JsonDocument.Parse(json); Equal(40, JsonRead.Int(doc.RootElement, "n", 40)); });
            foreach (var json in new[] { "{\"n\":0}", "{\"n\":\"0\"}" })
                Check("Int zero " + json, () => { using var doc = JsonDocument.Parse(json); Equal(0, JsonRead.Int(doc.RootElement, "n", 40)); });
            Check("Int overflow", () => { using var doc = JsonDocument.Parse("{\"n\":2147483648}"); Equal(40, JsonRead.Int(doc.RootElement, "n", 40)); });
            Check("Int signed bounds and TryLong distinguish missing from zero", () =>
            {
                using var doc = JsonDocument.Parse("{\"min\":-2147483648,\"max\":2147483647,\"zero\":0}");
                Equal(int.MinValue, JsonRead.Int(doc.RootElement, "min", 40));
                Equal(int.MaxValue, JsonRead.Int(doc.RootElement, "max", 40));
                Equal(true, JsonRead.TryLong(doc.RootElement, "zero", out var zero)); Equal(0L, zero);
                Equal(false, JsonRead.TryLong(doc.RootElement, "absent", out _)); Equal(0L, JsonRead.Long(doc.RootElement, "absent"));
            });
            foreach (var culture in new[] { "de-DE", "zh-CN", "en-US" })
                Check("Internal decimals " + culture, () =>
                {
                    var previous = CultureInfo.CurrentCulture;
                    try
                    {
                        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(culture);
                        using var doc = JsonDocument.Parse("{\"n\":\"0.7\"}");
                        Equal(0.7, JsonRead.Double(doc.RootElement, "n", 40));
                    }
                    finally { CultureInfo.CurrentCulture = previous; }
                });
            Check("Strict boolean remains strict", () => { using var doc = JsonDocument.Parse("{\"a\":true,\"b\":\"true\"}"); Equal(true, JsonRead.Bool(doc.RootElement, "a")); Equal(false, JsonRead.Bool(doc.RootElement, "b")); });
            foreach (var json in new[] { "{}", "{\"n\":null}", "{\"n\":true}", "{\"n\":\"NaN\"}", "{\"n\":\"Infinity\"}", "{\"n\":1e5000}", "{\"n\":\"0,7\"}" })
                Check("Double invalid/overflow fallback " + json, () => { using var doc = JsonDocument.Parse(json); Equal(40.0, JsonRead.Double(doc.RootElement, "n", 40)); });
            Check("Double numeric and string zero", () => { using var doc = JsonDocument.Parse("{\"a\":0,\"b\":\"0\"}"); Equal(0.0, JsonRead.Double(doc.RootElement, "a", 40)); Equal(0.0, JsonRead.Double(doc.RootElement, "b", 40)); });
            SaveChecks().GetAwaiter().GetResult();
            Console.WriteLine("T17 checks: passed=" + _passed + " failed=" + _failed);
            return _failed == 0 ? 0 : 1;
        }
    }
}
