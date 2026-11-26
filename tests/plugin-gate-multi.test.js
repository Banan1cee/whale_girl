'use strict';

/**
 * 116. gate 多插件的真实运行时用例（closure task-62 的【开·建议】）。
 *
 * 与 tests/plugin-extension-points.test.js 的单插件 gate 用例互补：这里不 mock 派发器、
 * 不 mock 运行时，插件是安装到临时 data 目录的 4 级 `whale-plugin/1` 包，由
 * UnifiedPluginRuntime 真起 `node unifiedPluginWorker.js` 子进程执行。断言只看
 * 可观察行为：每个门禁被问了几次、询问顺序、宿主 builtin 有没有拿到主人消息、
 * 最终返回的 action/payload、以及失败日志里点了谁的名。
 *
 * 覆盖的契约（src/services/unifiedCapabilityDispatcher.js）：
 * 1. gate 按插件 id 顺序逐个询问；
 * 2. 第一个非 pass 立即生效并返回，后面的 gate 不再被询问；
 * 3. 门禁自身故障（抛错 / 非法输出）按 pass 继续（fail-open），不能吞主人消息；
 * 4. 合法输出要过 validateOutput，非法字段（含 schema 之外的字段）不算生效。
 *
 * 跑法：node tests/plugin-gate-multi.test.js（零依赖、自带极简断言计数与退出码）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const { UnifiedPluginRuntime } = require('../src/services/unifiedPluginRuntime');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');

const sha256 = value => createHash('sha256').update(value).digest('hex');

const gateMessage = (text = '在吗') => ({
  platform: 'wechat', chatType: 'group', chatId: 'g1', senderId: 'u1',
  senderName: '甲', text, atMe: false, msgId: 'm1', chatTitle: '示例群',
});
const gateInput = (text = '在吗') => ({ message: gateMessage(text), localWechat: false });

/** 一套临时安装目录 + 真实运行时；每个场景单独一份，避免插件互相串台。 */
function makeEnv() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-gate-multi-'));
  const root = path.join(dataDir, 'plugins');
  const recordDir = path.join(dataDir, 'records');
  fs.mkdirSync(root);
  fs.mkdirSync(recordDir);
  return {
    dataDir, root, recordDir,
    runtime: new UnifiedPluginRuntime({ dataDir, logger: null }),
    calls: () => {
      const file = path.join(recordDir, 'calls.log');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    },
    pid: id => {
      const file = path.join(recordDir, `pid-${id}.txt`);
      return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : null;
    },
    async dispose() {
      await this.runtime.stop();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    },
  };
}

/**
 * 装一个 4 级桥接插件：清单合法、授权齐全，body 就是 provider 的真实实现。
 * 执行时先落 pid 文件（证明跑在独立子进程）再把自己的 id 追加到共享调用日志
 * （证明被询问的顺序），然后执行 body。
 */
