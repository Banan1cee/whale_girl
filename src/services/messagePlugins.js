'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HOOKS = ['chat.received', 'chat.pre_reply', 'chat.prompt', 'chat.generate', 'chat.reply', 'chat.before_send', 'chat.dispatched'];
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_BYTES = 65536;
const MAX_TEXT = 16000;
const MAX_STATE = 16384;
const MAX_STATE_FILES = 200;
const MAX_CONCURRENT = 2;
const MESSAGE_BUDGET_MS = 2400;
const HOOK_BUDGET_MS = 800;
const PLUGIN_BUDGET_MS = 300;
const CACHE_MS = 500;
// 换行和制表符允许；其余控制字符、双向文本标记一律拒绝，避免插件伪造显示或污染下游。
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
// 插件可以正常回复，但不允许借宿主之手 @所有人；零宽字符和全角 @ 也一起挡住。
const MENTION_ALL = /[@＠][\s\u200B-\u200D\u2060\uFEFF]*(?:所有人|全体成员|all)(?![\p{L}\p{N}.])/iu;

const WORKER = `
let data = '';
process.stdin.setEncoding('utf8').on('data', chunk => { data += chunk; }).on('end', () => {
let guard;
try {
  const workerData = JSON.parse(data);
  // 父进程被强行结束时，子进程不能变成没人杀得掉的孤儿。
  guard = setTimeout(() => process.exit(1), Math.max(1, Number(workerData.timeoutMs) || 1000) + 250);
  const input = Buffer.from(JSON.stringify(workerData.input));
  const output = [];
  const module = new WebAssembly.Module(Buffer.from(workerData.wasm, 'base64'));
  const imports = {
    input_size: () => input.length,
    input_byte: i => input[i] ?? -1,
    output_byte: value => {
      if (!Number.isInteger(value) || value < 0 || value > 255 || output.length >= 65536) throw Error('output_limit');
      output.push(value);
    }
  };
  if (WebAssembly.Module.imports(module).some(i => i.module !== 'whale' || i.kind !== 'function' || !Object.hasOwn(imports, i.name))) throw Error('invalid_import');
  const instance = new WebAssembly.Instance(module, { whale: imports });
  if (instance.exports.run() !== 0) throw Error('invalid_exit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(output));
  process.stdout.write(JSON.stringify({ ok: true, value: JSON.parse(text) }));
  clearTimeout(guard);
} catch { clearTimeout(guard); process.exitCode = 1; }
});
`;

function execute(wasm, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, ['--wasm-max-mem-pages=16', '--wasm-max-table-size=1024',
      '--max-old-space-size=32', '--no-addons', '-e', WORKER], { windowsHide: true, env: { SystemRoot: process.env.SystemRoot || '' },
      stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.kill();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(Error('timeout')), timeoutMs);
    let output = '';
    worker.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      if (output.length > 400000) finish(Error('output_limit'));
    });
    worker.once('close', code => {
      try {
        const result = JSON.parse(output);
        finish(code === 0 && result.ok ? null : Error('invalid_output'), result.value);
      } catch { finish(Error('invalid_output')); }
    });
    worker.once('error', error => finish(error));
    worker.stdin.on('error', error => finish(error));
    worker.stdin.end(JSON.stringify({ wasm, input, timeoutMs }));
  });
}

