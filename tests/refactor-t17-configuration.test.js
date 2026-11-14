'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const projectRelative = 'tests/launcher/JsonChecks/JsonChecks.csproj';
const project = path.join(root, 'tests/launcher/JsonChecks/JsonChecks.csproj');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

function selectJsonChecksCommand({ ci = Boolean(process.env.CI), sdkOutput = '', rootPath = root,
  projectPath = project, artifactsPath } = {}) {
  if (ci || /^10\./m.test(sdkOutput)) {
    if (!artifactsPath) throw new Error('isolated artifacts path required for dotnet');
    return {
      command: 'dotnet',
      args: ['run', '--project', projectPath, '-c', 'Release', '--artifacts-path', artifactsPath, '-p:NuGetAudit=false'],
      options: { cwd: rootPath, encoding: 'utf8', timeout: 110000, windowsHide: true,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } },
    };
  }
  const sources = [...fs.readFileSync(projectPath, 'utf8').matchAll(/<Compile Include="([^"]+)"/g)]
    .map(match => path.resolve(path.dirname(projectPath), match[1]));
  const quoted = sources.map(file => "'" + file.replace(/'/g, "''") + "'").join(',');
  const command = "$ErrorActionPreference='Stop'; Add-Type -Path @(" + quoted + '); exit ([WhaleLauncher.JsonChecks.Program]::Main())';
  return { command: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', command],
    options: { cwd: rootPath, encoding: 'utf8', timeout: 110000, windowsHide: true } };
}

function runJsonChecks(options, spawn = spawnSync) {
  const invocation = selectJsonChecksCommand(options);
  return { invocation, result: spawn(invocation.command, invocation.args, invocation.options) };
}

function nativeInvocationErrors(invocation, expectedProject) {
  const errors = [];
  const args = invocation && invocation.args;
  if (!invocation || invocation.command !== 'dotnet') errors.push('CI must invoke dotnet, not skip or use the local Add-Type path');
  if (!Array.isArray(args) || args[0] !== 'run' || args.filter(arg => arg === 'run').length !== 1)
    errors.push('CI must run exactly one nested dotnet project');
  if (!Array.isArray(args) || args.filter(arg => arg === '--project').length !== 1
      || args[args.indexOf('--project') + 1] !== expectedProject)
    errors.push('CI must select the single mapped JsonChecks project');
  if (!Array.isArray(args) || args.filter(arg => arg === '--artifacts-path').length !== 1
      || !args[args.indexOf('--artifacts-path') + 1]) errors.push('dotnet must write to an isolated artifacts path');
  if (Array.isArray(args) && args.includes('--no-build')) errors.push('CI must execute the native project, not reuse an old build');
  return errors;
}

function workflowSteps(workflow) {
  const lines = workflow.split(/\r?\n/);
  const starts = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^ {6}- (?:name|uses):/.test(lines[index])) starts.push(index);
  }
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? lines.length,
    text: lines.slice(start, starts[index + 1] ?? lines.length).join('\n'),
  }));
}

function removeWorkflowStep(workflow, predicate) {
  const lines = workflow.split(/\r?\n/);
  const step = workflowSteps(workflow).find(predicate);
  if (!step) return workflow;
  lines.splice(step.start, step.end - step.start);
  return lines.join('\n');
}

function moveNodeStepBeforeDotnetSetup(workflow) {
  const lines = workflow.split(/\r?\n/);
  const steps = workflowSteps(workflow);
  const node = steps.find(step => step.text.includes('--task node-tests '));
  const setup = steps.find(step => step.text.includes('uses: actions/setup-dotnet@v4'));
  if (!node || !setup) return workflow;
  const nodeLines = lines.splice(node.start, node.end - node.start);
  const setupStart = lines.findIndex(line => line.includes('uses: actions/setup-dotnet@v4'));
  lines.splice(setupStart, 0, ...nodeLines);
  return lines.join('\n');
}

