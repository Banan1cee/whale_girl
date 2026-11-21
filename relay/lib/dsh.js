'use strict';

/**
 * relay/lib/dsh.js —— 只负责“跑一轮 DSH”，不包含任何业务概念。
 *
 * 前台/worker 的分工、订单状态都在 relay.js 里；这里只做三件容易踩坑的事：
 * 1) 找到可用的 dsh CLI（本机没有全局 dsh，只能拿 Electron 当 Node 跑 asar 里的 bin.js）；
 * 2) 每轮一个进程，prompt 走 stdin，结果从 NDJSON 事件里取；
 * 3) 超时/异常都收敛成返回值，绝不因为子进程问题把调用方拖崩。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';

// 契约第 5 节里 desktop 版的默认安装位置；仅作为探测兜底，不写死在调用方。
const DEFAULT_ELECTRON = 'D:/DeepSeek Harness/DeepSeek Harness.exe';
const DEFAULT_BIN = 'D:/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';

const DEFAULT_TIMEOUT_MS = 180000;
// stderr 只保留尾部用于报告失败原因；不能无限增长，否则 worker 长任务会把内存吃掉。
const STDERR_TAIL_CHARS = 8000;
// taskkill 之后 close 理论上会来；留一个兜底，避免杀进程失败时 Promise 永久 pending。
const CLOSE_GRACE_MS = 5000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * app.asar 内部的文件用普通 Node 的 fs 看不见（只有 Electron 的 asar 补丁认得）。
 * 因此探测时退一步检查 asar 容器本身是否存在：容器在、路径拼对了，就能交给 Electron 跑。
 */
function isReachableFile(filePath) {
  if (!filePath) return false;
  const marker = filePath.toLowerCase().indexOf('.asar/');
  if (marker === -1) return fs.existsSync(filePath);
  return fs.existsSync(filePath.slice(0, marker + '.asar'.length));
}

function findOnPath(name) {
  const lookup = IS_WIN ? 'where' : 'which';
  const found = spawnSync(lookup, [name], { encoding: 'utf8', windowsHide: true });
  if (found.error || found.status !== 0 || !found.stdout) return null;
  const first = found.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first || null;
}

function looksLikeShellWrapper(command) {
  return IS_WIN && /\.(cmd|bat)$/i.test(command);
}

function notFoundMessage(details) {
  return [
    '找不到可用的 dsh CLI，relay 无法启动任何 AI 轮次。',
    ...details,
    '修复办法（任选一条）：',
    '  1. 在 relay/config.json 的 dsh 段填写 command（dsh 可执行文件），或同时填写 electronPath + binPath；',
    '  2. 安装 dsh 并确保它在 PATH 上；',
    '  3. 安装 DeepSeek Harness 桌面端（默认探测 ' + DEFAULT_ELECTRON + '）。',
  ].join('\n');
}

/**
 * 解析 dsh CLI 的启动方式。
 *
 * @param {object} [configDsh] relay/config 里的 dsh 段：{ command, electronPath, binPath }
 * @returns {{command: string, args: string[], source: string, electron: boolean, shell?: boolean}}
 */
