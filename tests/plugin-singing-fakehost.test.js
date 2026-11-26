'use strict';

/**
 * 116. 翻唱插件的最小 fake-host 用例（closure task-77 的【开·建议】）。
 *
 * 市场仓库里 breeze-sing / breezeblue-sing 是 4 级 `node-full` 插件，README 的降级写得很直白：
 * 「whale-plugin/1 不能把翻唱音频作为微信语音发出，message.send(delivery:'voice') 只是文本
 * 语音意图」。这条用例把那份 README 变成可执行断言：
 *
 * 1. 两个清单都能过宿主自己的 validateManifest，provides/calls 全部在注册表里；
 * 2. 入口按 worker 的方式载入（独立 Module + 暂扣 cwd），已声明的 provides 各跑一次，
 *    返回值必须过注册表 output schema；
 * 3. 每次宿主调用的 payload 必须过 message.send@1 的 input schema，且只带文本/会话字段；
 * 4. 授权缺失（宿主不批 message.send@1）时插件只能安静降级，不能假装已经发出去；
 * 5. 结构上不存在音频投递通道（注册表没有音频能力，message.send@1 也没有文件字段）。
 *
 * 另外附带 task-108 遗留核查：市场插件 care-plus / ruiping 的 `exports.__test` 调试导出审计。
 * 该项是硬断言：市场把三个插件的调试导出删掉之后（2026-11-26），再加回来必须立刻变红。
 *
 * 跑法：node tests/plugin-singing-fakehost.test.js
 * 市场仓库不在时整份跳过（与 tests/plugin-followup-compat.test.js 的口径一致），
 * 可用 WHALE_MARKET_DIR 指向别的市场检出。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateManifest } = require('../src/services/pluginProtocol');
const {
  registry, fakeCoverCli, loadPlugin, createFakeHost, contextFor, invokeProvider,
} = require('./fixtures/fake-host');

const MARKET = process.env.WHALE_MARKET_DIR || path.join(__dirname, '..', '..', 'whale-girl-plugins');
const PLUGIN_IDS = ['breeze-sing', 'breezeblue-sing'];
const SEND = 'message.send@1';

const groupMessage = text => ({
  platform: 'wechat', chatType: 'group', chatId: 'g1', senderId: 'u1',
  senderName: '甲', chatTitle: '示例群', text,
});
const privateMessage = text => ({
  platform: 'wechat', chatType: 'private', chatId: 'u1', senderId: 'u1', senderName: '甲', text,
});
const preReplyInput = text => ({ message: groupMessage(text), localWechat: false });

/** 队列里一条「已经唱好」的成品：README 说它只能留在本机，不能当微信语音发。 */
const readyOrder = {
  id: 'order-ready-1', song: '起风了', artist: '买辣椒也用券', status: 'ready',
  engine: 'seedvc', hasAudio: true, durationSec: 54, requester: '甲',
  source: 'C:/fake-cover/orders/order-ready-1/source.wav',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  group: { id: 'g1', name: '示例群' },
};

let passed = 0;
const failures = [];

async function scenario(title, body) {
  try {
    await body();
    passed++;
    console.log(`PASS  ${title}`);
  } catch (error) {
    failures.push(title);
    console.log(`FAIL  ${title}`);
    for (const line of String((error && error.stack) || error).split('\n').slice(0, 12)) {
      console.log('      ' + line.trim());
    }
  }
}

function makeLab() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sing-'));
  const stateDir = path.join(base, 'state');
  const dataDir = path.join(base, 'cover-data');
  const ordersFile = path.join(base, 'orders.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(ordersFile, JSON.stringify([readyOrder]));
  return {
    base, stateDir, dataDir, ordersFile,
    settings: { coverCli: fakeCoverCli, dataDir, engine: 'seedvc', maxSeconds: 54, onlyGroup: true, autoRender: true },
    dispose() {
      if (process.env.WHALE_FAKE_COVER_ORDERS === ordersFile) delete process.env.WHALE_FAKE_COVER_ORDERS;
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    },
  };
}

