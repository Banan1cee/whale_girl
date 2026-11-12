using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using WhaleLauncher;
var workspace = Path.GetFullPath(args[0]);
var root = Path.Combine(workspace, ".tools", "temp", "supervisor-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(Path.Combine(root, "runtime", "python"));
Directory.CreateDirectory(Path.Combine(root, "data"));
File.Copy(args[1],Path.Combine(root,"runtime","node.exe"));
foreach(var file in Directory.GetFiles(Path.Combine(workspace,"artifacts","launcher-tests","fake"))) File.Copy(file,Path.Combine(root,"runtime","python",Path.GetFileName(file)));
File.WriteAllText(Path.Combine(root,"server.js"), "const fs=require('fs'),http=require('http');const s=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify(q.url==='/healthz'?{ok:true,up:true,service:fs.existsSync('wrong-service')?'other':'whale-girl',pid:fs.existsSync('wrong-pid')?process.pid+1:process.pid}:{ok:true,gateways:[{platform:'qq',bridge:{account_nick:'wrong'}},{platform:'wechat',bridge:{online:true,accountOk:true,accountNick:'right'}}]}));});s.listen(0,'127.0.0.1',()=>fs.writeFileSync('data/server-port.txt',String(s.address().port)));process.stdin.on('data',b=>{if(String(b).includes('shutdown'))s.close(()=>process.exit(0));});");
void Check(bool ok,string message) { if(!ok) throw new Exception(message); Console.WriteLine("PASS: "+message); }
try {
 Check(Api.Detail(null)=="", "联系人摘要兼容空响应");
 Check(Api.Detail(new ApiResult { Raw=" \r\n ", Error="连接失败" })=="连接失败", "联系人摘要为空时保留原错误");
 Check(Api.Detail(new ApiResult { Raw="  first\r\nsecond  ", Error="fallback" })=="first  second", "联系人摘要去首尾空白并保持换行替换规则");
 Check(Api.Detail(new ApiResult { Raw=new string('中',120) })==new string('中',120), "联系人摘要 120 字不截断");
 Check(Api.Detail(new ApiResult { Raw=new string('中',121) })==new string('中',120)+"…", "联系人摘要超长才加省略号");
 using var sup = new RuntimeSupervisor(root);
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
         await sup.StartAllAsync();
         Check(!sup.NodeRunning && !sup.BridgeRunning, "已有后台内核时不会重复启动服务");
         sup.StopAll();
         Check(!external.HasExited && (await sup.ProbeAsync()).NodeReady, "停止启动器管理的服务不影响后台内核");

         var wrongService = Path.Combine(root, "wrong-service");
         File.WriteAllText(wrongService, "1");
         Check(!(await sup.ProbeAsync()).NodeUp, "不会把占用端口的其他服务显示成鲸鲸内核");
         File.Delete(wrongService);
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
} finally {
 var allowed=Path.GetFullPath(Path.Combine(workspace,".tools","temp"))+Path.DirectorySeparatorChar;
 if(!Path.GetFullPath(root).StartsWith(allowed,StringComparison.OrdinalIgnoreCase))throw new Exception("invalid cleanup target");
 Directory.Delete(root,true);
}
