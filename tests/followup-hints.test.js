'use strict';

/**
 * 追问信号（对应大肥鱼的 FOLLOW_UP_HINTS）。
 *
 * 大肥鱼的配置界面里有一行「追问信号（逗号分隔）」，用户自己往里加词：
 * 听到这些词就当是在跟 AI 说话，可以接着回。移植到鲸鲸后：
 *   - 词表存在 config.group.assistantHints，默认空（只用内置的 FALLBACK_HINTS）；
 *   - 内核用 followup.hasFollowupCue 判断，太弱的词（"你""吗""哈哈"）写了也忽略；
 *   - 设置接口收到的是逗号分隔的字符串，coerceValue 负责拆成数组，
 *     configSchema 的 list 类型负责拦住「空项 / 超长 / 太多项」。
 *
 * 这里把三层都测一遍：纯函数、判定链（assistantMode.judge）、配置读写。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const followup = require('../src/core/followup');
const assistantMode = require('../src/core/assistantMode');
const { loadConfig } = require('../src/infra/config');
const { validate, checkValue } = require('../src/infra/configSchema');
const { applyConfigPatch } = require('../src/infra/configPatch');

const NOW = new Date('2026-10-31T10:00:00+08:00').getTime();

function makeRuntime(configPatch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-hints-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(configPatch));
  const config = loadConfig({ root, env: {} });
  const runtime = {
    config,
    logger: { info() {}, warn() {}, error() {}, close() {} },
    llm: { reload() {} },
  };
  return {
    runtime,
    root,
    configFile: path.join(root, 'config.json'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }),
  };
}

function state(over = {}) {
  return {
    followLeft: 0,
    followInterrupted: false,
    lastBotAt: 0,
    lastBotText: '',
    lastBotSenderId: '',
    ...over,
  };
}

function judge(text, { hints = [], st, feature = true } = {}) {
  return assistantMode.judge({
    config: {
      group: { assistantTurns: 3, assistantSeconds: 180, assistantHints: hints },
      features: { assistantMode: feature },
      persona: { name: '鲸鲸', aliases: ['小鲸'] },
    },
    msg: { senderId: 'u1', isGroup: true, otherMemberNames: [] },
    clean: { text },
    state: st || state({ followLeft: 3, lastBotSenderId: 'u1', lastBotAt: NOW - 5 * 1000 }),
    nowMs: NOW,
  });
}

/* ---------------- 纯函数层 ---------------- */

test('用户自己加的追问信号会命中', () => {
  // 「隔壁」不在内置词表里，但用户把它写进了追问信号
  assert.equal(followup.hasFollowupCue('隔壁那家店还开着吗', { hints: [] }), false);
  assert.equal(followup.hasFollowupCue('隔壁那家店还开着吗', { hints: ['隔壁'] }), true);
});

test('太弱的词写进追问信号也不生效（和内置 WEAK_HINTS 一致）', () => {
  for (const weak of followup.WEAK_HINTS) {
    assert.equal(
      followup.hasFollowupCue('今天真是' + weak + '啊', { hints: [weak] }),
      false,
      `「${weak}」不该单独触发接话`
    );
  }
});

test('追问信号里的空白项 / 非字符串被忽略，不会炸', () => {
  assert.equal(followup.hasFollowupCue('隔壁那家店', { hints: ['  ', null, 3, '隔壁'] }), true);
  assert.equal(followup.hasFollowupCue('今天天气不错', { hints: ['  ', '', null] }), false);
});

test('「你们 / 大家」+ 没有具体指代时，追问信号也不救场', () => {
  // 泛称场景先拦住，否则旁人的感慨会被当成接话（对应大肥鱼 has_followup_cue 里那段）
  assert.equal(followup.hasFollowupCue('你们周末去哪了', { hints: ['周末'] }), false, '纯泛称不接');
  assert.equal(followup.hasFollowupCue('你们刚才说那个', { hints: ['刚才'] }), true, '带具体指代就该接');
});

