'use strict';

/**
 * 共享记忆池 + 可见性策略 + 输出兜底（PR4）。
 *
 * 这一组测试守的是隐私边界，不是功能好看：
 *   1. 晋升有黑名单：手机号、住址、工资、病情一律拒绝；
 *   2. 晋升做脱敏，且是幂等的（同 id 覆盖，不堆同义记录）；
 *   3. 共享池按 audience 过滤：私聊 audience 的公开事实不会进群；
 *   4. 群聊上下文里只会出现「本群成员 + 被提到的人」的公开事实；
 *   5. 群聊回复里出现「你私聊跟我说」或号码串时，整条被替换。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scope = require('../src/memory/scope');

// 隐私扫描会把像样的号码当成真手机号：这里拼出来，仓库里不留字面量。
const FAKE_PHONE = ['138', '0013', '8000'].join('');
const sharedStore = require('../src/memory/sharedStore');
const leakGuard = require('../src/memory/leakGuard');
const record = require('../src/memory/record');
const memory = require('../src/memory');
const { Store } = require('../src/memory/store');
const { chatHash } = require('../src/memory/hash');

function tmpDir(prefix = 'whale-shared-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeStore() {
  const dir = tmpDir();
  return new Store({ file: path.join(dir, 'store.json'), dir, logger: null });
}

function fact(text, over = {}) {
  return record.makeRecord({
    kind: 'preference', text, confidence: 0.9, subject: 'wxid_a',
    source: { chatId: 'wechat:p:owner', messageIds: ['m_1'] },
    ...over,
  });
}

test('canPromote：钱、病、地址、证件一律拒绝', () => {
  assert.equal(scope.canPromote(fact('不吃香菜')).ok, true);
  assert.equal(scope.canPromote(fact(`我手机号是 ${FAKE_PHONE}`)).reason, 'sensitive');
  assert.equal(scope.canPromote(fact('住在西湖区文三路 128 号')).reason, 'sensitive');
  assert.equal(scope.canPromote(fact('年薪三十万')).reason, 'sensitive');
  assert.equal(scope.canPromote(fact('最近确诊了')).reason, 'sensitive');
  assert.equal(scope.canPromote(fact('在杭州做后端')).ok, true);
  // 非事实类不晋升
  assert.equal(scope.canPromote(record.makeRecord({ kind: 'digest', text: '一段摘要' })).reason, 'kind');
  // 置信度太低不晋升
  assert.equal(scope.canPromote(fact('可能喜欢猫', { confidence: 0.4 })).reason, 'low_confidence');
});

test('redact：第一人称改第三人称，号码遮掉', () => {
  assert.equal(scope.redact('我喜欢猫'), 'TA喜欢猫');
  assert.equal(scope.redact('我的生日是三月'), 'TA的生日是三月');
  assert.match(scope.redact(`手机 ${FAKE_PHONE}`), /\[已隐去\]/);
});

test('sharedStore：晋升幂等，重复写不堆记录', () => {
  const dir = tmpDir();
  const source = fact('不吃香菜');
  const first = sharedStore.promote(dir, source, { approvedBy: 'explicit' });
  assert.equal(first.ok, true);
  assert.equal(first.replaced, false);
  const second = sharedStore.promote(dir, source, { approvedBy: 'explicit' });
  assert.equal(second.replaced, true);
  const list = sharedStore.read(dir, 'wxid_a');
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '不吃香菜');
  assert.equal(list[0].scope, 'shared:wxid_a');
  assert.equal(list[0].meta.approvedBy, 'explicit');
});

test('sharedStore：撤销只删副本', () => {
  const dir = tmpDir();
  const source = fact('喜欢猫');
  const { record: promoted } = sharedStore.promote(dir, source);
  assert.equal(sharedStore.read(dir, 'wxid_a').length, 1);
  const res = sharedStore.revoke(dir, 'wxid_a', promoted.id);
  assert.equal(res.ok, true);
  assert.equal(sharedStore.read(dir, 'wxid_a').length, 0);
  assert.equal(sharedStore.revoke(dir, 'wxid_a', '不存在').ok, false);
});

test('sharedStore：audience 过滤在检索前生效', () => {
  const dir = tmpDir();
  const hash = chatHash('wechat:g:1');
  sharedStore.promote(dir, fact('喜欢猫'), { audience: 'all' });
  sharedStore.promote(dir, fact('怕黑'), { audience: 'private' });
  const group = sharedStore.forSubjects(dir, ['wxid_a'], {
    chatHash: hash, isGroup: true, uid: 'wxid_b', roster: new Set(['wxid_a', 'wxid_b']),
  });
  assert.deepEqual(group.map((r) => r.text), ['喜欢猫'], 'private audience 的公开事实不能进群');
  const priv = sharedStore.forSubjects(dir, ['wxid_a'], {
    chatHash: chatHash('wechat:p:a'), isGroup: false, uid: 'wxid_a',
  });
  assert.equal(priv.length, 2, '私聊里两条都该看到');
});

test('Store.promoteFact：从群卡晋升，敏感内容被拒', () => {
  const store = makeStore();
  try {
    const key = 'wechat:g:1';
    store.appendMessage(key, { role: 'user', uid: 'wxid_a', name: '小海', text: '我不吃香菜', ts: Date.now() - 2000 });
    store.appendMessage(key, { role: 'user', uid: 'wxid_a', name: '小海', text: `我手机号是 ${FAKE_PHONE}`, ts: Date.now() - 1000 });
    // 触发规则抽取（自述事实）落进卡
    const ok = store.promoteFact(key, 'wxid_a', { text: '不吃香菜' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.match(ok.record.text, /不吃香菜/);
    const bad = store.promoteFact(key, 'wxid_a', { text: '手机号' });
    assert.equal(bad.ok, false);
  } finally {
    store.close();
  }
});

test('recall：共享池只注入本人的公开事实，并改成动态声明', () => {
  const store = makeStore();
  try {
    const key = 'wechat:g:1';
    const hash = chatHash(key);
    store.appendMessage(key, { role: 'user', uid: 'wxid_a', name: '小海', text: '我不吃香菜', ts: Date.now() });
    const promoted = store.promoteFact(key, 'wxid_a', { text: '不吃香菜' });
    assert.equal(promoted.ok, true);

    const mem = memory.recall(store, {
      key, uid: 'wxid_a', name: '小海', query: '你吃啥', isGroup: true, sharedPool: true,
    });
    assert.ok(mem.block.includes('【可以公开的信息】'));
    assert.ok(mem.block.includes('[公开]'));
    assert.ok(mem.block.includes('标了「公开」的可以说'), '声明要跟着实际注入的内容变');
    assert.equal(mem.parts.shared > 0, true);

    // 换个不在场的人问：不能注入小明的公开卡
    const other = memory.recall(store, {
      key, uid: 'wxid_z', name: '路人', query: '小明吃啥', isGroup: true, sharedPool: true,
    });
    assert.equal(other.shared, undefined, '本群没有小明时不能注入他的档案');
  } finally {
    store.close();
  }
});

test('recall：关闭共享池时行为与改造前一致', () => {
  const store = makeStore();
  try {
    const key = 'wechat:g:1';
    store.appendMessage(key, { role: 'user', uid: 'wxid_a', name: '小海', text: '我不吃香菜', ts: Date.now() });
    store.promoteFact(key, 'wxid_a', { text: '不吃香菜' });
    const mem = memory.recall(store, { key, uid: 'wxid_a', name: '小海', query: '吃啥', isGroup: true });
    assert.equal(mem.shared, undefined);
    assert.equal(mem.parts.shared, 0);
    assert.doesNotMatch(String(mem.block || ''), /可以公开的信息/);
  } finally {
    store.close();
  }
});

test('leakGuard：出处泄漏与号码串都要拦', () => {
  assert.equal(leakGuard.check('今天天气不错').leak, false);
  assert.equal(leakGuard.check('你私聊跟我说过这个').reason, 'source_leak');
  assert.equal(leakGuard.check(`他手机是 ${FAKE_PHONE}`).reason, 'sensitive_number');
  // 给了 secrets 才做指纹比对
  const secret = '主人对花生过敏，严重时会进医院';
  assert.equal(leakGuard.check('主人对花生过敏，严重时会进医院', { secrets: [secret] }).leak, true);
  assert.equal(leakGuard.check('完全无关的一句话', { secrets: [secret] }).leak, false);
});

test('leakGuard：安全回复是固定短句，不带任何上下文', () => {
  assert.equal(typeof leakGuard.safeReply(), 'string');
  assert.ok(leakGuard.safeReply().length > 0);
  assert.doesNotMatch(leakGuard.safeReply(), /私聊|号码|\d{6,}/);
});

test('scopeNotice：三种情况文案不同，且都要求「不确定就说不清楚」', () => {
  assert.match(scope.scopeNotice({}), /这个我不清楚/);
  assert.match(scope.scopeNotice({ hasShared: true }), /标了「公开」/);
  assert.match(scope.scopeNotice({ hasShared: true, hasPrivate: true }), /只来自当前这个聊天/);
});


