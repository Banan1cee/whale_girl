'use strict';

/**
 * 死配置 / 死注释的守卫。
 *
 * 4.0 删掉了「主动分享视频」和自动「消息汇总」两套功能（服务、路由、配置、桥接线程全下线），
 * 但当时配置段和注释都没跟着清，留了半年「功能没了、说明还在」的尾巴。
 * 这组用例就是防回潮。
 *
 * 4.1.0 重新上线了「消息汇总」，但只保留用户手动触发的那一半：
 *   · 没有自动采集、没有定时器、没有桥接线程、没有推送，也没有 digest 配置段；
 *   · 用户点一次才读一次记忆，结果只显示在启动器页面上。
 * 所以这里禁的是「主动分享」和「自动汇总」的残留，不是这个页面本身。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');

const DEAD_SECTIONS = ['share', 'digest'];
const DEAD_WORDS = /主动分享/;

test('出厂配置和存在的本机配置里不再有 share / digest 段', () => {
  for (const name of ['config.json', 'config/config.example.json']) {
    // A clean checkout intentionally has no personal config.json.
    if (name === 'config.json' && !fs.existsSync(path.join(root, name))) continue;
    let raw;
    try {
      raw = JSON.parse(read(name));
    } catch (err) {
      assert.fail(`${name} 不是合法 JSON：${err.message}`);
    }
    for (const key of DEAD_SECTIONS) {
      assert.equal(Object.prototype.hasOwnProperty.call(raw, key), false, `${name} 还留着 ${key} 段`);
    }
  }
});

test('源码与启动器里不再提「主动分享」', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.(js|py|cs|xaml|html)$/.test(entry.name)) files.push(rel);
    }
  };
  walk('src');
  walk('bridge');

  const hits = [];
  for (const rel of files) {
    if (rel === 'tests/sticker-ui.test.js') continue;
    const text = read(rel);
    text.split(/\r?\n/).forEach((line, i) => {
      if (DEAD_WORDS.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(hits, [], '删掉的功能不该还在源码/注释里出现');
});

test('消息汇总只手动触发：没有定时器、不推送、桥接里也没有线程', () => {
  const service = read('src/services/digest.js');
  // 自己跑起来 = 又变回 4.0 删掉的那个「主动汇总群聊」
  assert.doesNotMatch(service, /setInterval|setTimeout/);
  // 只把文本交回给启动器，不自己发微信
  assert.doesNotMatch(service, /enqueue|sendToOwner|gateway/);
  const app = read('src/app.js');
  assert.match(app, /new DigestService/);
  assert.doesNotMatch(app, /digest\.(start|tick|schedule)/);
  // 桥接是老版本自动汇总的入口，不能再接回来
  const engine = require('./helpers/bridge-source');
  assert.doesNotMatch(engine, /digest_worker|digest_watch|api\/digest/);
});

test('桥接不再留 digest worker 和它的死参数', () => {
  const engine = require('./helpers/bridge-source');
  assert.doesNotMatch(engine, /DIGEST_WORKER/, 'DIGEST_WORKER 是永远 None 的死变量');
  assert.doesNotMatch(engine, /send_guard/, 'send_guard 没有任何调用方传值');
  assert.doesNotMatch(engine, /digest_worker/, '桥接没有 digest worker，注释别再提');
});

test('限流口径统一写「每分钟」，别再有每小时上限的旧说法', () => {
  const files = ['src/pipeline/chat.js', 'src/pipeline/trigger.js'];
  for (const rel of files) {
    let text;
    try {
      text = read(rel);
    } catch {
      continue;
    }
    const bad = text
      .split(/\r?\n/)
      .map((line, i) => ({ line, no: i + 1 }))
      .filter((x) => /每小时上限|每小时最多/.test(x.line));
    assert.deepEqual(bad.map((x) => `${rel}:${x.no}`), [], `${rel} 还有每小时上限的旧说法`);
  }
});
