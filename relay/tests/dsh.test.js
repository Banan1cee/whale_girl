'use strict';

/**
 * relay/tests/dsh.test.js —— 驱动层测试。
 *
 * 全部走 relay/tests/fixtures/fake-dsh.js，不联网、不需要 API Key。
 * 通过 runTurn 的 opts.command / opts.argsPrefix（契约允许的测试注入偏离）替换真实 CLI。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveDsh, runTurn } = require('../lib/dsh.js');

const FAKE_DSH = path.join(__dirname, 'fixtures', 'fake-dsh.js');
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dsh-test-'));
const PROMPT = '这是一条测试提示，请原样走 stdin。';

let captureSeq = 0;
function nextCapturePath() {
  captureSeq += 1;
  return path.join(WORK_DIR, 'capture-' + captureSeq + '.json');
}

function readCapture(capturePath) {
  return JSON.parse(fs.readFileSync(capturePath, 'utf8'));
}

/** 统一入口：假 CLI + 临时 capture 文件，快的分支超时给足，慢的超时单独传。 */
function runFake(scenario, extra) {
  const options = extra || {};
  const capturePath = nextCapturePath();
  const env = Object.assign(
    {
      FAKE_DSH_SCENARIO: scenario,
      FAKE_DSH_CAPTURE: capturePath,
    },
    options.env || {}
  );
  return runTurn(
    Object.assign(
      {
        command: process.execPath,
        argsPrefix: [FAKE_DSH],
        cwd: WORK_DIR,
        prompt: PROMPT,
        timeoutMs: 15000,
        env,
      },
      options.run || {}
    )
  ).then((result) => Object.assign(result, { capturePath, capture: readCapture(capturePath) }));
}

function realPathKey(p) {
  try {
    return fs.realpathSync.native(p).toLowerCase();
  } catch {
    return path.resolve(p).toLowerCase();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (process.platform === 'win32') {
    const listed = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (listed.error) throw listed.error;
    return String(listed.stdout || '').includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------- resolveDsh

test('resolveDsh: 显式 command 原样返回，不带额外参数', () => {
  const resolved = resolveDsh({ command: 'dsh-under-test' });
  assert.strictEqual(resolved.command, 'dsh-under-test');
  assert.deepStrictEqual(resolved.args, []);
  assert.strictEqual(resolved.source, 'config.command');
  assert.strictEqual(resolved.electron, false);
});

test('resolveDsh: electronPath + binPath 组合成 Electron 跑脚本的形态', () => {
  const resolved = resolveDsh({ electronPath: process.execPath, binPath: FAKE_DSH });
  assert.strictEqual(resolved.command, process.execPath);
  assert.deepStrictEqual(resolved.args, [FAKE_DSH]);
  assert.strictEqual(resolved.electron, true);
  assert.strictEqual(resolved.source, 'config.electron');
});

test('resolveDsh: 配置指向不存在的文件时报错必须可操作', () => {
  assert.throws(
    () => resolveDsh({ electronPath: path.join(WORK_DIR, 'missing-electron.exe'), binPath: FAKE_DSH }),
    /electronPath[\s\S]*relay\/config\.json|relay\/config\.json[\s\S]*electronPath/
  );
  assert.throws(
    () => resolveDsh({ electronPath: process.execPath, binPath: path.join(WORK_DIR, 'missing-bin.js') }),
    /binPath[\s\S]*relay\/config\.json|relay\/config\.json[\s\S]*binPath/
  );
});

test('resolveDsh: 环境变量指定的 Electron 不存在时不静默退回 PATH', () => {
  const previous = process.env.RELAY_DSH_ELECTRON;
  process.env.RELAY_DSH_ELECTRON = path.join(WORK_DIR, 'missing-env-electron.exe');
  try {
    assert.throws(() => resolveDsh({}), /RELAY_DSH_ELECTRON/);
  } finally {
    if (previous === undefined) delete process.env.RELAY_DSH_ELECTRON;
    else process.env.RELAY_DSH_ELECTRON = previous;
  }
});

// ---------------------------------------------------------------- 正常路径

test('新 session: 从 session 事件抓到 id，prompt 走 stdin，argv 带 --json 与 -', async () => {
  const seen = [];
  const result = await runFake('ok', { run: { onEvent: (event) => seen.push(event) } });

  assert.strictEqual(result.ok, true, '应成功: ' + result.error);
  assert.strictEqual(result.sessionId, 'session-fake-new');
  assert.strictEqual(result.text, '收到，这是假 CLI 的回复。');
  assert.strictEqual(result.reason.kind, 'completed');
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.error, null);
  assert.ok(result.durationMs > 0);

  const types = result.events.map((event) => event.type);
  assert.ok(types.includes('session'));
  assert.ok(types.includes('text'));
  assert.strictEqual(result.events[result.events.length - 1].type, 'final');
  assert.strictEqual(seen.length, result.events.length, 'onEvent 应逐行回调每个事件');

  assert.strictEqual(result.capture.stdin, PROMPT, 'prompt 必须原样走 stdin');
  assert.deepStrictEqual(result.capture.argv.slice(0, 3), ['headless', '--json', '-']);
  assert.strictEqual(result.capture.argv.includes('--session-id'), false, '新 session 不能传 --session-id');
  assert.strictEqual(realPathKey(result.capture.cwd), realPathKey(WORK_DIR), '子进程 cwd 必须是工作区');
});

test('续接 session: --session-id 原样传给 CLI，返回值沿用同一个 id', async () => {
  const result = await runFake('resume', { run: { sessionId: 'session-fake-resume' } });

  assert.strictEqual(result.ok, true, '应成功: ' + result.error);
  assert.strictEqual(result.sessionId, 'session-fake-resume');
  const index = result.capture.argv.indexOf('--session-id');
  assert.ok(index !== -1, 'argv 应包含 --session-id');
  assert.strictEqual(result.capture.argv[index + 1], 'session-fake-resume');
});

test('permissionMode / approvalPolicy / addDirs 都翻译成 CLI 参数', async () => {
  const result = await runFake('ok', {
    run: { permissionMode: 'read-only', approvalPolicy: 'never', addDirs: [WORK_DIR] },
  });

  assert.strictEqual(result.ok, true, '应成功: ' + result.error);
  const argv = result.capture.argv;
  const flagValue = (flag) => argv[argv.indexOf(flag) + 1];
  assert.strictEqual(flagValue('--permission-mode'), 'read-only');
  assert.strictEqual(flagValue('--approval-policy'), 'never');
  assert.strictEqual(realPathKey(flagValue('--add-dir')), realPathKey(WORK_DIR));
});

test('opts.env 会合并进子进程环境', async () => {
  const result = await runFake('ok', { env: { FAKE_DSH_TAG: 'tag-42' } });
  assert.strictEqual(result.ok, true, '应成功: ' + result.error);
  assert.strictEqual(result.capture.tag, 'tag-42');
});

// ---------------------------------------------------------------- 失败判定

test('final.reason.kind=error: 返回 ok:false 且不抛异常', async () => {
  const result = await runFake('fail');

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.reason.kind, 'error');
  assert.match(result.error, /fake\/llm-error/);
  assert.match(result.error, /模拟失败/);
});

test('进程非 0 退出: ok:false，错误里带退出码与 stderr 尾部', async () => {
  const result = await runFake('exit3');

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /退出码 3/);
  assert.match(result.stderrTail, /模拟崩溃/);
});

