'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('healthy external service routing preserves owned-process start and stop semantics', () => {
  const supervisor = read('launcher/RuntimeSupervisor.cs');
  const probe = supervisor.slice(supervisor.indexOf('public async Task<Snapshot> ProbeAsync()'), supervisor.indexOf('private static string Str('));
  const config = supervisor.slice(supervisor.indexOf('public async Task<ApiResult> ReadConfigurationAsync'),
    supervisor.indexOf('public Task<ApiResult> PatchConfigurationAsync'));
  assert.match(probe, /ReadHealthyNodePidAsync\(s\.Port\)/);
  assert.match(probe, /s\.ExternalNode\s*=\s*true/);
  assert.match(supervisor, /public bool NodeRunning => _node != null/);
  assert.match(supervisor, /public async Task<ApiResult> SaveConfigurationAsync/);
  assert.match(supervisor, /ReadHealthyNodePidAsync/);
  assert.match(config, /ConfigurationServiceUrlAsync\(\)/);
  assert.match(config, /Api\.Get\(url, path\)/);
  assert.match(config, /LocalConfiguration\(BaseDir\)/);
  assert.match(config, /Api\.PostJson\(url, path, body\)/);
  assert.match(supervisor, /Process\.Kill|p\.Kill\(entireProcessTree: true\)/);
});

