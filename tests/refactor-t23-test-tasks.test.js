'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const runner = path.join(ROOT, 'scripts/test-tasks.js');

test('a later successful command never replaces an earlier failed command', () => {
  if (!fs.existsSync(runner)) {
    const script = `
      $text=Get-Content -Raw -Encoding UTF8 -LiteralPath '${ROOT.replace(/'/g, "''")}/scripts/ci-local.ps1'
      $tokens=$null; $errors=$null
      $ast=[System.Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors)
      $step=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Step'},$true)
      . ([scriptblock]::Create($step.Extent.Text))
      $script:results=@()
      Step 'fixture' { & '${process.execPath.replace(/'/g, "''")}' -e 'process.exit(23)'; & '${process.execPath.replace(/'/g, "''")}' -e 'process.exit(0)' }
      Write-Output ('RECORDED_CODE='+$script:results[0].Code)
    `;
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /RECORDED_CODE=0\b/, 'Step lost the first failure');
    return;
  }
  const { runTasks } = require(runner);
  const seen = [];
  const result = runTasks({ tasks: [{ id: 'fixture', commands: [['node', 'first'], ['node', 'second']] }] }, {
    root: ROOT, platform: 'win32', spawn(file, args) { seen.push(args[0]); return { status: args[0] === 'first' ? 23 : 0 }; },
  });
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.tasks[0].status, 'error');
  assert.deepEqual(result.tasks[0].commands.map((c) => c.exitCode), [23, 0]);
});

test('local and CI use the same ordered required tasks, including every C# project', () => {
  const { loadPlan, validatePlan, ciTaskIds } = require(runner);
  const plan = loadPlan(ROOT);
  assert.deepEqual(validatePlan(plan, ROOT), []);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  assert.deepEqual(ciTaskIds(workflow), plan.tasks.map((t) => t.id));
  const local = fs.readFileSync(path.join(ROOT, 'scripts/ci-local.ps1'), 'utf8');
  assert.match(local, /scripts[\\/]test-tasks\.js/);
  assert.doesNotMatch(local, /function Step\(/);
  for (const project of ['tests/launcher/UpdateChecks/UpdateChecks.csproj',
    'tests/voice-send/VoiceSendChecks.csproj', 'tests/plugin-market/Checks.csproj',
    'tests/launcher/Checks/Checks.csproj']) {
    assert.ok(plan.tasks.some((t) => (t.projects || []).includes(project)), project);
  }
  assert.ok(plan.tasks.some((t) => t.id === 'actionlint'));
  assert.ok(plan.tasks.findIndex((t) => t.id === 'python-dependencies') < plan.tasks.findIndex((t) => t.id === 'node-tests'));
  assert.ok(plan.tasks.findIndex((t) => t.id === 'privacy') < plan.tasks.findIndex((t) => t.id === 'launcher-build'));
  assert.match(workflow, /name: 测试 \/ 分层 \/ 编译/);
  assert.match(workflow, /needs: \[checks\]/);
  assert.match(workflow, /if: always\(\)/);
  for (const task of plan.tasks) {
    const command = `run: node scripts/test-tasks.js --task ${task.id} `;
    const offset = workflow.indexOf(command);
    const step = workflow.slice(workflow.lastIndexOf('      - name:', offset), offset);
    assert.match(step, /if: always\(\)/, `${task.id} must run after a preceding failure`);
  }
});

test('missing commands, unsupported hosts and unrequested task IDs fail visibly', () => {
  const { runTasks } = require(runner);
  let calls = 0;
  const result = runTasks({ tasks: [
    { id: 'missing', commands: [['missing-tool']] },
    { id: 'windows', platform: 'win32', commands: [['do-not-run']] },
    { id: 'after', commands: [['safe']] },
  ] }, { root: ROOT, platform: 'linux', spawn(file) { calls++; return file === 'missing-tool'
    ? { error: Object.assign(new Error('missing fixture'), { code: 'ENOENT' }), status: null }
    : { status: 0 }; } });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.tasks.map((t) => t.status), ['error', 'error', 'checked']);
  assert.equal(result.tasks[0].commands[0].errorCode, 'ENOENT');
  assert.equal(calls, 2);
  assert.throws(() => runTasks({ tasks: [] }, { ids: ['unknown'] }), /unknown|未知/i);
  assert.ok(result.tasks.every((t) => t.caseExecution === 'not_observed'), 'process success is not a per-case receipt');
});

test('the explicit project list rejects newly added unlisted C# projects', () => {
  const { loadPlan, validatePlan } = require(runner);
  const plan = loadPlan(ROOT);
  const copy = JSON.parse(JSON.stringify(plan));
  copy.tasks.forEach((task) => { task.projects = []; task.buildProjects = []; });
  assert.ok(validatePlan(copy, ROOT).some((error) => error.includes('UpdateChecks.csproj')));
});

