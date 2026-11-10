'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

test('插件入口固定在市场，设置在卡片内打开工具或人设', () => {
  const main = read('launcher/MainWindow.xaml.cs');
  const page = read('launcher/Views/PluginMarketPage.xaml.cs');
  assert.match(main, /case "插件市场": return new PluginMarketPage/);
  assert.doesNotMatch(main, /RefreshPluginNav|StartsWith\("plugin:"/);
  assert.match(page, /Content = "设置"/);
  assert.match(page, /ShowDetail\(new PluginToolPage/);
  assert.match(page, /await ShowPersonaSettings\(info\)/);
  assert.match(page, /MessageBox\.Show\("将这份人设应用到当前鲸鲸？"/);
});

test('市场右侧可打开随启动器打包的规范', () => {
  assert.match(read('launcher/Views/PluginMarketPage.xaml'), /Content="插件市场规范".*Click="OnRulesGuide"/);
  assert.match(read('launcher/WhaleLauncher.csproj'), /LogicalName="WhaleLauncher\.PluginRulesGuide\.md"/);
  assert.match(read('docs/插件市场规范.md'), /设置.*按次确认/);
});
