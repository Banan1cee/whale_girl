'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