function wiringErrors({ workflow, metadata, plan, projectText, testSource }) {
  const errors = [];
  let runner;
  try { runner = require(path.join(root, 'scripts/test-tasks.js')); }
  catch (error) { return ['shared CI task runner is missing: ' + error.message]; }
  errors.push(...runner.validatePlan(plan, root));

  const taskIds = plan.tasks.map(task => task.id);
  if (JSON.stringify(runner.ciTaskIds(workflow)) !== JSON.stringify(taskIds))
    errors.push('workflow shared-task discovery/order differs from scripts/test-tasks.json');
  if (!metadata.scripts || typeof metadata.scripts.test !== 'string') errors.push('npm test entry is missing');

  const steps = workflowSteps(workflow);
  const sdkChecks = steps.filter(step => step.text.includes('name: 检查 .NET 10 SDK'));
  const dotnetSetup = steps.filter(step => step.text.includes('uses: actions/setup-dotnet@v4'));
  const nodeSteps = steps.filter(step => /node scripts\/test-tasks\.js --task node-tests(?:\s|$)/m.test(step.text));
  if (sdkChecks.length !== 1 || !sdkChecks[0].text.includes('id: sdk')
      || !sdkChecks[0].text.includes('dotnet --list-sdks') || !sdkChecks[0].text.includes('GITHUB_OUTPUT'))
    errors.push('the .NET 10 SDK probe/output step is missing or duplicated');
  else {
    const probe = sdkChecks[0].text.match(/-match\s+'([^']+)'/);
    if (!probe || probe[1] !== '^10\\.0\\.') errors.push('the SDK probe must detect the .NET 10 version line');
  }
  if (dotnetSetup.length !== 1 || !dotnetSetup[0].text.includes("if: steps.sdk.outputs.has10 != 'true'")
      || !dotnetSetup[0].text.includes("dotnet-version: '10.0.x'"))
    errors.push('conditional .NET 10 SDK installation step is missing or duplicated');
  if (nodeSteps.length !== 1) errors.push('the shared node-tests CI task must be invoked exactly once');
  if (nodeSteps.length === 1 && !nodeSteps[0].text.includes('if: always()'))
    errors.push('the shared node-tests task must not be silently skipped after a previous CI failure');
  if (sdkChecks.length === 1 && dotnetSetup.length === 1 && nodeSteps.length === 1
      && !(sdkChecks[0].start < dotnetSetup[0].start && dotnetSetup[0].start < nodeSteps[0].start))
    errors.push('.NET SDK detection and installation must precede the shared node-tests task');

  const nodeTasks = plan.tasks.filter(task => task.id === 'node-tests');
  if (nodeTasks.length !== 1) errors.push('the shared manifest must contain exactly one node-tests task');
  const nodeTask = nodeTasks[0];
  const entries = plan.tasks.flatMap(task => task.projectEntries || [])
    .filter(entry => entry.project === projectRelative || entry.entry === 'tests/refactor-t17-configuration.test.js');
  if (entries.length !== 1 || !nodeTask || nodeTask.projectEntries?.length !== 1
      || entries[0]?.project !== projectRelative || entries[0]?.entry !== 'tests/refactor-t17-configuration.test.js')
    errors.push('the Node glob must map exactly once to the T17 JsonChecks project and test entry');
  if (!nodeTask || nodeTask.commands?.length !== 1
      || JSON.stringify(nodeTask.commands[0]) !== JSON.stringify(['{node}', '--test', '--test-concurrency=4', 'tests/*.test.js']))
    errors.push('node-tests must use the existing single Node glob command');

  const compileIncludes = [...projectText.matchAll(/<Compile Include="([^"]+)"\s*\/>/g)].map(match => match[1]);
  const expectedSources = [
    'Program.cs',
    '../../../launcher/JsonRead.cs',
    '../../../launcher/ConfigSaver.cs',
    '../../../launcher/ConfigurationSaveState.cs',
    '../../../launcher/PageOperation.cs',
  ];
  if (JSON.stringify(compileIncludes) !== JSON.stringify(expectedSources))
    errors.push('JsonChecks must compile its entry and all four real T17 source files');

  if (!/runJsonChecks\(\{\s*ci:\s*Boolean\(process\.env\.CI\)/.test(testSource)
      || !/spawn\(invocation\.command,\s*invocation\.args,\s*invocation\.options\)/.test(testSource))
    errors.push('the discovered Node entry does not execute its CI-selected command');
  return errors;
}

test('T17 runs the real isolated C# regression project in CI; local SDK-less checks compile the same sources in memory', { timeout: 120000 }, () => {
  const sdk = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true });
  const native = Boolean(process.env.CI) || /^10\./m.test(sdk.stdout || '');
  const artifacts = native ? fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t17-json-')) : undefined;
  try {
    const { result } = runJsonChecks({
      ci: Boolean(process.env.CI), sdkOutput: sdk.stdout || '', rootPath: root,
      projectPath: project, artifactsPath: artifacts,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
    assert.match(result.stdout, /T17 checks: passed=\d+ failed=0/);
    process.stdout.write(result.stdout);
  } finally {
    if (artifacts) fs.rmSync(artifacts, { recursive: true, force: true });
  }
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

test('the shared integration task plan discovers one nested JsonChecks run after conditional .NET 10 setup', () => {
  const workflow = read('.github/workflows/tests.yml');
  const metadata = JSON.parse(read('package.json'));
  const plan = JSON.parse(read('scripts/test-tasks.json'));
  const projectText = read(projectRelative);
  const testSource = read('tests/refactor-t17-configuration.test.js');
  const problems = wiringErrors({ workflow, metadata, plan, projectText, testSource });
  assert.deepEqual(problems, [], problems.join('\n'));

  const ciInvocation = selectJsonChecksCommand({ ci: true, sdkOutput: '', rootPath: root,
    projectPath: project, artifactsPath: path.join(os.tmpdir(), 'unused-t17-native-check') });
  assert.deepEqual(nativeInvocationErrors(ciInvocation, project), [],
    'CI must select one native dotnet run even when SDK probing reports none');
});

test('CI wiring negative controls reject missing setup, wrong order, missing entries and native-run skips', () => {
  const workflow = read('.github/workflows/tests.yml');
  const metadata = JSON.parse(read('package.json'));
  const plan = JSON.parse(read('scripts/test-tasks.json'));
  const projectText = read(projectRelative);
  const testSource = read('tests/refactor-t17-configuration.test.js');
  const inspect = changedWorkflow => wiringErrors({ workflow: changedWorkflow, metadata, plan, projectText, testSource });

  const noInstall = removeWorkflowStep(workflow, step => step.text.includes('uses: actions/setup-dotnet@v4'));
  assert.ok(inspect(noInstall).some(error => error.includes('SDK installation')));
  const noProbe = removeWorkflowStep(workflow, step => step.text.includes('name: 检查 .NET 10 SDK'));
  assert.ok(inspect(noProbe).some(error => error.includes('SDK probe')));
  const wrongOrder = moveNodeStepBeforeDotnetSetup(workflow);
  assert.ok(inspect(wrongOrder).some(error => error.includes('must precede')));
  const noNodeEntry = removeWorkflowStep(workflow, step => step.text.includes('--task node-tests '));
  assert.ok(inspect(noNodeEntry).some(error => error.includes('shared-task discovery/order')));
  const silentlySkippedNode = workflow.replace(
    '      - name: Node 单元测试（零 npm 依赖，含 Python 桥接回归）\n        if: always()\n',
    '      - name: Node 单元测试（零 npm 依赖，含 Python 桥接回归）\n');
  assert.ok(inspect(silentlySkippedNode).some(error => error.includes('silently skipped')));

  const missingProjectPlan = structuredClone(plan);
  missingProjectPlan.tasks.find(task => task.id === 'node-tests').projectEntries[0].project =
    'tests/launcher/JsonChecks/Missing.csproj';
  assert.ok(wiringErrors({ workflow, metadata, plan: missingProjectPlan, projectText, testSource }).length > 0);
  const missingNodeMapping = structuredClone(plan);
  missingNodeMapping.tasks.find(task => task.id === 'node-tests').projectEntries = [];
  assert.ok(wiringErrors({ workflow, metadata, plan: missingNodeMapping, projectText, testSource })
    .some(error => error.includes('map exactly once')));
  const absentNodeFile = structuredClone(plan);
  absentNodeFile.tasks.find(task => task.id === 'node-tests').projectEntries[0].entry =
    'tests/refactor-t17-configuration.missing.test.js';
  assert.ok(wiringErrors({ workflow, metadata, plan: absentNodeFile, projectText, testSource }).length > 0);

  assert.ok(nativeInvocationErrors(null, project).some(error => error.includes('skip')));
  assert.ok(nativeInvocationErrors({ command: 'pwsh', args: ['-Command', 'exit 0'] }, project)
    .some(error => error.includes('dotnet')));
  assert.ok(nativeInvocationErrors({ command: 'dotnet', args: ['run', '--project', project] }, project)
    .some(error => error.includes('artifacts path')));
  const ciWithoutSdk = selectJsonChecksCommand({ ci: true, sdkOutput: '', rootPath: root,
    projectPath: project, artifactsPath: path.join(os.tmpdir(), 'unused-t17-native-check') });
  assert.equal(ciWithoutSdk.command, 'dotnet');
  assert.ok(nativeInvocationErrors({ ...ciWithoutSdk, args: ciWithoutSdk.args.filter(arg => arg !== '--project') }, project)
    .some(error => error.includes('mapped JsonChecks project')));
});