function readJson(file, limit = 800000) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('invalid_file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class MessagePlugins {
  constructor({ dataDir, logger, executePlugin = execute, maxConcurrent = MAX_CONCURRENT,
    messageBudgetMs = MESSAGE_BUDGET_MS, hookBudgetMs = HOOK_BUDGET_MS, pluginBudgetMs = PLUGIN_BUDGET_MS }) {
    this.root = path.join(dataDir, 'plugins');
    this.logger = logger;
    this.execute = executePlugin;
    this.failedUntil = new Map();
    this.chains = new Map();
    this.budgets = new Map();
    this.cache = null;
    this.active = 0;
    this.waiters = [];
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || MAX_CONCURRENT);
    this.messageBudgetMs = Math.max(100, Number(messageBudgetMs) || MESSAGE_BUDGET_MS);
    this.hookBudgetMs = Math.max(50, Number(hookBudgetMs) || HOOK_BUDGET_MS);
    this.pluginBudgetMs = Math.max(20, Number(pluginBudgetMs) || PLUGIN_BUDGET_MS);
  }

  installed(fresh = false) {
    try {
      const parent = fs.lstatSync(path.dirname(this.root));
      if (parent.isSymbolicLink()) return [];
      const rootStat = fs.lstatSync(this.root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
      const cacheKey = rootStat.mtimeMs + ':' + rootStat.size;
      if (!fresh && this.cache && this.cache.key === cacheKey && Date.now() - this.cache.at < CACHE_MS)
        return this.cache.value;
      const value = fs.readdirSync(this.root).filter(name => name.endsWith('.flow.json')).sort().flatMap(name => {
        try {
          const id = name.slice(0, -10);
          if (!ID.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) return [];
          const flow = readJson(path.join(this.root, name));
          if (flow.id !== id || flow.api !== 3 || !Array.isArray(flow.hooks)
            || flow.hooks.length === 0 || flow.hooks.length > HOOKS.length
            || new Set(flow.hooks).size !== flow.hooks.length || flow.hooks.some(h => !HOOKS.includes(h))
            || !Array.isArray(flow.permissions)
            || flow.permissions.some(p => p !== 'chat.history' && p !== 'model.prompt')
            || typeof flow.wasm !== 'string' || flow.wasm.length > 700000) return [];
          const grant = readJson(path.join(this.root, id + '.flow-grant.json'), 8192);
          const hash = crypto.createHash('sha256').update(JSON.stringify(flow)).digest('hex');
          if (grant.hash !== hash || !grant.enabled) return [];
          return [{ ...flow, hash, grant: JSON.stringify(grant),
            settings: plainObject(grant.settings) ? grant.settings : {} }];
        } catch { return []; }
      }).slice(0, 8);
      this.cache = { key: cacheKey, at: Date.now(), value };
      return value;
    } catch { return []; }
  }

  countStateFiles(id) {
    try {
      return fs.readdirSync(this.root).filter(name =>
        name.startsWith(id + '.') && name.endsWith('.state.json')).length;
    } catch { return 0; }
  }

  async run(hook, context) {
    if (!HOOKS.includes(hook)) throw Error('unknown_hook');
    const key = String(context.key);
    const now = Date.now();
    // chat.received 是一条消息的起点；之后 prompt/generate/reply 共享同一份总预算，
    // 防止插件在 7 个钩子上各吃满 800ms，把一条消息拖到好几秒。
    if (hook === 'chat.received' || !this.budgets.has(key) || this.budgets.get(key) <= now)
      this.budgets.set(key, now + this.messageBudgetMs);
    // 每条新消息至少重扫一次目录，停用/更新不会因为缓存多跑一条消息；
    // 同一条消息的后续钩子仍可复用这次扫描结果。
    if (hook === 'chat.received') this.cache = null;
    const deadline = Math.min(now + this.hookBudgetMs, this.budgets.get(key));
    if (this.budgets.size > 1000) {
      for (const [session, until] of this.budgets) if (until <= now) this.budgets.delete(session);
    }
    const previous = this.chains.get(key) || Promise.resolve();
    const task = previous.then(() => this.dispatch(hook, context, deadline));
    const guard = task.catch(() => {});
    this.chains.set(key, guard);
    try { return await task; }
    finally {
      if (this.chains.get(key) === guard) this.chains.delete(key);
      if (hook === 'chat.dispatched') this.budgets.delete(key);
    }
  }

  async dispatch(hook, context, deadline = Date.now() + this.hookBudgetMs) {
    const result = { action: 'pass', text: context.text, system: context.system };
    for (const flow of this.installed().filter(p => p.hooks.includes(hook))) {
      if ((this.failedUntil.get(flow.id) || 0) > Date.now() || deadline - Date.now() < 40) continue;
      const granted = await this.acquire(deadline);
      if (!granted) continue;
      let temporary;
      try {
        if (deadline - Date.now() < 20) continue;
        const session = crypto.createHash('sha256').update(context.key).digest('hex');
        const stateFile = path.join(this.root, flow.id + '.' + session + '.state.json');
        let state = {};
        try { state = readJson(stateFile, MAX_STATE); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const input = { api: 3, hook, message: context.message, now: context.now || Date.now(),
          lastBot: context.lastBot, delivery: context.delivery, state, settings: flow.settings, decision: result.action,
          text: result.text, system: flow.permissions.includes('model.prompt') ? result.system : undefined,
          history: flow.permissions.includes('chat.history') ? context.history : undefined };
        if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) throw Error('input_limit');
        const output = await this.execute(flow.wasm, input,
          Math.max(1, Math.min(this.pluginBudgetMs, deadline - Date.now())));
        if (!plainObject(output)
          || Object.keys(output).some(k => !['action', 'text', 'system', 'state'].includes(k))) throw Error('invalid_output');
        if (output.action !== undefined && (hook !== 'chat.pre_reply' || !['wake', 'skip', 'pass'].includes(output.action))) throw Error('invalid_action');
        if (output.text !== undefined && (!['chat.generate', 'chat.reply', 'chat.before_send'].includes(hook)
          || typeof output.text !== 'string' || output.text.length > MAX_TEXT
          || UNSAFE_TEXT.test(output.text) || MENTION_ALL.test(output.text))) throw Error('invalid_text');
        if (output.system !== undefined && (hook !== 'chat.prompt' || !flow.permissions.includes('model.prompt')
          || typeof output.system !== 'string' || output.system.length > MAX_TEXT || UNSAFE_TEXT.test(output.system))) throw Error('invalid_system');
        if (output.state !== undefined && (!plainObject(output.state)
          || Buffer.byteLength(JSON.stringify(output.state)) > MAX_STATE)) throw Error('invalid_state');
        // 停用、更新或改权限发生在执行期间时，丢弃整个结果。这里必须重新扫盘，不能吃缓存。
        if (!this.installed(true).some(p => p.id === flow.id && p.grant === flow.grant)) continue;
        if (output.state !== undefined) {
          // 会话数量没有上限，插件不能靠给每个会话写状态把磁盘撑爆。
          if (!fs.existsSync(stateFile) && this.countStateFiles(flow.id) >= MAX_STATE_FILES) throw Error('state_limit');
          temporary = stateFile + '.' + crypto.randomUUID() + '.tmp';
          fs.writeFileSync(temporary, JSON.stringify(output.state), { flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, stateFile);
        }
        if (output.text !== undefined) result.text = output.text;
        if (output.system !== undefined) result.system = output.system;
        if (output.action && output.action !== 'pass') { result.action = output.action; break; }
      } catch (error) {
        this.failedUntil.set(flow.id, Date.now() + 30000);
        const code = error.code || (/^(invalid_[a-z_]+|input_limit|output_limit|state_limit|timeout)$/.test(error.message) ? error.message : error.name);
        this.logger?.warn?.('[plugin] id=' + flow.id + ' hook=' + hook + ' result=fallback code=' + code);
      } finally {
        if (granted) this.release();
        if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
      }
    }
    return result;
  }

  acquire(deadline) {
    if (this.active < this.maxConcurrent) { this.active += 1; return Promise.resolve(true); }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve(false);
    return new Promise(resolve => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      }, remaining);
      this.waiters.push(waiter);
    });
  }

  release() {
    const next = this.waiters.shift();
    // 排队的任务直接接管这个并发槽，active 不变；只有队列空了才释放。
    if (next) { clearTimeout(next.timer); next.resolve(true); }
    else this.active = Math.max(0, this.active - 1);
  }
}

module.exports = { MessagePlugins, execute, HOOKS };
