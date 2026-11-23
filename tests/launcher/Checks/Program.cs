using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using WhaleLauncher;
namespace WhaleLauncher.Checks
{
public static class Program
{
private static async Task CheckOfflineMigrationAsync(string root, RuntimeSupervisor sup, Action<bool,string> check)
{
    var scripts = Path.Combine(root, "scripts");
    Directory.CreateDirectory(scripts);
    var ready = Path.Combine(root, "data", "migration-ready");
    var finish = Path.Combine(root, "data", "migration-finish");
    var lockPath = Path.Combine(root, "data", ".data.lock");
    File.WriteAllText(lockPath, JsonSerializer.Serialize(new {
        version = 1, token = "fixture-lock-token", pid = Environment.ProcessId,
        startedAt = 0, host = Environment.MachineName, purpose = "migration"
    }));
    check(!(await sup.RunOfflineMemoryMigrationAsync(apply: false)).Ok, "活锁时拒绝离线预览");
    check(sup.MigrationLockActive(out _), "更新入口能识别迁移锁");
    sup.StartNode();
    check(!sup.NodeRunning, "活锁时启动入口不启动内核");
    File.Delete(lockPath);
    sup.UpdateInProgress = true;
    check(!(await sup.RunOfflineMemoryMigrationAsync(apply: false)).Ok, "更新中拒绝离线转换");
    sup.UpdateInProgress = false;

    var guardPath = Path.Combine(root, "data", ".data.lock.recover");
    var staleMain = JsonSerializer.Serialize(new {
        version = 1, token = "stale-main", pid = 2147483647, startedAt = 0,
        host = Environment.MachineName, purpose = "migration"
    });
    File.WriteAllText(lockPath, staleMain);
    File.WriteAllText(guardPath, JsonSerializer.Serialize(new {
        version = 1, token = "dead-guard", pid = 2147483647, startedAt = 1,
        host = Environment.MachineName, purpose = "recovery"
    }));
    check(sup.InspectDataLock().State == DataLockState.GuardStale, "死守卫被识别为 guard_stale");
    check(!(await sup.RunOfflineMemoryMigrationAsync(apply: false)).Ok, "死守卫拒绝离线预览");
    check(!(await sup.RunOfflineMemoryMigrationAsync(apply: true)).Ok, "死守卫拒绝离线转换");
    sup.StartNode();
    check(!sup.NodeRunning, "死守卫阻止启动内核");
    File.WriteAllText(guardPath, JsonSerializer.Serialize(new {
        version = 1, token = "live-guard", pid = Environment.ProcessId, startedAt = 1,
        host = Environment.MachineName, purpose = "recovery"
    }));
    check(sup.InspectDataLock().State == DataLockState.Recovering, "活守卫被识别为 recovering");
    File.Delete(guardPath);
    File.WriteAllText(lockPath, JsonSerializer.Serialize(new {
        version = 1, token = "live-main", pid = Environment.ProcessId, startedAt = 0,
        host = Environment.MachineName, purpose = "server"
    }));
    File.WriteAllText(guardPath, JsonSerializer.Serialize(new {
        version = 1, token = "dead-guard-2", pid = 2147483647, startedAt = 1,
        host = Environment.MachineName, purpose = "recovery"
    }));
    check(sup.InspectDataLock().State == DataLockState.Busy, "健康主锁优先于死守卫");
    File.Delete(guardPath);
    File.Delete(lockPath);
    File.WriteAllText(Path.Combine(scripts, "migrate-memory.js"), """
const fs = require('node:fs');
if (!process.argv.includes('--apply')) console.log(JSON.stringify({ok:true,status:'pending',chats:1}));
else {
  fs.writeFileSync('data/migration-ready', '1');
  const timer = setInterval(() => {
    if (!fs.existsSync('data/migration-finish')) return;
    clearInterval(timer);
    console.log(JSON.stringify({ok:true,status:'done',chats:1}));
  }, 10);
  setTimeout(() => process.exit(7), 5000).unref();
}
""");
    var preview = await sup.RunOfflineMemoryMigrationAsync(apply: false);
    check(preview.Ok && preview.Str("status") == "pending" && !sup.NodeRunning, "停止后 JSON 预览可用");
    var apply = sup.RunOfflineMemoryMigrationAsync(apply: true);
    try
    {
        for (var i = 0; i < 200 && !File.Exists(ready) && !apply.IsCompleted; i++) await Task.Delay(10);
        check(File.Exists(ready) && sup.MemoryMigrationRunning, "显式确认后启动离线转换进程");
        sup.StartNode();
        var start = sup.StartAllAsync(clearRestartHistory: false);
        check(!sup.NodeRunning && !start.IsCompleted, "离线转换持锁期间两条启动入口均不会启动内核");
        sup.StopAll();
        check(!sup.NodeRunning && sup.MemoryMigrationRunning, "停止服务不打断正在运行的转换");
        File.WriteAllText(finish, "1");
        check((await apply).Str("status") == "done", "转换成功后释放启动锁");
        await start;
        check(sup.NodeRunning, "等待中的内核启动在转换结束后执行");
        check(!(await sup.RunOfflineMemoryMigrationAsync(apply: true)).Ok, "内核运行时拒绝离线转换");
        sup.StopAll();
        // 保持既有桥接重启用例的计数基线。
        var bridgeCount = Path.Combine(root, "bridge-test-count");
        if (File.Exists(bridgeCount)) File.WriteAllText(bridgeCount, "0");
    }
    finally
    {
        File.WriteAllText(finish, "1");
        await apply;
    }
}
private static async Task CheckAutoUpgradeAsync(string workspace, string root, Action<bool,string> check)
{
    var autoRoot = Path.Combine(root, "auto-upgrade");
    var scripts = Path.Combine(autoRoot, "scripts");
    var maintenance = Path.Combine(scripts, "migrate", "upgrade-maintenance.js");
    var runner = Path.Combine(scripts, "migrate-memory.js");
    var importScript = Path.Combine(scripts, "migrate", "import-4.0.js");
    Directory.CreateDirectory(Path.Combine(scripts, "migrate"));
    File.WriteAllText(Path.Combine(autoRoot, ".whale-installed.json"), """{"schemaVersion":1,"installer":"whale-girl"}""");
    File.WriteAllText(maintenance, """
const fs=require('fs'),path=require('path');
const a=process.argv.slice(2);const data=a[a.indexOf('--data')+1];
if(a.includes('retention')){const f=path.join(data,'retention-count');const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));console.log(JSON.stringify({ok:true,status:'ok'}));}
else console.log(fs.readFileSync(path.join(data,'fake-status.json'),'utf8'));
""");
    var runnerCode = """
const fs=require('fs'),path=require('path');
const data=process.argv[process.argv.indexOf('--data')+1];
const mode=fs.existsSync(path.join(data,'fake-auto-mode'))?fs.readFileSync(path.join(data,'fake-auto-mode'),'utf8').trim():'done';
if (mode==='fail') { console.log(JSON.stringify({ok:false,status:'cleanup_pending',error:'cleanup_pending'})); process.exit(1); }
console.log(JSON.stringify({ok:true,status:'done',version:3,targetVersion:3,chats:1,messages:1,removedSources:0,legacySources:0}));
if (!fs.existsSync(path.join(data,'fake-no-durable')))
  fs.writeFileSync(path.join(data,'fake-status.json'), JSON.stringify({ok:true,status:'idle',version:3,targetVersion:3,canAuto:false,runnerRequired:false,runnerCleanupEligible:true,receipt:{stage:'done'}}));
""";
    File.WriteAllText(runner, runnerCode);
    File.WriteAllText(importScript, "// synthetic online import dependency\n");
    var sup = new RuntimeSupervisor(autoRoot);
    try
    {
        Directory.CreateDirectory(sup.DataDir);
        File.WriteAllText(Path.Combine(sup.DataDir, "server-port.txt"), "1");
        File.WriteAllText(Path.Combine(sup.DataDir, "fake-status.json"), """{"ok":true,"status":"pending","version":0,"targetVersion":3,"canAuto":true,"runnerRequired":true,"runnerCleanupEligible":false,"legacySources":1,"chats":2,"messages":3}""");
        var retentionCount = Path.Combine(sup.DataDir, "retention-count");

        sup.UpdateBlocked = true;
        var blockedUpdate = await sup.AutoForStartCoreAsync();
        check(!blockedUpdate.Ok && File.Exists(runner) && !File.Exists(retentionCount),
            "更新检查中不运行自动转换/retention，也不删 runner");
        sup.UpdateBlocked = false;

        var done = await sup.AutoForStartCoreAsync();
        check(done.Ok && done.Str("status") == "done", "启动前自动转换返回 done：" + done.Error);
        check(!File.Exists(runner), "已安装布局且 done 后删除 one-shot runner");
        check(File.Exists(importScript), "在线导入脚本必须保留");
        check(File.Exists(retentionCount), "启动前执行备份 retention");
        check(!sup.MemoryMigrationRunning, "自动流程结束释放迁移状态");

        File.WriteAllText(Path.Combine(sup.DataDir, "fake-status.json"), """{"ok":true,"status":"idle","version":3,"targetVersion":3,"canAuto":false,"runnerRequired":false,"runnerCleanupEligible":true}""");
        File.WriteAllText(runner, runnerCode);
        var idle = await sup.AutoForStartCoreAsync();
        check(idle.Ok && !File.Exists(runner), "receipt done 时 idle 启动也清理残留 runner");
        check(int.Parse(File.ReadAllText(retentionCount)) >= 2, "多次启动仍持续执行 retention");

        File.WriteAllText(Path.Combine(autoRoot, ".git"), "gitdir: fixture\n");
        File.WriteAllText(runner, runnerCode);
        var source = await sup.AutoForStartCoreAsync();
        check(source.Ok && File.Exists(runner), "源码 .git 布局保留 runner");
        File.Delete(Path.Combine(autoRoot, ".git"));

        // 自动转换 exit1/cleanup_pending：不得启动内核/桥接，保留可恢复旧输入与 runner。
        File.WriteAllText(Path.Combine(sup.DataDir, "fake-status.json"), """{"ok":true,"status":"pending","version":0,"targetVersion":3,"canAuto":true,"runnerRequired":true,"runnerCleanupEligible":false,"legacySources":1,"chats":2,"messages":3}""");
        File.WriteAllText(Path.Combine(sup.DataDir, "fake-auto-mode"), "fail");
        File.WriteAllText(Path.Combine(sup.DataDir, "store.json"), "{}");
        await sup.StartAllAsync(clearRestartHistory: false);
        check(!sup.NodeRunning && !sup.BridgeRunning, "归档/清理失败时自动转换阻止内核/桥接");
        check(!string.IsNullOrEmpty(sup.LastStartFailure), "启动失败状态可供按钮层立即呈现");
        check(File.Exists(runner) && File.Exists(Path.Combine(sup.DataDir, "store.json")), "失败时保留 runner 与可恢复旧输入");
        File.Delete(Path.Combine(sup.DataDir, "store.json"));
        File.Delete(Path.Combine(sup.DataDir, "fake-auto-mode"));

        File.WriteAllText(Path.Combine(sup.DataDir, "fake-status.json"), """{"ok":true,"status":"idle","version":3,"targetVersion":3,"canAuto":false,"runnerRequired":false,"runnerCleanupEligible":false}""");
        File.Delete(runner);
        var currentNoRunner = await sup.AutoForStartCoreAsync();
        check(currentNoRunner.Ok, "已是最新 v3 且 runner 缺失仍可启动");

        // current v3 + 混合旧源：status=pending，必须自动导入清理，不能回退在线导入。
        File.WriteAllText(runner, runnerCode);
        File.WriteAllText(Path.Combine(sup.DataDir, "fake-status.json"), """{"ok":true,"status":"pending","version":3,"targetVersion":3,"canAuto":true,"runnerRequired":true,"runnerCleanupEligible":false,"legacySources":1,"chats":1,"messages":1}""");
        var currentMixed = await sup.AutoForStartCoreAsync();
        check(currentMixed.Ok, "current v3+混合旧源自动调用成功：" + currentMixed.Error);
        check(currentMixed.Str("status") == "done" && !File.Exists(runner),
            "current v3+混合旧源启动前自动 done 并清 runner");

        // cleanup_pending：必须自动重试清理，失败阻止启动，成功后 done。
        File.WriteAllText(runner, runnerCode);
        File.WriteAllText(Path.Combine(sup.DataDir, "fake-status.json"), """{"ok":true,"status":"pending","version":3,"targetVersion":3,"canAuto":true,"runnerRequired":true,"runnerCleanupEligible":false,"legacySources":1,"chats":1,"messages":1}""");
        File.WriteAllText(Path.Combine(sup.DataDir, "fake-auto-mode"), "fail");
        var cleanupFail = await sup.AutoForStartCoreAsync();
        check(!cleanupFail.Ok && File.Exists(runner), "cleanup_pending 失败阻止启动并保留 runner");
        File.Delete(Path.Combine(sup.DataDir, "fake-auto-mode"));
        var cleanupDone = await sup.AutoForStartCoreAsync();
        check(cleanupDone.Ok && cleanupDone.Str("status") == "done" && !File.Exists(runner),
            "cleanup_pending 再次启动自动清理完成");

        // exit0 done 但 durable status 未完成：不得删除唯一 runner。
        File.WriteAllText(runner, runnerCode);
        File.WriteAllText(Path.Combine(sup.DataDir, "fake-status.json"), """{"ok":true,"status":"pending","version":3,"targetVersion":3,"canAuto":true,"runnerRequired":true,"runnerCleanupEligible":false,"legacySources":1,"chats":1,"messages":1}""");
        File.WriteAllText(Path.Combine(sup.DataDir, "fake-no-durable"), "1");
        var incomplete = await sup.AutoForStartCoreAsync();
        check(!incomplete.Ok && File.Exists(runner), "done 无 durable 收据时阻止启动并保留 runner");
        File.Delete(Path.Combine(sup.DataDir, "fake-no-durable"));

        File.Delete(runner);
        File.WriteAllText(Path.Combine(sup.DataDir, "fake-status.json"), """{"ok":true,"status":"pending","version":3,"targetVersion":3,"canAuto":true,"runnerRequired":true,"runnerCleanupEligible":false,"legacySources":1,"chats":1,"messages":1}""");
        var noRunnerPending = await sup.AutoForStartCoreAsync();
        check(!noRunnerPending.Ok, "pending 且 runner 缺失必须阻止，不退回在线导入");
    }
    finally
    {
        sup.Dispose();
    }
}

private static void CopyDirectory(string source, string destination)
{
    Directory.CreateDirectory(destination);
    foreach (var file in Directory.GetFiles(source))
        File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
    foreach (var dir in Directory.GetDirectories(source))
        CopyDirectory(dir, Path.Combine(destination, Path.GetFileName(dir)));
}

private static async Task CheckRealAutoUpgradeAsync(string workspace, string root, string node, Action<bool,string> check)
{
    // 正常 CI 的 workspace 是仓库根；隔离运行可能只放了 fixtures，需要回到当前仓库目录取真实脚本。
    var sourceRoot = File.Exists(Path.Combine(workspace, "scripts", "migrate-memory.js"))
        ? workspace : Environment.CurrentDirectory;
    var realRoot = Path.Combine(root, "real-auto");
    Directory.CreateDirectory(Path.Combine(realRoot, "scripts", "migrate"));
    Directory.CreateDirectory(Path.Combine(realRoot, "runtime"));
    CopyDirectory(Path.Combine(sourceRoot, "src"), Path.Combine(realRoot, "src"));
    File.Copy(Path.Combine(sourceRoot, "package.json"), Path.Combine(realRoot, "package.json"), true);
    File.Copy(Path.Combine(sourceRoot, "scripts", "migrate-memory.js"), Path.Combine(realRoot, "scripts", "migrate-memory.js"), true);
    foreach (var name in new[] { "archive.js", "upgrade-maintenance.js", "import-4.0.js" })
        File.Copy(Path.Combine(sourceRoot, "scripts", "migrate", name), Path.Combine(realRoot, "scripts", "migrate", name), true);
    File.Copy(node, Path.Combine(realRoot, "runtime", "node.exe"), true);
    File.WriteAllText(Path.Combine(realRoot, ".whale-installed.json"), """{"schemaVersion":1,"installer":"whale-girl"}""");
    File.WriteAllText(Path.Combine(realRoot, "fixture.js"), """
const {Store}=require('./src/memory/store');
const fs=require('fs'),path=require('path');
const data=path.join(process.cwd(),'data');
fs.mkdirSync(data,{recursive:true});
const store=new Store({file:path.join(data,'tmp-store.json'),dir:path.join(data,'memory')});
store.appendMessage('wechat:u:synthetic',{role:'user',uid:'synthetic',name:'Synthetic',text:'synthetic upgrade fact',ts:1});
store.close();
const manifest=path.join(data,'memory','manifest.json');
const value=JSON.parse(fs.readFileSync(manifest,'utf8'));
delete value.formatVersion;
fs.writeFileSync(manifest,JSON.stringify(value));
""");
    var fixture = await ProcessRunner.RunAsync(new ProcessStartInfo(Path.Combine(realRoot, "runtime", "node.exe"), "fixture.js")
    {
        WorkingDirectory = realRoot, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = true, RedirectStandardError = true,
    }, null, TimeSpan.FromSeconds(30));
    check(fixture.Success, "真实脚本夹具：合成 v2 记忆 exit=" + fixture.ExitCode + " err=" + fixture.Error + " out=" + fixture.Output);

    File.WriteAllText(Path.Combine(realRoot, "server.js"), """
const http=require('http'),fs=require('fs'),path=require('path');
const data=path.join(process.cwd(),'data');
const s=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({service:'whale-girl',up:true,pid:process.pid}));});
s.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(data,'server-port.txt'),String(s.address().port)));
process.stdin.on('data',(b)=>{if(String(b).includes('shutdown'))s.close(()=>process.exit(0));});
setInterval(()=>{},1000);
""");
    var sup = new RuntimeSupervisor(realRoot);
    try
    {
        var runner = Path.Combine(realRoot, "scripts", "migrate-memory.js");
        var importScript = Path.Combine(realRoot, "scripts", "migrate", "import-4.0.js");
        await sup.StartAllAsync(clearRestartHistory: false);
        check(sup.NodeRunning, "真实脚本自动升级后内核启动");
        check(!File.Exists(runner), "真实脚本 done 收据后删除 installed runner");
        check(File.Exists(importScript), "真实脚本保留在线导入脚本");
        var manifest = Path.Combine(realRoot, "data", "memory", "manifest.json");
        using (var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(manifest)))
            check(doc.RootElement.GetProperty("formatVersion").GetInt32() == 3, "真实脚本写入 formatVersion=3");
        var backups = Path.Combine(realRoot, "data", "backups");
        check(Directory.Exists(backups) && Directory.GetFiles(backups, "memory-pre-v3-*.zip").Length == 1,
            "真实脚本创建压缩归档");
    }
    finally
    {
        sup.StopAll();
        sup.Dispose();
    }
}

private static async Task CheckProcessRunnerAsync(string workspace, string root, string node, Action<bool,string> check)
{
    var script=Path.Combine(root,"process-runner-fixture.js");
    File.WriteAllText(script,"""
const fs=require('fs');
const mode=process.argv[2];
if(mode==='text'){process.stdout.write('中文输出');process.stderr.write('错误通道');process.exitCode=7;}
else if(mode==='success'){process.stdout.write('ready');}
else if(mode==='echo'){
  let input='';process.stdin.setEncoding('utf8').on('data',c=>input+=c).on('end',()=>process.stdout.write(JSON.stringify({input})));
  process.stderr.write('e'.repeat(100000));
}
else if(mode==='flood'){
  const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(0),5000);'],{stdio:'ignore'});
  fs.writeFileSync(process.argv[3],String(child.pid));
  setInterval(()=>{process.stdout.write('o'.repeat(4096));process.stderr.write('e'.repeat(4096));},1);
}
else if(mode==='hang-input'){setInterval(()=>{},1000);}
""");
    ProcessStartInfo Start(string mode)
    {
        var start=new ProcessStartInfo(node){WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true,
            RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,
            StandardInputEncoding=new UTF8Encoding(false),StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
        start.ArgumentList.Add(script);start.ArgumentList.Add(mode);return start;
    }
    var text=await ProcessRunner.RunAsync(Start("text"),null,TimeSpan.FromSeconds(3));
    check(text.Started&&text.ExitCode==7&&text.OutputComplete&&text.TerminationConfirmed&&!text.TimedOut,
        "短命令保留明确非零退出码且两路输出完成");
    check(text.Output=="中文输出"&&text.Error=="错误通道","短命令沿用调用者UTF8编码且不混淆stdout/stderr");
    var echo=await ProcessRunner.RunAsync(Start("echo"),new string('中',50000),TimeSpan.FromSeconds(3));
    check(echo.Success&&echo.Error.Length==100000,"大量stderr与stdin并发时不阻塞双管道");
    using(var result=JsonDocument.Parse(echo.Output))
        check(result.RootElement.GetProperty("input").GetString().Length==50000,"命令标准输入按UTF8完整传递一次");
    var pidFile=Path.Combine(root,"runner-owned-child.pid");
    var floodStart=Start("flood");floodStart.ArgumentList.Add(pidFile);
    var timer=Stopwatch.StartNew();
    var flood=await ProcessRunner.RunAsync(floodStart,null,TimeSpan.FromMilliseconds(1200));
    check(flood.TimedOut&&!flood.Cancelled&&timer.Elapsed<TimeSpan.FromSeconds(2),
        "持续stdout/stderr有单一总deadline且超时前终止owned命令");
    check(flood.TerminationConfirmed,"超时owned根进程已退出");
    check(File.Exists(pidFile),"超时夹具只使用其明确创建的子进程PID");
    var ownedPid=int.Parse(File.ReadAllText(pidFile));
    var ownedChildExited=false;
    for(var i=0;i<100&&!ownedChildExited;i++)
    {
        try{using var child=Process.GetProcessById(ownedPid);ownedChildExited=child.HasExited;}
        catch(ArgumentException){ownedChildExited=true;}
        if(!ownedChildExited)await Task.Delay(10);
    }
    check(ownedChildExited,"owned命令的显式fixture子进程随树终止");
    var drainGate=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    async Task<string> HeldDrain(StreamReader reader)
    {
        var value=await reader.ReadToEndAsync();
        await drainGate.Task;
        return value;
    }
    timer.Restart();
    try
    {
        var incomplete=await ProcessRunner.RunAsync(Start("text"),null,TimeSpan.FromMilliseconds(500),
            readOutput:HeldDrain);
        check(incomplete.TimedOut&&!incomplete.OutputComplete&&incomplete.CleanupUncertain&&timer.Elapsed<TimeSpan.FromSeconds(1),
            "受控未完成管道排空不能绕过总deadline且显式报告收尾不确定");
    }
    finally { drainGate.TrySetResult(true); }
    Task<string> LateCompletedDrain(StreamReader reader)
    {
        var value=reader.ReadToEndAsync().GetAwaiter().GetResult();
        Thread.Sleep(120);
        return Task.FromResult(value);
    }
    var lateCompletion=await ProcessRunner.RunAsync(Start("success"),null,TimeSpan.FromMilliseconds(200),
        readOutput:LateCompletedDrain);
    check(!lateCompletion.Success&&lateCompletion.TimedOut,
        "退出及排空任务即使完成也不能把超过总时限的命令报告成功");
    using(var cancelled=new CancellationTokenSource(TimeSpan.FromMilliseconds(150)))
    {
        timer.Restart();
        var result=await ProcessRunner.RunAsync(Start("hang-input"),new string('x',1000000),
            TimeSpan.FromSeconds(3),cancelled.Token);
        check(result.Cancelled&&!result.TimedOut&&!result.Success&&timer.Elapsed<TimeSpan.FromSeconds(1),
            "阻塞stdin可取消且不自动重放未知结果");
    }
    using(var cancelled=new CancellationTokenSource())
    {
        cancelled.Cancel();
        var result=await ProcessRunner.RunAsync(Start("text"),null,TimeSpan.FromSeconds(3),cancelled.Token);
        check(result.Cancelled&&!result.Started,"预取消不启动命令");
    }
    await CheckEffectiveConfigurationAsync(workspace,Path.Combine(root,"effective-configuration"),node,check);
}


private static async Task CheckEffectiveConfigurationAsync(string workspace, string root, string node, Action<bool,string> check)
{
    Directory.CreateDirectory(Path.Combine(root,"data"));
    Directory.CreateDirectory(Path.Combine(root,"runtime"));
    File.Copy(Path.Combine(workspace,"package.json"),Path.Combine(root,"package.json"));
    File.Copy(node,Path.Combine(root,"runtime","node.exe"));
    var source=Path.Combine(workspace,"src");
    foreach(var file in Directory.GetFiles(source,"*",SearchOption.AllDirectories))
    {
        var target=Path.Combine(root,"src",Path.GetRelativePath(source,file));
        Directory.CreateDirectory(Path.GetDirectoryName(target));
        File.Copy(file,target);
    }
    var active=Path.Combine(root,"data","config.json");
    var legacy=Path.Combine(root,"config.json");
    var settings=Path.Combine(root,"data","settings.json");
    var persona=Path.Combine(root,"data","persona.json");
    File.WriteAllText(legacy,"""{"persona":{"name":"legacy-shadow"},"deepseek":{"temperature":0},"group":{"requireAt":true},"phase1Unknown":{"zero":0,"off":false,"empty":""}}""");
    File.WriteAllText(active,"""{"persona":{"name":"effective-config"},"deepseek":{"temperature":0},"group":{"requireAt":true},"phase1Unknown":{"zero":0,"off":false,"empty":""}}""");
    File.WriteAllText(settings,"""{"model":"fixture-effective-model","phase1Unknown":{"zero":0,"off":false}}""");
    File.WriteAllText(persona,"""{"personality":"fixture-current-persona","phase1Unknown":{"zero":0,"off":false}}""");
    var paths=new[]{active,legacy,settings,persona};
    var before=Array.ConvertAll(paths,File.ReadAllText);
    check(ConfigurationPath.Resolve(root)==active,"effective-path resolves data/config.json before legacy");
    var local=new LocalConfiguration(root);
    var read=await local.ReadAsync("/api/config");
    var config=read.Prop("config");
    check(read.Ok&&config.GetProperty("persona").GetProperty("name").GetString()=="effective-config",
        "real LocalConfiguration runner reads the effective current snapshot source");
    check(config.GetProperty("deepseek").GetProperty("temperature").GetDouble()==0,
        "effective read preserves a configured numeric zero");
    var personaRead=await local.ReadAsync("/api/persona");
    check(personaRead.Ok&&personaRead.Prop("persona").GetProperty("personality").GetString()=="fixture-current-persona",
        "real current snapshot retains the persona service read connection");
    check(Array.TrueForAll(Array.ConvertAll(new[]{0,1,2,3},i=>File.ReadAllText(paths[i])==before[i]),same=>same),
        "effective read does not rewrite active legacy settings or persona files");
    var saved=await local.SaveAsync("/api/config",new{patch=new Dictionary<string,object>{{"group.requireAt",false}}});
    check(saved.Ok,"real LocalConfiguration saves a sparse patch through the current snapshot protocol");
    using(var current=JsonDocument.Parse(File.ReadAllText(active)))
    {
        var value=current.RootElement;
        check(!value.GetProperty("group").GetProperty("requireAt").GetBoolean(),
            "effective save persists false without replacing it by a default");
        var unknown=value.GetProperty("phase1Unknown");
        check(value.GetProperty("deepseek").GetProperty("temperature").GetDouble()==0&&
            unknown.GetProperty("zero").GetInt32()==0&&!unknown.GetProperty("off").GetBoolean()&&
            unknown.GetProperty("empty").GetString()=="",
            "effective sparse save preserves unknown fields zero false and empty string");
    }
    check(File.ReadAllText(legacy)==before[1]&&File.ReadAllText(settings)==before[2]&&File.ReadAllText(persona)==before[3],
        "effective config save leaves the shadowed legacy settings and persona files untouched");
    var personaSaved=await local.SaveAsync("/api/persona",new{name="effective-persona-saved"});
    var personaAfter=await local.ReadAsync("/api/persona");
    check(personaSaved.Ok&&personaAfter.Prop("persona").GetProperty("name").GetString()=="effective-persona-saved",
        "real current persona save remains reachable through LocalConfiguration");
    using(var current=JsonDocument.Parse(File.ReadAllText(active)))
    {
        var unknown=current.RootElement.GetProperty("phase1Unknown");
        check(unknown.GetProperty("zero").GetInt32()==0&&!unknown.GetProperty("off").GetBoolean()&&
            File.ReadAllText(legacy)==before[1],"persona save retains unknown zero false and the legacy shadow");
    }
    File.Delete(active);
    File.Delete(persona);
    var fallback=new LocalConfiguration(root);
    var legacyBefore=File.ReadAllText(legacy);
    check(ConfigurationPath.Resolve(root)==legacy,"legacy fallback resolves the root config when active config is absent");
    var legacyRead=await fallback.ReadAsync("/api/config");
    check(legacyRead.Ok&&legacyRead.Prop("config").GetProperty("persona").GetProperty("name").GetString()=="legacy-shadow"&&
        File.ReadAllText(legacy)==legacyBefore&&!File.Exists(active),
        "real legacy fallback read neither rewrites nor migrates config");
    var legacySave=await fallback.SaveAsync("/api/config",new{patch=new Dictionary<string,object>{{"group.requireAt",false}}});
    using(var document=JsonDocument.Parse(File.ReadAllText(legacy)))
    {
        var value=document.RootElement;
        check(legacySave.Ok&&!File.Exists(active)&&!value.GetProperty("group").GetProperty("requireAt").GetBoolean()&&
            value.GetProperty("deepseek").GetProperty("temperature").GetDouble()==0&&
            value.GetProperty("phase1Unknown").GetProperty("zero").GetInt32()==0&&
            !value.GetProperty("phase1Unknown").GetProperty("off").GetBoolean(),
            "real legacy fallback save updates only legacy and preserves zero false unknown fields");
    }
    var migrationBytes=File.ReadAllText(legacy);
    ConfigurationPath.Migrate(root);
    check(ConfigurationPath.Resolve(root)==active&&File.ReadAllText(active)==migrationBytes&&
        File.ReadAllText(legacy)==migrationBytes&&
        File.ReadAllText(Path.Combine(root,"data","config.legacy.backup.json"))==migrationBytes,
        "current migration copies valid legacy bytes and preserves legacy plus backup");
    ConfigurationPath.Migrate(root);
    check(File.ReadAllText(active)==migrationBytes,"current migration never overwrites an existing effective config");
    check(!File.Exists(Path.Combine(root,"data","server-port.txt"))&&
        !File.Exists(Path.Combine(root,"data","bridge-ready.json")),
        "effective path controls launch no kernel bridge or user account service");
}


public static async Task<string[]> RunAdaptationControlsAsync(string workspace, string root, string node)
{
    var cases=new List<string>();
    void Check(bool ok,string message) { if(!ok) throw new Exception(message); cases.Add(message); }
    await CheckEffectiveConfigurationAsync(workspace,Path.Combine(root,"effective-configuration"),node,Check);
    var logs=Path.Combine(root,"log-source-controls");
    Directory.CreateDirectory(Path.Combine(logs,"data"));
    var keys=new[]{"fixture-arbitrary-legacy-7f1c/+=:","fixture-arbitrary-current-8b2d/+=:","fixture-arbitrary-settings-9c3e/+=:"};
    File.WriteAllText(Path.Combine(logs,"config.json"),JsonSerializer.Serialize(new{apiKey=keys[0]}));
    File.WriteAllText(Path.Combine(logs,"data","config.json"),JsonSerializer.Serialize(new{apiKey=keys[1]}));
    File.WriteAllText(Path.Combine(logs,"data","settings.json"),JsonSerializer.Serialize(new{apiKey=keys[2]}));
    SecretRedactor.Refresh(logs,force:true);
    for(var i=0;i<keys.Length;i++)
    {
        var raw="connection detail "+keys[i];
        Check(!LogSanitizer.SanitizeLog(raw,SecretRedactor.Redact).Contains(keys[i]),
            "ordinary shared sanitizer retains configured secret source "+i);
        Check(!LogSanitizer.SanitizeCrash(raw,SecretRedactor.Redact).Contains(keys[i]),
            "crash shared sanitizer retains configured secret source "+i);
    }
    Func<string,string> fail=_=>throw new InvalidOperationException("controlled redaction failure");
    Check(!LogSanitizer.SanitizeLog("fixture-sensitive",fail).Contains("fixture-sensitive"),
        "ordinary shared sanitizer fails closed with the current registered-secret delegate");
    Check(!LogSanitizer.SanitizeCrash("fixture-sensitive",fail).Contains("fixture-sensitive"),
        "crash shared sanitizer fails closed with the current registered-secret delegate");
    return cases.ToArray();
}

public static async Task<int> Main(string[] args)
{
if(args.Length<2||args.Length>3||(args.Length==3&&Array.IndexOf(new[]{
    "--phase1-f38","--phase1-f43","--phase1-runner","--phase1-all"},args[2])<0))
    throw new ArgumentException("expected workspace/node plus an optional explicit local phase1 selection");
var workspace = Path.GetFullPath(args[0]);
var root = Path.Combine(workspace, ".tools", "temp", "supervisor-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(Path.Combine(root, "runtime", "python"));
Directory.CreateDirectory(Path.Combine(root, "data"));
File.Copy(args[1],Path.Combine(root,"runtime","node.exe"));
foreach(var file in Directory.GetFiles(Path.Combine(workspace,"artifacts","launcher-tests","fake"))) File.Copy(file,Path.Combine(root,"runtime","python",Path.GetFileName(file)));
var externalServer = """
const fs=require('fs'),http=require('http');
const remotePath='data/external-config.json';
const reply=(r,o)=>{r.statusCode=200;r.setHeader('content-type','application/json');r.end(JSON.stringify(o));};
const s=http.createServer((q,r)=>{
  if(q.url==='/healthz')return reply(r,{ok:true,up:true,service:fs.existsSync('wrong-service')?'other':'whale-girl',pid:fs.existsSync('invalid-pid')?0:fs.existsSync('wrong-pid')?process.pid+1:process.pid});
  if(q.url==='/api/status')return reply(r,{ok:true,gateways:[{platform:'qq',bridge:{account_nick:'wrong'}},{platform:'wechat',bridge:{online:true,accountOk:true,accountNick:'right'}}]});
  if(q.url==='/api/config'&&q.method==='GET'){const x=JSON.parse(fs.readFileSync(remotePath,'utf8'));x.gets++;fs.writeFileSync(remotePath,JSON.stringify(x));return reply(r,{ok:true,config:x});}
  if(q.url==='/api/config'&&q.method==='POST'){let b='';q.setEncoding('utf8');q.on('data',c=>b+=c);q.on('end',()=>{const x=JSON.parse(fs.readFileSync(remotePath,'utf8'));x.writes++;x.lastBody=JSON.parse(b);x.marker='external-hot';fs.writeFileSync(remotePath,JSON.stringify(x));reply(r,{ok:true,saved:true});});return;}
  if(q.url==='/api/settings'&&q.method==='GET')return reply(r,{ok:true,model:JSON.parse(fs.readFileSync(remotePath,'utf8')).model||''});
  if(q.url==='/api/settings'&&q.method==='POST'){let b='';q.setEncoding('utf8');q.on('data',c=>b+=c);q.on('end',()=>{const x=JSON.parse(fs.readFileSync(remotePath,'utf8'));x.model=JSON.parse(b).model;fs.writeFileSync(remotePath,JSON.stringify(x));reply(r,{ok:true});});return;}
  reply(r,{ok:true});
});
s.listen(0,'127.0.0.1',()=>fs.writeFileSync('data/server-port.txt',String(s.address().port)));
process.stdin.on('data',b=>{if(String(b).includes('shutdown'))s.close(()=>process.exit(0));});
""";
File.WriteAllText(Path.Combine(root,"server.js"),externalServer);
void Check(bool ok,string message) { if(!ok) throw new Exception(message); Console.WriteLine("PASS: "+message); }
try {
 File.WriteAllText(Path.Combine(root,"config.json"),"{\"marker\":\"offline-untouched\",\"apiKey\":\"fixture-arbitrary-7f1c/+=:\"}");
 File.WriteAllText(Path.Combine(root,"data","external-config.json"),"{\"marker\":\"external-before\",\"gets\":0,\"writes\":0}");
 Check(Api.Detail(null)=="", "联系人摘要兼容空响应");
 Check(Api.Detail(new ApiResult { Raw=" \r\n ", Error="连接失败" })=="连接失败", "联系人摘要为空时保留原错误");
 Check(Api.Detail(new ApiResult { Raw="  first\r\nsecond  ", Error="fallback" })=="first  second", "联系人摘要去首尾空白并保持换行替换规则");
 Check(Api.Detail(new ApiResult { Raw=new string('中',120) })==new string('中',120), "联系人摘要 120 字不截断");
 Check(Api.Detail(new ApiResult { Raw=new string('中',121) })==new string('中',120)+"…", "联系人摘要超长才加省略号");
 using var sup = new RuntimeSupervisor(root);
 sup.UpdateBlocked = true;
 sup.StartNode(); sup.StartBridge(); await sup.StartAllAsync();
 Check(!sup.NodeRunning && !sup.BridgeRunning, "启动更新检查及强制态阻止所有业务启动入口");
 sup.UpdateBlocked = false;
 var portFile = Path.Combine(root, "data", "server-port.txt");
 using (var external = Process.Start(new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), "server.js")
 {
     WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true
 }))
 {
     try
     {
         for (var i = 0; i < 100 && !File.Exists(portFile); i++) await Task.Delay(50);
         Check(File.Exists(portFile), "后台模拟内核已监听端口");
         var externalState = await sup.ProbeAsync();
         Check(externalState.NodeUp && externalState.ExternalNode && externalState.NodeReady && externalState.BridgeUp && externalState.BrOnline
             && externalState.BrAccountOk && externalState.BrAccountNick == "right" && !sup.NodeRunning,
             "能看到后台内核、桥接和微信状态，同时保留进程归属");
          if(args.Length<=2 || args[2]=="--phase1-all" || args[2]=="--phase1-f43")
          {
              SecretRedactor.Refresh(root,force:true);
              var synthetic="fixture-arbitrary-7f1c/+=:";
              var ordinary="connection failed with key "+synthetic;
              Check(!SecretRedactor.Redact(ordinary).Contains(synthetic),"合成Key先由现有普通日志脱敏器保护");
              var sanitizerType=typeof(SecretRedactor).Assembly.GetType("WhaleLauncher.LogSanitizer");
              Check(sanitizerType!=null,"崩溃文本与普通日志共享的脱敏入口已存在");
              var crash=LogSanitizer.SanitizeCrash("connection failed with key "+synthetic+" wxid_fixture-user",
                  SecretRedactor.Redact);
              Check(!crash.Contains(synthetic) && !crash.Contains("wxid_fixture-user"),"崩溃文本与普通日志共用脱敏结果且保留PII规则");
              Func<string,string> failSanitizer=_=>throw new InvalidOperationException("fixture");
              var failClosed=LogSanitizer.SanitizeLog("synthetic-sensitive",failSanitizer);
              Check(!failClosed.Contains("synthetic-sensitive") && failClosed.Contains("省略"),"脱敏异常时失败关闭并省略正文");
              Check(LogSanitizer.SanitizeCrash("synthetic-sensitive",failSanitizer).Contains("省略"),
                  "崩溃脱敏异常同样失败关闭而不回落原文");
              var pii=LogSanitizer.SanitizeCrash(@"111111111@chatroom 13800000000 user@example.com C:\Users\fixture-person\data",
                  SecretRedactor.Redact);
              Check(!pii.Contains("111111111@chatroom")&&!pii.Contains("13800000000")&&!pii.Contains("user@example.com")
                  &&!pii.Contains("fixture-person"),"崩溃保留原有群号手机号邮箱和用户路径保护");
              Check(LogSanitizer.SanitizeLog("ordinary non-sensitive line",SecretRedactor.Redact)=="ordinary non-sensitive line",
                  "普通无敏感内容的日志文本保持兼容");
              var encoded=Uri.EscapeDataString(synthetic);
              var encodedResult=LogSanitizer.SanitizeLog("https://example.test/?token="+encoded,SecretRedactor.Redact);
              Check(!encodedResult.Contains(synthetic)&&!encodedResult.Contains(encoded),"任意前缀Key及URL编码形式不会留在普通日志");
              Check(LogSanitizer.SanitizeLog("Bearer fixture-bearer-long-token",SecretRedactor.Redact)=="Bearer ***",
                  "共享阶段保留Bearer通用脱敏");
              sup.Say(ordinary);
              Check(!sup.History().Exists(line=>line.Text.Contains(synthetic)),"真实普通日志消费者不留下合成Key");
              if(args.Length>2 && args[2]=="--phase1-f43") return 0;
          }
         var offlineConfigPath=ConfigurationPath.Resolve(root);
         Check(offlineConfigPath==Path.Combine(root,"data","config.json"),"external route guard observes the migrated effective config");
         var legacyConfigBefore=File.ReadAllText(Path.Combine(root,"config.json"));
         var offlineConfigBefore=File.ReadAllText(offlineConfigPath);
         var externalConfig=await sup.ReadConfigurationAsync("/api/config");
         var externalRoot=externalConfig.Prop("config");
         Check(externalConfig.Ok && externalRoot.TryGetProperty("marker",out var externalMarker)
             && externalMarker.GetString()=="external-before",
             "自有NodeRunning为false时，可信外部内核配置读取仍走在线API");
         var externalSave=await sup.SaveConfigurationAsync("/api/config",new { patch=new { phase1Probe=true } });
         Check(externalSave.Ok && File.ReadAllText(Path.Combine(root,"data","external-config.json")).Contains("external-hot"),
             "外部内核配置写入在线生效");
         var externalSettings=await sup.SaveConfigurationAsync("/api/settings",new{model="fixture-model"});
         Check(externalSettings.Ok&&(await sup.ReadConfigurationAsync("/api/settings")).Str("model")=="fixture-model",
             "同一可信外部配置通路支持settings在线热更新");
         Check(File.ReadAllText(offlineConfigPath)==offlineConfigBefore&&File.ReadAllText(Path.Combine(root,"config.json"))==legacyConfigBefore,
             "外部在线读写不改动隔离fixture中的离线配置");
         await sup.StartAllAsync();
         Check(!sup.NodeRunning && !sup.BridgeRunning, "已有后台内核时不会重复启动服务");
         sup.StopAll();
         Check(!external.HasExited && (await sup.ProbeAsync()).NodeReady, "停止启动器管理的服务不影响后台内核");

         var wrongService = Path.Combine(root, "wrong-service");
         File.WriteAllText(wrongService, "1");
         Check(!(await sup.ProbeAsync()).NodeUp, "不会把占用端口的其他服务显示成鲸鲸内核");
         var externalReadCount=File.ReadAllText(Path.Combine(root,"data","external-config.json"));
         Check(!(await sup.ReadConfigurationAsync("/api/config")).Ok
             &&File.ReadAllText(Path.Combine(root,"data","external-config.json"))==externalReadCount,
             "错误服务身份不得进入外部配置API");
         File.Delete(wrongService);
         File.WriteAllText(Path.Combine(root,"invalid-pid"),"1");
         Check(!(await sup.ProbeAsync()).NodeUp&&!(await sup.ReadConfigurationAsync("/api/config")).Ok,
             "无效PID健康响应不被配置路由接受");
         File.Delete(Path.Combine(root,"invalid-pid"));
     }
     finally
     {
         if (!external.HasExited)
         {
             await external.StandardInput.WriteLineAsync("shutdown");
             if (!external.WaitForExit(3000)) external.Kill();
             external.WaitForExit();
         }
     }
 }
 Check(!(await sup.ProbeAsync()).NodeUp, "后台内核退出后恢复未启动状态");
 sup.StartNode();
 Check(await sup.WaitForNodeAsync(), "单独桥接门禁场景内核就绪");
 sup.UpdateBlocked = true;
 sup.StartBridge();
 Check(!sup.BridgeRunning, "内核运行时也不能绕过强制策略单独启动桥接");
 sup.StopAll();
 sup.UpdateBlocked = false;
  if(args.Length<=2 || args[2]=="--phase1-all" || args[2]=="--phase1-runner")
      {
       await CheckOfflineMigrationAsync(root, sup, Check);
       await CheckAutoUpgradeAsync(workspace, root, Check);
       await CheckRealAutoUpgradeAsync(workspace, root, Path.Combine(root,"runtime","node.exe"), Check);
       await CheckProcessRunnerAsync(workspace,root,Path.Combine(root,"runtime","node.exe"),Check);
   }
  if(args.Length>2 && (args[2]=="--phase1-f38" || args[2]=="--phase1-all" || args[2]=="--phase1-runner")) return 0;
 var restartHistory=(List<DateTime>)typeof(RuntimeSupervisor).GetField("_bridgeRestarts",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(sup);
 var previousRestart=DateTime.UtcNow.AddMinutes(-1);restartHistory.Add(previousRestart);
 await sup.StartAllAsync(clearRestartHistory:false);
 Check(sup.NodeRunning && restartHistory.Contains(previousRestart),"主窗口启动保留原有重启历史");
 Check(await sup.WaitForNodeAsync(),"内核就绪验证实例 PID");
 await sup.StartAllAsync();
 Check(!restartHistory.Contains(previousRestart),"诊断入口默认仍清空重启历史");
 for(int i=0;i<70;i++){if(File.Exists(Path.Combine(root,"bridge-test-count")) && File.ReadAllText(Path.Combine(root,"bridge-test-count"))=="2" && sup.BridgeRunning)break;await Task.Delay(100);}
 Check(File.ReadAllText(Path.Combine(root,"bridge-test-count"))=="2" && sup.BridgeRunning,"桥接 code 7 自动重启并保持运行");
 var state=await sup.ProbeAsync(); Check(state.NodeReady && !state.ExternalNode && state.BrAccountNick=="right","由启动器管理的内核保持原有状态，多平台状态选择微信");
 sup.StopAll(); await Task.Delay(3300); Check(!sup.BridgeRunning && !sup.NodeRunning,"手动停止后不会被自动恢复拉起");
 File.WriteAllText(Path.Combine(root,"bridge-test-count"),"0");
 sup.StartNode();Check(await sup.WaitForNodeAsync(),"重新启动正常");sup.StartBridge();
 for(int i=0;i<30 && File.ReadAllText(Path.Combine(root,"bridge-test-count"))!="1";i++)await Task.Delay(100);
 await Task.Delay(200);sup.StopAll();await Task.Delay(3300);
 Check(File.ReadAllText(Path.Combine(root,"bridge-test-count"))=="1","停止会取消尚未执行的自动重启");
 var raw="中文\t\r\n\"\\\u0001";Check(JsonSerializer.Deserialize<string>("\""+Api.Esc(raw)+"\"")==raw,"JSON 转义保留控制字符");
 sup.StopAll(); File.WriteAllText(Path.Combine(root,"wrong-pid"),"1");
  var wrong= sup.StartAllAsync(clearRestartHistory:false);var wrongReady=sup.WaitForNodeAsync();await Task.Delay(400);sup.StopAll();
  Check(!await wrongReady,"不能把其它实例的健康响应误认为自身就绪");
  await wrong;Check(!sup.BridgeRunning,"内核 PID 不匹配时公共启动流程不能启动桥接");File.Delete(Path.Combine(root,"wrong-pid"));
 foreach(var code in new[]{0,1,2})
 {
  File.WriteAllText(Path.Combine(root,"bridge-test-count"),"0");File.WriteAllText(Path.Combine(root,"bridge-test-code"),code.ToString());
  sup.StartNode();Check(await sup.WaitForNodeAsync(),"故障场景内核就绪 "+code);sup.StartBridge();
  await Task.Delay(3600);
  Check(File.ReadAllText(Path.Combine(root,"bridge-test-count"))=="1" && !sup.BridgeRunning,"正常退出或配置错误不反复重启 code="+code);
  sup.StopAll();
 }
 File.WriteAllText(Path.Combine(root,"bridge-test-count"),"0");File.WriteAllText(Path.Combine(root,"bridge-test-code"),"7");File.WriteAllText(Path.Combine(root,"bridge-test-always"),"1");
 sup.StartNode();Check(await sup.WaitForNodeAsync(),"连续故障场景内核就绪");sup.StartBridge();
 bool brakeApplied = false;
 for (var i = 0; i < 250; i++)
 {
     brakeApplied = sup.History().Exists(line => line.Text.Contains("桥接连续异常退出"));
     if (brakeApplied) break;
     await Task.Delay(100);
 }
 Check(brakeApplied && File.ReadAllText(Path.Combine(root,"bridge-test-count"))=="4" && !sup.BridgeRunning,"连续异常最多自动恢复三次，避免重启风暴");
 // 启动器被强杀时窗口 Closed 不会执行，只能靠 Job 句柄关闭兜底。
 using(var job = new ProcessJob())
 using(var orphan = Process.Start(new ProcessStartInfo(Path.Combine(root,"runtime","node.exe"), "-e \"setInterval(()=>{},1000)\""){UseShellExecute=false,CreateNoWindow=true}))
 {
  Check(job.IsAvailable,"能创建带 KILL_ON_JOB_CLOSE 的进程 Job");
  Check(job.Assign(orphan),"内核进程能加入启动器 Job");
  job.Dispose();
  Check(orphan.WaitForExit(5000),"Job 句柄关闭后内核进程被系统结束");
 }
return 0;
} finally {
 var allowed=Path.GetFullPath(Path.Combine(workspace,".tools","temp"))+Path.DirectorySeparatorChar;
 if(!Path.GetFullPath(root).StartsWith(allowed,StringComparison.OrdinalIgnoreCase))throw new Exception("invalid cleanup target");
 Directory.Delete(root,true);
}
}
}
}

