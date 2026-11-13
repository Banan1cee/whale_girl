'use strict';

// 同一清单负责本地执行、CI 步骤与台账入口；进程成功只证明任务完成，不伪称每个 case 已执行。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nodeSelectsEntry } = require('./test-inventory');
const ROOT = path.resolve(__dirname, '..');

function loadPlan(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'scripts/test-tasks.json'), 'utf8'));
}

function ciTaskIds(workflow) {
  return [...String(workflow).matchAll(/^\s*(?:run:\s*)?node scripts\/test-tasks\.js --task ([a-z0-9-]+)(?:\s|$)/gm)].map((m) => m[1]);
}

function validatePlan(plan, root = ROOT) {
  const errors = [], ids = new Set(), listed = new Set();
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.tasks) || !plan.tasks.length) return ['invalid test task manifest'];
  for (const task of plan.tasks) {
    if (!/^[a-z0-9-]+$/.test(task.id) || ids.has(task.id)) errors.push(`invalid or duplicate task ${task.id}`);
    ids.add(task.id);
    if (!Array.isArray(task.commands) || !task.commands.length || task.commands.some((command) =>
      !Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string' || !part))) {
      errors.push(`invalid commands for ${task.id}`);
    }
    for (const project of [...(task.projects || []), ...(task.buildProjects || [])]) {
      if (!/^tests\/.+\.csproj$/.test(project) || !fs.existsSync(path.join(root, project))) errors.push(`missing project ${project}`);
      listed.add(project);
      const direct = (task.commands || []).some((command) => command.includes(project));
      const throughScript = (task.commands || []).some((command) => command.some((part) => {
        if (!/^scripts\/.+\.ps1$/.test(part)) return false;
        return fs.readFileSync(path.join(root, part), 'utf8').replace(/\\/g, '/').includes(project);
      }));
      if (!direct && !throughScript) errors.push(`project has no command declaration: ${project}`);
    }
    for (const { project, entry } of task.projectEntries || []) {
      if (![project, entry].every((value) => typeof value === 'string' && /^tests\/[\w./-]+$/.test(value) &&
        !value.split('/').some((part) => part === '.' || part === '..')) ||
        !project.endsWith('.csproj') || !entry.endsWith('.test.js')) {
        errors.push(`invalid nested project entry: ${project}`); continue;
      }
      if (!nodeSelectsEntry(task, entry)) {
        errors.push(`nested project entry not selected by required Node command: ${entry}`); continue;
      }
      const projectExists = fs.existsSync(path.join(root, project)), entryExists = fs.existsSync(path.join(root, entry));
      // 这是现存项目的归属映射，不新增执行任务。独立分支尚无两端时没有项目可枚举；
      // 一旦任意一端进入当前树，另一端必须存在，且不能靠源码文本冒充运行回执。
      if (!projectExists && !entryExists) continue;
      if (!projectExists || !entryExists || !fs.statSync(path.join(root, project)).isFile() ||
        !fs.statSync(path.join(root, entry)).isFile()) {
        errors.push(`incomplete nested project entry: ${project} -> ${entry}`); continue;
      }
      if (listed.has(project)) errors.push(`duplicate project declaration: ${project}`);
      listed.add(project);
    }
  }
  function projects(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // 这里只枚举源码项目；不把编译中间目录当成新增回归项目。
      if (entry.isDirectory() && !['bin', 'obj', '__pycache__'].includes(entry.name)) projects(path.join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.csproj')) {
        const relative = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
        if (!listed.has(relative)) errors.push(`unlisted C# project: ${relative}`);
      }
    }
  }
  projects(path.join(root, 'tests'));
  const nodeTask = plan.tasks.find((task) => task.id === 'node-tests');
  const npmTest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test;
  const npmArgs = (npmTest.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((part) => part.replace(/^(["'])(.*)\1$/, '$2'));
  const nodeArgs = nodeTask && nodeTask.commands && nodeTask.commands[0].map((part) => part === '{node}' ? 'node' : part);
  if (JSON.stringify(npmArgs) !== JSON.stringify(nodeArgs)) errors.push('npm test differs from the shared node-tests command');
  const index = (id) => plan.tasks.findIndex((task) => task.id === id);
  for (const [before, after] of [['python-dependencies', 'node-tests'], ['python-dependencies', 'python-tests'],
    ['python-test-audit', 'python-tests'], ['release-check', 'launcher-build'], ['privacy', 'launcher-build']]) {
    if (index(before) < 0 || index(after) < 0 || index(before) >= index(after)) errors.push(`required task order: ${before} before ${after}`);
  }
  return errors;
}

function runTasks(plan, { ids, root = ROOT, platform = process.platform, env = process.env,
  python = env.PYTHON || 'python', actionlint = env.ACTIONLINT_PATH || 'actionlint', spawn = spawnSync } = {}) {
  if (ids && ids.some((id) => !plan.tasks.some((task) => task.id === id))) throw new Error('unknown test task ID');
  const replacements = { node: process.execPath, python, actionlint, powershell: 'powershell' };
  const expand = (text) => text.replace(/\{(node|python|actionlint|powershell)\}/g, (_, name) => replacements[name]);
  const tasks = [];
  for (const task of plan.tasks.filter((task) => !ids || ids.includes(task.id))) {
    const row = { id: task.id, status: 'checked', caseExecution: 'not_observed', commands: [] };
    tasks.push(row);
    if (task.platform && task.platform !== platform) {
      row.status = 'error';
      row.reason = `requires ${task.platform}; current host is ${platform}`;
      continue;
    }
    for (const command of task.commands) {
      const [file, ...args] = command.map(expand);
      let result;
      try { result = spawn(file, args, { cwd: root, env: { ...env, PYTHON: python, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: 'inherit' }); }
      catch (error) { result = { error }; }
      const exitCode = Number.isInteger(result.status) ? result.status : 1;
      const receipt = { command: [file, ...args], exitCode };
      if (result.error) receipt.errorCode = result.error.code || 'SPAWN_ERROR';
      if (result.signal) receipt.signal = result.signal;
      row.commands.push(receipt);
      if (exitCode !== 0 || result.error || result.signal) row.status = 'error';
    }
  }
  return { schemaVersion: 1, tasks, exitCode: tasks.some((task) => task.status === 'error') ? 1 : 0 };
}

function main(argv) {
  let report, python, actionlint, check = false, list = false;
  const ids = [];
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === '--check') check = true;
    else if (option === '--list') list = true;
    else if (['--task', '--report', '--python', '--actionlint'].includes(option)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${option}`);
      const value = argv[++i];
      if (option === '--task') ids.push(value);
      else if (option === '--report') report = value;
      else if (option === '--python') python = value;
      else actionlint = value;
    } else throw new Error(`unknown option ${option}`);
  }
  const plan = loadPlan();
  const errors = validatePlan(plan);
  const ciIds = ciTaskIds(fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8'));
  if (JSON.stringify(ciIds) !== JSON.stringify(plan.tasks.map((task) => task.id))) errors.push('CI task IDs/order differ from the shared manifest');
  if (errors.length) throw new Error(errors.join('\n'));
  if (check || list) { console.log(JSON.stringify(list ? plan : { status: 'checked', tasks: plan.tasks.map((task) => task.id) }, null, 2)); return 0; }
  const result = runTasks(plan, { ids: ids.length ? ids : undefined, python, actionlint });
  if (report) {
    const filename = path.resolve(ROOT, report);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(result, null, 2) + '\n');
  }
  console.log(JSON.stringify(result, null, 2));
  return result.exitCode;
}

module.exports = { loadPlan, validatePlan, ciTaskIds, runTasks };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