/** 载入一份市场插件并把假 CLI 的队列接上；调用方负责 lab.dispose()。 */
function open(pluginId, lab, authorized) {
  const dir = path.join(MARKET, 'plugins', pluginId);
  process.env.WHALE_FAKE_COVER_ORDERS = lab.ordersFile;
  const loaded = loadPlugin(dir, { stateDir: lab.stateDir });
  const fake = createFakeHost({ authorized, settings: lab.settings });
  return { dir, loaded, fake, ctx: contextFor(fake) };
}

const payloadKeys = payload => Object.keys(payload).sort();

async function pluginChecks(pluginId) {
  const lab = makeLab();
  try {
    const { dir, loaded, fake, ctx } = open(pluginId, lab, [SEND]);
    const { manifest, source } = loaded;

    /* A. 清单：必须过宿主自己的清单校验，声明的能力全部在注册表里。 */
    const raw = fs.readFileSync(path.join(dir, 'plugin.json'));
    const validated = validateManifest(raw, { appVersion: '4.3.0' });
    assert.equal(validated.level, 4, '4 级 node-full');
    assert.equal(validated.runtime, 'node-full');
    assert.deepEqual(validated.calls, [SEND], '只声明 message.send@1（没有音频/语音能力）');
    const declared = Object.keys(manifest.provides).sort();
    assert.deepEqual(declared, ['chat.pre_reply@1', 'task.tick@1', 'tool.run@1'], 'provides 与 README 一致');
    for (const name of declared) {
      const spec = registry.providers[name];
      assert.ok(spec, `${name} 必须在注册表里`);
      assert.ok(spec.modes.includes(manifest.provides[name].mode), `${name} 的 mode 合法`);
      assert.ok(registry.levels['4'].providers.includes(name), `4 级允许 ${name}`);
    }

    /* B. 入口导出的 providers 与声明的 provides 一一对应（不多不少）。 */
    const exported = Object.keys(loaded.exports.providers || {}).sort();
    assert.deepEqual(exported, declared, '声明了却跑不了的 provider，或者没声明的僵尸 provider 都会红');
    for (const name of exported) assert.equal(typeof loaded.exports.providers[name], 'function', name);

    /* C. 已声明的 provides 各跑一次，输出必须过注册表 schema（invokeProvider 内部校验）。 */
    const help = await invokeProvider(loaded, 'chat.pre_reply@1', preReplyInput('点歌帮助'), ctx);
    assert.deepEqual(help, { action: 'skip' }, '点歌帮助 由插件自己回，宿主不再默认回复');
    assert.match(fake.calls.at(-1).input.text, /点歌/, '菜单发的是文本');
    assert.equal(fake.calls.at(-1).name, SEND);

    const status = await invokeProvider(loaded, 'tool.run@1', { action: 'status' }, ctx);
    assert.equal(status.ok, true, 'status 走通假 cover CLI');
    assert.equal(status.orders[0].song, '起风了');
    assert.equal(fake.calls.length, 1, 'status 是只读的，不该调宿主');

    const ordered = await invokeProvider(loaded, 'tool.run@1', {
      action: 'order', chatId: 'g1', chatType: 'group',
      senderId: 'u1', senderName: '甲', chatTitle: '示例群', text: '点歌 起风了',
    }, ctx);
    assert.equal(ordered.ok, true, '手动点歌走通');
    assert.match(fake.calls.at(-1).input.text, /《起风了》/, '回执里带歌名');
    assert.match(fake.calls.at(-1).input.text, /不能发翻唱音频/, '回执当场说清不能发音频');

    const tick = await invokeProvider(loaded, 'task.tick@1',
      { scheduledAt: 0, now: Date.now(), settings: lab.settings }, ctx);
    assert.deepEqual(tick, {}, 'task.tick 的输出是空对象（json schema）');
    const delivered = fake.calls.at(-1).input;
    assert.match(delivered.text, /不能把音频文件投递成微信语音/, '成品交付只发这条降级说明');
    assert.match(delivered.text, /成品留在本机 cover 数据目录/);
    assert.ok(fs.existsSync(path.join(lab.stateDir, 'auto-state.json')), '队列状态真写进插件 data 目录');
    assert.equal(fs.existsSync(path.join(lab.stateDir, 'tick.lock')), false, 'tick 结束必须放锁');

    const sing = await invokeProvider(loaded, 'chat.pre_reply@1', preReplyInput('唱 起风了'), ctx);
    assert.deepEqual(sing, { action: 'skip' });
    assert.match(fake.calls.at(-1).input.text, /不能把翻唱音频作为微信语音发出/, '「唱」只回文本说明');

    /* D. 闲聊不该被门禁接管；私聊默认只认「唱」，不认「点歌」。 */
    const chat = await invokeProvider(loaded, 'chat.pre_reply@1', preReplyInput('今天天气不错'), ctx);
    assert.deepEqual(chat, { action: 'pass' }, '不相关消息一律 pass，不能抢主人消息');
    const privateOrder = await invokeProvider(loaded, 'chat.pre_reply@1',
      { message: privateMessage('点歌 起风了'), localWechat: false }, ctx);
    assert.deepEqual(privateOrder, { action: 'pass' }, 'onlyGroup 默认 true：私聊不接管点歌');
    const privateSing = await invokeProvider(loaded, 'chat.pre_reply@1',
      { message: privateMessage('唱 起风了'), localWechat: false }, ctx);
    assert.deepEqual(privateSing, { action: 'skip' }, '私聊保留「唱」');

    /* E. 所有宿主调用都只能是文本：字段集合与内容都钉死。 */
    const accepted = fake.accepted();
    assert.ok(accepted.length >= 4, `至少 4 条文本回执，实际 ${accepted.length}`);
    for (const call of accepted) {
      assert.equal(call.name, SEND);
      assert.deepEqual(payloadKeys(call.input), ['chatId', 'chatType', 'name', 'text'],
        'payload 只能带会话与文本字段（六个字段以外的一律算越界）');
      assert.ok(call.input.text.trim().length > 0, '空文本会被宿主 input schema 拒绝');
    }
    const wire = JSON.stringify(accepted.map(call => call.input));
    for (const forbidden of ['[[cover:', '.wav', '.mp3', 'http://', 'https://']) {
      assert.equal(wire.includes(forbidden), false, `payload 里不得出现 ${forbidden}`);
    }

    /* F. 缺授权降级：宿主不批 message.send@1 时只能安静失败，不能假装发送成功。 */
    const deniedLab = makeLab();
    try {
      const denied = open(pluginId, deniedLab, []);
      const degraded = await invokeProvider(denied.loaded, 'chat.pre_reply@1',
        preReplyInput('唱 起风了'), denied.ctx);
      assert.deepEqual(degraded, { action: 'skip' }, '门禁结论不因发送失败而炸掉');
      assert.equal(denied.fake.accepted().length, 0, '一条都没发出去');
      assert.equal(denied.fake.rejected().length, 1, '插件尝试过一次发送，被宿主按未授权拒绝');
      assert.equal(denied.fake.rejected()[0].rejected, 'host_capability_not_declared');
      const readOnly = await invokeProvider(denied.loaded, 'tool.run@1', { action: 'status' }, denied.ctx);
      assert.equal(readOnly.ok, true, '只读工具不依赖 message.send，缺授权也不该坏');
      assert.equal(denied.fake.calls.length, 1, '只读路径没有额外宿主调用');
    } finally {
      deniedLab.dispose();
    }

    /* G. model.complete：两个插件都不声明、不使用，所以「缺它」不构成降级路径。 */
    assert.equal(manifest.calls.includes('model.complete@1'), false);
    assert.ok(Object.hasOwn(registry.calls, 'model.complete@1'), '宿主确实有该能力，只是插件没要');
    assert.equal(source.includes('model.complete'), false, '入口源码里没有这个能力的引用');
    assert.equal(source.includes('host.call('), true, '插件确实只通过 host.call 出去');
  } finally {
    lab.dispose();
  }
}

