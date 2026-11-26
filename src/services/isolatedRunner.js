'use strict';

/**
 * 隔离执行器：把可能阻塞、崩溃或不受信任的 JS handler 放进独立 worker 线程执行。
 *
 * 为什么每次调用都新建 worker：模块级状态、未清理的定时器和全局变量都会随 worker
 * 结束一起消失，两次调用之间不会互相影响；代价是启动开销，定位是低频重任务。
 * 为什么结果只走 JSON：跨线程边界只传字符串，调用方拿不到 worker 内部对象，
 * 顺带把输出大小限制在一个可度量的口径上（UTF-8 字节）。
 *
 * 错误分类：超时 isolated_timeout、取消 capability_aborted、加载/调用失败
 * isolated_failed（保留原错误 message，截断至 200 字）、输出超限 isolated_output_limit。
 */

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_MESSAGE_CHARS = 200;
const MAX_TIMER_MS = 2147483647;

// 运行在 worker 内：只通过 workerData 拿参数，不接触调用方对象。
// require 失败、导出不是函数、调用抛错都转成 isolated_failed；输出先序列化再量字节，
// 避免把超大对象跨线程搬回主进程后才拒绝。
const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');

const OUTPUT_LIMIT_BYTES = ${MAX_OUTPUT_BYTES};
const MESSAGE_MAX_CHARS = ${MAX_MESSAGE_CHARS};

function describe(error) {
  if (error && typeof error.message === 'string') return error.message;
  return String(error);
}

function fail(code, detail) {
  parentPort.postMessage({
    ok: false,
    code,
    message: String(detail === undefined ? code : detail).slice(0, MESSAGE_MAX_CHARS),
  });
}

(async () => {
  let handler;
  try {
    const loaded = require(workerData.module);
    handler = loaded ? loaded[workerData.exportName] : undefined;
  } catch (error) {
    fail('isolated_failed', describe(error));
    return;
  }
  if (typeof handler !== 'function') {
    fail('isolated_failed', 'export ' + String(workerData.exportName) + ' is not a function');
    return;
  }
  let value;
  try {
    value = await handler(workerData.input);
  } catch (error) {
    fail('isolated_failed', describe(error));
    return;
  }
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    fail('isolated_failed', describe(error));
    return;
  }
  // JSON.stringify(undefined) 不产生字符串；统一按 null 回传，保持返回值始终是 JSON。
  if (json === undefined) json = 'null';
  if (Buffer.byteLength(json, 'utf8') > OUTPUT_LIMIT_BYTES) {
    fail('isolated_output_limit', 'isolated_output_limit');
    return;
  }
  parentPort.postMessage({ ok: true, json });
})();
`;

function failure(code, message) {
  const error = new Error(typeof message === 'string' && message ? message : code);
  error.code = code;
  return error;
}

function truncateMessage(value) {
  return String(value).slice(0, MAX_MESSAGE_CHARS);
}

// 相对路径/包名按调用进程的工作目录解析；解析不到也交给 worker 报加载错误，
// 这样“模块不存在”和“模块加载时抛错”会走同一条 isolated_failed 通道。
function resolveModule(request) {
  if (typeof request !== 'string' || !request) {
    throw failure('isolated_failed', 'module must be a non-empty string');
  }
  if (path.isAbsolute(request)) return request;
  try {
    return require.resolve(request, { paths: [process.cwd()] });
  } catch {
    return path.resolve(process.cwd(), request);
  }
}

async function runIsolated({ module, exportName, input, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  if (signal?.aborted) throw failure('capability_aborted');
  if (typeof exportName !== 'string' || !exportName) {
    throw failure('isolated_failed', 'exportName must be a non-empty string');
  }
  const moduleId = resolveModule(module);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, MAX_TIMER_MS)
    : DEFAULT_TIMEOUT_MS;

  let worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { module: moduleId, exportName, input },
    });
  } catch (error) {
    // 例如 input 无法结构化克隆：启动失败同样按加载失败处理。
    throw failure('isolated_failed', truncateMessage(error?.message || error));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const settle = (action, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
      // onmessage 必须在 settle 时摘掉；error/exit 监听保留但内部用 settled 守卫，
      // 否则 terminate 之后迟到的 error 事件会因没有监听而变成未捕获异常。
      worker.removeListener('message', onMessage);
      // 先交付结果再异步终止；terminate 的 Promise 必须消费，避免未处理拒绝。
      worker.terminate().catch(() => {});
      action(value);
    };

    const onMessage = message => {
      if (settled) return;
      if (!message || typeof message !== 'object') {
        settle(reject, failure('isolated_failed', 'invalid worker message'));
        return;
      }
      if (message.ok === true) {
        let value;
        try {
          value = JSON.parse(message.json);
        } catch (error) {
          settle(reject, failure('isolated_failed', truncateMessage(error?.message || error)));
          return;
        }
        settle(resolve, value);
        return;
      }
      if (message.code === 'isolated_output_limit') {
        settle(reject, failure('isolated_output_limit'));
        return;
      }
      settle(reject, failure('isolated_failed', truncateMessage(message.message || 'isolated_failed')));
    };

    const onError = error => {
      if (!settled) settle(reject, failure('isolated_failed', truncateMessage(error?.message || error)));
    };
    const onExit = code => {
      if (!settled) settle(reject, failure('isolated_failed', `worker exited with code ${code}`));
    };
    const onAbort = () => settle(reject, failure('capability_aborted'));

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => settle(reject, failure('isolated_timeout')), timeout);
  });
}

module.exports = { runIsolated };
