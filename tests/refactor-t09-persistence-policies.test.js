'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReminderService } = require('../src/modules/reminders');
const { DiaryService } = require('../src/modules/diary');
const json = require('../src/infra/jsonFile');

const NOW = Date.UTC(2026, 0, 1, 12);
const OWNER = 'wxid_test_t09_owner';
function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t09-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));
  return dir;
}
const temps = dir => fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
function fault(t, target, stage) {
  const open = fs.openSync, write = fs.writeFileSync, rename = fs.renameSync, names = new Map();
  const matches = file => typeof file === 'string' && file.startsWith(target + '.') && file.endsWith('.tmp') && !file.startsWith(target + '.bak.');
  t.mock.method(fs, 'openSync', (file, ...args) => { const fd = open(file, ...args); names.set(fd, file); return fd; });
  t.mock.method(fs, 'writeFileSync', (file, body, ...args) => {
    if (stage === 'write' && matches(typeof file === 'number' ? names.get(file) : file)) {
      write(file, 'partial', ...args);
      throw Object.assign(new Error('synthetic partial write'), { code: 'ENOSPC' });
    }
    return write(file, body, ...args);
  });
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (stage === 'rename' && to === target) throw Object.assign(new Error('synthetic rename failure'), { code: 'EACCES' });
    return rename(from, to);
  });
}

for (const stage of ['write', 'rename']) {
  test(`T09 persistence: reminder ${stage} failure rolls back and cleans only its staging file`, t => {
    const dir = root(t), clock = { now: NOW };
    const config = { paths: { dataDir: dir }, env: { timezone: 'UTC' } };
    const svc = new ReminderService(config, { now: () => clock.now });
    svc.add({ wxid: OWNER, text: 'synthetic old', at: NOW + 1000 });
    const main = fs.readFileSync(svc.file), mirror = fs.readFileSync(svc.file + '.bak'), memory = JSON.stringify(svc.items);
    fault(t, svc.file, stage);
    assert.throws(() => svc.add({ wxid: OWNER, text: 'synthetic new', at: NOW + 2000 }), { statusCode: 503 });
    assert.deepEqual(fs.readFileSync(svc.file), main);
    assert.deepEqual(fs.readFileSync(svc.file + '.bak'), mirror);
    assert.equal(JSON.stringify(svc.items), memory);
    assert.deepEqual(temps(dir), []);
  });
  test(`T09 persistence: diary index ${stage} failure is best-effort and leaves no staging file`, t => {
    const svc = new DiaryService({ paths: { dataDir: root(t) } }, { store: { sessions: new Map() }, now: () => NOW });
    svc.saveIndex('2025-12-31', '2025/12-31.md', 'synthetic old');
    const previous = fs.readFileSync(svc.indexFile);
    fault(t, svc.indexFile, stage);
    assert.equal(svc.saveIndex('2026-01-01', '2026/01-01.md', 'synthetic new'), undefined);
    assert.deepEqual(fs.readFileSync(svc.indexFile), previous);
    assert.deepEqual(temps(svc.dir), []);
  });
}

function reminder(t) {
  const dir = root(t), clock = { now: NOW }, warnings = [];
  const config = { paths: { dataDir: dir }, env: { timezone: 'UTC' } };
  const make = () => new ReminderService(config, { now: () => clock.now, logger: { warn: value => warnings.push(value) } });
  return { dir, clock, warnings, make, svc: make() };
}
function diary(t) {
  const dir = root(t), warnings = [], queued = [];
  const config = { paths: { dataDir: dir }, env: { timezone: 'UTC' }, diary: { sendToOwner: false }, persona: { name: 'Fixture', master: { wxids: [OWNER], names: ['Fixture Owner'] } } };
  const session = { platform: 'wechat', chatType: 'private', chatId: OWNER, title: 'Fixture Owner', messages: [{ role: 'user', uid: OWNER, name: 'Fixture Owner', text: 'synthetic source', ts: NOW - 1000 }] };
  const svc = new DiaryService(config, {
    store: { sessions: new Map([['owner', session]]) }, now: () => NOW,
    llm: { isMock: false, complete: async () => 'Synthetic fixture diary.' },
    logger: { warn: value => warnings.push(value), info() {}, debug() {} },
    enqueue: value => { queued.push(value); throw new Error('No actual delivery permitted'); },
  });
  return { dir, warnings, queued, svc };
}

test('T09 persistence: reminder main and mirror retain compact version1 bytes without newline', t => {
  const f = reminder(t);
  f.svc.add({ wxid: OWNER, text: 'synthetic', at: NOW + 1000 });
  const expected = JSON.stringify({ version: 1, savedAt: NOW, items: f.svc.items });
  assert.equal(fs.readFileSync(f.svc.file, 'utf8'), expected);
  assert.equal(fs.readFileSync(f.svc.file + '.bak', 'utf8'), expected);
  assert.equal(expected.endsWith('\n'), false);
  assert.deepEqual(temps(f.dir), []);
});

