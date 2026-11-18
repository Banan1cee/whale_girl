'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFileAtomicSync } = require('../src/infra/atomicFile');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t09-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }));
  const file = path.join(dir, 'target.dat');
  fs.writeFileSync(file, 'original complete');
  return { dir, file };
}
const staged = (file, target) => typeof file === 'string' && file.startsWith(target + '.') && file.endsWith('.tmp');
const temporary = dir => fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));

test('T09 atomic: raw text, Buffer and explicit encoding retain exact bytes', t => {
  const { file, dir } = fixture(t);
  assert.equal(replaceFileAtomicSync(file, '原样\r\nno trailing newline'), undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), '原样\r\nno trailing newline');
  const buffer = Buffer.from([0, 255, 1, 0]);
  replaceFileAtomicSync(file, buffer);
  assert.deepEqual(fs.readFileSync(file), buffer);
  replaceFileAtomicSync(file, '\u00e9', 'latin1');
  assert.deepEqual(fs.readFileSync(file), Buffer.from([233]));
  assert.deepEqual(temporary(dir), []);
});

test('T09 atomic: same-directory exclusive create retains native default mode', t => {
  const { file } = fixture(t), open = fs.openSync, calls = [];
  t.mock.method(fs, 'openSync', (target, flags, ...rest) => { calls.push({ target, flags, rest }); return open(target, flags, ...rest); });
  const chmod = t.mock.method(fs, 'chmodSync', () => assert.fail('atomic replacement must not invent chmod policy'));
  replaceFileAtomicSync(file, 'complete');
  assert.equal(calls.length, 1);
  assert.equal(path.dirname(calls[0].target), path.dirname(file));
  assert.equal(calls[0].flags, 'wx');
  assert.deepEqual(calls[0].rest, []);
  assert.equal(chmod.mock.callCount(), 0);
});

test('T09 atomic: write and close complete before the target rename', t => {
  const { file } = fixture(t), events = [], open = fs.openSync, write = fs.writeFileSync, close = fs.closeSync, rename = fs.renameSync;
  let descriptor;
  t.mock.method(fs, 'openSync', (target, ...args) => { const fd = open(target, ...args); if (staged(target, file)) { descriptor = fd; events.push('open'); } return fd; });
  t.mock.method(fs, 'writeFileSync', (target, ...args) => { const result = write(target, ...args); if (target === descriptor) events.push('write'); return result; });
  t.mock.method(fs, 'closeSync', fd => { const result = close(fd); if (fd === descriptor) events.push('close'); return result; });
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === file) { assert.deepEqual(events, ['open', 'write', 'close']); events.push('rename'); } return rename(from, to); });
  replaceFileAtomicSync(file, 'complete');
  assert.deepEqual(events, ['open', 'write', 'close', 'rename']);
});

for (const stage of ['open', 'write', 'close', 'rename']) {
  test(`T09 atomic: ${stage} failure retains original bytes and primary error`, t => {
    const { file, dir } = fixture(t), primary = Object.assign(new Error('synthetic ' + stage), { code: 'EIO' });
    const open = fs.openSync, write = fs.writeFileSync, close = fs.closeSync, rename = fs.renameSync;
    let descriptor, closeFault = false;
    t.mock.method(fs, 'openSync', (target, ...args) => {
      if (staged(target, file) && stage === 'open') throw primary;
      const fd = open(target, ...args); if (staged(target, file)) descriptor = fd; return fd;
    });
    t.mock.method(fs, 'writeFileSync', (target, body, ...args) => {
      if (target === descriptor && stage === 'write') { write(target, 'partial', ...args); throw primary; }
      return write(target, body, ...args);
    });
    t.mock.method(fs, 'closeSync', fd => {
      if (fd === descriptor && stage === 'close' && !closeFault) { closeFault = true; throw primary; }
      return close(fd);
    });
    t.mock.method(fs, 'renameSync', (from, to) => { if (to === file && stage === 'rename') throw primary; return rename(from, to); });
    assert.throws(() => replaceFileAtomicSync(file, 'replacement'), error => error === primary);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original complete');
    assert.deepEqual(temporary(dir), []);
  });
}

