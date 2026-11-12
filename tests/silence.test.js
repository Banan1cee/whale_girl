'use strict';

/**
 * 「让她滚就该群里静默，没人 @ 她别说话」的回归测试。
 *
 * 三个问题叠在一起：
 *   1. 「让她滚」是第三人称，dismiss 正则只认「你滚 / 滚」这种直接命令 → 根本没进静默。
 *   2. INSULT_RE 里就有「滚」，而且两处都是**裸匹配**（不管在说谁）：群里任何人抱怨
 *      「这天气真垃圾」「股票跌了滚蛋吧」，她都当成在骂自己，跳出来对喷 —— 也就是
 *      「没人 @ 她，她还在说话」。
 *   3. 静默期的优先级低于 masterAlwaysReply，主人说完「让她滚」，下一句又把她叫起来。
 *
 * 另外要保住一条底线：静默期内只有主人 @ / 回复她能唤醒，群友喊不回来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

function makeBot(over = {}) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.persona.master = { names: ['主人'], wxids: ['wxid_master'] };
  cfg.admin = { spell: 'test-spell', minutes: 30, allowAll: false };
  Object.assign(cfg.group, over.group || {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-silence-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: cfg.memory });
  const llm = { isMock: true, model: 'mock', reload() {}, describe: () => ({}) };
  const bot = new Bot({ config: cfg, store, llm, logger: null, mockChunkDelayMs: 0 });
  return {
    bot,
    cleanup() {
      try { store.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    },
  };
}

const groupMsg = (text, extra = {}) => ({
  platform: 'web',
  chatId: 'g1',
  chatType: 'group',
  senderId: 'u2',
  senderName: '阿螈',
  chatTitle: '深海鱼塘',
  text,
  ...extra,
});

test('「让她滚」这种第三人称也算赶她走，进静默', async () => {
  const { bot, cleanup } = makeBot();
  try {
    // 先让她进入接话状态
    await bot.handle(groupMsg('@鲸鲸 在吗', { atMe: true }));

    const r = await bot.handle(groupMsg('让她滚'));
    assert.equal(r.action, 'reply', '赶她走时要回一句再退场');
    assert.equal(r.reason, 'dismissed', '要识别成 dismissed，实际：' + r.reason);

    // 之后群里闲聊一律不理
    for (const line of ['今天中午吃啥', '不知道啊']) {
      const x = await bot.handle(groupMsg(line));
      assert.equal(x.action, 'ignore', '被赶走后不该再说话：' + line);
      assert.equal(x.reason, 'silent', '原因应该是静默，实际：' + x.reason);
    }
  } finally {
    cleanup();
  }
});

test('群里 @她 闭嘴 / 滚：人设名、别名、桥接 self_names 都按项目识别', async () => {
  const { bot, cleanup } = makeBot();
  try {
    // 1) 人设别名：项目里就是配在 persona.aliases
    bot.config.persona.aliases = ['大肥鱼'];
    let r = await bot.handle(groupMsg('@大肥鱼 闭嘴', { atMe: true, chatId: 'g-alias', msgId: 'a1' }));
    assert.equal(r.reason, 'dismissed', '别名 + @ 要静默');
    r = await bot.handle(groupMsg('大肥鱼 滚', { chatId: 'g-alias-2', msgId: 'a2' }));
    assert.equal(r.reason, 'dismissed', '别名 + 没 @ 也要认出是在赶她');

    // 2) 桥接上报的 self_names（账号昵称/备注走这里）
    r = await bot.handle(groupMsg('@新昵称 闭嘴', { atMe: true, selfNames: ['新昵称'], chatId: 'g-self', msgId: 'b1' }));
    assert.equal(r.reason, 'dismissed', 'self_names 是项目识别的一部分');

    // 3) 刚改名、配置和桥接都还没刷新，但桥接确认 @ 的是她：兜底剥掉 @ 前缀
    r = await bot.handle(groupMsg('@刚改的名 闭嘴', { atMe: true, chatId: 'g-new', msgId: 'c1' }));
    assert.equal(r.reason, 'dismissed', 'atMe 时名字不该挡住退场');
  } finally {
    cleanup();
  }
});

test('群里没人 @ 她、只是路人闲聊里带脏字，她不该跳出来', async () => {
  const { bot, cleanup } = makeBot();
  try {
    // 先让她说过话（进入接话窗口的是另一个人）
    await bot.handle(groupMsg('@鲸鲸 在吗', { atMe: true, senderId: 'u2' }));

    // 路人在群里闲聊，说的是别人/别的事，不是骂她
    const chatter = [
      { senderId: 'u3', senderName: '路人甲', text: '滚啊这天气' },
      { senderId: 'u4', senderName: '路人乙', text: '今天股票又跌了，滚蛋吧' },
      { senderId: 'u5', senderName: '路人丙', text: '刚才那个电影真垃圾' },
      { senderId: 'u6', senderName: '路人丁', text: '这破网速真没用' },
      { senderId: 'u7', senderName: '路人戊', text: '烦死了，闭嘴吧这破系统' },
    ];
    for (const m of chatter) {
      const x = await bot.handle(groupMsg(m.text, m));
      assert.equal(
        x.action,
        'ignore',
        '路人闲聊里的脏字不是在骂她，不该回：' + m.text + '（实际 ' + x.action + ' / ' + x.reason + '）'
      );
    }
  } finally {
    cleanup();
  }
});

test('真在骂她（点名 / @ 她）还是要回', async () => {
  const { bot, cleanup } = makeBot();
  try {
    // 点名她的：不管有没有 @ 都算冲她
    for (const line of ['鲸鲸你个智障', '机器人真垃圾']) {
      const x = await bot.handle(groupMsg(line));
      assert.equal(
        x.action,
        'reply',
        '点名骂她必须回（不能为了安静把该怼的也掐掉）：' + line + '（实际 ' + x.action + ' / ' + x.reason + '）'
      );
    }
    // 带 @ 的：哪怕只有「你」也知道在骂她
    const x = await bot.handle(groupMsg('你是不是傻逼', { atMe: true }));
    assert.equal(x.action, 'reply', '@ 她说「你是不是傻逼」必须回');
  } finally {
    cleanup();
  }
});

test('没有 @、也没点名，光一句「你是不是傻逼」不接（可能是在骂别人）', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const x = await bot.handle(groupMsg('你是不是傻逼'));
    assert.equal(
      x.action,
      'ignore',
      '群里没 @ 没点名，这句可能是在骂别人，不该自己认领'
    );
  } finally {
    cleanup();
  }
});

test('静默期内只有主人 @ 能唤醒，群友 @ 不回来', async () => {
  const { bot, cleanup } = makeBot();
  try {
    await bot.handle(groupMsg('@鲸鲸 在吗', { atMe: true }));
    await bot.handle(groupMsg('让她滚'));

    // 静默中
    const quiet = await bot.handle(groupMsg('随便聊聊'));
    assert.equal(quiet.action, 'ignore');

    // 群友 @ 她也不回来（改了：以前任何人都能 @ 醒）
    const stranger = await bot.handle(groupMsg('@鲸鲸 在吗', { atMe: true }));
    assert.equal(stranger.action, 'ignore', '静默期内群友 @ 不该唤醒');
    assert.equal(stranger.reason, 'silent');

    // 主人 @ 才回来
    const back = await bot.handle(groupMsg('@鲸鲸 在吗', {
      atMe: true, platform: 'wechat', senderId: 'wxid_master', senderName: '主人',
    }));
    assert.equal(back.action, 'reply', '主人 @ 必须能唤醒');
    assert.equal(back.reason, 'addressed');

    // 唤醒之后，主人接着说（不用再 @）又能接
    const after = await bot.handle(groupMsg('今天吃啥', {
      msgId: 'after', platform: 'wechat', senderId: 'wxid_master', senderName: '主人',
    }));
    assert.equal(after.action, 'reply', '被唤醒后接话窗口要重新打开');
  } finally {
    cleanup();
  }
});

test('静默标记 ((silence)) 和表情包 [[sticker]] 彻底分开，不冲突', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const decide = (id, chatId) => bot.decide(groupMsg('@鲸鲸 在吗', { atMe: true, msgId: id, chatId }));

    // 两个标记相邻：各自剥掉、各自生效
    const a = await decide('a', 'g-both-1');
    const bubbles = bot.finalize(a, '行[[sticker:开心]]((silence:7))');
    assert.doesNotMatch(bubbles.join('|'), /sticker|silence/i, '两个标记都不能漏给用户');
    assert.equal(a.stickerCategory, '开心', '表情包分类要正常拿到');
    const m1 = (Number(bot.store.getState(a.key).silentUntil) - Date.now()) / 60000;
    assert.ok(m1 > 5 && m1 <= 7.5, '静默也要正常生效，实际 ' + m1.toFixed(2));

    // 顺序反过来
    const b = await decide('b', 'g-both-2');
    bot.finalize(b, '((silence:3))[[sticker:炸毛]]好');
    assert.equal(b.stickerCategory, '炸毛');
    const m2 = (Number(bot.store.getState(b.key).silentUntil) - Date.now()) / 60000;
    assert.ok(m2 > 1 && m2 <= 3.5);

    // 没闭合、写「10分钟」也要能认
    const c = await decide('c', 'g-both-3');
    const cb = bot.finalize(c, '行((silence:10');
    assert.doesNotMatch(cb.join('|'), /silence/i, '半截标记不能外泄');
    const m3 = (Number(bot.store.getState(c.key).silentUntil) - Date.now()) / 60000;
    assert.ok(m3 > 8 && m3 <= 10.5);

    const d = await decide('d', 'g-both-4');
    bot.finalize(d, '行((silence 10分钟))');
    const m4 = (Number(bot.store.getState(d.key).silentUntil) - Date.now()) / 60000;
    assert.ok(m4 > 8 && m4 <= 10.5, '带「分钟」也要认，实际 ' + m4.toFixed(2));

    // 旧的方括号写法不再生效；[[sticker:silence]] 也只当表情包分类
    const e = await decide('e', 'g-both-5');
    bot.finalize(e, '行[[silence:4]]');
    assert.equal(Number(bot.store.getState(e.key).silentUntil) || 0, 0, '旧的 [[silence:]] 不再兼容');
    const f = await decide('f', 'g-both-6');
    bot.finalize(f, '行[[sticker:silence]]');
    assert.equal(Number(bot.store.getState(f.key).silentUntil) || 0, 0, '表情包分类叫 silence 不能触发静默');
  } finally {
    cleanup();
  }
});

test('模型被赶时写 ((silence:分钟))：宿主执行静默并把标记剥干净', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const d = await bot.decide(groupMsg('@鲸鲸 在吗', { atMe: true }));
    const bubbles = bot.finalize(d, '好，那我闭嘴 ((silence:5))');
    const joined = bubbles.join('|');
    assert.doesNotMatch(joined, /silence/i, '标记不能漏给用户');
    const until = Number(bot.store.getState(d.key).silentUntil);
    const mins = (until - Date.now()) / 60000;
    assert.ok(mins > 3 && mins <= 5.5, '应静默约 5 分钟，实际 ' + mins.toFixed(2));

    // 没被 @ / 不是主人：标记不生效，但也不会外泄（换一个群，避免读到上一条的静默）
    const idle = await bot.decide(groupMsg('今天天气不错', { msgId: 'idle', chatId: 'g-idle' }));
    bot.finalize(idle, '嗯 ((silence:5))');
    assert.equal(Number(bot.store.getState(idle.key).silentUntil) || 0, 0, '没冲她说的消息不能自我静默');

    // 时长夹到 1–60 分钟
    const d3 = await bot.decide(groupMsg('@鲸鲸 在吗', { atMe: true, chatId: 'g-clamp' }));
    bot.finalize(d3, '行 ((silence:999))');
    const clampMins = (Number(bot.store.getState(d3.key).silentUntil) - Date.now()) / 60000;
    assert.ok(clampMins > 58 && clampMins <= 60.5, '超长时长要夹到 60 分钟，实际 ' + clampMins.toFixed(2));
  } finally {
    cleanup();
  }
});

test('静默期优先级高于「主人说话就回」', () => {
  const botSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'trigger.js'), 'utf8');
  const silentIdx = botSrc.indexOf("reason: 'silent'");
  const masterIdx = botSrc.indexOf("reason: 'master'");
  assert.ok(silentIdx > 0 && masterIdx > 0, '两个分支都要在');
  assert.ok(
    silentIdx < masterIdx,
    '静默判断必须排在 masterAlwaysReply 之前，否则主人说完「让她滚」下一句又把她叫起来'
  );
});

test('「让他滚」（指别的男生）不该把她赶走', () => {
  const botSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'stages', 'canned.js'), 'utf8');
  // 第三人称正则里不能出现单独一个「他」
  const m = botSrc.match(/\(让\|叫\|把\|喊\|请\)\(\?:([^)]*)\)/);
  assert.ok(m, '找得到第三人称 dismiss 正则');
  const targets = m[1].split('|');
  assert.ok(targets.includes('她'), '要认「让她滚」');
  assert.ok(!targets.includes('他'), '不能把「让他滚」也当成赶她走');
});
