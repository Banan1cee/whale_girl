'use strict';

/**
 * 「鲸鲸插件作者」技能（skills/whale-plugin-author）的自检。
 *
 * 技能宣称「只读文档和 examples 就能做出能装的插件」，所以最容易坏的地方不是措辞，
 * 而是文档与宿主实现悄悄脱节：清单示例少了键、配方里字段名写错、表格里的 mode 早就变了、
 * 示例入口根本没被运行过。这些都不会让宿主启动失败，只会让照着技能写插件的人反复踩坑。
 *
 * 这里钉住五类事实，全部用宿主真实代码校验，而不是只查名字存在：
 *
 *   1. 文件齐全、frontmatter 可被技能发现、正文没有 PowerShell 反引号留下的制表符/反斜杠；
 *   2. 四个完整项目都能过真实 validateManifest，清单的等级/入口/runtime/provides/calls/dataAccess
 *      与当前注册表逐项一致，入口能被加载且导出的键与 provides 完全对应；
 *   3. 文档里的每个代码围栏都能编译/解析，标记为 plugin-manifest 的围栏是完整清单；
 *   4. protocol.md 的等级表、扩展点表、可声明 calls 名单与注册表逐项相等；SKILL.md 速查表的
 *      mode/scope 与等级确实被注册表允许；testing.md 的错误码都真的在宿主源码里出现；
 *   5. 用宿主真实的 UnifiedCapabilityDispatcher + projectDataAccess + capabilitySchema 组成
 *      合成 host（不 spawn、不联网、不碰微信），把四个示例的承诺行为跑出来。
 *
 * 不启动子进程：沙箱里 spawn 会 EPERM，直接 `node tests/plugin-skill.test.js` 跑。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const registry = require('../src/services/pluginProtocolRegistry.json');
const { validateManifest } = require('../src/services/pluginProtocol');
const { UnifiedCapabilityDispatcher } = require('../src/services/unifiedCapabilityDispatcher');
const { projectDataAccess } = require('../src/services/unifiedPluginRuntime');

const ROOT = path.join(__dirname, '..');
const SKILL_ROOT = path.join(ROOT, 'skills', 'whale-plugin-author');
const EXAMPLES_ROOT = path.join(SKILL_ROOT, 'examples');

const MARKDOWN = ['SKILL.md', 'references/protocol.md', 'references/recipes.md', 'references/testing.md', 'references/gotchas.md'];

const EXAMPLES = [
  { dir: 'theme-minimal', entry: 'theme.json', level: 0 },
  { dir: 'gate-quiet-hours', entry: 'plugin.js', level: 4 },
  { dir: 'prompt-enhance', entry: 'plugin.js', level: 4 },
  { dir: 'tool-node', entry: 'plugin.js', level: 4 },
];

const read = relative => fs.readFileSync(path.join(SKILL_ROOT, relative), 'utf8');
const readExample = (dir, file) => fs.readFileSync(path.join(EXAMPLES_ROOT, dir, file));

function exampleManifest(dir) {
  const raw = readExample(dir, 'plugin.json');
  return { raw, manifest: validateManifest(raw) };
}

/** 极简 frontmatter 解析：只认顶层 `key: value`。 */
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

/** 把 markdown 拆成围栏与正文；围栏内是代码，正文用于检查转义残留。 */
function parseMarkdown(text) {
  const fences = [];
  const prose = [];
  const lines = text.split(/\r?\n/);
  let info = null;
  let body = [];
  for (const line of lines) {
    if (info === null) {
      const open = /^```(.*)$/.exec(line);
      if (open) { info = open[1].trim(); body = []; } else prose.push(line);
      continue;
    }
    if (/^```\s*$/.test(line)) {
      fences.push({ info, body: body.join('\n') });
      info = null;
      continue;
    }
    body.push(line);
  }
  assert.equal(info, null, '有未闭合的代码围栏');
  return { fences, prose: prose.join('\n') };
}

const codeTokens = cell => [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1]);

function tableRows(section, { prefix = '|' } = {}) {
  return section.split(/\r?\n/).filter(line => line.startsWith(prefix) && !/^\|\s*-/.test(line));
}

/** 从 protocol.md 里切出一节（到下一个同级或更高标题为止）。 */
function section(markdown, heading) {
  const start = markdown.indexOf('\n' + heading);
  assert.ok(start >= 0, '找不到章节：' + heading);
  const rest = markdown.slice(start + 1 + heading.length);
  const next = /\n#{1,3} /.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function compileCommonJs(source, filename) {
  return vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename });
}

/** 按 worker 的方式加载入口：CommonJS 包装，不 spawn、不联网。 */
function loadProviders(dir, entry) {
  const file = path.join(EXAMPLES_ROOT, dir, entry);
  const module = { exports: {} };
  const compile = compileCommonJs(fs.readFileSync(file, 'utf8'), file);
  const denyRequire = name => { throw new Error(`示例不应 require（${name}）：${dir}`); };
  compile(module.exports, denyRequire, module, file, path.dirname(file));
  return module.exports.providers;
}

test('技能文件齐全、非空，且 frontmatter 可被技能发现', () => {
  const required = ['SKILL.md', ...MARKDOWN.slice(1), ...EXAMPLES.flatMap(item => [
    `examples/${item.dir}/plugin.json`, `examples/${item.dir}/${item.entry}`,
  ])];
  for (const relative of required) {
    const file = path.join(SKILL_ROOT, relative);
    assert.ok(fs.existsSync(file), '缺少文件：' + relative);
    assert.ok(fs.statSync(file).size > 0, '文件为空：' + relative);
  }
  const fields = frontmatter(read('SKILL.md'));
  assert.ok(fields, 'SKILL.md 必须以 --- frontmatter 开头');
  assert.equal(fields.name, path.basename(SKILL_ROOT), 'frontmatter name 必须等于目录名');
  assert.match(fields.description, /插件/, 'description 要说明这是做插件的技能');
  assert.ok([...fields.description].length >= 40, 'description 太短，触发词不足');
  assert.ok([...fields.description].length <= 1024, 'description 过长，技能目录会被截断');
});