test('crash and ordinary logs use the common fail-closed sanitizer without weakening export redaction', () => {
  const sanitizer = read('launcher/LogSanitizer.cs');
  assert.match(read('launcher/App.xaml.cs'), /LogSanitizer\.SanitizeCrash\(text, SecretRedactor\.Redact\)/);
  assert.match(read('launcher/RuntimeSupervisor.cs'), /LogSanitizer\.SanitizeLog\(raw, SecretRedactor\.Redact\)/);
  assert.match(sanitizer, /catch\s*\{\s*return FailureMarker;/);
  assert.match(sanitizer, /GroupId\.Replace/);
  assert.match(sanitizer, /Wxid\.Replace/);
  assert.match(read('launcher/Views/DiagPage.xaml.cs'), /SecretRedactor\.Redact\(text\)/);
});

test('bounded runner has the real offline snapshot consumer and preserves diagnostic lifecycle', () => {
  const runner = read('launcher/ProcessRunner.cs');
  const local = read('launcher/LocalConfiguration.cs');
  assert.match(local, /ProcessRunner\.RunAsync/);
  assert.match(runner, /WaitForExitAsync/);
  assert.match(runner, /ReadToEndAsync|ReadOutputAsync/);
  assert.match(runner, /Kill\(entireProcessTree:\s*true\)/);
  assert.match(runner, /Stopwatch|TimeProvider/);
  assert.match(read('launcher/ProcessJob.cs'), /KILL_ON_JOB_CLOSE/);
  assert.match(read('launcher/Views/DiagPage.xaml.cs'), /private (?:async )?Task<\(int Code, string Output\)> RunToolAsync\(/,
    'the reserved diagnostic caller wrapper remains available; its pending F42 body is not locked into a test');
});

test('start button auto-upgrades memory through the stable maintenance/auto contract', () => {
  const supervisor = read('launcher/RuntimeSupervisor.cs');
  const settings = read('launcher/Views/SettingsPage.xaml.cs');
  assert.match(supervisor, /AutoForStartCoreAsync/);
  assert.match(supervisor, /upgrade-maintenance\.js/);
  assert.match(supervisor, /--auto-upgrade/);
  assert.match(supervisor, /runnerCleanupEligible/i);
  assert.match(supervisor, /durable == null \|\| durable\.Status != "idle"/, 'done 后必须以 durable idle 放行');
  assert.match(supervisor, /private void RemoveRunnerIfEligible\(MemoryUpgradeStatus status\)[\s\S]{0,260}!status\.RunnerCleanupEligible/,
    '删 runner 前必须确认 eligible 收据');
  assert.match(supervisor, /ReparsePoint/, '重解析点 scripts 父目录不得被删');
  assert.match(supervisor, /unins000\.exe/);
  assert.match(supervisor, /HasInstallerMarker/);
  assert.match(supervisor, /File\.Delete\(MigrationRunner\)/);
  assert.doesNotMatch(supervisor, /Delete\([^)]*import-4\.0/, '在线导入脚本必须保留');
  assert.doesNotMatch(supervisor, /status\.Version == status\.TargetVersion[\s\S]{0,160}在线导入/,
    'pending 不得因 version==target 退回在线导入');
  assert.match(settings, /RunAutoMemoryUpgradeAsync\(\)/);
  assert.doesNotMatch(settings, /RunOfflineMemoryMigrationAsync\(apply: false\)[\s\S]*?AppDialog\.Confirm/, '启动自动转换不再手动确认');
  assert.ok((supervisor.match(/AutoForStartCoreAsync\(\)/g) || []).length >= 2, 'StartAll 与设置页都复用同一自动 seam');
  const installer = read('installer/whale.iss');
  assert.ok(installer.includes('..\\scripts\\migrate-memory.js'));
  assert.ok(installer.includes('..\\scripts\\migrate\\import-4.0.js'));
});

test('server and offline migration share one data-directory lock with crash-safe recovery', () => {
  const server = read('server.js');
  assert.match(server, /dataLock\.acquire\(\{ dataDir, purpose: 'server' \}\)/);
  assert.match(server, /listen 失败时服务从未对外可用[\s\S]*?releaseLock\(\)/);
  assert.match(server, /logger\.close\(\);[\s\S]*?releaseLock\(\)/, 'close 必须在 store/插件/HTTP teardown 之后释放');
  const migration = read('scripts/migrate-memory.js');
  assert.match(migration, /purpose: 'migration'/);
  assert.match(migration, /finally \{ lock\.releaseSync\(\); \}/);
  assert.match(migration, /dataLock\.inspect\(args\.dataDir\)/, '预览读前/读后查锁');
  const lock = read('src/memory/dataLock.js');
  assert.match(lock, /linkSync/, '锁文件必须原子创建且首行即完整 owner');
  assert.match(lock, /data\.lock\.recover/, '陈旧锁恢复需要单恢复者守卫');
  assert.match(lock, /data_lock_unknown/, '无法判定的锁必须 fail-closed');
  assert.match(lock, /data_lock_recovering/, '活守卫要能区分正常恢复中');
  assert.match(lock, /data_lock_guard_stale/, '死守卫必须 fail-closed 给人工诊断');
  assert.match(lock, /data_lock_guard_unknown/, '坏守卫必须 fail-closed');
  assert.doesNotMatch(lock, /setInterval|readHeartbeat|heartbeatAt/, '不能用心跳时间做恢复判断');
  assert.match(server, /isDataLockError/, 'server CLI 必须接住所有 data_lock_* 错误码');
  const supervisor = read('launcher/RuntimeSupervisor.cs');
  assert.match(supervisor, /DataLockState\.GuardStale/);
  assert.match(supervisor, /guardStaleMessage|DataLockGuardStaleMessage/);
  assert.match(supervisor, /程序不会自动删除/);
  const checks = read('tests/launcher/Checks/Program.cs');
  assert.ok(checks.includes('活锁时拒绝离线预览'));
  assert.ok(checks.includes('活锁时启动入口不启动内核'));
});

test('existing launcher-lifecycle task already includes SupervisorChecks and its linked production sources', () => {
  const plan = JSON.parse(read('scripts/test-tasks.json'));
  const lifecycle = plan.tasks.find(task => task.id === 'launcher-lifecycle');
  assert.ok(lifecycle);
  assert.ok(lifecycle.projects.includes('tests/launcher/Checks/Checks.csproj'));
  assert.ok(lifecycle.buildProjects.includes('tests/launcher/FakeBridge/FakeBridge.csproj'));
  assert.equal(lifecycle.commands.length, 1, 'do not add another native C# task');
  const invocation = read('scripts/test-launcher.ps1');
  assert.match(invocation, /SupervisorChecks\.dll'\)\s+\$root\s+\$node/);
  assert.doesNotMatch(invocation, /--phase1-/, 'normal CI must run the full existing entry');
  const checks = read('tests/launcher/Checks/Program.cs');
  assert.ok(checks.includes('args.Length<=2 || args[2]=="--phase1-all" || args[2]=="--phase1-f43"'));
  assert.match(checks, /await CheckProcessRunnerAsync\(/);
  assert.match(checks, /ConfigurationPath\.Resolve\(root\)/);
  assert.match(checks, /CheckEffectiveConfigurationAsync\(/);
  assert.doesNotMatch(checks, /File\.WriteAllText\(Path\.Combine\(snapshot,\s*"launcherSnapshot\.js"\)/,
    'effective-path controls use the real current snapshot source');
  const project = read('tests/launcher/Checks/Checks.csproj');
  for (const source of ['RuntimeSupervisor.cs', 'LocalConfiguration.cs', 'ContactDirectory.cs',
    'SecretRedactor.cs', 'ProcessJob.cs', 'ProcessRunner.cs', 'LogSanitizer.cs', 'ConfigurationPath.cs']) {
    assert.ok(project.includes(source), `SupervisorChecks does not link ${source}`);
  }
});
