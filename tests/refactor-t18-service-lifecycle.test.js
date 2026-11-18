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

test('contact cache carries account identity and rejects cross-account late completions', () => {
  const directory = read('launcher/ContactDirectory.cs');
  assert.match(directory, /Account\s*=\s*_account/);
  assert.match(directory, /InvalidateForAccountChange\(string account\s*=\s*""\)/);
  assert.match(directory, /_generation\+\+/);
  assert.match(directory, /generation\s*!=\s*_generation/);
  assert.match(directory, /_account\s*=\s*account/);
  assert.match(directory, /LoadAsync\(bool force\s*=\s*false\)/);

  const bridge = read('launcher/Views/BridgePage.xaml.cs');
  assert.match(bridge, /_sup\.Contacts\.InvalidateForAccountChange\(account\)/);
  assert.match(bridge, /_sup\.Contacts\.InvalidateForAccountChange\(s\.BrAccount\)/);
  assert.match(bridge, /generation\s*!=\s*_accountGeneration/);
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

test('bounded runner has the real offline snapshot consumer and leaves plugin and reserved paths alone', () => {
  const runner = read('launcher/ProcessRunner.cs');
  const local = read('launcher/LocalConfiguration.cs');
  assert.match(local, /ProcessRunner\.RunAsync/);
  assert.match(runner, /WaitForExitAsync/);
  assert.match(runner, /ReadToEndAsync|ReadOutputAsync/);
  assert.match(runner, /Kill\(entireProcessTree:\s*true\)/);
  assert.match(runner, /Stopwatch|TimeProvider/);
  assert.match(read('launcher/PluginMarket.cs'), /start\.Environment\.Clear\(\)/);
  assert.match(read('launcher/PluginMarket.cs'), /--wasm-max-mem-pages=16/);
  assert.match(read('launcher/ProcessJob.cs'), /KILL_ON_JOB_CLOSE/);
  assert.match(read('launcher/Views/DiagPage.xaml.cs'), /private (?:async )?Task<\(int Code, string Output\)> RunToolAsync\(/,
    'the reserved diagnostic caller wrapper remains available; its pending F42 body is not locked into a test');
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
  assert.ok(checks.includes('args.Length<=2 || args[2]=="--phase1-all" || args[2]=="--phase1-f46"'));
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
