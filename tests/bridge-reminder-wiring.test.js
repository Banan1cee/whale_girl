'use strict';

/**
 * 桥接启动接线回归（Node 侧，与 tests/test_engine_reminder_wiring.py 互补）。
 *
 * 4.0 故障：`main()` 里定义了一个无参的同名 `start_reminder_watch`（闭包版），
 * 遮蔽了模块顶部从 `reminder_watch` 导入的那个；调用处仍按模块级签名传 6 个
 * 关键字参数 → 桥接启动末尾必抛 TypeError，进程 code=1，启动器不会拉起。
 *
 * 保留调用形态检查，并运行隔离的真实组合类行为回归；不导入有副作用的 engine。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const src = require('./helpers/bridge-source');

test('桥接启动保留无参 start_reminder_watch 与可停止的实例', () => {
  assert.match(src, /def start_reminder_watch\(\):/, 'main() 里的无参闭包版不见了');
  assert.match(
    src,
    /REMINDER_RUNNER\s*=\s*start_reminder_watch\(\)/,
    '启动处应无参调用闭包版并把实例存进 REMINDER_RUNNER',
  );
  const app = fs.readFileSync(path.join(root, 'bridge/app.py'), 'utf8');
  assert.match(app, /G\.REMINDER_RUNNER\.stop\(\)/, '退出必须停止实际启动的调度器');
});

test('实际 app 装配通过群@、身份、错误回执、权限与 shutdown 行为回归', () => {
  assert.match(src, /from reminder_watch import start_reminder_watch/, '模块顶部导入丢了');
  const bundled = path.join(root, 'runtime/python/python.exe');
  const python = process.env.WHALE_TEST_PYTHON || (fs.existsSync(bundled) ? bundled : 'python');
  const output = execFileSync(python,
    ['-B', path.join(root, 'tests/test_engine_reminder_wiring.py'), 'ActualRuntimeReminderTests'], {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  assert.equal(typeof output, 'string');
});