for (const stage of ['write', 'rename']) {
  test(`T09 persistence: mirror ${stage} failure cannot reverse the committed main`, t => {
    const f = reminder(t);
    f.svc.add({ wxid: OWNER, text: 'synthetic old', at: NOW + 1000 });
    const oldMirror = fs.readFileSync(f.svc.file + '.bak');
    fault(t, f.svc.file + '.bak', stage);
    assert.ok(f.svc.add({ wxid: OWNER, text: 'synthetic new', at: NOW + 2000 }).id);
    assert.equal(JSON.parse(fs.readFileSync(f.svc.file)).items.length, 2);
    assert.equal(f.svc.items.length, 2);
    assert.deepEqual(fs.readFileSync(f.svc.file + '.bak'), oldMirror);
    assert.equal(f.warnings.length, 1);
    assert.deepEqual(temps(f.dir), []);
  });
}

test('T09 persistence: latest completed mirror restores a damaged main without resending', t => {
  const f = reminder(t), item = f.svc.add({ wxid: OWNER, text: 'synthetic', at: NOW + 1000 });
  f.clock.now += 1000; f.svc.due(); f.svc.ack(item.id, { ok: true });
  fs.writeFileSync(f.svc.file, '{damaged');
  const restored = f.make();
  assert.equal(restored.items[0].status, 'done');
  assert.deepEqual(restored.due(), []);
});

test('T09 persistence: two damaged copies refuse overwrite with the original503 rollback contract', t => {
  const f = reminder(t);
  fs.writeFileSync(f.svc.file, '{damaged'); fs.writeFileSync(f.svc.file + '.bak', 'damaged backup');
  const broken = f.make();
  assert.equal(broken.loadFailed, true);
  assert.throws(() => broken.add({ wxid: OWNER, text: 'synthetic', at: NOW + 1000 }), { statusCode: 503 });
  assert.equal(fs.readFileSync(f.svc.file, 'utf8'), '{damaged');
  assert.equal(fs.readFileSync(f.svc.file + '.bak', 'utf8'), 'damaged backup');
  assert.deepEqual(broken.items, []);
});

test('T09 persistence: diary index retains pretty2 bytes, summary and400-entry policy', t => {
  const f = diary(t), entries = {};
  for (let i = 0; i < 401; i++) {
    const day = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    entries[day] = { file: `${day.slice(0, 4)}/${day.slice(5)}.md`, summary: 'synthetic old', createdAt: 1 };
  }
  fs.mkdirSync(f.svc.dir, { recursive: true });
  fs.writeFileSync(f.svc.indexFile, JSON.stringify({ version: 1, entries }));
  assert.equal(f.svc.saveIndex('2026-01-01', '2026/01-01.md', '  synthetic\n body  '), undefined);
  const value = f.svc.loadIndex(), raw = fs.readFileSync(f.svc.indexFile, 'utf8');
  assert.equal(Object.keys(value.entries).length, 400);
  assert.equal(value.entries['2024-01-01'], undefined);
  assert.equal(value.entries['2024-01-02'], undefined);
  assert.deepEqual(value.entries['2026-01-01'], { file: '2026/01-01.md', summary: 'synthetic body', createdAt: NOW });
  assert.equal(raw, JSON.stringify(value, null, 2));
  assert.equal(raw.endsWith('\n'), false);
});

test('T09 persistence: diary index failure remains undefined and warns without failing published body', async t => {
  const f = diary(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === f.svc.indexFile) throw new Error('synthetic index failure'); return rename(from, to); });
  assert.equal(await f.svc.write(false), 'saved');
  assert.ok(fs.existsSync(path.join(f.svc.dir, f.svc.fileFor('2026-01-01'))));
  assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.queued, []);
  assert.deepEqual(temps(f.svc.dir), []);
});

test('T09 persistence: diary unsupported-link fallback uses COPYFILE_EXCL and keeps the final newline', async t => {
  const f = diary(t), copy = fs.copyFileSync, flags = [];
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('synthetic unsupported link'), { code: 'EPERM' }); });
  t.mock.method(fs, 'copyFileSync', (from, to, flag) => { flags.push(flag); return copy(from, to, flag); });
  assert.equal(await f.svc.write(false), 'saved');
  assert.deepEqual(flags, [fs.constants.COPYFILE_EXCL]);
  const file = path.join(f.svc.dir, f.svc.fileFor('2026-01-01'));
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
  assert.deepEqual(temps(path.dirname(file)), []);
});

