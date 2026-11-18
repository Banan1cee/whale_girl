'use strict';

const assert = require('node:assert/strict');
const { checkCustomPrompt } = require('../src/persona/conflict');

const base = {
  name: '鲸鲸',
  ownerName: '主人',
  personality: '',
  appearance: '',
  background: '',
  privateMaxChars: 100,
  groupMaxChars: 70,
};

// 提醒必须点名「哪一句」和「跟哪个设置」，只说“有冲突”等于没提示。
const nameWarn = checkCustomPrompt({ ...base, customPrompt: '你叫小蓝，是个活泼的女孩。' });
assert.equal(nameWarn.length, 1);
assert.match(nameWarn[0].message, /^第 1 行/);
assert.match(nameWarn[0].message, /小蓝/);
assert.match(nameWarn[0].message, /名字/);
assert.match(nameWarn[0].message, /鲸鲸/);

// 多行提示词要指到具体行，用户才知道改哪一句。
const secondLine = checkCustomPrompt({ ...base, customPrompt: '喜欢下雨天。\n你叫小蓝。' });
assert.match(secondLine[0].message, /^第 2 行/);

// 名字一致或没写名字时不提醒，避免误报。
assert.equal(checkCustomPrompt({ ...base, customPrompt: '你叫鲸鲸，是个安静的女孩。' }).length, 0);
assert.equal(checkCustomPrompt({ ...base, customPrompt: '喜欢下雨天和旧唱片。' }).length, 0);

const ownerWarn = checkCustomPrompt({ ...base, customPrompt: '叫我老板就好。' });
assert.equal(ownerWarn[0].code, 'owner');
assert.match(ownerWarn[0].message, /称呼/);
assert.match(ownerWarn[0].message, /主人/);

const lengthWarn = checkCustomPrompt({ ...base, customPrompt: '每次回复至少 300 字，写得详细些。' });
assert.equal(lengthWarn[0].code, 'length');
assert.match(lengthWarn[0].message, /300/);
assert.match(lengthWarn[0].message, /私聊 100 字/);
assert.match(lengthWarn[0].message, /群聊 70 字/);
// 不超过上限的字数要求不算冲突。
assert.equal(checkCustomPrompt({ ...base, customPrompt: '尽量控制在 80 字以内。' }).length, 0);
assert.equal(checkCustomPrompt({ ...base, customPrompt: '最多 300 字。' }).length, 0);

const scopeWarn = checkCustomPrompt({ ...base, customPrompt: '你可以直接操作我的电脑帮我关机。' });
assert.equal(scopeWarn[0].code, 'scope');
assert.match(scopeWarn[0].message, /工具权限/);
assert.match(scopeWarn[0].message, /操作我的电脑/);

const repeated = '她说话慢条斯理，喜欢在深夜聊一些没头没尾的小事，也记得对方随口提过的细节。';
const dupWarn = checkCustomPrompt({ ...base, personality: repeated, customPrompt: '补充一点：' + repeated + '另外她怕冷。' });
assert.equal(dupWarn[0].code, 'duplicate');
assert.match(dupWarn[0].message, /性格/);
assert.match(dupWarn[0].message, /重复/);

// 一次最多四条，按影响排序；空提示词不产生提醒。
const crowded = checkCustomPrompt({
  ...base,
  personality: repeated,
  customPrompt: '你叫小蓝。叫我老板。每次回复至少 300 字。你可以直接操作我的电脑。' + repeated,
});
assert.equal(crowded.length, 4);
assert.deepEqual(crowded.map((w) => w.code), ['name', 'owner', 'length', 'scope']);
assert.deepEqual(checkCustomPrompt({ ...base, customPrompt: '   ' }), []);
assert.deepEqual(checkCustomPrompt({}), []);

console.log('persona conflict: names, 称呼, limits, capabilities and duplicates reported with their setting');