/** 注册表层面证明「新协议没有音频投递」：README 的降级不是实现偷懒，是没有通道。 */
async function structuralNoAudio() {
  const names = Object.keys(registry.calls);
  assert.equal(names.some(name => /audio|voice/i.test(name)), false,
    `宿主能力表里不该有音频/语音投递能力：${names.filter(name => /audio|voice/i.test(name))}`);
  const properties = Object.keys(registry.schemas['message.send.input@1'].properties).sort();
  assert.deepEqual(properties, ['chatId', 'chatType', 'delivery', 'name', 'text']);
  for (const absent of ['file', 'audio', 'voice', 'path', 'url', 'data', 'bytes']) {
    assert.equal(properties.includes(absent), false, `message.send@1 不能有 ${absent} 字段`);
  }
  const fake = createFakeHost({ authorized: [SEND] });
  // delivery:'voice' 是合法枚举（README 明说它只是「让宿主用文本走语音通道」），仍然只有文本。
  const intent = await fake.host.call(SEND, { chatId: 'g1', text: '语音意图也是文本', delivery: 'voice' });
  assert.equal(intent.status, 'queued');
  // 负向对照：真想夹带音频字节 / 文件路径，宿主在 input schema 上就拒了。
  for (const extra of [{ audio: 'BASE64...' }, { file: 'a.wav' }, { path: 'C:/a.wav' }]) {
    await assert.rejects(
      fake.host.call(SEND, { chatId: 'g1', text: 'x', ...extra }),
      { code: 'invalid_host_capability_input' },
      `message.send@1 不该收得下 ${Object.keys(extra)[0]}`,
    );
  }
}

