'use strict';

/**
 * 在线（HTTP 设置接口）与离线（launcherSnapshot 本地保存）配置写入的共用规则。
 *
 * 4.1.3 起约定「只保存本次提交字段、空白不算零、显式零保留」；这里把它固化成
 * 在线 / 离线同口径的验收：空白数字两侧都拒绝且不写盘，显式 0 两侧都保留。
 * 在线用真实 HTTP 响应验证，离线只走本地保存（不得启动定位/联网探测）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../server');
const { saveLocalConfiguration } = require('../src/services/launcherSnapshot');
const location = require('../src/services/location');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-config-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    watchConfig: false,
    server: { port: 0, openBrowser: false },
    features: { envContext: false },
    env: { autoDetect: false },
    moments: { autoLike: true, autoLikeMaxPerDay: 7, autoReadEveryHours: 6 },
  }));
  return root;
}

const configFile = (root) => path.join(root, 'config.json');
const momentsOf = (root) => JSON.parse(fs.readFileSync(configFile(root), 'utf8')).moments;

test('朋友圈基础设置：空白数字不是零、显式零保留，在线与离线同口径', async (t) => {
  let probes = 0;
  t.mock.method(location, 'startAutoProbe', () => { probes += 1; return () => {}; });

  const onlineRoot = fixture(t);
  const app = await startServer({ root: onlineRoot, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  t.after(() => app.close());
  const post = async (body) => {
    const res = await fetch(app.url + '/api/moments/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const offlineRoot = fixture(t);

  // ---- 在线：真实 HTTP 响应 ----
  // 空白（''、纯空格）不是 0：拒绝且不写盘。
  for (const body of [{ autoLikeMaxPerDay: '' }, { autoReadEveryHours: '   ' }]) {
    const onlineBefore = fs.readFileSync(configFile(onlineRoot), 'utf8');
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, /要填数字/);
    assert.equal(fs.readFileSync(configFile(onlineRoot), 'utf8'), onlineBefore, '在线空白不能写盘');
  }
  // 显式 0 是合法值：响应和落盘都保留 0。
  const zero = await post({ autoLikeMaxPerDay: 0, autoReadEveryHours: 0 });
  assert.equal(zero.status, 200);
  assert.equal(zero.body.ok, true);
  assert.equal(zero.body.autoLikeMaxPerDay, 0);
  assert.equal(zero.body.autoReadEveryHours, 0);
  assert.deepEqual(momentsOf(onlineRoot), { autoLike: true, autoLikeMaxPerDay: 0, autoReadEveryHours: 0 });

  // ---- 离线：同一口径，且只在本机写配置 ----
  const probesBeforeOffline = probes;
  for (const body of [{ autoLikeMaxPerDay: '' }, { autoReadEveryHours: '   ' }]) {
    const offlineBefore = fs.readFileSync(configFile(offlineRoot), 'utf8');
    // 离线 CLI（launcherSnapshot --save）会把内部异常折成 {ok:false,error}；
    // 直接调模块时异常原样抛出，这里按 CLI 的实际契约折算后再比。
    let saved;
    try {
      saved = await saveLocalConfiguration(offlineRoot, { path: '/api/moments/settings', body }, {});
    } catch (err) {
      saved = { ok: false, error: err.message };
    }
    assert.equal(saved.ok, false, JSON.stringify(body));
    assert.match(saved.error, /要填数字/);
    assert.equal(fs.readFileSync(configFile(offlineRoot), 'utf8'), offlineBefore, '离线空白不能写盘');
  }
  const savedZero = await saveLocalConfiguration(offlineRoot, {
    path: '/api/moments/settings', body: { autoLikeMaxPerDay: 0, autoReadEveryHours: 0 },
  }, {});
  assert.equal(savedZero.ok, true);
  assert.equal(savedZero.autoLikeMaxPerDay, 0);
  assert.deepEqual(momentsOf(offlineRoot), { autoLike: true, autoLikeMaxPerDay: 0, autoReadEveryHours: 0 });
  // 离线保存只在本机写配置：不启动定位/联网探测。
  assert.equal(probes, probesBeforeOffline, '离线保存不能触发定位探测');
});
