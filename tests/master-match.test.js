'use strict';

/**
 * 主人判定的唯一实现（src/core/master.js）：微信里认 wxid，网页等没有稳定 id 的渠道才认昵称；
 * 配了真 wxid 时昵称冒充无效，但 wxid 栏里错填成微信号时要能提示、别把主人永远挡在外面。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { matchMaster, masterWarnings, looksLikeWxid } = require('../src/core/master');

const cfg = (names, wxids) => ({ persona: { master: { names, wxids } } });
const wechat = (senderId, senderName) => ({ platform: 'wechat', senderId, senderName });

test('wxid 对上就是主人，昵称改成什么都认', () => {
  const r = matchMaster(cfg(['阿鲸'], ['wxid_master_test']), wechat('wxid_master_test', '随便改的昵称'));
  assert.equal(r.isMaster, true);
  assert.equal(r.reason, 'wxid');
});

test('配了真 wxid 时，光把昵称改成主人名字冒充不了', () => {
  const r = matchMaster(cfg(['阿鲸'], ['wxid_master_test']), wechat('wxid_fake', '阿鲸'));
  assert.equal(r.isMaster, false);
  assert.equal(r.reason, 'name_blocked');
  assert.equal(r.nameHit, true);
});

test('wxids 错填成微信号（不是 wxid_ 开头）时，昵称还能兜底', () => {
  const r = matchMaster(cfg(['阿鲸'], ['my_own_wechat_id']), wechat('wxid_master_test', '阿鲸'));
  assert.equal(r.isMaster, true);
  assert.equal(r.reason, 'nickname');
  assert.deepEqual(r.hardIds, []);
});

test('一条真 wxid + 一条错填的，仍然只认真 wxid', () => {
  const r = matchMaster(cfg([], ['my_own_wechat_id', 'wxid_master_test']), wechat('wxid_fake', '阿鲸'));
  assert.equal(r.isMaster, false);
});

test('没配主人时谁都不是主人，也不叫主人', () => {
  for (const id of ['wxid_any', '']) {
    const r = matchMaster(cfg([], []), wechat(id, '阿鲸'));
    assert.equal(r.isMaster, false);
  }
});

test('没有稳定 id 的渠道（网页）按昵称认（忽略大小写）', () => {
  const r = matchMaster(cfg(['A-Jing'], ['wxid_master_test']), { platform: 'web', senderId: 'web-u-abc', senderName: 'a-jing' });
  assert.equal(r.isMaster, true);
  assert.equal(r.reason, 'nickname');
});

test('大小写和首尾空格都能容错（昵称列表容易带空格）', () => {
  const r = matchMaster(cfg(['  阿鲸 '], ['  WXID_MASTER_TEST  ']), wechat('wxid_master_test', '阿鲸'));
  assert.equal(r.isMaster, true);
  assert.equal(r.reason, 'wxid');
});

test('wxids 里填微信号会给出人话告警', () => {
  const warn = masterWarnings(cfg(['阿鲸'], ['my_own_wechat_id']));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /不是 wxid/);
});

test('主人 wxid 填成机器人自己的账号时给出提示', () => {
  const warn = masterWarnings({
    persona: { master: { names: [], wxids: ['wxid_master_test_c248'] } },
    wechat: { account: 'wxid_master_test_c248' },
  });
  assert.equal(warn.length, 1);
  assert.match(warn[0], /机器人当前登录的账号/);
});

test('只填昵称时提醒可能被冒充', () => {
  const warn = masterWarnings(cfg(['阿鲸'], []));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /只靠昵称/);
});

test('没配主人时提醒未设置', () => {
  const warn = masterWarnings(cfg([], []));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /还没设置主人/);
});

test('选择式配置的名字和 wxid 成对时没有告警', () => {
  assert.deepEqual(masterWarnings(cfg(['阿鲸'], ['wxid_master_test'])), []);
});

test('主人 wxid 填成账号目录名（多 4 位哈希）也认', () => {
  // 启动器账号列表显示的就是 wxid_xxx_c248，用户复制进去很常见；
  // 消息里的 senderId 却是真 wxid_xxx，不归一化就永远「非主人」。
  const r = matchMaster(cfg([], ['wxid_master_test_c248']), wechat('wxid_master_test', '阿鲸'));
  assert.equal(r.isMaster, true);
  assert.equal(r.reason, 'wxid');
});

test('looksLikeWxid 认得清 wxid 和微信号', () => {
  assert.equal(looksLikeWxid('wxid_master_test'), true);
  assert.equal(looksLikeWxid('my_own_wechat_id'), false);
  assert.equal(looksLikeWxid('阿鲸'), false);
  assert.equal(looksLikeWxid(''), false);
});
