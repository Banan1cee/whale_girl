'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('本批发布保留独立的表情收集，朋友圈和日记暂缓', () => {
  assert.equal(DEFAULT_CONFIG.diary, undefined);
  assert.equal(DEFAULT_CONFIG.sticker.collectReceived, false);
  for (const file of ['src/services/diary.js', 'src/services/moments.js',
    'src/http/routes/diary.js', 'src/http/routes/moments.js',
    'bridge/moments.py', 'bridge/moments_actions.py', 'launcher/Views/MomentsPage.cs']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
  for (const file of ['src/app.js', 'src/http/routes/index.js', 'server.js']) {
    assert.doesNotMatch(read(file), /DiaryService|MomentsService|runtime\.diary|require\('\.\/(?:diary|moments)'\)/);
  }
  assert.doesNotMatch(read('launcher/MainWindow.xaml.cs'), /MomentsPage|Key = "朋友圈"/);
  assert.doesNotMatch(read('launcher/Views/ReminderPage.xaml'), /ChkDiaryEnabled/);
  assert.match(read('launcher/Views/StickerPage.xaml'), /ChkCollect/);
  assert.doesNotMatch(read('bridge/app.py'), /moments_reader|from moments import/);
});
