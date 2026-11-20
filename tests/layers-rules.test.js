'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { check } = require('../scripts/check-layers');

/** 在临时目录里铺一个最小 src/，跑完 check 后整目录删除。 */
function withFixture(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-layers-'));
  try {
    const srcRoot = path.join(root, 'src');
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(srcRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
    return run(srcRoot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function violationsOf(files) {
  return withFixture(files, (srcRoot) => check(srcRoot));
}

test('infra 不能 require modules', () => {
  const violations = violationsOf({ 'infra/x.js': "require('../modules/foo');\n" });
  assert.deepStrictEqual(violations.map((v) => v.target), ['modules/foo']);
  assert.strictEqual(violations[0].rule, 'infra -/-> modules');
});

test('模块不能 require bootstrap（含子路径）', () => {
  const violations = violationsOf({ 'modules/foo/x.js': "require('../../bootstrap/modules');\n" });
  assert.deepStrictEqual(violations.map((v) => v.target), ['bootstrap/modules']);
  assert.strictEqual(violations[0].rule, 'modules/foo -/-> bootstrap');
});

test('模块不能 require app', () => {
  const violations = violationsOf({ 'modules/foo/x.js': "require('../../app');\n" });
  assert.deepStrictEqual(violations.map((v) => v.target), ['app']);
  assert.strictEqual(violations[0].rule, 'modules/foo -/-> app');

  const withExt = violationsOf({ 'modules/foo/x.js': "require('../../app.js');\n" });
  assert.deepStrictEqual(withExt.map((v) => v.target), ['app.js']);
  assert.strictEqual(withExt[0].rule, 'modules/foo -/-> app');
});

test('模块不能 require http/routes 总装，协议工具放行', () => {
  const registry = violationsOf({ 'modules/foo/routes.js': "require('../../http/routes');\n" });
  assert.deepStrictEqual(registry.map((v) => v.target), ['http/routes']);
  assert.strictEqual(registry[0].rule, 'modules/foo -/-> http/routes');

  const protocol = violationsOf({ 'modules/foo/routes.js': "require('../../http/protocol');\nrequire('../../http/util');\n" });
  assert.deepStrictEqual(protocol, []);
});

test('跨模块深 import 被拦，公开入口放行', () => {
  const deep = violationsOf({ 'modules/foo/x.js': "require('../bar/service');\n" });
  assert.deepStrictEqual(deep.map((v) => v.target), ['modules/bar/service']);

  const entry = violationsOf({ 'modules/foo/x.js': "require('../bar');\n" });
  assert.deepStrictEqual(entry, []);
});

test('模块可以 require 平台 services 用例层，但不能把 services 当模块深 import', () => {
  // services/ 是共享用例平台层，模块路由/服务可以调用。
  const allowed = violationsOf({ 'modules/foo/x.js': "require('../../services/x');\n" });
  assert.deepStrictEqual(allowed, []);

  // ../services/x 会解析成 modules/services/x，仍属于跨模块深 import。
  const deep = violationsOf({ 'modules/foo/x.js': "require('../services/x');\n" });
  assert.deepStrictEqual(deep.map((v) => v.target), ['modules/services/x']);
});

test('services 调用模块只能走公开 index，深 import 被拦', () => {
  const deep = violationsOf({ 'services/x.js': "require('../modules/foo/config');\n" });
  assert.deepStrictEqual(deep.map((v) => v.target), ['modules/foo/config']);
  assert.match(deep[0].rule, /services -\/-> modules\/foo/);

  const entry = violationsOf({ 'services/x.js': "require('../modules/foo');\n" });
  assert.deepStrictEqual(entry, []);
});

test('core 不能 require modules', () => {
  const violations = violationsOf({ 'core/x.js': "require('../modules/foo');\n" });
  assert.deepStrictEqual(violations.map((v) => v.target), ['modules/foo']);
});

test('pipeline 只过渡放行 modules/search 公开入口', () => {
  const allowed = violationsOf({ 'pipeline/chat.js': "require('../modules/search');\n" });
  assert.deepStrictEqual(allowed, []);

  const deep = violationsOf({ 'pipeline/chat.js': "require('../modules/search/service');\n" });
  assert.deepStrictEqual(deep.map((v) => v.target), ['modules/search/service']);

  const denied = violationsOf({ 'pipeline/chat.js': "require('../modules/stickers');\n" });
  assert.deepStrictEqual(denied.map((v) => v.target), ['modules/stickers']);
  assert.strictEqual(denied[0].rule, 'pipeline -/-> modules');
});

test('合法模块文件（infra + 跨模块公开入口）零 violation', () => {
  const violations = violationsOf({
    'modules/foo/x.js': "require('../../infra/errors');\nrequire('../bar');\n",
  });
  assert.deepStrictEqual(violations, []);
});