const jsonProject = 'tests/launcher/JsonChecks/JsonChecks.csproj';
const jsonEntry = 'tests/refactor-t17-configuration.test.js';
function nestedFixture({ entry = jsonEntry, projectPresent = true, entryPresent = true, declared = true,
  commands } = {}) {
  const plan = require(runner).loadPlan(ROOT);
  const nodeTask = plan.tasks.find((task) => task.id === 'node-tests');
  nodeTask.projectEntries = declared ? [{ project: jsonProject, entry }] : [];
  if (commands) nodeTask.commands = commands;
  const projectDir = path.dirname(path.join(ROOT, jsonProject));
  const launcherDir = path.join(ROOT, 'tests/launcher');
  const mockFs = { ...fs,
    existsSync(file) {
      if (path.resolve(file) === path.join(ROOT, jsonProject)) return projectPresent;
      if (path.resolve(file) === path.join(ROOT, entry)) return entryPresent;
      return fs.existsSync(file);
    },
    statSync(file) {
      if ([path.join(ROOT, jsonProject), path.join(ROOT, entry)].includes(path.resolve(file))) return { isFile: () => true };
      return fs.statSync(file);
    },
    readFileSync(file, ...args) {
      assert.notEqual(path.resolve(file), path.join(ROOT, entry), 'entry source text is not runtime evidence');
      return fs.readFileSync(file, ...args);
    },
    readdirSync(dir, options) {
      if (path.resolve(dir) === projectDir) return projectPresent
        ? [{ name: 'JsonChecks.csproj', isDirectory: () => false, isFile: () => true }] : [];
      const entries = fs.readdirSync(dir, options).filter((item) =>
        !(path.resolve(dir) === launcherDir && item.name === 'JsonChecks'));
      if (projectPresent && path.resolve(dir) === launcherDir) entries.push({ name: 'JsonChecks', isDirectory: () => true, isFile: () => false });
      return entries;
    },
  };
  const module = { exports: {} }, fromRunner = createRequire(runner);
  vm.runInNewContext(fs.readFileSync(runner, 'utf8'), { module,
    require: (id) => id === 'node:fs' ? mockFs : fromRunner(id),
    process, console, __dirname: path.dirname(runner) }, { filename: runner });
  return { plan, api: module.exports, errors: module.exports.validatePlan(plan, ROOT) };
}

test('known JsonChecks is explicitly delegated to its existing required Node entry', () => {
  const plan = require(runner).loadPlan(ROOT);
  assert.deepEqual(plan.tasks.find((task) => task.id === 'node-tests').projectEntries,
    [{ project: jsonProject, entry: jsonEntry }]);
  assert.equal(plan.tasks.some((task) => task.commands.some((command) => command.includes(jsonProject))), false,
    'do not add a second dotnet invocation to satisfy inventory');
});

test('an existing selected Node entry declares its nested C# project without source-call heuristics', () => {
  assert.deepEqual(Array.from(nestedFixture().errors), []);
});

test('delegation rules alone do not require nonexistent feature files or create execution receipts', () => {
  assert.deepEqual(Array.from(nestedFixture({ projectPresent: false, entryPresent: false }).errors), []);
});

for (const [name, options] of [
  ['undeclared project', { declared: false }],
  ['orphan project', { entryPresent: false }],
  ['entry without its project', { projectPresent: false }],
  ['entry outside the actual shallow glob', { entry: 'tests/helpers/refactor-t17-configuration.test.js' }],
  ['comment pretending to be a Node command', { commands: [['{node}', '-e', '// node --test tests/*.test.js']] }],
  ['entry supplied only as a preload', { commands: [['{node}', '--test', '--require', jsonEntry, 'tests/other*.test.js']] }],
  ['case-filtered entry', { commands: [['{node}', '--test', '--test-name-pattern=unrelated', 'tests/*.test.js']] }],
]) {
  test(`nested project declaration rejects ${name}`, () => {
    const { errors } = nestedFixture(options);
    assert.ok(errors.some((error) => error.includes('JsonChecks') || error.includes('refactor-t17-configuration')),
      Array.from(errors).join('\n'));
  });
}

test('the delegated Node task runs once and its failure remains a failure without claiming C# cases', () => {
  const { plan, api } = nestedFixture();
  const calls = [];
  const result = api.runTasks(plan, { ids: ['node-tests'], root: ROOT,
    spawn(file, args) { calls.push({ file, args }); return { status: 23 }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(Array.from(calls[0].args), ['--test', '--test-concurrency=4', 'tests/*.test.js']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.tasks[0].status, 'error');
  assert.equal(result.tasks[0].caseExecution, 'not_observed');
});
