'use strict';

/**
 * 公告发布工具（scripts/announce.js）的回归测试。
 *
 * 工具是维护者本地用的：一条命令改 announcements.json，写前校验、写后跑门禁、失败回滚。
 * 这里把「写入什么、什么时候不许写、本地预览缓存」都钉住，避免以后改工具把文件改坏。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main, validateFeed } = require('../scripts/announce.js');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE = path.join(ROOT, 'examples', 'announcements-sample.json');
const quiet = { log() {}, warn() {}, error() {} };

function withDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-announce-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readFeed = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('示例公告文件本身符合规格', () => {
  const feed = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  assert.deepEqual(validateFeed(feed), []);
  assert.ok(feed.announcements.length >= 2, '示例至少要有两条，覆盖不同 level/action');
});

test('追加公告：默认值、序号递增、写盘前校验', () => {
  withDir((dir) => {
    const file = path.join(dir, 'announcements.json');
    assert.equal(main(['域名已更新', '官网正式域名为 bot.zyyc.cc', '--file', file], quiet), 0);
    const feed = readFeed(file);
    assert.equal(feed.manifest_version, 1);
    assert.equal(feed.announcements.length, 1);
    const item = feed.announcements[0];
    assert.match(item.id, /^notice-\d{8}-[a-z0-9]{4}$/);
    assert.equal(item.level, 'info');
    assert.equal(item.action, 'none');
    assert.equal(item.priority, 10);
    assert.deepEqual(validateFeed(feed), []);

    assert.equal(main(['第二条', '正文', '--file', file, '--id', 'second', '--level', 'warn'], quiet), 0);
    const next = readFeed(file);
    assert.equal(next.manifest_version, 2);
    assert.equal(next.announcements[1].id, 'second');
  });
});

test('重复 id、非法链接、缺正文都不写盘', () => {
  withDir((dir) => {
    const file = path.join(dir, 'announcements.json');
    assert.equal(main(['A', '正文', '--file', file, '--id', 'same'], quiet), 0);
    const before = fs.readFileSync(file, 'utf8');

    assert.equal(main(['B', '正文', '--file', file, '--id', 'same'], quiet), 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before, '重复 id 不能写盘');

    assert.equal(main(['C', '正文', '--file', file, '--action', 'open_url', '--url', 'https://evil.example/x'], quiet), 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before, '非白名单链接不能写盘');

    assert.equal(main(['只有标题', '--file', file], quiet), 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before, '缺正文不能写盘');
  });
});

test('删除、撤下与恢复都会递增序号', () => {
  withDir((dir) => {
    const file = path.join(dir, 'announcements.json');
    main(['A', '正文', '--file', file, '--id', 'a'], quiet);
    main(['B', '正文', '--file', file, '--id', 'b'], quiet);

    assert.equal(main(['--remove', 'a', '--file', file], quiet), 0);
    let feed = readFeed(file);
    assert.equal(feed.announcements.length, 1);
    assert.equal(feed.announcements[0].id, 'b');
    assert.equal(feed.manifest_version, 3);

    assert.equal(main(['--remove', 'missing', '--file', file], quiet), 1);

    assert.equal(main(['--kill', '--file', file], quiet), 0);
    feed = readFeed(file);
    assert.equal(feed.kill, true);
    assert.equal(feed.manifest_version, 4);

    assert.equal(main(['--unkill', '--file', file], quiet), 0);
    assert.equal(readFeed(file).kill, false);
  });
});

test('节奏参数写进 config，超上限按本地钳制收口', () => {
  withDir((dir) => {
    const file = path.join(dir, 'announcements.json');
    assert.equal(
      main(['节奏', '正文', '--file', file, '--max-popups', '99', '--delay', '99999', '--popups', 'off'], quiet),
      0,
    );
    const config = readFeed(file).config;
    assert.equal(config.max_popups_per_launch, 20);
    assert.equal(config.popup_delay_ms, 10000);
    assert.equal(config.popups_enabled, false);
  });
});

test('--dry-run 不写盘', () => {
  withDir((dir) => {
    const file = path.join(dir, 'announcements.json');
    assert.equal(main(['预览', '正文', '--file', file, '--dry-run'], quiet), 0);
    assert.equal(fs.existsSync(file), false);
  });
});

test('--seed-local 写进本机缓存供启动器预览，--clear-local 清掉', () => {
  withDir((dir) => {
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = path.join(dir, 'localappdata');
    try {
      assert.equal(main(['--seed-local', SAMPLE], quiet), 0);
      const stateFile = path.join(process.env.LOCALAPPDATA, 'WhaleGirl', 'announcements-state.json');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.ok(state.cache.manifest_version >= 1000000, '本地预览缓存序号要压过线上');
      assert.deepEqual(state.read, {}, '本地预览默认重置已读');
      assert.equal(
        state.cache.announcements.length,
        JSON.parse(fs.readFileSync(SAMPLE, 'utf8')).announcements.length,
      );

      assert.equal(main(['--clear-local'], quiet), 0);
      assert.equal(fs.existsSync(stateFile), false);
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
    }
  });
});

test('发布工具不会被编进启动器', () => {
  const csproj = fs.readFileSync(path.join(ROOT, 'launcher', 'WhaleLauncher.csproj'), 'utf8');
  assert.ok(!csproj.includes('announce.js'), 'csproj 不能把公告工具编进 EXE');
  assert.ok(!/scripts[\\/]announce/.test(csproj), 'csproj 不能引用公告脚本');
  assert.ok(!/\.js["']/.test(csproj), 'csproj 不该编译任何 JS 文件');
});