function resolveDsh(configDsh) {
  const cfg = configDsh && typeof configDsh === 'object' ? configDsh : {};

  // 1) 显式 command：可执行文件本身。若同时给了 binPath，说明 command 是 Electron，后面跟 asar 内的脚本。
  const configuredCommand = nonEmptyString(cfg.command);
  if (configuredCommand) {
    const binPath = nonEmptyString(cfg.binPath);
    return {
      command: configuredCommand,
      args: binPath ? [binPath] : [],
      source: 'config.command',
      electron: Boolean(binPath),
      shell: looksLikeShellWrapper(configuredCommand),
    };
  }

  // 2) 显式 electronPath + binPath：缺一项就用桌面端默认位置补齐。
  if (nonEmptyString(cfg.electronPath) || nonEmptyString(cfg.binPath)) {
    const electronPath = nonEmptyString(cfg.electronPath) || DEFAULT_ELECTRON;
    const binPath = nonEmptyString(cfg.binPath) || DEFAULT_BIN;
    if (!fs.existsSync(electronPath)) {
      throw new Error(notFoundMessage(['  - 配置的 electronPath 不存在：' + electronPath]));
    }
    if (!isReachableFile(binPath)) {
      throw new Error(
        notFoundMessage(['  - 配置的 binPath 不存在（asar 内路径需保证 app.asar 本身存在）：' + binPath])
      );
    }
    return { command: electronPath, args: [binPath], source: 'config.electron', electron: true };
  }

  // 3) 环境变量覆盖（方便 systemd / 容器里不写配置文件）。
  const envCommand = nonEmptyString(process.env.RELAY_DSH_COMMAND);
  if (envCommand) {
    const envBin = nonEmptyString(process.env.RELAY_DSH_BIN);
    return {
      command: envCommand,
      args: envBin ? [envBin] : [],
      source: 'env.command',
      electron: Boolean(envBin),
      shell: looksLikeShellWrapper(envCommand),
    };
  }
  const envElectron = nonEmptyString(process.env.RELAY_DSH_ELECTRON);
  const envBin = nonEmptyString(process.env.RELAY_DSH_BIN);
  if (envElectron || envBin) {
    const electronPath = envElectron || DEFAULT_ELECTRON;
    const binPath = envBin || DEFAULT_BIN;
    if (!fs.existsSync(electronPath)) {
      throw new Error(notFoundMessage(['  - 环境变量 RELAY_DSH_ELECTRON 指向的文件不存在：' + electronPath]));
    }
    if (!isReachableFile(binPath)) {
      throw new Error(notFoundMessage(['  - 环境变量 RELAY_DSH_BIN 指向的脚本不存在：' + binPath]));
    }
    return { command: electronPath, args: [binPath], source: 'env.electron', electron: true };
  }

  // 4) PATH 上的 dsh 优先于桌面端兜底（用户自己装了 CLI 就以他的为准）。
  const onPath = findOnPath('dsh');
  if (onPath) {
    return { command: onPath, args: [], source: 'path', electron: false, shell: looksLikeShellWrapper(onPath) };
  }

  // 5) 桌面端默认安装位置。
  if (fs.existsSync(DEFAULT_ELECTRON) && isReachableFile(DEFAULT_BIN)) {
    return { command: DEFAULT_ELECTRON, args: [DEFAULT_BIN], source: 'electron-asar', electron: true };
  }

  throw new Error(
    notFoundMessage([
      '  - config.dsh.command 为空',
      '  - PATH 上没有 dsh（where dsh 未找到）',
      '  - 默认 Electron 探测失败：' + DEFAULT_ELECTRON,
      '  - 默认 bin.js 探测失败：' + DEFAULT_BIN,
    ])
  );
}

function normalizeAddDirs(addDirs) {
  if (!Array.isArray(addDirs)) return [];
  return addDirs
    .filter((dir) => typeof dir === 'string' && dir.trim() !== '')
    .map((dir) => path.resolve(dir));
}

/** final.reason 的形状由 dsh 决定；这里只提取人能看懂的一小段，不假设具体错误结构。 */
function describeReason(reason) {
  if (!reason || typeof reason !== 'object') return '无 reason';
  if (reason.kind === 'error' && reason.error && typeof reason.error === 'object') {
    const code = reason.error.code ? String(reason.error.code) : 'unknown';
    const message = reason.error.message ? String(reason.error.message) : '';
    return code + (message ? ': ' + message : '');
  }
  const message = reason.message ? String(reason.message) : '';
  return String(reason.kind || 'unknown') + (message ? ': ' + message : '');
}

function tailText(text, limit) {
  if (!text) return '';
  return text.length > limit ? text.slice(-limit) : text;
}

/** Windows 上只杀直接子进程会留下孙进程，必须 taskkill /T 整棵树。 */
function killProcessTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      /* taskkill 自己失败也只能继续收尾，不能让 runTurn 抛错 */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 进程可能已经退出 */
    }
  }
}

/**
 * 跑一轮 dsh headless。
 *
 * opts.command / opts.argsPrefix 是测试注入用的契约偏离（CONTRACT 第 4 节）：
 * 给了 command 就完全跳过 resolveDsh，argsPrefix 作为命令前缀参数（例如 [fake-cli.js]）。
 * opts.dsh 可透传 config 的 dsh 段；不传则按默认探测。
 *
 * 永不 reject：找不到 CLI、spawn 失败、非 0 退出、超时都折成 ok:false。
 *
 * @param {object} opts
 * @returns {Promise<{ok:boolean, sessionId:string|null, text:string, reason:object|null,
 *   events:object[], timedOut:boolean, durationMs:number, stderrTail:string, error:string|null}>}
 */