for (const fallback of [false, true]) {
  test(`T09 persistence: a diary winner created before ${fallback ? 'exclusive copy' : 'hard-link'} publication is never overwritten`, async t => {
    const f = diary(t), target = path.join(f.svc.dir, f.svc.fileFor('2026-01-01')), write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, body, ...args) => {
      const result = write(file, body, ...args);
      if (typeof file === 'string' && file.startsWith(target + '.') && file.endsWith('.tmp')) write(target, 'synthetic winner', 'utf8');
      return result;
    });
    if (fallback) t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('synthetic unsupported link'), { code: 'EPERM' }); });
    assert.equal(await f.svc.write(false), 'existing');
    assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic winner');
    assert.deepEqual(temps(path.dirname(target)), []);
  });
}

test('T09 persistence: diary body cleanup denial cannot change an already saved result', async t => {
  const f = diary(t), target = path.join(f.svc.dir, f.svc.fileFor('2026-01-01')), unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => { if (String(file).startsWith(target + '.') && String(file).endsWith('.tmp')) throw new Error('synthetic cleanup denial'); return unlink(file); });
  assert.equal(await f.svc.write(false), 'saved');
  assert.ok(fs.existsSync(target));
  assert.equal(f.warnings.length, 1);
  assert.equal(temps(path.dirname(target)).length, 1);
});

test('T09 persistence: centralized JSON readers keep BOM/fallback identity/journal semantics', t => {
  const dir = root(t), file = path.join(dir, 'fixture.json'), fallback = { marker: true };
  assert.deepEqual(Object.keys(json).sort(), ['readJournal', 'readJson']);
  fs.writeFileSync(file, '\uFEFF{"zero":0,"flag":false}');
  assert.deepEqual(json.readJson(file), { zero: 0, flag: false });
  fs.writeFileSync(file, '{bad');
  assert.equal(json.readJson(file, fallback), fallback);
  assert.equal(json.readJson(file + '.missing'), null);
  fs.writeFileSync(file + '.journal', '{"a":1}\n{"partial"\n\n{"b":2}\n');
  assert.deepEqual(json.readJournal(file), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(json.readJournal(file + '.missing'), []);
});

test('T09 persistence: reader access errors remain nonthrowing fallbacks', t => {
  const file = path.join(root(t), 'fixture.json'), read = fs.readFileSync, fallback = { marker: true };
  t.mock.method(fs, 'readFileSync', (target, ...args) => { if (target === file || target === file + '.journal') throw Object.assign(new Error('synthetic access failure'), { code: 'EACCES' }); return read(target, ...args); });
  assert.equal(json.readJson(file, fallback), fallback);
  assert.deepEqual(json.readJournal(file), []);
});

for (const stage of ['write', 'rename']) {
  test(`T09 round2: uncertain ACK ${stage} failure retains durable sending and original503 rollback`, t => {
    const f = reminder(t), item = f.svc.add({ wxid: OWNER, text: 'synthetic', at: NOW + 1000 });
    f.clock.now += 1000; f.svc.due();
    const main = fs.readFileSync(f.svc.file), mirror = fs.readFileSync(f.svc.file + '.bak'), memory = JSON.stringify(f.svc.items);
    fault(t, f.svc.file, stage);
    assert.throws(() => f.svc.ack(item.id, { ok: true, uncertain: true }), { statusCode: 503 });
    assert.deepEqual(fs.readFileSync(f.svc.file), main);
    assert.deepEqual(fs.readFileSync(f.svc.file + '.bak'), mirror);
    assert.equal(JSON.stringify(f.svc.items), memory);
    assert.deepEqual(temps(f.dir), []);
    const reloaded = f.make(); assert.equal(reloaded.items[0].status, 'sending'); assert.equal(reloaded.rules().sentToday, 1);
  });
}

test('T09 round2: mirror refusal does not reverse a committed uncertain ACK and recovery remains terminal', t => {
  const f = reminder(t), item = f.svc.add({ wxid: OWNER, text: 'synthetic', at: NOW + 1000 });
  f.clock.now += 1000; f.svc.due(); const mirror = fs.readFileSync(f.svc.file + '.bak');
  fault(t, f.svc.file + '.bak', 'rename');
  assert.equal(f.svc.ack(item.id, { uncertain: true, ok: true }).item.status, 'unconfirmed');
  assert.deepEqual(fs.readFileSync(f.svc.file + '.bak'), mirror);
  const reloaded = f.make(); assert.equal(reloaded.items[0].status, 'unconfirmed');
  assert.deepEqual(reloaded.due(), []); assert.equal(reloaded.rules().sentToday, 1);
  assert.equal(f.warnings.length, 1); assert.deepEqual(temps(f.dir), []);
});
