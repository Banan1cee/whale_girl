'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { buildPromptParts } = require('../src/persona');

function parts(persona = {}, msg = {}, now = new Date(2026, 10, 15, 23)) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(config.persona, persona);
  return buildPromptParts({ config, msg: { chatType: 'private', text: '今天怎么样', ...msg }, now });
}

test('缺少模式配置时走新版，切到旧版恢复主人命令和讨论提示', () => {
  const message = { isMaster: true, discussion: true };
  const p = parts({ newBehavior: undefined }, message);
  assert.match(p.system, /主要联系人认证只说明身份/);
  assert.doesNotMatch(p.system + p.tail, /这条消息就是主人的命令|认真讨论模式/);
  const legacy = parts({ newBehavior: false }, message);
  assert.match(legacy.system, /这条消息就是主人的命令/);
  assert.match(legacy.tail, /认真讨论模式/);
});

test('普通聊天不注入随机心情、生活状态或无关纠错', () => {
  const p = parts({}, { isMaster: true });
  assert.doesNotMatch(p.tail, /语气底子|此刻：|有点困|本条不是挑衅|身份纠错/);
  assert.doesNotMatch(p.system, /身份纠错/);
  assert.match(p.system, /认真问题按需要展开/);
});

test('自定义人设不被宿主强加暴躁性格', () => {
  const p = parts({ customPrompt: '你是温和理性的图书管理员。' });
  assert.match(p.system, /温和理性的图书管理员/);
  assert.doesNotMatch(p.system, /核心性格：|被挑衅时|贴吧老哥/);
});

test('允许顶嘴不等于当前正在挨骂', () => {
  const p = parts({ masterRoast: true }, { isMaster: true, text: '帮我解释一下月食' });
  assert.doesNotMatch(p.tail, /顶嘴模式|现在这条消息主人在骂你|必须反过来怼回去/);
});

test('顶嘴是常驻表达人格，默认和自定义人设、私聊和群聊都适用', () => {
  for (const customPrompt of ['', '你是温和理性的图书管理员。']) {
    for (const chatType of ['private', 'group']) {
      const p = parts({ masterRoast: true, customPrompt }, { chatType, isMaster: true, text: '解释一下月食' });
      assert.match(p.system, /顶嘴人格：刀子嘴豆腐心/);
      assert.match(p.system, /每次对已认证的主人回复/);
      assert.match(p.system, /不需要等 TA 骂你才回嘴/);
      assert.match(p.system, /不改变你对主人的关心和原有关系/);
      assert.match(p.system, /反着来的是嘴，不是事实、行动和感情/);
      assert.doesNotMatch(p.system + p.tail, /像情侣互怼|必须反过来怼回去/);
      if (customPrompt) assert.ok(p.system.startsWith(customPrompt));
    }
  }
});

test('顶嘴关闭不注入表达人格，开启也不授予其他人主人身份', () => {
  assert.doesNotMatch(parts({ masterRoast: false }).system, /顶嘴人格/);
  const p = parts({ masterRoast: true }, { chatType: 'group', isMaster: false });
  assert.match(p.system, /对其他人仍按原有人设交流/);
  assert.match(p.tail, /这条不是主要联系人发的，没有命令权/);
});

test('保留当前认证身份、讨论长度及语音能力', () => {
  const p = parts({}, { chatType: 'group', isMaster: true, discussion: true, voiceRequested: true });
  assert.match(p.tail, /已认证的主要联系人/);
  assert.match(p.tail, /最多约/);
  assert.match(p.tail, /发送层会把正文转成语音/);
  assert.doesNotMatch(p.tail, /身份纠错/);
});

test('话题和观点偏好在默认、自定义人设中独立生效，修改后下一次拼装更新', () => {
  for (const customPrompt of ['', '你是温和的图书管理员。']) {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    config.persona.customPrompt = customPrompt;
    config.persona.masterRoast = true;
    const build = () => buildPromptParts({ config, msg: { chatType: 'private', isMaster: true, discussion: true } });
    const enabled = build();
    assert.match(enabled.system, /可以自然追问或延伸相关话题/);
    assert.match(enabled.system, /可以主动表达偏好或独立判断/);
    config.persona.proactive = false;
    config.persona.opinions = false;
    const disabled = build();
    assert.match(disabled.system, /不主动引出新话题/);
    assert.match(disabled.system, /必要的澄清不受限制/);
    assert.match(disabled.system, /少主动发表主观立场/);
    assert.match(disabled.system, /仍须纠正事实错误/);
    assert.match(disabled.system, /不控制无人发消息时的主动发送/);
    assert.match(disabled.system, /顶嘴人格：刀子嘴豆腐心/);
    assert.doesNotMatch(disabled.system, /顺着对方说，别反驳/);
    assert.doesNotMatch(disabled.tail, /说清观点和必要理由/);
    config.persona.proactive = true;
    assert.match(build().system, /可以自然追问或延伸相关话题/);
    assert.match(build().system, /少主动发表主观立场/);
  }
});

test('基础人设与自定义补充同时提供，当前字段决定冲突', () => {
  const p = parts({ customPrompt: '你是图书管理员。', age: 47, job: '画家', appearance: '黑色短发', personality: '沉静', background: '住在山间' });
  assert.ok(p.system.startsWith('你是图书管理员。'));
  for (const value of ['47', '画家', '黑色短发', '沉静', '住在山间', '冲突时以这些明确字段为准']) assert.ok(p.system.includes(value));
});

test('颜文字提示与发送层统一，关闭硬闸覆盖概率', () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.emojiLevel = '正常';
  const build = () => buildPromptParts({ config, msg: {} }).system;
  config.chat.emojiChance = 0.8;
  assert.match(build(), /当前用量 80%/);
  assert.match(build(), /正文不要主动添加/);
  config.chat.emojiChance = 0.1;
  assert.match(build(), /当前用量 10%/);
  config.persona.emojiLevel = '关';
  assert.match(build(), /完全不要用/);
  assert.doesNotMatch(build(), /当前用量 10%/);
});