test('正文没有 PowerShell 反引号转义留下的制表符与反斜杠', () => {
  for (const relative of MARKDOWN) {
    const text = read(relative);
    assert.ok(!text.includes('\t'), `${relative} 含制表符（多半是 \\t 被真实展开）`);
    assert.ok(!text.includes('\r'), `${relative} 含 CR`);
    const { prose } = parseMarkdown(text);
    assert.ok(!prose.includes('\\'), `${relative} 正文含反斜杠（多半是 \\\` 或 \\n 转义漏进文档）`);
    assert.ok(!/[ \t]+$/m.test(prose), `${relative} 正文有行尾空白`);
  }
});

test('文档里没有硬编码的本机路径或用户名', () => {
  for (const relative of MARKDOWN) {
    const text = read(relative);
    assert.ok(!/%USERPROFILE%|~\/|\/Users\/|\/home\/|C:\\\\/i.test(text), `${relative} 出现本机路径`);
  }
});

test('每个代码围栏都能编译或解析', () => {
  for (const relative of MARKDOWN) {
    const { fences } = parseMarkdown(read(relative));
    for (const [index, fence] of fences.entries()) {
      const where = `${relative} 第 ${index + 1} 个围栏（${fence.info || '无语言'}）`;
      const language = fence.info.split(/\s+/)[0];
      if (language === 'json') {
        assert.doesNotThrow(() => JSON.parse(fence.body), `${where} 不是合法 JSON`);
        if (/plugin-manifest/.test(fence.info)) {
          validateManifest(Buffer.from(fence.body + '\n'));
        }
      } else if (language === 'js' || language === 'javascript') {
        assert.doesNotThrow(() => compileCommonJs(fence.body, where), `${where} 有语法错误`);
        assert.match(fence.body, /exports\.providers\s*=/, `${where} 必须是完整的 CommonJS 入口`);
      } else if (!['wat', 'text', 'bash', 'powershell'].includes(language)) {
        assert.fail(`${where} 使用了未登记的语言标记`);
      }
    }
  }
});

test('四个完整项目都被正文引用，作者不用猜路径', () => {
  const recipes = read('references/recipes.md');
  const skill = read('SKILL.md');
  for (const example of EXAMPLES) {
    const pointer = `examples/${example.dir}`;
    assert.ok(recipes.includes(pointer), `recipes.md 没有指向 ${pointer}`);
    assert.ok(skill.includes(pointer), `SKILL.md 没有指向 ${pointer}`);
  }
});

test('四个示例各带 README，写明等级/provides/calls/dataAccess/已知限制', () => {
  // SKILL.md 的「交付前自检」要求 README 写全这五项，示例就是范本；
  // 这里按注册表核对，防止文档改版后示例 README 变旧（作者会照抄错的）。
  const row = (body, name) => {
    const line = body.split(/\r?\n/).find(item => new RegExp('^\\|\\s*' + name + '\\s*\\|').test(item));
    assert.ok(line, `${name} 缺一行：${name}`);
    return line;
  };
  for (const example of EXAMPLES) {
    const file = path.join(EXAMPLES_ROOT, example.dir, 'README.md');
    assert.ok(fs.existsSync(file), `缺少示例 README：${example.dir}/README.md`);
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(!body.includes('\t'), `${example.dir}/README.md 含制表符`);
    assert.ok(body.includes('已知限制'), `${example.dir}/README.md 没有「已知限制」一节`);

    const { manifest } = exampleManifest(example.dir);
    assert.match(row(body, '等级'), new RegExp('^\\|\\s*等级\\s*\\|\\s*' + manifest.level + '(?!\\d)'),
      `${example.dir}/README.md 的等级与清单不符`);
    assert.equal(manifest.entry, example.entry);

    const provides = row(body, 'provides');
    for (const [name, descriptor] of Object.entries(manifest.provides)) {
      assert.ok(provides.includes(name), `${example.dir}/README.md 的 provides 漏了 ${name}`);
      assert.ok(provides.includes(descriptor.mode + '/' + descriptor.scope),
        `${example.dir}/README.md 的 provides 没有写 ${descriptor.mode}/${descriptor.scope}`);
    }
    if (Object.keys(manifest.provides).length === 0) assert.match(provides, /\{\}/, '0 级 README 要写 provides 是 {}');

    const calls = row(body, 'calls');
    if (manifest.calls.length === 0) assert.ok(calls.includes('[]'), `${example.dir}/README.md 的 calls 应写 []`);
    for (const name of manifest.calls) assert.ok(calls.includes(name), `${example.dir}/README.md 的 calls 漏了 ${name}`);

    const dataAccess = row(body, 'dataAccess');
    for (const name of manifest.dataAccess || []) {
      assert.ok(dataAccess.includes(name), `${example.dir}/README.md 的 dataAccess 漏了 ${name}`);
    }
  }
});

