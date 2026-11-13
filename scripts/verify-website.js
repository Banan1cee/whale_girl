'use strict';

// 使用已安装的 Chromium/Edge 做真实布局检查，不给官网引入浏览器测试依赖。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { describeError } = require('../src/infra/errors');

async function verify({ directory, browser, screenshots }) {
  const root = path.resolve(directory);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-browser-'));
  const missing = [];
  const errors = [];
  const server = http.createServer((request, response) => {
    let file;
    try { file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname)); }
    catch { response.writeHead(400).end(); return; }
    if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { missing.push(request.url); response.writeHead(404).end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.webp': 'image/webp' };
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let log = '';
      const timeout = setTimeout(() => reject(new Error('浏览器调试端点启动超时')), 20000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('浏览器提前退出')); });
      child.stderr.on('data', chunk => {
        log += chunk;
        const found = /DevTools listening on (ws:\/\/[^\s]+)/.exec(log);
        if (found) { clearTimeout(timeout); resolve(found[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await once(socket, 'open');
    const pending = new Map();
    const listeners = new Map();
    let sequence = 0;
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const task = pending.get(data.id);
        if (!task) return;
        pending.delete(data.id); clearTimeout(task.timer);
        if (data.error) task.reject(new Error(JSON.stringify(data.error))); else task.resolve(data.result);
      } else {
        if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text + ': ' + (data.params.exceptionDetails.exception?.description || ''));
        const key = `${data.sessionId || ''}:${data.method}`;
        const task = listeners.get(key);
        if (task) { listeners.delete(key); clearTimeout(task.timer); task.resolve(data.params); }
      }
    });
    function send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 20000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    await cdp('Page.enable'); await cdp('Runtime.enable');
    async function evaluate(expression) {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    async function visit(route, scripting = true) {
      const loaded = new Promise((resolve, reject) => {
        const key = `${sessionId}:Page.loadEventFired`;
        const timer = setTimeout(() => { listeners.delete(key); reject(new Error(`页面加载超时：${route}`)); }, 20000);
        listeners.set(key, { resolve, timer });
      });
      await cdp('Page.navigate', { url: origin + route }); await loaded;
      if (scripting) await evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    }
    const routes = ['/', '/downloads/', '/downloads/v3.60/', '/plugins/', '/plugins/followup-window/', '/support/', '/support/transparency/', '/team/'];
    fs.mkdirSync(screenshots, { recursive: true });
    for (const width of [375, 1440]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: false });
      for (const route of routes) {
        await visit(route);
        const measured = await evaluate(`({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,main:!!document.querySelector('main h1'),broken:[...document.images].filter(i=>i.complete&&!i.naturalWidth).map(i=>i.getAttribute('src'))})`);
        assert.ok(measured.main, `${route}: 缺少主标题`);
        assert.equal(measured.scroll, measured.width, `${route} 在 ${width}px 出现整页横向溢出`);
        assert.deepEqual(measured.broken, [], `${route}: 图片加载失败`);
        if (route === '/plugins/') {
          const filtered = await evaluate(`(()=>{const input=document.querySelector('input');input.value='接话窗口';input.dispatchEvent(new Event('input',{bubbles:true}));return [...document.querySelectorAll('[data-filter-item]')].filter(i=>!i.hidden).length})()`);
          assert.equal(filtered, 1, '插件关键词搜索生效');
          const empty = await evaluate(`(()=>{const input=document.querySelector('input');input.value='no-such-plugin';input.dispatchEvent(new Event('input',{bubbles:true}));return !document.querySelector('#filter-empty').hidden})()`);
          assert.ok(empty, '插件空筛选有明确提示');
          await evaluate(`(()=>{const input=document.querySelector('input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        }
        if (route === '/downloads/') {
          const filtered = await evaluate(`(()=>{const input=document.querySelector('input');input.value='v3.60';input.dispatchEvent(new Event('input',{bubbles:true}));return [...document.querySelectorAll('[data-filter-item]')].filter(i=>!i.hidden).length})()`);
          assert.equal(filtered, 1, '下载历史搜索生效');
          await evaluate(`(()=>{const input=document.querySelector('input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        }
        if (width === 375) {
          const menu = await evaluate(`(()=>{const b=document.querySelector('.menu-toggle');b.click();const open=b.getAttribute('aria-expanded');document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return {open,closed:b.getAttribute('aria-expanded')}})()`);
          assert.deepEqual(menu, { open: 'true', closed: 'false' });
        }
        const before = await evaluate('document.documentElement.dataset.theme');
        await evaluate("document.querySelector('#theme-toggle').click()");
        const after = await evaluate('document.documentElement.dataset.theme');
        assert.notEqual(before, after, '主题按钮生效');
        await evaluate('Promise.all(document.getAnimations().filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
        // 截图覆盖两种主题；下一个页面也检查已保存选择。
        const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const filename = `${width}-${route === '/' ? 'home' : route.split('/').filter(Boolean).join('-')}.png`;
        fs.writeFileSync(path.join(screenshots, filename), Buffer.from(shot.data, 'base64'));
        console.log(`PASS ${width}px ${route}`);
      }
    }
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await visit('/');
    assert.equal(await evaluate('document.documentElement.dataset.motion'), 'paused', '减少动态效果设置生效');
    await cdp('Emulation.setScriptExecutionDisabled', { value: true });
    await visit('/plugins/', false);
    assert.ok(await evaluate('document.querySelectorAll(".plugin-card").length > 0'), '无脚本仍有真实插件内容');
    assert.deepEqual(missing, [], '所有已访问页面的站内资源可加载');
    assert.deepEqual(errors, [], '浏览器没有未处理脚本异常');
    console.log('Browser verification passed: responsive layout, search, navigation, themes, reduced motion and static content.');
  } finally {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    child.kill();
    await new Promise(resolve => server.close(resolve));
    // Edge 退出后可能仍短暂占用 profile；不强删其他浏览器进程或目录。
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 仅临时浏览器缓存。 */ }
  }
}

if (require.main === module) {
  const [directory, browser, screenshots = 'artifacts/website-screenshots'] = process.argv.slice(2);
  if (!directory || !browser) throw new Error('用法：node scripts/verify-website.js <生成目录> <Chromium/Edge 路径> [截图目录]');
  verify({ directory, browser, screenshots }).catch(error => { console.error(describeError(error)); process.exitCode = 1; });
}
module.exports = { verify };
