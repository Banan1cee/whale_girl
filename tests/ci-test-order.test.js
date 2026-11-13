'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPlan, ciTaskIds } = require('../scripts/test-tasks');

test('CI 在 Node 调用桥接回归之前安装 Python 测试依赖', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/tests.yml'), 'utf8');
  const plan = loadPlan(path.resolve(__dirname, '..'));
  const ids = ciTaskIds(workflow);
  const install = workflow.indexOf('run: python -m pip install');
  const nodeTests = workflow.indexOf('node scripts/test-tasks.js --task node-tests');
  const pythonTests = workflow.indexOf('node scripts/test-tasks.js --task python-tests');
  assert.ok(install >= 0, '桥接回归需要显式安装 Python 依赖');
  assert.ok(nodeTests >= 0 && pythonTests >= 0, 'Node 和 Python 回归都必须保留');
  assert.ok(install < nodeTests && install < pythonTests,
    'Node 也会运行 Python 桥接用例，依赖不能等到 Node 测试结束才安装');
  const command = workflow.slice(install).split(/\r?\n/)[0];
  for (const dependency of ['pillow', 'cryptography', 'requests']) {
    assert.match(command, new RegExp(`\\b${dependency}\\b`));
  }
  assert.deepEqual(ids, plan.tasks.map((task) => task.id), 'CI 必须按共同清单执行全部任务');
  const preflight = ids.indexOf('python-dependencies');
  assert.ok(preflight >= 0 && preflight < ids.indexOf('node-tests') && preflight < ids.indexOf('python-tests'),
    '本地与 CI 都必须在两组回归前核验 Python 依赖');
  const dependencyCommand = plan.tasks[preflight].commands.flat().join(' ');
  for (const module of ['PIL', 'cryptography', 'requests']) {
    assert.match(dependencyCommand, new RegExp(`\\b${module}\\b`));
  }
  const node = plan.tasks.find((task) => task.id === 'node-tests').commands.flat();
  assert.ok(node.includes('--test') && node.includes('tests/*.test.js'), 'Node 实际执行测试 glob');
  const python = plan.tasks.find((task) => task.id === 'python-tests').commands.flat();
  assert.ok(python.includes('unittest') && python.includes('discover') && python.includes('test_*.py'),
    'Python 实际执行 unittest discovery');
});