test('四个示例清单与注册表逐项一致，入口导出的键与 provides 完全对应', () => {
  const ids = new Set();
  for (const example of EXAMPLES) {
    const { manifest } = exampleManifest(example.dir);
    assert.equal(manifest.level, example.level, `${example.dir} 等级应为 ${example.level}`);
    assert.equal(manifest.entry, example.entry, `${example.dir} 入口应为 ${example.entry}`);
    assert.ok(!ids.has(manifest.id), '示例 id 重复：' + manifest.id);
    ids.add(manifest.id);

    const level = registry.levels[String(manifest.level)];
    assert.equal(manifest.runtime, level.runtime, `${example.dir} runtime 与等级不符`);
    assert.equal(manifest.entry, level.entry, `${example.dir} 入口与等级不符`);
    for (const [name, descriptor] of Object.entries(manifest.provides)) {
      assert.ok(level.providers.includes(name), `${example.dir} 声明了等级不允许的扩展点 ${name}`);
      const rule = registry.providers[name];
      assert.ok(rule.modes.includes(descriptor.mode), `${example.dir} ${name} 的 mode 不受支持`);
      assert.ok(rule.scopes.includes(descriptor.scope), `${example.dir} ${name} 的 scope 不受支持`);
      assert.deepEqual(Object.keys(descriptor).sort(), ['mode', 'scope'], `${example.dir} ${name} 描述符只能有 mode/scope`);
    }
    assert.equal(new Set(manifest.calls).size, manifest.calls.length, 'calls 不能重复');
    for (const call of manifest.calls) {
      assert.ok(level.calls.includes(call), `${example.dir} 的 calls 含该等级不可声明的 ${call}`);
      assert.ok(Object.hasOwn(registry.calls, call), '注册表没有宿主能力 ' + call);
    }
    if (manifest.level === 3) assert.deepEqual(manifest.calls, [], '3 级 calls 必须为空');
    if (manifest.level === 0) {
      assert.deepEqual(manifest.provides, {}, '0 级不能声明 provides');
      assert.equal(manifest.settingsSchema, undefined, '0 级不能声明 settingsSchema');
      assert.equal(manifest.dataAccess, undefined, '0 级不能声明 dataAccess');
    }
    if (manifest.settingsSchema) {
      assert.equal(manifest.settingsSchema.type, 'object', 'settingsSchema 根必须是 object');
      assert.ok(!JSON.stringify(manifest.settingsSchema).includes('"default"'), 'settingsSchema 不支持 default 关键字');
      assert.equal(manifest.settingsSchema.required, undefined, '安装时设置是 {}，用 required 会让插件装上就不可用');
    }
    if (manifest.level === 4) {
      assert.ok(manifest.provides && Object.keys(manifest.provides).length > 0, '4 级必须至少声明一个扩展点');
    }

    if (manifest.level === 0) {
      JSON.parse(readExample(example.dir, example.entry).toString('utf8'));
      continue;
    }
    const providers = loadProviders(example.dir, example.entry);
    assert.ok(providers && typeof providers === 'object', `${example.dir} 入口没有导出 providers`);
    assert.deepEqual(Object.keys(providers).sort(), Object.keys(manifest.provides).sort(),
      `${example.dir} 的 provides 与 exports.providers 键必须逐字一致`);
    for (const [name, handler] of Object.entries(providers)) {
      assert.equal(typeof handler, 'function', `${example.dir} 的 ${name} 不是函数`);
    }
    const source = readExample(example.dir, example.entry).toString('utf8');
    const called = new Set([...source.matchAll(/host\.call\(\s*'([^']+)'/g)].map(match => match[1]));
    for (const call of called) {
      assert.ok(manifest.calls.includes(call), `${example.dir} 调用了未在 calls 声明的 ${call}`);
    }
    for (const call of manifest.calls) {
      assert.ok(called.has(call), `${example.dir} 声明了 ${call} 却没有调用，权限面白给`);
    }
  }
  const dirs = fs.readdirSync(EXAMPLES_ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(dirs, EXAMPLES.map(item => item.dir).sort(), 'examples 目录与自检清单不一致');
});

test('正文里的处理器配方能按契约运行（合成 host，不发消息）', async () => {
  const { validate } = require('../src/services/capabilitySchema');
  const baseMessage = message();
  const inputs = {
    'chat.pre_reply@1': () => ({ message: baseMessage, localWechat: true, now: Date.now(), lastBot: null }),
    'chat.prompt@1': () => ({ system: '你是鲸鲸。', message: baseMessage }),
    'chat.before_send@1': () => ({ message: baseMessage, text: '  多余   空格  ' }),
    'chat.reply@1': () => ({ message: baseMessage, text: '一段草稿' }),
    'chat.generate@1': () => ({ message: baseMessage, system: 'S', turns: [{ role: 'user', content: '在吗' }] }),
    'chat.handle@1': () => ({ message: baseMessage, localWechat: true }),
    'chat.search@1': () => ({ message: baseMessage }),
    'task.tick@1': () => ({ scheduledAt: 1, now: 2, settings: {} }),
    'app.start@1': () => ({ at: 1, settings: {} }),
    'app.stop@1': () => ({ at: 1, settings: {} }),
    'tool.run@1': () => ({ text: '你好' }),
  };
  const canned = {
    'status.read@1': () => ({ version: '4.3.0', running: true, pluginProtocol: 'whale-plugin/1' }),
    'model.complete@1': () => ({ text: '摘要' }),
    'search.query@1': () => ({ text: '', items: [], status: 'empty' }),
    'settings.read@1': () => ({}),
  };
  const host = {
    call: async (name, value) => {
      assert.ok(Object.hasOwn(registry.calls, name), '配方调用了不存在的宿主能力 ' + name);
      const rule = registry.calls[name];
      if (rule.enabled === false) throw Object.assign(new Error(name), { code: 'host_capability_disabled' });
      validate(rule.inputSchema, value, 'invalid_host_capability_input');
      const answer = canned[name]();
      validate(rule.outputSchema, answer, 'invalid_host_capability_output');
      return answer;
    },
  };
  let recipes = 0;
  for (const relative of MARKDOWN) {
    const { fences } = parseMarkdown(read(relative));
    for (const fence of fences) {
      if (!['js', 'javascript'].includes(fence.info.split(/\s+/)[0])) continue;
      const file = relative + '#fence';
      const module = { exports: {} };
      compileCommonJs(fence.body, file)(module.exports, () => { throw new Error('配方不应 require'); }, module, file, '.');
      const providers = module.exports.providers;
      assert.ok(providers, `${file} 没有导出 providers`);
      for (const [name, handler] of Object.entries(providers)) {
        const rule = registry.providers[name];
        assert.ok(rule, `${file} 声明了不存在的扩展点 ` + name);
        assert.equal(typeof handler, 'function', `${file} 的 ${name} 不是函数`);
        const input = inputs[name]();
        validate(rule.inputSchema, input, 'invalid_capability_input');
        const output = await handler(input, { host, settings: {}, state: {}, signal: new AbortController().signal });
        validate(rule.outputSchema, output, 'invalid_capability_output');
        if (name === 'chat.handle@1' && output.action === 'reply') {
          assert.ok(typeof output.reply === 'string' && output.reply.trim(), 'chat.handle 的 reply 不能为空');
        }
        if (name === 'chat.generate@1') assert.equal(typeof output.text, 'string', 'chat.generate 必须返回 text');
        recipes += 1;
      }
    }
  }
  assert.ok(recipes >= 5, `正文里只跑通了 ${recipes} 个处理器配方，配方被删空了吗`);
});

test('dataAccess 投影：generate 的 turns、now/lastBot 的发放规则与文档一致', () => {
  // 与 protocol.md §3.2 的承诺逐条核对：未授权只裁会话内容，不裁默认接话上下文。
  const message = { platform: 'wechat', chatType: 'group', chatId: 'g1', senderId: 'u1', text: '在吗' };
  const turns = [{ role: 'user', content: '前一句' }, { role: 'assistant', content: '嗯' }];
  const base = { message, system: 'S', turns, now: 1700000000000, lastBot: { text: '嗯', at: 1, targetId: 'u1' } };

  const ungranted = projectDataAccess('chat.generate@1', base, []);
  assert.deepEqual(ungranted.turns, [], '未授权 generate 应清空 turns 内容');
  assert.ok(Object.hasOwn(ungranted, 'turns'), 'turns 是必填字段，只能清空不能删除');
  assert.equal(ungranted.system, undefined, '未授权不该拿到 system');
  assert.deepEqual(ungranted.message, message, '当前消息不受会话历史授权影响');

  const granted = projectDataAccess('chat.generate@1', base, ['chat.history']);
  assert.deepEqual(granted.turns, turns, '声明 chat.history 后应拿到完整 turns');
  assert.equal(granted.system, undefined, 'system 仍按 model.prompt 独立裁剪');

  const both = projectDataAccess('chat.generate@1', base, ['chat.history', 'model.prompt']);
  assert.equal(both.system, 'S');
  assert.deepEqual(both.turns, turns);

  const prompt = projectDataAccess('chat.prompt@1',
    { system: 'S', message, history: turns, now: 1, lastBot: null }, []);
  assert.equal(prompt.history, undefined, '未授权 prompt 拿不到 history');
  assert.equal(prompt.now, 1, 'now 不受 dataAccess 裁剪');
  assert.equal(prompt.lastBot, null, 'lastBot 不受 dataAccess 裁剪');
});

test('protocol.md §3.2 写清了 generate 的 turns 与默认接话上下文', () => {
  const body = section(read('references/protocol.md'), '### 3.2 dataAccess');
  assert.match(body, /`chat\.generate@1`/, '§3.2 必须点名 chat.generate@1');
  assert.match(body, /`turns`/, '§3.2 必须说明 generate 的历史在 turns');
  assert.match(body, /\[\]/, '§3.2 必须说明未授权时 turns 被清空为 []');
  assert.match(body, /`chat\.history`/, '§3.2 必须说明 chat.history 授权');
  assert.match(body, /四个聊天能力/, '§3.2 必须说明 now/lastBot 只在四个聊天能力里');
  for (const name of ['chat.pre_reply@1', 'chat.prompt@1', 'chat.before_send@1', 'chat.reply@1']) {
    assert.ok(body.includes('`' + name + '`'), '§3.2 的 now/lastBot 名单漏了 ' + name);
  }
  assert.match(body, /`chat\.generate@1`、`chat\.handle@1` 的输入没有这两个字段/,
    '§3.2 必须说明 generate/handle 没有 now/lastBot，避免作者以为任何情况都能拿到');
});

test('protocol.md 的启停语义写全了撤权优先与调用时机', () => {
  const body = section(read('references/protocol.md'), '### 3.5 各能力的额外约束');
  for (const phrase of ['listen 之前', '同一授权快照只通知一次', '约 500ms', '不会自动重试', '正常停机',
    '撤权之后不保证', '只保证不再运行', '各自独立的进程调用']) {
    assert.ok(body.includes(phrase), '§3.5 缺少启停语义：' + phrase);
  }
  assert.ok(!body.includes('内核启动完成后'), '§3.5 不能用「内核启动完成后」这种实现无关的旧说法');
  const recipes = read('references/recipes.md');
  const lifecycle = section(recipes, '## 8. 启停生命周期');
  assert.match(lifecycle, /observe/, '配方必须写明 observe');
  assert.match(lifecycle, /`app\.start@1`/, '配方必须给出 app.start@1');
  assert.match(lifecycle, /`app\.stop@1`/, '配方必须给出 app.stop@1');
  assert.ok(lifecycle.includes('撤权之后不保证'), '配方必须写明撤权后不保证收到 stop');
});

test('protocol.md 等级表与注册表逐项相等', () => {
  const text = read('references/protocol.md');
  const rows = tableRows(section(text, '## 1. 等级')).filter(row => /^\|\s*\d\s*\|/.test(row));
  assert.equal(rows.length, 5, '等级表应有 5 行');
  for (const row of rows) {
    const cells = row.split('|').map(cell => cell.trim());
    const levelId = cells[1];
    const level = registry.levels[levelId];
    assert.ok(level, '注册表没有等级 ' + levelId);
    assert.equal(cells[2], '`' + level.runtime + '`', `等级 ${levelId} 的 runtime 与注册表不符`);
    assert.equal(cells[3], '`' + level.entry + '`', `等级 ${levelId} 的入口与注册表不符`);
    const documented = codeTokens(cells[4]).filter(name => name.includes('@1')).sort();
    assert.deepEqual(documented, [...level.providers].sort(), `等级 ${levelId} 的扩展点列表与注册表不符`);
    if (Number(levelId) === 4) {
      assert.match(cells[5], new RegExp(String(level.calls.length) + ' 项'), '4 级 calls 数量与注册表不符');
    } else {
      assert.match(cells[5], /\[\]/, `等级 ${levelId} 的 calls 必须写空数组`);
      assert.deepEqual(level.calls, [], `等级 ${levelId} 注册表里 calls 应为空`);
    }
  }
});

test('protocol.md 的 message 附加字段名单与注册表 schema 一致', () => {
  const text = read('references/protocol.md');
  const body = section(text, '### 2.3 message 子对象');
  const rows = tableRows(body).filter(row => /`[a-z][A-Za-z0-9_]*`/.test(row));
  assert.equal(rows.length, 1, '§2.3 应恰有一张「额外字段 → 扩展点」表');
  const cells = rows[0].split('|').map(cell => cell.trim());
  const field = codeTokens(cells[1])[0];
  assert.equal(field, 'mentionedNames', '§2.2 描述的是 message.mentionedNames');
  const documented = codeTokens(cells[2]).filter(name => name.includes('@1')).sort();
  const expected = Object.entries(registry.providers)
    .filter(([, rule]) => {
      const schema = registry.schemas[rule.inputSchema];
      return schema?.properties?.message?.properties?.[field] !== undefined;
    })
    .map(([name]) => name)
    .sort();
  assert.deepEqual(documented, expected, 'mentionedNames 的扩展点名单与注册表 schema 不符');
});

test('protocol.md 的 3 级聊天访问确认名单与注册表一致', () => {
  const body = section(read('references/protocol.md'), '### 2.2 授权与确认');
  const line = body.split(/\r?\n/).find(item => item.startsWith('- 3 级：'));
  assert.ok(line, '§2.2 缺少 3 级授权说明');
  // 只在「只声明 … 不需要」之前取能力名，后半句是反例。
  const documented = codeTokens(line.split('只声明')[0]).filter(name => name.includes('@1')).sort();
  const expected = Object.entries(registry.providers)
    .filter(([name, rule]) => Array.isArray(rule.dataAccess) && rule.dataAccess.includes('current-message')
      && registry.levels['3'].providers.includes(name))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(documented, expected, '3 级「聊天访问」确认名单与注册表不符');
});

test('protocol.md 的限额表与注册表 limits 逐键相等', () => {
  const body = section(read('references/protocol.md'), '## 5. 限额');
  const rows = tableRows(body).filter(row => /`[A-Za-z]+`/.test(row));
  const documented = new Map();
  for (const row of rows) {
    const cells = row.split('|').map(cell => cell.trim());
    const key = codeTokens(cells[1])[0];
    assert.ok(key && Object.hasOwn(registry.limits, key), '限额表出现注册表没有的键：' + key);
    const match = /^(\d+)\s*(KiB|MiB)?$/.exec(cells[2]);
    assert.ok(match, `限额表的值无法解析：${key} = ${cells[2]}`);
    const value = Number(match[1]) * (match[2] === 'MiB' ? 1024 * 1024 : match[2] === 'KiB' ? 1024 : 1);
    documented.set(key, value);
  }
  assert.deepEqual([...documented.keys()].sort(), Object.keys(registry.limits).sort(), '限额表必须覆盖注册表全部 limits');
  for (const [key, value] of documented) assert.equal(value, registry.limits[key], `限额 ${key} 与注册表不符`);
});

test('protocol.md 扩展点表的 mode/scope/输入/输出与注册表 schema 完全一致', () => {
  const text = read('references/protocol.md');
  const rows = tableRows(section(text, '## 3. 扩展点（provides）')).filter(row => /`[a-z]+\.[^`]+@1`/.test(row));
  assert.equal(rows.length, Object.keys(registry.providers).length, '扩展点表行数应等于注册表 provider 数量');
  const seen = new Set();
  for (const row of rows) {
    const cells = row.split('|').map(cell => cell.trim());
    const name = codeTokens(cells[1])[0];
    const rule = registry.providers[name];
    assert.ok(rule, '注册表没有扩展点 ' + name);
    assert.ok(!seen.has(name), '扩展点表重复：' + name);
    seen.add(name);
    assert.equal(cells[2], rule.modes.join('/'), `${name} 的 mode 与注册表不符`);
    assert.equal(cells[3], rule.scopes.join('/'), `${name} 的 scope 与注册表不符`);
    const inputSchema = registry.schemas[rule.inputSchema];
    const outputSchema = registry.schemas[rule.outputSchema];
    assert.deepEqual(codeTokens(cells[4]), inputSchema ? Object.keys(inputSchema.properties || {}) : [],
      `${name} 的输入字段与 schema 不符`);
    assert.deepEqual(codeTokens(cells[5]), outputSchema ? Object.keys(outputSchema.properties || {}) : [],
      `${name} 的输出字段与 schema 不符`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(registry.providers).sort(), '扩展点表必须覆盖全部 provider');
});

test('protocol.md 的可声明 calls 名单与注册表一致', () => {
  const text = read('references/protocol.md');
  const body = section(text, '## 4. 宿主能力（calls，只有 4 级能声明）');
  const level4 = registry.levels['4'].calls;
  assert.ok(level4.length > 0, '注册表等级 4 没有可声明能力？');

  const declarable = new Set();
  const unavailableLines = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    if (line.startsWith('- 不能在')) { unavailableLines.push(line); continue; }
    for (const token of codeTokens(line)) if (token.includes('@1')) declarable.add(token);
  }
  assert.deepEqual([...declarable].sort(), [...level4].sort(), '「可声明」名单与注册表 levels.4.calls 不符');
  assert.match(body, new RegExp('共 ' + Object.keys(registry.calls).length + ' 项'), '§4 的注册表能力总数写错');
  assert.match(body, new RegExp('只能声明下面 ' + level4.length + ' 项'), '§4 的可声明数量写错');

  assert.equal(unavailableLines.length, 1, '§4 必须恰有一行列举不可声明能力');
  const unavailable = codeTokens(unavailableLines[0]).filter(token => token.includes('@1'));
  const expected = Object.keys(registry.calls).filter(name => !level4.includes(name));
  assert.deepEqual(unavailable.sort(), expected.sort(), '「不可声明」名单与注册表差值不符');
  assert.match(unavailableLines[0], new RegExp(String(expected.length) + ' 项'), '不可声明数量写错');
});

test('SKILL.md 速查表的 mode/scope 与等级被注册表允许', () => {
  const text = read('SKILL.md');
  const rows = tableRows(section(text, '## 常见需求 → 声明')).filter(row => /`[a-z]+\.[^`]+@1`/.test(row));
  assert.ok(rows.length >= 10, '速查表太短，覆盖不到主要需求');
  for (const row of rows) {
    const cells = row.split('|').map(cell => cell.trim());
    const levels = /^(\d)(?:\s*[–-]\s*(\d))?$/.exec(cells[2]);
    assert.ok(levels, '等级列格式应为 3、4 或 3–4：' + cells[2]);
    const from = Number(levels[1]);
    const to = Number(levels[2] ?? levels[1]);
    assert.ok(to >= from && to <= 4, '等级范围不合法：' + cells[2]);
    const declaration = /`([a-z]+\.[^`]+@1)`\s+([a-z]+)\/([a-z]+)/.exec(cells[3]);
    assert.ok(declaration, 'provides 列应写成 `能力` mode/scope：' + cells[3]);
    const [, name, mode, scope] = declaration;
    const rule = registry.providers[name];
    assert.ok(rule, '速查表引用了不存在的扩展点 ' + name);
    assert.ok(rule.modes.includes(mode), `${name} 的 mode 写错：${mode}`);
    assert.ok(rule.scopes.includes(scope), `${name} 的 scope 写错：${scope}`);
    for (let level = from; level <= to; level += 1) {
      assert.ok(registry.levels[String(level)].providers.includes(name), `${name} 在 ${level} 级不可用，速查表等级写错`);
    }
  }
  // 反向覆盖：每个 provider 都要在技能里出现过，避免新增能力后文档整体漏掉。
  const mentioned = new Set();
  for (const relative of MARKDOWN) {
    for (const match of read(relative).matchAll(/\b([a-z][a-z0-9]*)\.([A-Za-z][A-Za-z0-9_-]*)@1\b/g)) {
      mentioned.add(`${match[1]}.${match[2]}@1`);
    }
  }
  const missing = [...Object.keys(registry.providers), ...Object.keys(registry.calls)].filter(name => !mentioned.has(name));
  assert.deepEqual(missing, [], '注册表里有、技能完全没提到的能力：\n' + missing.join('\n'));
});

test('testing.md 的错误码都真的在宿主源码里出现', () => {
  const sources = [
    'src/services/unifiedPluginRuntime.js',
    'src/services/unifiedCapabilityDispatcher.js',
    'src/services/unifiedPluginWorker.js',
    'src/services/unifiedWasm.js',
    'src/services/capabilitySchema.js',
    'src/services/pluginProtocol.js',
  ].map(relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')).join('\n');
  const codes = new Set();
  for (const match of sources.matchAll(/'([a-z][a-z0-9_]{3,40})'/g)) codes.add(match[1]);

  const text = read('references/testing.md');
  const body = section(text, '## 3. 报错 → 原因 → 下一步');
  const documented = new Set();
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('| `')) continue;
    for (const token of codeTokens(line.split('|')[1])) {
      if (/^[a-z][a-z0-9_]+$/.test(token)) documented.add(token);
    }
  }
  assert.ok(documented.size >= 15, `错误码表只有 ${documented.size} 条，覆盖不足`);
  const unknown = [...documented].filter(code => !codes.has(code));
  assert.deepEqual(unknown, [], '文档写了宿主不会产生的错误码：\n' + unknown.join('\n'));
  // worker 内部的 missing_provider 不会到插件侧，不能当作者可见错误码写进表。
  assert.ok(!documented.has('missing_provider'), 'missing_provider 是 worker 内部错误，插件只会看到 plugin_error');
  assert.ok(!documented.has('unknown_capability'), 'unknown_capability 是宿主侧错误，插件调用不会见到');
});

test('主题示例能过启动器的真实 token/限额/对比度规则', () => {
  const themeSource = fs.readFileSync(path.join(ROOT, 'launcher', 'LauncherTheme.cs'), 'utf8');
  const stringArray = name => {
    const match = new RegExp(name + '\\s*=\\s*\\{([\\s\\S]*?)\\}').exec(themeSource);
    assert.ok(match, '启动器里找不到 ' + name);
    return [...match[1].matchAll(/"([^"]+)"/g)].map(item => item[1]);
  };
  const constant = name => {
    const match = new RegExp('internal const (?:int|double) ' + name + ' = ([^;]+);').exec(themeSource);
    assert.ok(match, '启动器里找不到常量 ' + name);
    return match[1].split('*').map(part => Number(part.trim())).reduce((a, b) => a * b, 1);
  };
  const COLOR_TOKENS = stringArray('ColorTokens');
  const FONT_FAMILIES = stringArray('FontFamilies');
  const TOP_KEYS = stringArray('TopKeys');
  const FONT_KEYS = stringArray('FontKeys');
  const METRIC_KEYS = stringArray('MetricKeys');
  const DIALOG_KEYS = stringArray('DialogKeys');
  const MAX_BYTES = constant('MaxBytes');
  const MIN_SCALE = constant('MinScale');
  const MAX_SCALE = constant('MaxScale');
  const MIN_CORNER = constant('MinCorner');
  const MAX_CORNER = constant('MaxCorner');
  const TEXT_CONTRAST = constant('TextContrast');
  const ACCENT_CONTRAST = constant('AccentContrast');

  const raw = readExample('theme-minimal', 'theme.json');
  assert.ok(raw.length <= MAX_BYTES, '主题超过启动器的 64 KiB 上限');
  const theme = JSON.parse(raw.toString('utf8'));
  const { manifest } = exampleManifest('theme-minimal');
  assert.deepEqual(Object.keys(theme).filter(key => !TOP_KEYS.includes(key)), [], '主题出现顶层白名单外的键');
  assert.equal(theme.schema, 1, 'schema 必须是 1');
  assert.equal(theme.id, manifest.id, '主题 id 必须等于清单 id');
  assert.ok([...String(theme.name || '')].length <= 40 && String(theme.name || '').trim(), '主题 name 不合规');

  const hex = /^#[0-9a-fA-F]{6}$/;
  assert.deepEqual(Object.keys(theme.colors).filter(key => !COLOR_TOKENS.includes(key)), [], 'colors 出现白名单外的键');
  for (const [key, value] of Object.entries(theme.colors)) assert.match(value, hex, `colors.${key} 必须是 #RRGGBB`);
  assert.deepEqual(Object.keys(theme.font).filter(key => !FONT_KEYS.includes(key)), [], 'font 出现白名单外的键');
  assert.ok(FONT_FAMILIES.includes(theme.font.family), 'font.family 不在启动器白名单里');
  assert.ok(theme.font.scale >= MIN_SCALE && theme.font.scale <= MAX_SCALE, 'font.scale 超出 0.85–1.15');
  assert.deepEqual(Object.keys(theme.metrics).filter(key => !METRIC_KEYS.includes(key)), [], 'metrics 出现白名单外的键');
  assert.ok(Number.isInteger(theme.metrics.corner) && theme.metrics.corner >= MIN_CORNER && theme.metrics.corner <= MAX_CORNER, 'metrics.corner 超出 0–24');
  assert.ok(theme.metrics.spacing >= MIN_SCALE && theme.metrics.spacing <= MAX_SCALE, 'metrics.spacing 超出 0.85–1.15');
  assert.deepEqual(Object.keys(theme.dialog).filter(key => !DIALOG_KEYS.includes(key)), [], 'dialog 出现白名单外的键');
  assert.match(theme.dialog.surface, hex, 'dialog.surface 必须是 #RRGGBB');
  assert.match(theme.dialog.border, hex, 'dialog.border 必须是 #RRGGBB');
  assert.ok(Number.isInteger(theme.dialog.corner) && theme.dialog.corner >= MIN_CORNER && theme.dialog.corner <= MAX_CORNER, 'dialog.corner 超出 0–24');

  const luminance = value => {
    const channels = [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
      .map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const ratio = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  };
  assert.ok(ratio(theme.colors.text, theme.colors.background) >= TEXT_CONTRAST, '正文与底色对比度不足 4.5');
  assert.ok(ratio(theme.colors.text, theme.colors.surface) >= TEXT_CONTRAST, '正文与卡片底色对比度不足 4.5');
  assert.ok(ratio(theme.colors.text, theme.dialog.surface) >= TEXT_CONTRAST, '正文与弹窗底色对比度不足 4.5');
  assert.ok(ratio(theme.colors.accent, theme.colors.background) >= ACCENT_CONTRAST, '主题色与底色对比度不足 3.0');
  for (const key of ['accent', 'background', 'surface', 'text', 'muted', 'border', 'field']) {
    assert.ok(theme.colors[key], '主题缺少语义色 ' + key);
  }
});

// ---------------------------------------------------------------------------
// 合成 host：真实的 dispatcher + 真实的数据投影 + 真实的 schema 校验，
// 只有「加载入口」和「宿主能力」是本地替身。不 spawn、不联网、不发消息。
// ---------------------------------------------------------------------------

function createSyntheticHost(items) {
  const flows = items.map(item => {
    const providers = loadProviders(item.dir, item.entry);
    return {
      id: item.manifest.id,
      level: item.manifest.level,
      provides: item.manifest.provides,
      calls: item.manifest.calls,
      dataAccess: item.manifest.dataAccess || [],
      settings: item.settings || {},
      executionTimeoutMs: 30000,
      authRevision: 'test',
      providers,
    };
  });
  const runtime = {
    installed: () => flows,
    isApproved: () => true,
    invoke: async (flow, capability, input, { validateOutput } = {}) => {
      const handler = flow.providers[capability];
      assert.equal(typeof handler, 'function', `${flow.id} 没有实现 ${capability}`);
      // 与真实 worker 边界一致：按插件自己的 dataAccess 投影后才交给处理器。
      const projected = projectDataAccess(capability, input, flow.dataAccess);
      const context = Object.freeze({
        host: Object.freeze({ call: (name, value) => dispatcher.invokeHost(name, value, { plugin: flow }) }),
        signal: new AbortController().signal,
        settings: flow.settings,
        state: projected?.state ?? {},
      });
      const output = await handler(projected, context);
      // 真实 runtime 在保存 state 前调用宿主校验；这里保留同一顺序，验证「输出合法才生效」。
      if (typeof validateOutput === 'function') validateOutput(output);
      return output;
    },
  };
  const dispatcher = new UnifiedCapabilityDispatcher({ plugins: runtime, logger: null });
  dispatcher
    .define('chat.pre_reply@1', { builtin: async () => ({ action: 'pass' }) })
    .define('chat.received@1', { builtin: async () => ({}) })
    .define('chat.prompt@1', { builtin: async input => ({ system: input.system }) })
    .define('chat.before_send@1', { builtin: async input => ({ text: input.text }) })
    .define('chat.reply@1', { builtin: async input => ({ text: input.text }) })
    .define('tool.run@1', { builtin: async () => null })
    .define('chat.search@1', { builtin: async () => ({ text: '', items: [], status: 'empty' }) })
    .define('task.tick@1', { builtin: async () => null });
  const hostCalls = [];
  dispatcher.defineHost('status.read@1', () => ({ version: '4.3.0', running: true, pluginProtocol: 'whale-plugin/1' }));
  dispatcher.defineHost('model.complete@1', input => {
    hostCalls.push(input);
    return { text: '这是一句摘要' };
  });
  return { dispatcher, flows, hostCalls, flow: id => flows.find(flow => flow.id === id) };
}

const message = (overrides = {}) => ({
  platform: 'wechat', chatType: 'group', chatId: 'g1', senderId: 'u1', senderName: '群友', text: '在吗', ...overrides,
});

test('gate 示例：安静时段 skip、被叫到 pass、私聊 pass', async () => {
  const { manifest } = exampleManifest('gate-quiet-hours');
  const host = createSyntheticHost([{ dir: 'gate-quiet-hours', entry: 'plugin.js', manifest }]);
  const quiet = new Date(2026, 0, 1, 23, 30).getTime();
  const noon = new Date(2026, 0, 1, 12, 0).getTime();

  const skip = await host.dispatcher.invoke('chat.pre_reply@1',
    { message: message({ atMe: false, replyToBot: false }), localWechat: true, now: quiet }, { key: 'g1' });
  assert.deepEqual(skip, { action: 'skip', reason: 'quiet_hours' });

  const called = await host.dispatcher.invoke('chat.pre_reply@1',
    { message: message({ atMe: true }), localWechat: true, now: quiet }, { key: 'g1' });
  assert.deepEqual(called, { action: 'pass' });

  const noonResult = await host.dispatcher.invoke('chat.pre_reply@1',
    { message: message(), localWechat: true, now: noon }, { key: 'g1' });
  assert.deepEqual(noonResult, { action: 'pass' });

  const privateChat = await host.dispatcher.invoke('chat.pre_reply@1',
    { message: message({ chatType: 'private', atMe: false }), localWechat: false, now: quiet }, { key: 'g1' });
  assert.deepEqual(privateChat, { action: 'pass' });
});

test('prompt 示例：声明 dataAccess 才拿到 system，未声明时读不到也改不动', async () => {
  const { manifest } = exampleManifest('prompt-enhance');
  const granted = { ...manifest, id: 'prompt-enhance' };
  const ungranted = { ...manifest, id: 'prompt-enhance-ungranted', dataAccess: undefined };
  const host = createSyntheticHost([
    { dir: 'prompt-enhance', entry: 'plugin.js', manifest: granted, settings: { suffix: '只用中文回复。' } },
    { dir: 'prompt-enhance', entry: 'plugin.js', manifest: ungranted, settings: {} },
  ]);
  const input = { system: '你是鲸鲸。', message: message() };

  const enhanced = await host.dispatcher.invoke('chat.prompt@1', input, { key: 'g1', pluginId: 'prompt-enhance' });
  assert.deepEqual(enhanced, { system: '你是鲸鲸。\n只用中文回复。' });

  // 设置没填时用代码里的默认值（schema 不注入 default）。
  const defaults = createSyntheticHost([
    { dir: 'prompt-enhance', entry: 'plugin.js', manifest: granted, settings: {} },
  ]);
  const plain = await defaults.dispatcher.invoke('chat.prompt@1', input, { key: 'g1' });
  assert.equal(plain.system, '你是鲸鲸。\n回复用短句，不要输出 Markdown。');

  // 直接验证投影：未授权插件看不到 system，也看不到 enhance 信封里的 system。
  const projected = projectDataAccess('chat.prompt@1',
    { system: 'S', message: message(), output: { system: 'S', state: {} } }, []);
  assert.equal(projected.system, undefined);
  assert.equal(projected.output.system, undefined);
  assert.equal(projected.message.text, '在吗', '投影不能动非敏感字段');

  // 未授权的同名提供者：照旧被调用，但返回的 system 被换回上一层（不是清空）。
  const denied = await host.dispatcher.invoke('chat.prompt@1', input, { key: 'g1', pluginId: 'prompt-enhance-ungranted' });
  assert.equal(denied.system, '你是鲸鲸。');
});

test('工具示例：query 与 model.complete 的字段形状正确', async () => {
  const { manifest, raw } = exampleManifest('tool-node');
  const host = createSyntheticHost([{ dir: 'tool-node', entry: 'plugin.js', manifest }]);
  const flow = host.flow(manifest.id);

  const counted = await host.dispatcher.runTool(manifest.id, { text: '你好' });
  assert.deepEqual(counted, { characters: 2, bytes: 6 });

  const status = await host.dispatcher.runTool(manifest.id, { action: 'status' });
  assert.equal(status.version, '4.3.0');

  const summary = await host.dispatcher.runTool(manifest.id, { action: 'summarize', text: '一段很长的话' });
  assert.deepEqual(summary, { summary: '这是一句摘要' });
  assert.equal(host.hostCalls.length, 1, 'model.complete 应只被调用一次');
  const call = host.hostCalls[0];
  assert.deepEqual(Object.keys(call).sort(), ['maxTokens', 'system', 'turns'], 'model.complete 只接受 system/turns/maxTokens');
  assert.deepEqual(call.turns, [{ role: 'user', content: '一段很长的话' }], '不能把当前消息重复追加成第二条 user turn');
  assert.equal(typeof call.system, 'string');

  // calls 少了 model.complete@1 时，host.call 必须被拒绝（授权面是清单决定的）。
  const narrowed = { ...manifest, calls: ['status.read@1'] };
  const strict = createSyntheticHost([{ dir: 'tool-node', entry: 'plugin.js', manifest: narrowed }]);
  await assert.rejects(
    () => strict.dispatcher.runTool(narrowed.id, { action: 'summarize', text: 'x' }),
    error => error.code === 'host_capability_not_declared',
  );
  assert.ok(raw.length > 0);
});
