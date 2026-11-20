'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModules } = require('../src/bootstrap/modules');

function withManifests(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-modules-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('单路由 manifest 归一化为一个注册项', () => {
  const mods = withManifests({
    'alpha/manifest.js': "module.exports = { id: 'alpha', order: 10, routes: function (r) {} };\n",
  }, loadModules);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].routeEntries.length, 1);
  assert.equal(mods[0].routeEntries[0].order, 10);
  assert.equal(typeof mods[0].routeEntries[0].register, 'function');
});

test('多路由 manifest 保留每个注册项的 order', () => {
  const mods = withManifests({
    'beta/manifest.js': "module.exports = { id: 'beta', routes: [\n  { order: 30, register: function (r) {} },\n  { order: 20, register: function (r) {} },\n] };\n",
  }, loadModules);
  assert.equal(mods[0].routeEntries.length, 2);
  assert.deepEqual(mods[0].routeEntries.map((e) => e.order), [30, 20]);
});

test('无路由的服务模块可以没有 order', () => {
  const mods = withManifests({
    'svc/manifest.js': "module.exports = { id: 'svc', create: function () { return {}; } };\n",
  }, loadModules);
  assert.equal(mods[0].routeEntries.length, 0);
  assert.equal(typeof mods[0].create, 'function');
});

test('跨模块 order 重复必须报错', () => {
  assert.throws(() => withManifests({
    'a/manifest.js': "module.exports = { id: 'a', order: 10, routes: function (r) {} };\n",
    'b/manifest.js': "module.exports = { id: 'b', order: 10, routes: function (r) {} };\n",
  }, loadModules), /order=10/);
});

test('模块内 order 重复必须报错', () => {
  assert.throws(() => withManifests({
    'a/manifest.js': "module.exports = { id: 'a', routes: [\n  { order: 10, register: function (r) {} },\n  { order: 10, register: function (r) {} },\n] };\n",
  }, loadModules), /order=10/);
});

test('非法 register / id 不匹配必须报错', () => {
  assert.throws(() => withManifests({
    'a/manifest.js': "module.exports = { id: 'a', routes: [{ order: 1, register: 1 }] };\n",
  }, loadModules), /register/);
  assert.throws(() => withManifests({
    'a/manifest.js': "module.exports = { id: 'b', order: 1, routes: function (r) {} };\n",
  }, loadModules), /必须与目录名/);
});
