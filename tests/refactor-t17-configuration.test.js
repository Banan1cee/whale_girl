'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const project = path.join(root, 'tests/launcher/JsonChecks/JsonChecks.csproj');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('T17 runs the real isolated C# regression project in CI; local SDK-less checks compile the same sources in memory', { timeout: 120000 }, () => {
  const sdk = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true });
  let result;
  if (process.env.CI || /^10\./m.test(sdk.stdout || '')) {
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t17-json-'));
    try {
      result = spawnSync('dotnet', ['run', '--project', project, '-c', 'Release', '--artifacts-path', artifacts, '-p:NuGetAudit=false'], {
        cwd: root, encoding: 'utf8', timeout: 110000, windowsHide: true,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' },
      });
    } finally { fs.rmSync(artifacts, { recursive: true, force: true }); }
  } else {
    const sources = [...fs.readFileSync(project, 'utf8').matchAll(/<Compile Include="([^"]+)"/g)]
      .map(match => path.resolve(path.dirname(project), match[1]));
    const quoted = sources.map(file => "'" + file.replace(/'/g, "''") + "'").join(',');
    const command = "$ErrorActionPreference='Stop'; Add-Type -Path @(" + quoted + '); exit ([WhaleLauncher.JsonChecks.Program]::Main())';
    result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: root, encoding: 'utf8', timeout: 110000, windowsHide: true,
    });
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
  assert.match(result.stdout, /T17 checks: passed=\d+ failed=0/);
  process.stdout.write(result.stdout);
});

test('settings wires revisions, committed-only watermarks and page-lifetime protection into the real callbacks', () => {
  const source = read('launcher/Views/SettingsPage.xaml.cs');
  assert.match(source, /ConfigurationSaveState</);
  assert.doesNotMatch(source, /suppressAuto\s*\|\|\s*autoSaving/);
  assert.doesNotMatch(source, /saved\s*=\s*v;\s*await PatchAsync/);
  assert.match(source, /hintOperation\.IsCurrent/);
  assert.match(source, /Unloaded\s*\+=.*_pageLifetime\.Deactivate/);
  assert.match(source, /await chatSaves\.SaveAsync\(\)/);
  assert.match(source, /await visionSaves\.SaveAsync\(\)/);
  assert.match(source, /await saves\.SaveAsync\(\)/);
  assert.match(source, /chatSecret\.IsCurrent\(snapshot\.Secret, key\.Password\)/);
  assert.match(source, /visionSecret\.IsCurrent\(snapshot\.Secret, visionKey\.Password\)/);
  assert.match(source, /revision != _configurationRevision/);
});

test('the existing required CI discovers the regression and must execute dotnet rather than silently skip it', () => {
  const workflow = read('.github/workflows/tests.yml');
  const metadata = JSON.parse(read('package.json'));
  assert.ok(metadata.scripts.test.includes('tests/*.test.js'));
  assert.ok(workflow.includes('npm test'));
  assert.ok(workflow.indexOf('检查 .NET 10 SDK') < workflow.indexOf('npm test *>'));
});
