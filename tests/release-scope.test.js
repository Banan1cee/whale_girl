'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { createRouter } = require('../src/http/routes');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('4.1.0 恢复朋友圈与日记，表情收集保持独立开关', () => {
  assert.ok(DEFAULT_CONFIG.diary && DEFAULT_CONFIG.diary.enabled === false);
  assert.equal(DEFAULT_CONFIG.sticker.collectReceived, false);

  for (const file of ['src/modules/diary/service.js', 'src/modules/diary/routes.js',
    'src/modules/moments/service.js', 'src/modules/moments/publisher.js',
    'src/modules/moments/routes.js',
    'bridge/moments.py', 'bridge/moments_actions.py', 'launcher/Views/MomentsPage.cs']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  }

  // 直接验证生产路由：日记与朋友圈的既有 method/path 都在，且只注册一次。
  const runtime = {};
  const router = createRouter(runtime);
  for (const [method, route] of [
    ['GET', '/api/diary'],
    ['POST', '/api/diary/generate'],
    ['GET', '/api/moments/latest'],
  ]) {
    const hits = router.routes.filter((r) => r.method === method && r.path === route);
    assert.equal(hits.length, 1, `${method} ${route} 应只注册一次`);
    assert.ok(
      runtime.pluginApiRoutes.some((r) => r.method === method && r.path === route),
      `${method} ${route} 应出现在插件 API 清单里`
    );
  }

  assert.match(read('launcher/MainWindow.xaml.cs'), /MomentsPage|Key = "朋友圈"/);
  assert.match(read('launcher/Views/ReminderPage.xaml'), /ChkDiaryEnabled/);
  assert.match(read('launcher/Views/StickerPage.xaml'), /ChkCollect/);
  assert.match(read('bridge/app.py'), /moments_reader|from moments import/);
});
