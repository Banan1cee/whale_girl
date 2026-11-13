'use strict';

/**
 * scripts/test-inventory.js 的自检：清单得认得 CI 真正在跑的东西，也得拒绝「看着像测试、其实没人跑」的路径。
 *
 * 起因：台账 #86 写了 `tests/launcher/Checks`，旧规则只认 `tests/*.test.js` 和
 * `tests/voice-send/*Checks.cs`，把一个**真的在 CI 里跑**的启动器检查判红；而 #68 里同样的写法
 * 从没被校验过。白名单一旦跟不上仓库，两头都错：合法的进不来，幽灵的又出不去。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const inv = require('../scripts/test-inventory.js');

const ROOT = path.resolve(__dirname, '..');
const inventory = inv.collect(ROOT);

test('CI 清单从工作流里认出三类入口：JS/Python 的 glob、C# 项目、出包自检脚本', () => {
  const globs = inventory.globs.map((g) => `${g.dir}/${g.pattern}`);
  assert.ok(globs.includes('tests/*.test.js'), `没认出 npm test 的 glob：${globs.join(' , ')}`);
  assert.ok(globs.includes('tests/test_*.py'), `没认出 unittest discover 的 pattern：${globs.join(' , ')}`);
  assert.ok(inventory.projects.has('tests/voice-send/VoiceSendChecks.csproj'), '漏了语音 C# 检查');
  assert.ok(inventory.projects.has('tests/launcher/Checks/Checks.csproj'), '漏了 test-launcher.ps1 里间接执行的启动器检查');
  assert.ok(inventory.scripts.has('scripts/release-check.js'), '漏了出包自检');
});

test('目录写法的回归入口能归约到目录里 CI 执行的项目（#86 的 tests/launcher/Checks）', () => {
  const r = inv.resolveRef('tests/launcher/Checks', inventory, ROOT);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.entry, 'tests/launcher/Checks/Checks.csproj');
});

test('JS / Python / C# 三种既有写法都认（不能因为改规则把历史行判红）', () => {
  for (const ref of ['tests/bug-ledger.test.js', 'tests/test_parent_watch.py', 'tests/voice-send/VbCableChecks.cs']) {
    const r = inv.resolveRef(ref, inventory, ROOT);
    assert.equal(r.ok, true, `${ref}：${r.reason}`);
  }
});

test('存在但 CI 不会跑的文件必须判红，否则就是幽灵引用', () => {
  const helper = inv.resolveRef('tests/helpers/bridge-source.js', inventory, ROOT);
  assert.equal(helper.ok, false, 'tests/helpers/bridge-source.js 不是测试入口，不该通过');
  assert.match(helper.reason, /不是 CI 会执行的测试入口/);
  assert.equal(inv.resolveRef('tests/不存在.test.js', inventory, ROOT).ok, false, '不存在的路径不该通过');
  assert.equal(inv.resolveRef('docs/BUGS.md', inventory, ROOT).ok, false, 'tests/ 和 scripts/ 之外的路径不该通过');
});

test('扫描工作流只看 run 块：注释里的命令和 name 字段不算入口', () => {
  const lines = inv.runCommandLines(
    [
      '      - name: 说明文字',
      '        # run: node scripts/not-real.js',
      '        run: |',
      '          npm test',
      '          ./scripts/test-launcher.ps1',
      '        with:',
      '          path: tests/whatever.test.js',
    ].join('\n')
  );
  assert.deepEqual(lines.map((l) => l.trim()), ['npm test', './scripts/test-launcher.ps1']);
});