test('exit 0 但没有 final: ok:false 而不是误判成功', async () => {
  const result = await runFake('nofinal');

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /没有输出 final/);
  assert.strictEqual(result.sessionId, 'session-fake-new');
});

test('json 模式下的 error 事件 + 非 0 退出: ok:false 可诊断', async () => {
  const result = await runFake('errorline');

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /退出码 1/);
  assert.ok(result.events.some((event) => event.type === 'error'));
  assert.match(result.stderrTail, /unknown session/);
});

// ---------------------------------------------------------------- 脏 stdout

test('非法 JSON 行与 stderr 噪音不影响成功判定', async () => {
  const result = await runFake('dirty');

  assert.strictEqual(result.ok, true, '脏输出不应改变成功判定: ' + result.error);
  assert.strictEqual(result.text, '脏输出之后仍然成功');
  const types = result.events.map((event) => event.type);
  assert.ok(types.includes('session'));
  assert.ok(types.includes('final'));
  assert.match(result.stderrTail, /harmless stderr noise/);
});

// ---------------------------------------------------------------- 超时杀树

test('timeoutMs 到点: timedOut=true、杀整棵进程树、不抛异常', async () => {
  const childPidFile = path.join(WORK_DIR, 'grandchild.pid');
  const childPidPath = childPidFile;
  let grandchildPid = null;
  try {
    const result = await runFake('hang', {
      env: { FAKE_DSH_CHILD_PID: childPidPath },
      run: { timeoutMs: 800 },
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.timedOut, true);
    assert.match(result.error, /超时/);
    assert.ok(result.durationMs >= 700, '应等到超时时间：' + result.durationMs);
    assert.ok(result.durationMs < 10000, '超时后应尽快返回：' + result.durationMs);

    grandchildPid = Number(fs.readFileSync(childPidPath, 'utf8'));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, '假 CLI 应记录孙进程 pid');
    assert.ok(
      await waitForPidGone(grandchildPid, 5000),
      'taskkill /T 之后孙进程必须消失，pid=' + grandchildPid
    );
  } finally {
    // 极端失败时别把测试机上的假进程留下。
    if (grandchildPid && isPidAlive(grandchildPid)) {
      spawnSync('taskkill', ['/PID', String(grandchildPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  }
});

// ---------------------------------------------------------------- 启动失败

test('CLI 不存在: spawn 失败折成 ok:false，不 reject', async () => {
  const result = await runTurn({
    command: 'definitely-not-a-real-dsh-command-xyz',
    cwd: WORK_DIR,
    prompt: PROMPT,
    timeoutMs: 3000,
  });

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /无法启动 dsh/);
  assert.strictEqual(result.timedOut, false);
});

// ---------------------------------------------------------------- runner

async function main() {
  const startedAt = Date.now();
  let failed = 0;
  for (const entry of tests) {
    const testStartedAt = Date.now();
    try {
      await entry.fn();
      console.log('PASS ' + entry.name + ' (' + (Date.now() - testStartedAt) + 'ms)');
    } catch (error) {
      failed += 1;
      console.error('FAIL ' + entry.name + ' (' + (Date.now() - testStartedAt) + 'ms)');
      console.error(error && error.stack ? error.stack : String(error));
    }
  }
  try {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响判定 */
  }
  const durationMs = Date.now() - startedAt;
  if (failed === 0) {
    console.log('PASS all ' + tests.length + ' tests in ' + durationMs + 'ms');
  } else {
    console.error('FAIL ' + failed + '/' + tests.length + ' tests failed in ' + durationMs + 'ms');
    process.exitCode = 1;
  }
}

main();
