'use strict';
// 协议层是前台/工人唯一的接口，出错就等于消息发错人，所以这里测的是「容错」而不是「精确」。

const assert = require('assert');
const p = require('../lib/protocol');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (err) { failed += 1; console.log('FAIL ' + name + ' :: ' + err.message); }
}

test('三个标记都能切出来', () => {
  const d = p.parseDesk('【回复客户】好的，明天给你\n【派单】做官网首页\n【需求更新】- 要手机端\n- 要备案');
  assert.strictEqual(d.reply, '好的，明天给你');
  assert.strictEqual(d.dispatch, '做官网首页');
  assert.deepStrictEqual(d.requirements, ['要手机端', '要备案']);
  assert.strictEqual(d.matched, true);
});

test('没有标记时整段话当回复', () => {
  const d = p.parseDesk('这个我先记下了，晚点回你');
  assert.strictEqual(d.reply, '这个我先记下了，晚点回你');
  assert.strictEqual(d.dispatch, null);
  assert.deepStrictEqual(d.requirements, []);
});

test('只有派单没有回复时回复为空（交给编排层兜底）', () => {
  const d = p.parseDesk('【派单】先跑一遍构建');
  assert.strictEqual(d.reply, '');
  assert.strictEqual(d.dispatch, '先跑一遍构建');
});

test('同一标记出现两次按顺序拼接', () => {
  const d = p.parseDesk('【回复客户】第一句\n【回复客户】第二句');
  assert.strictEqual(d.reply, '第一句\n第二句');
});

test('标记名前后有空格也能认', () => {
  const d = p.parseDesk('【 回复客户 】带空格的标记');
  assert.strictEqual(d.reply, '带空格的标记');
});

test('工人三段解析', () => {
  const w = p.parseWorker('【给前台】页面做好了\n【需要确认】域名用哪个\n【产出】index.html\nstyles.css');
  assert.strictEqual(w.report, '页面做好了');
  assert.deepStrictEqual(w.questions, ['域名用哪个']);
  assert.deepStrictEqual(w.outputs, ['index.html', 'styles.css']);
});

test('工人没有标记时整段当汇报', () => {
  const w = p.parseWorker('构建跑通了，产物在 dist');
  assert.strictEqual(w.report, '构建跑通了，产物在 dist');
  assert.deepStrictEqual(w.questions, []);
});

test('微信清洗：去掉 markdown 和列表符号', () => {
  const out = p.cleanForWeChat('**加粗**\n```js\ncode\n```\n- 第一条\n- 第二条\n#### 小标题');
  assert.ok(!out.includes('*'), '不该留星号：' + out);
  assert.ok(!out.includes('```'), '不该留代码围栏：' + out);
  assert.ok(out.includes('第一条'), '内容要保留：' + out);
});

test('微信清洗：超长截断带省略号', () => {
  const out = p.cleanForWeChat('一'.repeat(50), 10);
  assert.strictEqual(out.length, 10);
  assert.ok(out.endsWith('…'));
});

test('微信清洗：收尾的逗号句号不留在省略号前', () => {
  const out = p.cleanForWeChat('一二三四五六七八九，十', 6);
  assert.strictEqual(out, '一二三四五…');
});

test('前台任务单里必须有档案、原话和输出格式', () => {
  const task = p.buildDeskTask({ orderMd: '【需求】官网', customerText: '我要个官网', status: 'intake' });
  assert.ok(task.includes('【需求】官网'));
  assert.ok(task.includes('我要个官网'));
  assert.ok(task.includes('【回复客户】'));
  assert.ok(task.includes('【派单】'));
  assert.ok(task.includes('不要暴露身份') || task.includes('不暴露身份'));
});

test('前台任务单带上工程的汇报和待确认', () => {
  const task = p.buildDeskTask({
    orderMd: '【需求】官网',
    customerText: '怎么样了',
    status: 'working',
    workerReport: '首页做好了',
    workerQuestions: ['域名用哪个', '要不要备案'],
  });
  assert.ok(task.includes('首页做好了'));
  assert.ok(task.includes('- 域名用哪个'));
  assert.ok(task.includes('- 要不要备案'));
});

test('工人任务单强调不对客户说话、要动手', () => {
  const task = p.buildWorkerTask({ orderMd: '【需求】官网', dispatch: '做首页', customerText: '快点' });
  assert.ok(task.includes('做首页'));
  assert.ok(task.includes('不直接对客户说话'));
  assert.ok(task.includes('该动手就动手'));
  assert.ok(task.includes('【给前台】'));
});

test('人设里写死了不许承诺价格/工期', () => {
  assert.ok(p.DESK_PERSONA.includes('价格'));
  assert.ok(p.DESK_PERSONA.includes('不承诺') || p.DESK_PERSONA.includes('一律不承诺'));
  assert.ok(p.DESK_PERSONA.includes('不暴露身份'));
});

test('拆气泡：短句只有一条', () => {
  assert.deepStrictEqual(p.splitBubbles('在的，想做什么项目？', 180), ['在的，想做什么项目？']);
});

test('拆气泡：长文按句末断开，且每条不超上限太多', () => {
  const long = '第一句说需求。第二句问预算！第三句讲工期？第四句补一句别的。'.repeat(4);
  const bubbles = p.splitBubbles(long, 40);
  assert.ok(bubbles.length > 1, '应该拆成多条');
  for (const b of bubbles) assert.ok(b.length <= 40, '单条太长：' + b.length);
  assert.strictEqual(bubbles.join(''), long.replace(/\s/g, ''));
});

test('拆气泡：没有句末标点就硬切，不丢字', () => {
  const text = '一'.repeat(500);
  const bubbles = p.splitBubbles(text, 100);
  assert.ok(bubbles.every((b) => b.length <= 100));
  assert.strictEqual(bubbles.join('').length, 500);
});

test('拆气泡：空串返回空数组', () => {
  assert.deepStrictEqual(p.splitBubbles('   ', 100), []);
  assert.deepStrictEqual(p.splitBubbles(null, 100), []);
});

process.exitCode = failed ? 1 : 0;
console.log(failed ? ('FAILED ' + failed) : 'ALL PASS');
