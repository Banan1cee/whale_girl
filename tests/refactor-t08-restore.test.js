'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const backup = require('../src/memory/backup');

function seed(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t08-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 }));
  const data = path.join(root, 'data');
  const memory = path.join(data, 'memory');
  const original = {
    'manifest.json': '{"old":true}',
    'chats/aaaaaaaaaaaaaaaa/messages.jsonl': '{"fixture":true}\n',
    'archive/cold/old.bin': Buffer.from([0, 1, 255]),
    'legacy/old.json': '{"legacy":true}',
  };
  for (const [rel, body] of Object.entries(original)) {
    const file = path.join(memory, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  fs.writeFileSync(path.join(data, 'settings.json'), '{"provider":"fixture","userName":"before"}');
  const bundle = { kind: 'whale-girl-memory', version: 2, files: { memory: {
    'manifest.json': '{"new":true}',
    'chats/bbbbbbbbbbbbbbbb/messages.jsonl': '{"restored":true}\n',
  }, settings: { userName: 'after' } } };
  return { root, data, memory, original, bundle };
}

function assertOriginal(fixture) {
  for (const [rel, body] of Object.entries(fixture.original)) {
    assert.deepEqual(fs.readFileSync(path.join(fixture.memory, rel)), Buffer.from(body), rel);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.data, 'settings.json'))).userName, 'before');
}

test('T08/F17: archive copy failure aborts before replacing active or cold memory', t => {
  const fixture = seed(t);
  const cp = fs.cpSync;
  let injected = false;
  t.mock.method(fs, 'cpSync', (from, to, options) => {
    if (from === path.join(fixture.memory, 'archive')) {
      injected = true;
      throw Object.assign(new Error('T08 fixture archive copy failure'), { code: 'EACCES' });
    }
    return cp(from, to, options);
  });
  assert.throws(() => backup.restoreFrom(fixture.root, fixture.bundle), { code: 'EACCES' });
  assert.equal(injected, true);
  assertOriginal(fixture);
});
