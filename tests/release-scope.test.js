'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('4.1.0 恢复朋友圈与日记，表情收集保持独立开关', () => {
  assert.ok(DEFAULT_CONFIG.diary && DEFAULT_CONFIG.diary.enabled === false);
  assert.equal(DEFAULT_CONFIG.sticker.collectReceived, false);

  for (const file of ['src/services/diary.js', 'src/services/moments.js',
    'src/http/routes/diary.js', 'src/http/routes/moments.js',
    'bridge/moments.py', 'bridge/moments_actions.py', 'launcher/Views/MomentsPage.cs']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, file);
  }
  assert.match(read('src/http/routes/index.js'), /require\('\.\/diary'\)/);
  assert.match(read('src/http/routes/index.js'), /require\('\.\/moments'\)/);
  assert.match(read('launcher/MainWindow.xaml.cs'), /MomentsPage|Key = "朋友圈"/);
  assert.match(read('launcher/Views/ReminderPage.xaml'), /ChkDiaryEnabled/);
  assert.match(read('launcher/Views/StickerPage.xaml'), /ChkCollect/);
  assert.match(read('bridge/app.py'), /moments_reader|from moments import/);
});
