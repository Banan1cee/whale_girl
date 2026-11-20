'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReminderService, RETRY_DELAY_MS } = require('../src/modules/reminders');

const NOW = Date.UTC(2026, 0, 1, 12);
const OWNER = 'wxid_test_t09_owner';
function fixture(t, cap = 1, start = NOW) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t09-quota-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));
  const clock = { now: start };
  const config = { paths: { dataDir: root }, env: { timezone: 'UTC' }, reminder: { enabled: true, maxPerDay: cap, quietAfterMinutes: 0 } };
  const make = () => { const svc = new ReminderService(config, { now: () => clock.now }); svc.pluginAllowed = () => true; return svc; };
  return { clock, config, make, svc: make() };
}
const kinds = items => items.map(item => item.kind || 'ordinary');
function append(f, kind, at = f.clock.now + 1000) {
  if (kind === 'ordinary') return f.svc.add({ wxid: OWNER, text: 'synthetic reminder', at });
  return f.svc.enqueueNow({ wxid: OWNER, text: 'synthetic notification', kind, pluginId: 'test-t09-plugin', pluginHash: 'test-hash' });
}

for (const [label, order, cap, expected] of [
  ['diary first', ['diary', 'ordinary'], 1, ['diary', 'ordinary']],
  ['ordinary first', ['ordinary', 'diary'], 1, ['ordinary', 'diary']],
  ['multiple diaries', ['diary', 'diary', 'ordinary'], 1, ['diary', 'diary', 'ordinary']],
  ['authorized plugin first', ['plugin', 'ordinary'], 1, ['plugin', 'ordinary']],
  ['cap0 unlimited', ['diary', 'ordinary', 'ordinary'], 0, ['diary', 'ordinary', 'ordinary']],
  ['ordinary hard cap1', ['ordinary', 'ordinary'], 1, ['ordinary']],
]) {
  test(`T09 quota: ${label}`, t => {
    const f = fixture(t, cap);
    for (const kind of order) append(f, kind);
    f.clock.now += 1000;
    assert.deepEqual(kinds(f.svc.due()), expected);
    assert.equal(f.svc.rules().sentToday, expected.filter(kind => kind === 'ordinary').length);
  });
}

test('T09 quota: physical limit still counts notification output', t => {
  const f = fixture(t);
  append(f, 'diary'); append(f, 'ordinary'); f.clock.now += 1000;
  assert.deepEqual(kinds(f.svc.due(f.clock.now, { limit: 1 })), ['diary']);
  assert.equal(f.svc.items[1].status, 'pending');
  assert.deepEqual(kinds(f.svc.due()), ['ordinary']);
});

test('T09 quota: in-flight ordinary jobs reserve the cap across polls', t => {
  const f = fixture(t);
  append(f, 'ordinary'); append(f, 'ordinary'); f.clock.now += 1000;
  assert.equal(f.svc.due(f.clock.now, { limit: 1 }).length, 1);
  assert.equal(f.svc.due().length, 0);
  assert.equal(f.svc.rules().sentToday, 1);
});

function retryFixture(t, cap = 1, start = NOW) {
  const f = fixture(t, cap, start);
  const item = append(f, 'ordinary'); f.clock.now += 1000;
  assert.equal(f.svc.due().length, 1);
  assert.equal(f.svc.ack(item.id, { ok: false, error: 'synthetic failure' }).item.status, 'retrying');
  return { ...f, item };
}
for (const restart of [false, true]) {
  test(`T09 quota: same-day reserved retry at cap1${restart ? ' after restart' : ''}`, t => {
    const f = retryFixture(t); f.clock.now += RETRY_DELAY_MS;
    const svc = restart ? f.make() : f.svc;
    assert.equal(svc.rules().sentToday, 1);
    const out = svc.due();
    assert.equal(out.length, 1);
    assert.equal(out[0].id, f.item.id);
    assert.equal(out[0].attempts, 1);
    assert.equal(svc.rules().sentToday, 1);
  });
}

test('T09 quota: ordinary retry timing remains valid with cap0', t => {
  const f = retryFixture(t, 0);
  assert.equal(f.svc.due().length, 0);
  f.clock.now += RETRY_DELAY_MS;
  assert.equal(f.svc.due().length, 1);
});

for (const order of ['retry-first', 'pending-first']) {
  test(`T09 quota: retry and pending use distinct reservations ${order}`, t => {
    const f = fixture(t, 2), at = f.clock.now + 1000, retryAt = at + RETRY_DELAY_MS;
    let old;
    if (order === 'retry-first') { old = append(f, 'ordinary', at); append(f, 'ordinary', retryAt); }
    else { append(f, 'ordinary', retryAt); old = append(f, 'ordinary', at); }
    f.clock.now = at;
    assert.equal(f.svc.due(f.clock.now, { limit: 1 })[0].id, old.id);
    f.svc.ack(old.id, { ok: false }); f.clock.now = retryAt;
    assert.equal(f.svc.rules().sentToday, 1);
    assert.equal(f.svc.due().length, 2);
    assert.equal(f.svc.rules().sentToday, 2);
  });
}

test('T09 quota: cross-day retry consumes a new-day reservation', t => {
  const f = retryFixture(t, 1, Date.UTC(2026, 0, 1, 23, 59)); f.clock.now += RETRY_DELAY_MS;
  assert.equal(f.svc.rules().sentToday, 0);
  assert.equal(f.svc.due().length, 1);
  assert.equal(f.svc.rules().sentToday, 1);
});