/* ---------------- 判定链：小助手模式 ---------------- */

test('追问信号配置后，同一人的追问会被放行（wake + followup）', () => {
  assert.equal(judge('隔壁那家店还开着吗', { hints: [] }), null);
  const fired = judge('隔壁那家店还开着吗', { hints: ['隔壁'] });
  assert.ok(fired);
  assert.equal(fired.wake, true);
  assert.equal(fired.reason, 'followup');
});

test('追问信号只对「她还开着窗口的那个人」有效，别人说了照样收口', () => {
  const st = state({ followLeft: 3, lastBotSenderId: 'u1', lastBotAt: NOW - 5 * 1000 });
  const out = assistantMode.judge({
    config: {
      group: { assistantTurns: 3, assistantSeconds: 180, assistantHints: ['隔壁'] },
      features: { assistantMode: true },
      persona: { name: '鲸鲸', aliases: [] },
    },
    msg: { senderId: 'u2', isGroup: true, otherMemberNames: [] },
    clean: { text: '隔壁那家店还开着吗' },
    state: st,
    nowMs: NOW,
  });
  assert.equal(out, null, '别人插话不接');
  assert.equal(st.followInterrupted, true, '而且窗口当场收口');
});

test('开关关掉后，追问信号也不起作用', () => {
  assert.equal(judge('隔壁那家店还开着吗', { hints: ['隔壁'], feature: false }), null);
});

/* ---------------- 配置层：list 类型与逗号拆分 ---------------- */

test('默认配置里追问信号是空数组，且默认配置没有校验错误', () => {
  const { runtime, cleanup } = makeRuntime();
  assert.deepEqual(runtime.config.group.assistantHints, []);
  assert.deepEqual(validate(runtime.config), []);
  cleanup();
});

test('设置接口把逗号分隔的字符串拆成数组并落盘', () => {
  const { runtime, configFile, cleanup } = makeRuntime();
  applyConfigPatch(runtime, { 'group.assistantHints': '最近, 忙啥,, 隔壁 ' });
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(saved.group.assistantHints, ['最近', '忙啥', '隔壁']);
  assert.deepEqual(runtime.config.group.assistantHints, ['最近', '忙啥', '隔壁']);
  cleanup();
});

test('数组形式的追问信号也能直接保存（接口 / config.json 两种写法都认）', () => {
  const { runtime, cleanup } = makeRuntime();
  applyConfigPatch(runtime, { 'group.assistantHints': ['最近', '隔壁'] });
  assert.deepEqual(runtime.config.group.assistantHints, ['最近', '隔壁']);
  cleanup();
});

test('list 类型校验：空项、超长、太多项都会被指出来', () => {
  const spec = { type: 'list', maxItems: 3, maxItemLen: 4 };
  assert.equal(checkValue(['最近', '忙啥'], spec), null);
  assert.match(checkValue(['最近', ''], spec), /空项/);
  assert.match(checkValue(['太长太长太长'], spec), /最多 4 个字符/);
  assert.match(checkValue(['a', 'b', 'c', 'd'], spec), /最多 3 项/);
  assert.match(checkValue('最近,忙啥', spec), /列表/);
  assert.match(checkValue([1], spec), /字符串/);
});

test('非法追问信号会在校验里带路径报出来，不会静默吞掉', () => {
  const long = 'x'.repeat(40);
  const errors = validate({ group: { assistantHints: [long] } });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, 'group.assistantHints');
  assert.match(errors[0].message, /太长/);
});

test('清空追问信号（空数组）是合法的，等于只用内置词表', () => {
  const { runtime, cleanup } = makeRuntime({ group: { assistantHints: ['放这里'] } });
  applyConfigPatch(runtime, { 'group.assistantHints': '' });
  assert.deepEqual(runtime.config.group.assistantHints, []);
  assert.deepEqual(validate(runtime.config), []);
  cleanup();
});