/** task-108 遗留：市场插件入口是否还挂着仅供本地测试的调试导出。 */
function debugExportLeaks() {
  const leaks = [];
  const root = path.join(MARKET, 'plugins');
  if (!fs.existsSync(root)) return leaks;
  for (const id of fs.readdirSync(root).sort()) {
    const file = path.join(root, id, 'plugin.js');
    if (!fs.existsSync(file)) continue;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (/^\s*(?:module\.)?exports\.__test\s*=/.test(line)) {
        leaks.push({ id, file: `plugins/${id}/plugin.js`, line: index + 1, text: line.trim() });
      }
    });
  }
  return leaks;
}

async function main() {
  const missing = PLUGIN_IDS.filter(id => !fs.existsSync(path.join(MARKET, 'plugins', id, 'plugin.js')));
  if (missing.length) {
    console.log(`SKIP  市场仓库不完整（${MARKET}）：缺 ${missing.join(', ')}`);
    console.log('      这不是通过；设置 WHALE_MARKET_DIR 指向市场检出后再跑。');
    process.exitCode = 0;
    return;
  }

  for (const id of PLUGIN_IDS) {
    await scenario(`${id}：provides 全部可跑、输出合 schema、只发文本`, () => pluginChecks(id));
  }
  await scenario('注册表层面没有音频投递通道（README 的降级有结构依据）', structuralNoAudio);

  const leaks = debugExportLeaks();
  if (!leaks.length) {
    passed++;
    console.log('PASS  care-plus / ruiping 的 plugin.js 不再暴露 __test 调试导出');
  } else {
    const detail = leaks.map(leak => `${leak.file}:${leak.line}  ${leak.text}`).join('\n        ');
    failures.push('生产入口仍然暴露 __test 调试导出');
    console.log('FAIL  生产入口不应暴露 __test 调试导出');
    console.log('        实际导出：\n        ' + detail);
    console.log('      这条已是硬断言（2026-11-26 起）：市场把三个插件的调试导出删掉了，');
    console.log('      再加回来会立刻变红。市场仓库缺失时本文件整体 SKIP，不算通过。');
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED ${failures.length} / ${passed + failures.length}`);
    for (const title of failures) console.log('  - ' + title);
    process.exitCode = 1;
  } else {
    console.log(`OK ${passed} checks passed, 0 failed`);
    process.exitCode = 0;
  }
}

main().catch(error => {
  console.error((error && error.stack) || error);
  process.exitCode = 1;
});