function install(env, id, body, provides = { 'chat.pre_reply@1': { mode: 'gate', scope: 'all' } }) {
  const directory = path.join(env.root, id);
  fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
  const manifest = {
    format: 'whale-plugin/1', level: 4, id, name: 'Gate fixture', author: 'Tester',
    version: '1.0.0', minAppVersion: '1.0.0', description: 'gate multi fixture',
    appEpoch: 2, runtime: 'node-full', entry: 'plugin.js',
    provides, calls: [], dataAccess: [], executionTimeoutMs: 8000,
  };
  const raw = JSON.stringify(manifest);
  const source = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const RECORD = ${JSON.stringify(env.recordDir)};
function note() {
  fs.writeFileSync(path.join(RECORD, 'pid-${id}.txt'), String(process.pid));
  fs.appendFileSync(path.join(RECORD, 'calls.log'), '${id}\\n');
}
exports.providers = {
${Object.keys(provides).map(name => `  '${name}': async input => { note(); ${body} },`).join('\n')}
};
`;
  fs.writeFileSync(path.join(directory, 'plugin.js'), source);
  fs.writeFileSync(path.join(directory, 'plugin.json'), raw);
  fs.writeFileSync(path.join(directory, 'grant.json'), JSON.stringify({
    epoch: randomUUID(), packageHash: sha256(raw + source),
    manifestHash: sha256(raw), entryHash: sha256(source), enabled: true, level: 4,
    fullAccess: true, nodeFullConfirmed: true, chatConfirmed: true,
    approvedCalls: [], approvedProviders: Object.keys(provides), approvedDataAccess: [],
    settings: {},
  }));
  return directory;
}

/** 宿主侧：builtin 就是「宿主自己的判定」，被调用即说明主人消息没有被吞。 */
function makeDispatcher(env, { warnings = [], builtin } = {}) {
  const seen = [];
  const dispatcher = new UnifiedCapabilityDispatcher({
    plugins: env.runtime,
    logger: { warn: line => warnings.push(line), info() {} },
  });
  dispatcher.define('chat.pre_reply@1', {
    builtin: async input => {
      seen.push(input.message.text);
      return builtin ? builtin(input) : { action: 'pass' };
    },
  });
  return { dispatcher, seen };
}

let passed = 0;
const failures = [];

async function scenario(title, body) {
  const env = makeEnv();
  try {
    await body(env);
    passed++;
    console.log(`PASS  ${title}`);
  } catch (error) {
    failures.push({ title, error });
    console.log(`FAIL  ${title}`);
    for (const line of String(error && error.stack || error).split('\n').slice(0, 12)) {
      console.log('      ' + line.trim());
    }
  } finally {
    try { await env.dispose(); } catch (error) { console.log('      cleanup:', error && error.message); }
  }
}

async function main() {
  await scenario('gate 按插件 id 顺序询问，首个非 pass 立即生效，后面的 gate 不再被调用', async env => {
    install(env, 'a-pass', "return { action: 'pass' };");
    install(env, 'b-skip', "return { action: 'skip', reason: 'b-blocked' };");
    install(env, 'c-wake', "return { action: 'wake' };");
    const { dispatcher, seen } = makeDispatcher(env);

    const result = await dispatcher.invoke('chat.pre_reply@1', gateInput());

    assert.deepEqual(result, { action: 'skip', reason: 'b-blocked' },
      '返回必须就是第一个非 pass 的 payload，不能被后面的 wake 改写');
    assert.deepEqual(env.calls(), ['a-pass', 'b-skip'],
      'a 先被问、b 生效后 c 不得再被询问');
    assert.equal(env.pid('c-wake'), null, 'c-wake 的 plugin.js 根本没有执行');
    assert.deepEqual(seen, [], '有门禁生效时宿主 builtin 不参与');
  });

  await scenario('前面的 gate 抛错按 pass 继续（fail-open），主人消息仍然到达宿主 builtin', async env => {
    install(env, 'a-boom', "throw new Error('gate boom');");
    install(env, 'b-bad', "return { action: 'explode' };");
    install(env, 'c-pass', "return { action: 'pass' };");
    const warnings = [];
    const { dispatcher, seen } = makeDispatcher(env, {
      warnings,
      builtin: () => ({ action: 'pass', reason: 'host-continued' }),
    });

    const result = await dispatcher.invoke('chat.pre_reply@1', gateInput('门禁坏了也要回'));

    assert.deepEqual(result, { action: 'pass', reason: 'host-continued' },
      '一个抛错、一个非法输出之后，结论仍要来自宿主 builtin');
    assert.deepEqual(env.calls(), ['a-boom', 'b-bad', 'c-pass'], '故障门禁算 pass，后续 gate 必须继续被问');
    assert.deepEqual(seen, ['门禁坏了也要回'], '宿主拿到的仍是主人原文，消息没有被吞');
    assert.equal(warnings.length, 2, '两个故障门禁各记一条告警');
    assert.ok(warnings[0].includes('a-boom') && warnings[0].includes('plugin_error'),
      `抛错的门禁要记成 plugin_error：${warnings[0]}`);
    assert.ok(warnings[1].includes('b-bad') && warnings[1].includes('invalid_capability_output'),
      `非法 action 要记成 invalid_capability_output：${warnings[1]}`);
  });

  await scenario('gate 返回 schema 之外的字段算非法输出：不生效、不吞消息', async env => {
    install(env, 'a-leaky', "return { action: 'skip', extra: 'mine' };");
    const warnings = [];
    const { dispatcher, seen } = makeDispatcher(env, {
      warnings,
      builtin: () => ({ action: 'pass', reason: 'host-decided' }),
    });

    const result = await dispatcher.invoke('chat.pre_reply@1', gateInput('带私货的门禁'));

    assert.deepEqual(result, { action: 'pass', reason: 'host-decided' }, '非法输出不得生效');
    assert.deepEqual(seen, ['带私货的门禁'], '非法输出不得吞掉主人消息');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('invalid_capability_output'), warnings[0]);
  });

  await scenario('全部 gate 都是 pass 时结论等于宿主 builtin；只声明了别的能力的插件不参与', async env => {
    install(env, 'a-pass', "return { action: 'pass' };");
    install(env, 'b-pass', "return { action: 'pass' };");
    install(env, 'c-other', "return { ignored: true };", { 'chat.prompt@1': { mode: 'enhance', scope: 'all' } });
    const { dispatcher, seen } = makeDispatcher(env, { builtin: () => ({ action: 'pass', reason: 'host-only' }) });

    const result = await dispatcher.invoke('chat.pre_reply@1', gateInput('普通消息'));

    assert.deepEqual(result, { action: 'pass', reason: 'host-only' });
    assert.deepEqual(env.calls(), ['a-pass', 'b-pass'], 'c-other 没声明 pre_reply，不该被询问');
    assert.equal(env.pid('c-other'), null, 'c-other 的 plugin.js 不该被执行');
    assert.deepEqual(seen, ['普通消息'], '两个 pass 之后消息照常交给宿主');
  });

  await scenario('真实 worker 证据：每次询问都跑在独立子进程，执行的是安装目录里的 plugin.js', async env => {
    install(env, 'a-pass', "return { action: 'pass' };");
    install(env, 'b-skip', "return { action: 'skip' };");
    const { dispatcher } = makeDispatcher(env);

    await dispatcher.invoke('chat.pre_reply@1', gateInput());

    const first = env.pid('a-pass');
    const second = env.pid('b-skip');
    assert.ok(Number.isInteger(first) && first > 0, 'a-pass 必须留下执行进程号');
    assert.ok(Number.isInteger(second) && second > 0, 'b-skip 必须留下执行进程号');
    assert.notEqual(first, process.pid, '插件不在用例进程里跑（不是 mock 派发器）');
    assert.notEqual(second, process.pid, '插件不在用例进程里跑（不是 mock 派发器）');
    assert.notEqual(first, second, '两个插件各自是自己的 worker 子进程');
    assert.ok(fs.existsSync(path.join(env.root, 'a-pass', 'plugin.js')), '执行的是安装目录里的入口');
  });

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} / ${passed + failures.length}`);
    for (const { title } of failures) console.log('  - ' + title);
    process.exitCode = 1;
  } else {
    console.log(`OK ${passed} checks passed, 0 failed`);
    process.exitCode = 0;
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
