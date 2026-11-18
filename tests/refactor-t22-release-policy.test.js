'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('pinned legacy latest cannot reopen the same selected-target brake in the actual generator', t => {
  const source = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t22-private-producer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  const sourceFiles = ['scripts/make-manifest.ps1', 'scripts/release-update-policy.json', 'package.json'];
  for (const file of sourceFiles) fs.copyFileSync(path.join(source, file), path.join(root, file));
  const previous = { latest: '4.1.6', legacy_latest: '4.1.6', epoch: 1, brand_latest: '4.1.7', target: '4.1.7',
    manifest_version: 30, force: false, force_from: '4.1.6', force_versions: [], kill_below: null,
    force_after_hours: 12, message: 'fixture manual brake', release_notes: 'fixture summary',
    release_details: 'fixture details', update_warning: 'fixture warning', update_warning_version: '4.1.7',
    custom_metadata: { nested: { preserved: true } } };
  const template = path.join(root, 'template.json'), output = path.join(root, 'candidate.json');
  fs.writeFileSync(template, JSON.stringify(previous));
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  const readonly = [...sourceFiles, 'template.json'];
  const before = Object.fromEntries(readonly.map(file => [file, digest(file)]));
  // The real script reads package/policy only beside this private source copy and writes this private OutFile.
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/make-manifest.ps1'),
    '-Version', '4.1.7', '-TemplateFile', template, '-OutFile', output], { cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(value.force, false); assert.deepEqual(value.force_versions, []);
  assert.equal(value.manifest_version, 31);
  assert.deepEqual([value.latest, value.legacy_latest, value.brand_latest, value.target, value.epoch],
    ['4.1.6', '4.1.6', '4.1.7', '4.1.7', 1]);
  for (const key of ['force_from', 'kill_below', 'force_after_hours', 'message', 'release_notes', 'release_details',
    'update_warning', 'update_warning_version', 'custom_metadata']) assert.deepEqual(value[key], previous[key]);
  assert.deepEqual(Object.fromEntries(readonly.map(file => [file, digest(file)])), before);
});