async function runTurn(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  if (!nonEmptyString(options.cwd)) throw new TypeError('runTurn: cwd 必填（string）');
  if (typeof options.prompt !== 'string' || options.prompt.trim() === '') {
    throw new TypeError('runTurn: prompt 必填（非空 string）');
  }

  const startedAt = Date.now();
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  // 结果只在 finish 里组装一次，避免多处重复判定导致口径漂移。
  const state = {
    events: [],
    discoveredSessionId: null,
    finalEvent: null,
    invalidLines: 0,
    lastErrorEvent: null,
    timedOut: false,
    spawnError: null,
    processExited: false,
    exitCode: null,
    exitSignal: null,
  };
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let settled = false;
  let resolveTurn = null;
  let timeoutTimer = null;
  let killGraceTimer = null;
  let child = null;
  let commandForError = '';

  const baseResult = (extra) =>
    Object.assign(
      {
        ok: false,
        sessionId: null,
        text: '',
        reason: null,
        events: state.events,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stderrTail: '',
        error: null,
      },
      extra
    );

  // 1) 解析 CLI；解析失败（CLI 没装/配置写错）也不 reject，让 relay 能优雅回话。
  let resolved;
  try {
    if (nonEmptyString(options.command)) {
      resolved = {
        command: options.command,
        args: Array.isArray(options.argsPrefix) ? options.argsPrefix.map((arg) => String(arg)) : [],
        source: 'opts.command',
        electron: false,
        shell: looksLikeShellWrapper(options.command),
      };
    } else {
      resolved = resolveDsh(options.dsh);
    }
  } catch (error) {
    return baseResult({ error: error instanceof Error ? error.message : String(error) });
  }

  commandForError = resolved.command;
  const args = [...resolved.args, 'headless', '--json'];
  if (nonEmptyString(options.sessionId)) args.push('--session-id', options.sessionId);
  if (nonEmptyString(options.permissionMode)) args.push('--permission-mode', options.permissionMode);
  if (nonEmptyString(options.approvalPolicy)) args.push('--approval-policy', options.approvalPolicy);
  for (const dir of normalizeAddDirs(options.addDirs)) args.push('--add-dir', dir);
  args.push('-');

  // 凭据从调用方 env 传入；Key 不进命令行，避免出现在进程列表里。
  const env = Object.assign({}, process.env, options.env && typeof options.env === 'object' ? options.env : {});
  if (resolved.electron && env.ELECTRON_RUN_AS_NODE === undefined) env.ELECTRON_RUN_AS_NODE = '1';

  // 2) 逐行解析 NDJSON。非法行只计数并丢弃，不能让一行脏输出毁掉整轮。
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      state.invalidLines += 1;
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      state.invalidLines += 1;
      return;
    }
    state.events.push(event);
    if (event.type === 'session' && typeof event.sessionId === 'string' && event.sessionId !== '') {
      state.discoveredSessionId = event.sessionId;
    }
    if (event.type === 'final') state.finalEvent = event;
    if (event.type === 'error') state.lastErrorEvent = event;
    if (typeof options.onEvent === 'function') {
      try {
        options.onEvent(event);
      } catch {
        /* 观察者的错误不该影响这一轮的结果 */
      }
    }
  };

  const drainStdout = () => {
    let newline = stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      handleLine(stdoutBuffer.slice(0, newline));
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf('\n');
    }
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killGraceTimer) clearTimeout(killGraceTimer);
    // 退出前把缓冲区里最后一行（无换行结尾）也解析掉。
    if (stdoutBuffer !== '') {
      handleLine(stdoutBuffer);
      stdoutBuffer = '';
    }
    const result = buildResult();
    if (resolveTurn) resolveTurn(result);
  };

  function buildResult() {
    const reason =
      state.finalEvent && state.finalEvent.reason && typeof state.finalEvent.reason === 'object'
        ? state.finalEvent.reason
        : null;
    const ok =
      state.processExited &&
      state.exitCode === 0 &&
      !state.timedOut &&
      !state.spawnError &&
      Boolean(reason) &&
      reason.kind === 'completed';
    const text = state.finalEvent && typeof state.finalEvent.text === 'string' ? state.finalEvent.text.trim() : '';
    const stderrTail = tailText(stderrBuffer, STDERR_TAIL_CHARS);
    let error = ok ? null : describeFailure(reason, stderrTail);
    // 脏 stdout 不改变成功判定，但失败时必须能看出“是不是被垃圾输出误导了”。
    if (error && state.invalidLines > 0) error += '（另忽略了 ' + state.invalidLines + ' 行非 JSON stdout）';
    return baseResult({
      ok,
      sessionId: state.discoveredSessionId || nonEmptyString(options.sessionId) || null,
      text,
      reason,
      timedOut: state.timedOut,
      stderrTail,
      error,
    });
  }

  function describeFailure(reason, stderrTail) {
    if (state.timedOut) return 'dsh 超时（' + timeoutMs + 'ms），已终止进程树';
    if (state.spawnError) {
      return '无法启动 dsh：' + (state.spawnError.message || String(state.spawnError)) + '（' + commandForError + '）';
    }
    const stderrSuffix = () => {
      const tail = tailText(stderrTail.trim(), 500);
      return tail ? '；stderr 末尾：' + tail : '';
    };
    // 有 final.reason 时优先报 reason：真实 dsh 的业务失败也走 exit 1，
    // 只报退出码会丢掉 error.code/message，调用方无法归因。
    if (state.finalEvent && reason && reason.kind !== 'completed') {
      const exitPart = state.exitCode !== 0 ? '（退出码 ' + state.exitCode + '）' : '';
      return 'dsh 未完成（reason.kind=' + String(reason.kind) + '）' + exitPart + '：' + describeReason(reason) + stderrSuffix();
    }
    if (state.exitCode !== 0) {
      const signalPart = state.exitSignal ? '（信号 ' + state.exitSignal + '）' : '';
      return 'dsh 退出码 ' + state.exitCode + signalPart + stderrSuffix();
    }
    if (!state.finalEvent) {
      const hint = state.lastErrorEvent && state.lastErrorEvent.message ? '：' + state.lastErrorEvent.message : '';
      return 'dsh 退出码 0，但没有输出 final 事件' + hint;
    }
    if (!reason) return 'dsh 的 final 事件缺少 reason';
    return 'dsh 结果判定失败';
  }

  // 3) 启动子进程。--json 下正文只走 stdout，stderr 只当诊断尾巴。
  try {
    child = spawn(resolved.command, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: resolved.shell === true,
    });
  } catch (error) {
    return baseResult({
      error: '无法启动 dsh：' + (error instanceof Error ? error.message : String(error)) + '（' + resolved.command + '）',
    });
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    drainStdout();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
    // 长任务不要攒 stderr，保留尾部即可。
    if (stderrBuffer.length > STDERR_TAIL_CHARS * 2) stderrBuffer = stderrBuffer.slice(-STDERR_TAIL_CHARS);
  });
  child.on('error', (error) => {
    state.spawnError = error;
    finish();
  });
  child.on('close', (code, signal) => {
    state.processExited = true;
    state.exitCode = code;
    state.exitSignal = signal;
    finish();
  });

  // stdin 写失败（子进程已退出）时不要抛未捕获错误。
  child.stdin.on('error', () => {});
  try {
    child.stdin.end(options.prompt);
  } catch {
    /* 交给 close/error 事件收敛 */
  }

  timeoutTimer = setTimeout(() => {
    state.timedOut = true;
    killProcessTree(child.pid);
    // 极端情况下 taskkill 没触发 close：兜底结束这一轮。
    killGraceTimer = setTimeout(() => finish(), CLOSE_GRACE_MS);
    if (killGraceTimer.unref) killGraceTimer.unref();
  }, timeoutMs);

  return new Promise((resolve) => {
    resolveTurn = resolve;
    if (settled) resolve(buildResult());
  });
}

module.exports = {
  resolveDsh,
  runTurn,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_ELECTRON,
  DEFAULT_BIN,
};