test('T09 atomic: cleanup denial cannot replace the primary write error', t => {
  const { file, dir } = fixture(t), primary = new Error('synthetic primary write error');
  const open = fs.openSync, write = fs.writeFileSync, unlink = fs.unlinkSync;
  let descriptor;
  t.mock.method(fs, 'openSync', (target, ...args) => { const fd = open(target, ...args); if (staged(target, file)) descriptor = fd; return fd; });
  t.mock.method(fs, 'writeFileSync', (target, body, ...args) => { if (target === descriptor) { write(target, 'partial', ...args); throw primary; } return write(target, body, ...args); });
  t.mock.method(fs, 'unlinkSync', target => { if (staged(target, file)) throw Object.assign(new Error('synthetic cleanup denial'), { code: 'EACCES' }); return unlink(target); });
  assert.throws(() => replaceFileAtomicSync(file, 'new'), error => error === primary);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original complete');
  assert.equal(temporary(dir).length, 1, 'denied cleanup leaves only this fixture-owned temporary');
});

test('T09 atomic: committed success does not become failure during secondary cleanup', t => {
  const { file, dir } = fixture(t);
  const cleanup = t.mock.method(fs, 'unlinkSync', () => { throw new Error('synthetic cleanup denial'); });
  assert.equal(replaceFileAtomicSync(file, 'committed'), undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), 'committed');
  assert.deepEqual(temporary(dir), []);
  assert.equal(cleanup.mock.callCount(), 0);
});

test('T09 atomic: an exclusive-name collision never deletes the foreign temporary', t => {
  const { file } = fixture(t), foreign = file + '.collision.tmp';
  fs.writeFileSync(foreign, 'foreign complete');
  t.mock.method(crypto, 'randomUUID', () => 'collision');
  const unlink = fs.unlinkSync, removed = [];
  t.mock.method(fs, 'unlinkSync', target => { removed.push(target); return unlink(target); });
  assert.throws(() => replaceFileAtomicSync(file, 'new'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'original complete');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign complete');
  assert.deepEqual(removed, []);
});

test('T09 atomic: interleaved writers stage independently and expose only complete targets', t => {
  const { file, dir } = fixture(t), rename = fs.renameSync, names = [], seen = [];
  let nested = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) {
      names.push(from);
      seen.push(fs.readFileSync(file, 'utf8'));
      if (!nested) { nested = true; replaceFileAtomicSync(file, 'inner complete'); seen.push(fs.readFileSync(file, 'utf8')); }
    }
    return rename(from, to);
  });
  assert.equal(replaceFileAtomicSync(file, 'outer complete'), undefined);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every(name => path.dirname(name) === dir));
  assert.ok(seen.every(value => ['original complete', 'inner complete'].includes(value)));
  assert.equal(fs.readFileSync(file, 'utf8'), 'outer complete');
  assert.deepEqual(temporary(dir), []);
});

test('T09 atomic: rename refusal never triggers a destination-unlink fallback', t => {
  const { file, dir } = fixture(t), primary = Object.assign(new Error('synthetic rename refusal'), { code: 'EEXIST' });
  const unlink = fs.unlinkSync, removed = [];
  t.mock.method(fs, 'renameSync', () => { throw primary; });
  t.mock.method(fs, 'unlinkSync', target => { removed.push(target); return unlink(target); });
  assert.throws(() => replaceFileAtomicSync(file, 'replacement'), error => error === primary);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original complete');
  assert.ok(removed.length === 1 && removed.every(target => target !== file));
  assert.deepEqual(temporary(dir), []);
});

test('T09 atomic: native invalid-content error is preserved without serializing values', t => {
  const { file, dir } = fixture(t);
  assert.throws(() => replaceFileAtomicSync(file, { not: 'bytes' }), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'original complete');
  assert.deepEqual(temporary(dir), []);
});
