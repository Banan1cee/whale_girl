'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { loadConfig } = require('../src/infra/config');
const location = require('../src/services/location');
const registerMoments = require('../src/http/routes/moments');

function fixture(t, moments, confirmedAccount = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t03-moments-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('whale-t03-moments-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    server: { port: 0, openBrowser: false, allowRemote: false },
    features: { envContext: false }, env: { autoDetect: false }, moments,
  }));
  const config = loadConfig({ root, env: {}, readOnly: true });
  const events = [];
  const bridge = {
    accountOk: Boolean(confirmedAccount),
    account: confirmedAccount,
  };
  const runtime = {
    config,
    logger: { info() {}, warn() {}, error() {} },
    store: { replan() { events.push('replan'); } },
    stopLocationProbe() { events.push('stopProbe'); },
    gateways: new Map([['wechat', {
      bridge,
      bridgeStatus() { events.push('bridgeStatus'); return { online: Boolean(confirmedAccount) }; },
    }]]),
    momentsPublisher: {
      settings() {
        const m = config.moments || {};
        return {
          featureEnabled: m.publishFeatureEnabled === true,
          enabled: m.publishEnabled === true,
          withImage: m.publishWithImage === true,
          account: String(m.publishAccount || ''),
          interval: Number(m.publishIntervalHours) || 6,
          maxPerDay: Number.isSafeInteger(Number(m.publishMaxPerDay)) && Number(m.publishMaxPerDay) >= 0
            ? Number(m.publishMaxPerDay) : 1,
        };
      },
      status() { return { revision: events.filter(name => name === 'publisherReconcile').length }; },
      reconcile() { events.push('publisherReconcile'); },
    },
    moments: { startAutoRead() { events.push('startAutoRead'); } },
    stickerService: { reconcile() { events.push('stickerReconcile'); } },
    llm: { reload() { events.push('llmReload'); } },
  };
  t.mock.method(location, 'startAutoProbe', () => { events.push('locationProbe'); return () => {}; });
  let handler;
  registerMoments({
    get() {},
    post(route, fn) { if (route === '/api/moments/publish-settings') handler = fn; },
    any() {},
  });
  return { root, file, config, runtime, events, bridge, handler };
}

async function post(f, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { host: '127.0.0.1:8787', 'content-type': 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  let status;
  let response;
  await f.handler(f.runtime, req, {
    writeHead(value) { status = value; },
    end(text) { response = JSON.parse(text); },
  });
  return { status, response };
}

test('online partial publish-settings omits absent maxPerDay and preserves its configured value', async t => {
  const f = fixture(t, {
    publishFeatureEnabled: false, publishEnabled: false, publishWithImage: true,
    publishAccount: 'saved-account', publishIntervalHours: 6, publishMaxPerDay: 3,
  });
  const before = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  const { status, response } = await post(f, { featureEnabled: true, enabled: false, withImage: false, interval: 8 });
  assert.equal(status, 200);
  assert.equal(response.ok, true);
  assert.equal(response.revision, 1);
  assert.equal(f.events.filter(name => name === 'publisherReconcile').length, 1);
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(saved.moments.publishFeatureEnabled, true);
  assert.equal(saved.moments.publishEnabled, false);
  assert.equal(saved.moments.publishWithImage, false);
  assert.equal(saved.moments.publishIntervalHours, 8);
  assert.equal(saved.moments.publishAccount, before.moments.publishAccount);
  assert.equal(saved.moments.publishMaxPerDay, 3);
  assert.equal(f.events.includes('bridgeStatus'), false);
});

test('online publish-settings keeps explicit zero and false values', async t => {
  const f = fixture(t, { publishMaxPerDay: 3, publishIntervalHours: 6, publishWithImage: true });
  const { status, response } = await post(f, {
    featureEnabled: true, enabled: false, withImage: false, interval: 8, maxPerDay: 0,
  });
  assert.equal(status, 200);
  assert.equal(response.ok, true);
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(saved.moments.publishMaxPerDay, 0);
  assert.equal(saved.moments.publishWithImage, false);
});

test('explicit online enable still requires and binds the live confirmed account', async t => {
  const f = fixture(t, { publishFeatureEnabled: false, publishEnabled: false, publishMaxPerDay: 3 }, 'live-confirmed-account');
  const { status, response } = await post(f, {
    featureEnabled: true, enabled: true, withImage: false, interval: 8, maxPerDay: 3,
  });
  assert.equal(status, 200);
  assert.equal(response.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).moments.publishAccount, 'live-confirmed-account');
  assert.equal(f.events.filter(name => name === 'bridgeStatus').length, 1);
});

test('partial online flag update cannot activate an inconsistent previously enabled setting', async t => {
  const f = fixture(t, { publishFeatureEnabled: false, publishEnabled: true, publishMaxPerDay: 3 });
  const before = fs.readFileSync(f.file, 'utf8');
  const { status, response } = await post(f, { featureEnabled: true, interval: 8 });
  assert.equal(status, 400);
  assert.equal(response.ok, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(f.events.includes('bridgeStatus'), false);
});

test('explicit online enable without a live confirmed account changes no configuration', async t => {
  const f = fixture(t, { publishFeatureEnabled: false, publishEnabled: false, publishMaxPerDay: 3 });
  const before = fs.readFileSync(f.file, 'utf8');
  const { status, response } = await post(f, {
    featureEnabled: true, enabled: true, withImage: false, interval: 8, maxPerDay: 3,
  });
  assert.equal(status, 400);
  assert.equal(response.ok, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(f.events.filter(name => name === 'bridgeStatus').length, 1);
});
