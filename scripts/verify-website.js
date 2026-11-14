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
const { auditContrast } = require('./website-contrast');

async function verify({ directory, browser, screenshots }) {
  const root = path.resolve(directory);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-browser-'));
  const missing = [];
  const errors = [];
  const evidence = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/__motion-qa__/') {
      const html = fs.readFileSync(path.join(root, 'support/index.html'), 'utf8');
      const fixture = '<section class="page-section"><h2>仅供本地动效验收</h2><details class="qr-details"><summary class="button secondary">展开测试图片</summary><div class="qr-content"><img src="../images/launcher-icon.png" alt="测试图片，不是收款码" width="240" height="240"></div></details></section>';
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html.replace('</main>', fixture + '</main>')); return;
    }
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
    await send('Target.activateTarget', { targetId });
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    async function evaluate(expression) {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    function pageEvent(method, route) {
      return new Promise((resolve, reject) => {
        const key = `${sessionId}:${method}`;
        const timer = setTimeout(() => { listeners.delete(key); reject(new Error(`页面加载超时：${route}`)); }, 20000);
        listeners.set(key, { resolve, timer });
      });
    }
    async function visit(route, scripting = true) {
      const loaded = pageEvent('Page.loadEventFired', route);
      await cdp('Page.navigate', { url: origin + route }); await loaded;
      if (scripting) await evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    }
    const routes = ['/', '/downloads/', '/downloads/v3.60/', '/plugins/', '/plugins/followup-window/', '/support/', '/support/transparency/', '/team/'];
    fs.mkdirSync(screenshots, { recursive: true });
    const frames = count => evaluate(`new Promise(resolve=>{let left=${count};function tick(){if(--left<=0)resolve();else requestAnimationFrame(tick)}requestAnimationFrame(tick)})`);
    const settle = () => evaluate('Promise.all(document.getAnimations().filter(a=>a.playState!=="paused"&&a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
    const contrastResults = [];
    for (const width of process.env.WEBSITE_POLISH_FAST ? [1440] : [375, 768, 1024, 1440, 1920]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: width < 520 ? 812 : 900, deviceScaleFactor: 1, mobile: false });
      for (const route of routes) {
        await visit(route);
        await settle();
        const measured = await evaluate(`({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,main:!!document.querySelector('main h1'),broken:[...document.images].filter(i=>i.complete&&!i.naturalWidth).map(i=>i.getAttribute('src'))})`);
        assert.ok(measured.main, `${route}: 缺少主标题`);
        assert.equal(measured.scroll, measured.width, `${route} 在 ${width}px 出现整页横向溢出`);
        assert.deepEqual(measured.broken, [], `${route}: 图片加载失败`);
        assert.ok(await evaluate("!!document.querySelector('main [data-whale-mark] img')?.naturalWidth"), `${route} 主内容区有真实鲸鲸标识`);
        if (width === 1440) {
          const density = await evaluate(`({cards:[...document.querySelectorAll('.plugin-card,.archive-row,.person-card,.support-channel')].filter(e=>{const r=e.getBoundingClientRect();return r.top>=76&&r.bottom<=innerHeight}).length,columns:getComputedStyle(document.querySelector('.plugin-grid,.team-grid,.support-layout,.release-layout')||document.querySelector('main')).gridTemplateColumns})`);
          if (route === '/plugins/' && density.cards < 3) {
            const debug = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.writeFileSync(path.join(screenshots, 'density-debug.png'), Buffer.from(debug.data, 'base64'));
            console.log(await evaluate("[...document.querySelectorAll('.plugin-card')].slice(0,3).map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,height:e.getBoundingClientRect().height}))"));
          }
          if (route === '/plugins/') assert.ok(density.cards >= 3, '桌面首屏应完整展示一行真实插件内容');
          if (route === '/downloads/') assert.ok(density.cards >= 2, '桌面首屏应同时包含最新版本、安装说明与多条完整历史');
          if (route === '/team/') assert.ok(density.cards >= 3, '桌面首屏应同时看到三位成员的完整卡片');
          const motion = await evaluate(`(()=>{const a=document.getAnimations().find(a=>a.effect?.getComputedTiming().iterations===Infinity&&a.playState==='running');window.__proofAnimation=a;return {exists:!!a,time:a?.currentTime||0,name:a?.animationName||''}})()`);
          assert.ok(motion.exists, `${route} 有实际运行的持续动效`);
          await frames(8);
          const advanced = await evaluate('window.__proofAnimation.currentTime');
          assert.ok(advanced > motion.time, `${route} 动效时间轴在推进`);
          await evaluate("document.querySelector('[data-motion-toggle]').click()");
          assert.equal(await evaluate('document.documentElement.dataset.motion'), 'paused', '全站按钮可暂停');
          await frames(2);
          const stopped = await evaluate('window.__proofAnimation.currentTime');
          await frames(5);
          assert.equal(await evaluate('window.__proofAnimation.currentTime'), stopped, '暂停后持续动效不再推进');
          assert.equal(await evaluate("localStorage.getItem('whale-motion')"), 'paused', '暂停偏好保存');
          await evaluate("document.querySelector('[data-motion-toggle]').click()");
          evidence.push({ route, width, fullyVisibleCards: density.cards, columns: density.columns, animation: motion.name, progressed: true, pauseVerified: true });
        }
        if (route === '/plugins/') {
          const filtered = await evaluate(`(()=>{const input=document.querySelector('input');input.value='接话窗口';input.dispatchEvent(new Event('input',{bubbles:true}));return [...document.querySelectorAll('[data-filter-item]')].filter(i=>!i.hidden).length})()`);
          assert.equal(filtered, 1, '插件关键词搜索生效');
          const empty = await evaluate(`(()=>{const input=document.querySelector('input');input.value='no-such-plugin';input.dispatchEvent(new Event('input',{bubbles:true}));return !document.querySelector('#filter-empty').hidden})()`);
          assert.ok(empty, '插件空筛选有明确提示');
          await evaluate(`(()=>{const input=document.querySelector('input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
          const category = await evaluate(`(()=>{document.querySelector('[data-kind-choice="persona"]').click();const visible=[...document.querySelectorAll('[data-filter-item]')].filter(i=>!i.hidden);return visible.every(i=>i.dataset.kind==='persona')&&visible.length>0})()`);
          assert.ok(category, '分类侧栏与筛选同步');
          await evaluate("document.querySelector('[data-kind-choice=\"\"]').click()");
          const sorted = await evaluate(`(()=>{const select=document.querySelector('[data-sort]');select.value='author';select.dispatchEvent(new Event('change',{bubbles:true}));const names=[...document.querySelectorAll('[data-filter-item]')].map(i=>i.dataset.author);return names.every((s,i)=>!i||names[i-1].localeCompare(s,'zh-CN')<=0)})()`);
          assert.ok(sorted, '目录排序生效');
        }
        if (route === '/downloads/') {
          const filtered = await evaluate(`(()=>{const input=document.querySelector('input');input.value='v3.60';input.dispatchEvent(new Event('input',{bubbles:true}));return [...document.querySelectorAll('[data-filter-item]')].filter(i=>!i.hidden).length})()`);
          assert.equal(filtered, 1, '下载历史搜索生效');
          await evaluate(`(()=>{const input=document.querySelector('input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        }
        if (width <= 768) {
          const menu = await evaluate(`(()=>{const b=document.querySelector('.menu-toggle');b.click();const open=b.getAttribute('aria-expanded');document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return {open,closed:b.getAttribute('aria-expanded')}})()`);
          assert.deepEqual(menu, { open: 'true', closed: 'false' });
          await evaluate("(()=>{const b=document.querySelector('.menu-toggle');b.click();b.click();b.click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))})()");
          await settle();
          assert.equal(await evaluate("document.querySelector('.nav-links').classList.contains('open')"), false, '快速反向操作后菜单完整关闭');
        }
        const before = await evaluate('document.documentElement.dataset.theme');
        await evaluate("document.querySelector('#theme-toggle').click()");
        await evaluate('window.WhaleSiteMotion.themeReady');
        const after = await evaluate('document.documentElement.dataset.theme');
        assert.notEqual(before, after, '主题按钮生效');
        await settle();
        if (width === 1440) {
          if (route === '/support/') {
            await evaluate("document.querySelector('.faq-layout summary').click()"); await frames(3);
            await evaluate("(()=>{const s=document.querySelector('.faq-layout summary');s.click();s.click()})()");
            await settle();
            assert.deepEqual(await evaluate("(()=>{const d=document.querySelector('.faq-layout details');return {open:d.open,state:d.dataset.disclosureState,hidden:d.querySelector('.disclosure-body').hidden}})()"), { open: true, state: 'open', hidden: false }, 'FAQ 快速开合从当前状态恢复');
            await evaluate("document.querySelector('.faq-layout summary').click()"); await frames(2);
            assert.equal(await evaluate("document.querySelector('.faq-layout details').dataset.disclosureState"), 'closing', '收起先播放退场，不直接删除内容');
            await evaluate("document.querySelector('[data-motion-toggle]').click()"); await frames(3);
            assert.equal(await evaluate("document.querySelector('.faq-layout details').open"), false, '收起中暂停仍完成最后的关闭意图');
            await evaluate("document.querySelector('[data-motion-toggle]').click()");
          }
          if (route === '/plugins/') {
            await evaluate("document.querySelector('[data-kind-choice=\"persona\"]').click()");
            assert.ok(await evaluate("document.querySelector('.motion-ghost-layer')?.children.length>0"), '筛选旧内容有独立退场，不直接跳没');
            await evaluate("(()=>{document.querySelector('[data-kind-choice=\"message\"]').click();document.querySelector('[data-kind-choice=\"\"]').click()})()"); await settle();
            assert.equal(await evaluate("[...document.querySelectorAll('[data-filter-item]')].filter(e=>!e.hidden).length"), await evaluate("document.querySelectorAll('[data-filter-item]').length"), '快速切换后最终筛选正确');
            assert.equal(await evaluate("document.querySelector('.motion-ghost-layer')?.children.length||0"), 0, '退场结束清理克隆，不累积假卡片');
            await evaluate("window.__scrollCard=document.querySelector('.plugin-card');scrollTo({top:Math.min(document.documentElement.scrollHeight-innerHeight,window.__scrollCard.getBoundingClientRect().bottom+100),behavior:'instant'})");
            await frames(4); await settle();
            assert.equal(await evaluate('window.__scrollCard.dataset.motionState'), 'outside', '离开视口有退场后的确定状态');
            await evaluate("scrollTo({top:0,behavior:'instant'})"); await frames(3); await settle();
            assert.equal(await evaluate('window.__scrollCard.dataset.motionState'), 'settled', '回滚能重新入场并稳定，不是一次性显现');
          }
          const desired = await evaluate('document.documentElement.dataset.theme');
          await evaluate("(()=>{const b=document.querySelector('#theme-toggle');b.click();b.click();b.click()})()");
          await evaluate('window.WhaleSiteMotion.themeReady'); await settle();
          assert.notEqual(await evaluate('document.documentElement.dataset.theme'), desired, '连续主题切换以最后一次点击为准');
          for (const theme of ['dark', 'light']) {
            if (await evaluate('document.documentElement.dataset.theme') !== theme) {
              await evaluate("document.querySelector('#theme-toggle').click()"); await evaluate('window.WhaleSiteMotion.themeReady');
            }
            await evaluate("document.querySelector('[data-motion-toggle]').click()"); await frames(3); await settle();
            const result = await evaluate(`(${auditContrast.toString()})()`);
            contrastResults.push({ route, ...result });
            fs.writeFileSync(path.join(screenshots, 'contrast-audit.json'), JSON.stringify(contrastResults, null, 2));
            assert.deepEqual(result.failures, [], `${route} ${theme} 存在低对比度文字`);
            const themedShot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.writeFileSync(path.join(screenshots, `1440-${route==='/'?'home':route.split('/').filter(Boolean).join('-')}-${theme}.png`), Buffer.from(themedShot.data, 'base64'));
            await evaluate("document.querySelector('[data-motion-toggle]').click()");
            if (route === '/support/' && theme === 'dark') {
              const folder = path.join(screenshots, 'dark-interaction-frames');
              fs.mkdirSync(folder, { recursive: true });
              await evaluate("document.querySelector('.faq-layout summary').scrollIntoView({block:'center',behavior:'instant'})"); await frames(3);
              for (let frame = 0; frame < 24; frame += 1) {
                if ([3, 11, 17, 20].includes(frame)) await evaluate("document.querySelector('.faq-layout summary').click()");
                await frames(3);
                const capture = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                fs.writeFileSync(path.join(folder, `${String(frame).padStart(2, '0')}.png`), Buffer.from(capture.data, 'base64'));
              }
              await settle(); await evaluate("scrollTo({top:0,behavior:'instant'})"); await frames(3); await settle();
            }
          }
        }
        // 截图覆盖两种主题；下一个页面也检查已保存选择。
        const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const filename = `${width}-${route === '/' ? 'home' : route.split('/').filter(Boolean).join('-')}.png`;
        fs.writeFileSync(path.join(screenshots, filename), Buffer.from(shot.data, 'base64'));
        if (width === 1440 && route === '/support/') {
          const folder = path.join(screenshots, 'support-motion-frames');
          fs.mkdirSync(folder, { recursive: true });
          for (let frame = 0; frame < 12; frame += 1) {
            await frames(9);
            const capture = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.writeFileSync(path.join(folder, `${String(frame).padStart(2, '0')}.png`), Buffer.from(capture.data, 'base64'));
          }
        }
        console.log(`PASS ${width}px ${route}`);
      }
    }
    await visit('/__motion-qa__/'); await settle();
    await evaluate("document.querySelector('.qr-details summary').scrollIntoView({block:'center',behavior:'instant'})"); await frames(3);
    await evaluate("document.querySelector('.qr-details summary').dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}))"); await frames(8);
    assert.ok(await evaluate("parseFloat(getComputedStyle(document.querySelector('.qr-details summary')).scale)<.995"), '按住控件有实际按压反馈');
    await evaluate("document.querySelector('.qr-details summary').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}))"); await settle();
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.qr-details summary')).scale"), 'none', '长按释放后不残留缩放');
    await evaluate("document.querySelector('.qr-details summary').click()"); await frames(3);
    await evaluate("(()=>{const s=document.querySelector('.qr-details summary');s.click();s.click();s.click()})()"); await settle();
    assert.equal(await evaluate("document.querySelector('.qr-details').dataset.disclosureState"), 'closed', '二维码反复开合以最后一次关闭为准');
    await evaluate("document.querySelector('.qr-details summary').focus()");
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await settle();
    assert.equal(await evaluate("document.querySelector('.qr-details').open"), true, '键盘同样能展开二维码内容');
    await visit('/'); await settle();
    await evaluate("document.querySelector('[data-article=report]').click()"); await frames(3);
    await evaluate("document.querySelector('#close-dialog').click()"); await frames(2);
    assert.equal(await evaluate("document.querySelector('#article-dialog').dataset.dialogState"), 'closing', '更新报告关闭有完整退场阶段');
    await settle();
    assert.equal(await evaluate("document.querySelector('#article-dialog').open"), false);
    await evaluate("document.querySelector('[data-article=report]').click()"); await settle();
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await settle();
    assert.equal(await evaluate("document.querySelector('#article-dialog').open"), false, '报告弹窗保留 Escape 行为');
    await visit('/support/');
    const clicked = pageEvent('Page.loadEventFired', '站内导航');
    await evaluate("[...document.querySelectorAll('.nav-links a')].find(a=>new URL(a.href).pathname==='/team/').click()");
    await clicked;
    assert.equal(await evaluate('location.pathname'), '/team/', '离场动画后完成真实导航');
    const back = pageEvent('Page.frameNavigated', '浏览器返回');
    await evaluate('history.back()');
    await back;
    await frames(8);
    assert.equal(await evaluate('location.pathname'), '/support/');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('main')).opacity"), '1', '返回缓存页面不残留透明离场状态');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await visit('/');
    assert.equal(await evaluate('document.documentElement.dataset.motion'), 'paused', '减少动态效果设置生效');
    await visit('/support/');
    assert.equal(await evaluate('document.documentElement.dataset.motion'), 'paused', '信息页同样遵循系统减少动态效果');
    assert.equal(await evaluate("document.querySelector('[data-motion-toggle]').disabled"), true);
    await cdp('Emulation.setScriptExecutionDisabled', { value: true });
    await visit('/plugins/', false);
    assert.ok(await evaluate('document.querySelectorAll(".plugin-card").length > 0'), '无脚本仍有真实插件内容');
    assert.deepEqual(missing, [], '所有已访问页面的站内资源可加载');
    assert.deepEqual(errors, [], '浏览器没有未处理脚本异常');
    fs.writeFileSync(path.join(screenshots, 'experience-evidence.json'), JSON.stringify(evidence, null, 2));
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
