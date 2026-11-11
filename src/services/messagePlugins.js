'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HOOKS = ['chat.received', 'chat.pre_reply', 'chat.prompt', 'chat.generate', 'chat.reply', 'chat.before_send', 'chat.dispatched'];
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_BYTES = 65536;

const WORKER = `
let data = '';
process.stdin.setEncoding('utf8').on('data', chunk => { data += chunk; }).on('end', () => {
try {
  const workerData = JSON.parse(data);
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
} catch { process.exitCode = 1; }
});
`;

function execute(wasm, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, ['--wasm-max-mem-pages=16', '--wasm-max-table-size=1024',
      '--max-old-space-size=32', '-e', WORKER], { windowsHide: true, env: { SystemRoot: process.env.SystemRoot || '' },
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
    worker.stdin.end(JSON.stringify({ wasm, input }));
  });
}

function readJson(file, limit = 800000) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('invalid_file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

class MessagePlugins {
  constructor({ dataDir, logger, executePlugin = execute }) {
    this.root = path.join(dataDir, 'plugins');
    this.logger = logger;
    this.execute = executePlugin;
    this.failedUntil = new Map();
    this.chains = new Map();
  }

  installed() {
    try {
      if (fs.lstatSync(path.dirname(this.root)).isSymbolicLink() || fs.lstatSync(this.root).isSymbolicLink()) return [];
      return fs.readdirSync(this.root).filter(name => name.endsWith('.flow.json')).sort().flatMap(name => {
        try {
          const id = name.slice(0, -10);
          if (!ID.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) return [];
          const flow = readJson(path.join(this.root, name));
          if (flow.id !== id || flow.api !== 3 || !Array.isArray(flow.hooks) || flow.hooks.some(h => !HOOKS.includes(h))
            || !Array.isArray(flow.permissions) || typeof flow.wasm !== 'string' || flow.wasm.length > 700000) return [];
          const grant = readJson(path.join(this.root, id + '.flow-grant.json'), 8192);
          const hash = crypto.createHash('sha256').update(JSON.stringify(flow)).digest('hex');
          if (grant.hash !== hash || !grant.enabled) return [];
          return [{ ...flow, hash, grant: JSON.stringify(grant), settings: grant.settings || {} }];
        } catch { return []; }
      }).slice(0, 8);
    } catch { return []; }
  }

  async run(hook, context) {
    if (!HOOKS.includes(hook)) throw Error('unknown_hook');
    const key = String(context.key);
    const previous = this.chains.get(key) || Promise.resolve();
    const task = previous.then(() => this.dispatch(hook, context));
    const guard = task.catch(() => {});
    this.chains.set(key, guard);
    try { return await task; }
    finally { if (this.chains.get(key) === guard) this.chains.delete(key); }
  }

  async dispatch(hook, context) {
    const result = { action: 'pass', text: context.text, system: context.system };
    const deadline = Date.now() + 800;
    for (const flow of this.installed().filter(p => p.hooks.includes(hook))) {
      if ((this.failedUntil.get(flow.id) || 0) > Date.now() || deadline - Date.now() < 40) continue;
      let temporary;
      try {
        const session = crypto.createHash('sha256').update(context.key).digest('hex');
        const stateFile = path.join(this.root, flow.id + '.' + session + '.state.json');
        let state = {};
        try { state = readJson(stateFile, 16384); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const input = { api: 3, hook, message: context.message, now: context.now || Date.now(),
          lastBot: context.lastBot, delivery: context.delivery, state, settings: flow.settings, decision: result.action,
          text: result.text, system: flow.permissions.includes('model.prompt') ? result.system : undefined,
          history: flow.permissions.includes('chat.history') ? context.history : undefined };
        if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) throw Error('input_limit');
        const output = await this.execute(flow.wasm, input, Math.min(300, deadline - Date.now()));
        if (!output || Array.isArray(output) || typeof output !== 'object'
          || Object.keys(output).some(k => !['action', 'text', 'system', 'state'].includes(k))) throw Error('invalid_output');
        if (output.action !== undefined && (hook !== 'chat.pre_reply' || !['wake', 'skip', 'pass'].includes(output.action))) throw Error('invalid_action');
        if (output.text !== undefined && (!['chat.generate', 'chat.reply', 'chat.before_send'].includes(hook) || typeof output.text !== 'string' || output.text.length > 16000)) throw Error('invalid_text');
        if (output.system !== undefined && (hook !== 'chat.prompt' || !flow.permissions.includes('model.prompt')
          || typeof output.system !== 'string' || output.system.length > 16000)) throw Error('invalid_system');
        if (output.state !== undefined && (!output.state || Array.isArray(output.state) || typeof output.state !== 'object'
          || Buffer.byteLength(JSON.stringify(output.state)) > 16384)) throw Error('invalid_state');
        // 停用、更新或改权限发生在执行期间时，丢弃整个结果。
        if (!this.installed().some(p => p.id === flow.id && p.grant === flow.grant)) continue;
        if (output.state !== undefined) {
          temporary = stateFile + '.' + crypto.randomUUID() + '.tmp';
          fs.writeFileSync(temporary, JSON.stringify(output.state), { flag: 'wx', mode: 0o600 });
          fs.renameSync(temporary, stateFile);
        }
        if (output.text !== undefined) result.text = output.text;
        if (output.system !== undefined) result.system = output.system;
        if (output.action && output.action !== 'pass') { result.action = output.action; break; }
      } catch (error) {
        this.failedUntil.set(flow.id, Date.now() + 30000);
        const code = error.code || (/^(invalid_[a-z_]+|input_limit|timeout)$/.test(error.message) ? error.message : error.name);
        this.logger?.warn?.('[plugin] id=' + flow.id + ' hook=' + hook + ' result=fallback code=' + code);
      } finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
    }
    return result;
  }
}

module.exports = { MessagePlugins, execute, HOOKS };