test('T09 quota: old-day retry cannot bypass an already filled new-day cap', t => {
  const f = retryFixture(t, 1, Date.UTC(2026, 0, 1, 23, 59)), retryAt = f.clock.now + RETRY_DELAY_MS;
  f.clock.now = Date.UTC(2026, 0, 2, 0);
  const fresh = append(f, 'ordinary'); f.clock.now += 1000;
  assert.equal(f.svc.due()[0].id, fresh.id); f.svc.ack(fresh.id, { ok: true }); f.clock.now = retryAt;
  assert.equal(f.svc.due().length, 0);
  assert.equal(f.svc.rules().sentToday, 1);
});

test('T09 quota: unconfirmed plugin outcome is never automatically retried', t => {
  const f = fixture(t), item = append(f, 'plugin');
  assert.equal(f.svc.due().length, 1);
  assert.equal(f.svc.ack(item.id, { ok: false }).item.status, 'unconfirmed');
  f.clock.now += RETRY_DELAY_MS;
  assert.equal(f.svc.due().length, 0);
  assert.equal(f.svc.rules().sentToday, 0);
});

test('T09 quota: unknown/custom kind is ordinary rather than a new exemption', t => {
  for (const kind of ['custom', 'unknown', 'DIARY', 'PLUGIN']) {
    const f = fixture(t);
    append(f, kind); append(f, 'ordinary'); f.clock.now += 1000;
    assert.deepEqual(kinds(f.svc.due()), [kind]);
    assert.equal(f.svc.rules().sentToday, 1);
    assert.equal(f.svc.items[1].status, 'expired');
  }
});

test('T09 quota: diary and authorized plugin keep their existing disabled-reminder exemption', t => {
  const f = fixture(t); f.config.reminder.enabled = false;
  append(f, 'diary'); append(f, 'plugin');
  assert.deepEqual(kinds(f.svc.due()), ['diary', 'plugin']);
  assert.equal(f.svc.rules().sentToday, 0);
});

test('T09 quota: revoked plugin cannot claim a task or consume an ordinary reservation', t => {
  const f = fixture(t); append(f, 'plugin'); append(f, 'ordinary');
  f.svc.pluginAllowed = () => false; f.clock.now += 1000;
  assert.deepEqual(kinds(f.svc.due()), ['ordinary']);
  assert.equal(f.svc.items[0].status, 'cancelled');
  assert.equal(f.svc.rules().sentToday, 1);
});

test('T09 quota: final ordinary retry failure stays terminal without another claim', t => {
  const f = retryFixture(t); f.clock.now += RETRY_DELAY_MS;
  assert.equal(f.svc.due().length, 1);
  assert.equal(f.svc.ack(f.item.id, { ok: false }).item.status, 'failed');
  assert.equal(f.svc.due().length, 0);
  assert.equal(f.svc.items[0].attempts, 2);
});

test('T09 quota: day reservation follows configured timezone rather than UTC', t => {
  const f = fixture(t, 1, Date.UTC(2026, 0, 1, 15, 59));
  f.config.env.timezone = 'Asia/Shanghai';
  const item = append(f, 'ordinary'); f.clock.now += 1000;
  assert.equal(f.svc.due().length, 1); f.svc.ack(item.id, { ok: false });
  f.clock.now += RETRY_DELAY_MS;
  assert.equal(f.svc.rules().sentToday, 0);
  assert.equal(f.svc.due().length, 1);
  assert.equal(f.svc.rules().sentToday, 1);
});

test('T09 round2: ordinary uncertain claim retains daily quota across reload without resend', t => {
  const f = fixture(t), item = append(f, 'ordinary'); f.clock.now += 1000; f.svc.due();
  assert.equal(f.svc.ack(item.id, { ok: true, uncertain: true }).item.status, 'unconfirmed');
  const reloaded = f.make();
  assert.equal(reloaded.rules().sentToday, 1);
  assert.throws(() => reloaded.add({ wxid: OWNER, text: 'synthetic extra', at: f.clock.now + 1000 }), { statusCode: 429 });
  f.clock.now += RETRY_DELAY_MS; assert.deepEqual(reloaded.due(), []);
  assert.equal(reloaded.rules().sentToday, 1);
});

test('T09 round2: delayed uncertain ACK retains claimed-day quota rather than moving to ACK day', t => {
  const f = fixture(t, 1, Date.UTC(2026, 0, 1, 23, 59)), item = append(f, 'ordinary');
  f.clock.now += 1000; f.svc.due(); const claimedAt = f.clock.now;
  f.clock.now = Date.UTC(2026, 0, 2, 0, 1);
  f.svc.ack(item.id, { uncertain: true }); const reloaded = f.make();
  assert.equal(reloaded.items[0].status, 'unconfirmed');
  assert.equal(reloaded.items[0].claimedAt, claimedAt);
  assert.equal(reloaded.rules(claimedAt).sentToday, 1);
  assert.equal(reloaded.rules().sentToday, 0);
});

for (const kind of ['plugin', 'diary']) {
  test(`T09 round2: uncertain ${kind} remains exempt from ordinary reminder quota`, t => {
    const f = fixture(t), item = append(f, kind); assert.equal(f.svc.due().length, 1);
    assert.equal(f.svc.ack(item.id, { ok: true, uncertain: true }).item.status, 'unconfirmed');
    assert.equal(f.svc.rules().sentToday, 0);
    assert.equal(f.make().rules().sentToday, 0);
    append(f, 'ordinary'); f.clock.now += 1000; assert.deepEqual(kinds(f.svc.due()), ['ordinary']);
  });
}

test('T09 round2: legacy known-not-sent final failure keeps existing quota release', t => {
  const f = retryFixture(t); f.clock.now += RETRY_DELAY_MS; f.svc.due();
  assert.equal(f.svc.ack(f.item.id, { ok: false, uncertain: false }).item.status, 'failed');
  assert.equal(f.svc.rules().sentToday, 0);
});
