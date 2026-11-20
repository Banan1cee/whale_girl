'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't22-resources-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const catalog = path.join(base, 'catalog'), stage = path.join(base, 'stage');
  function put(root, rel, bytes) { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  const vendor = { 'wechatauto/module.py': 'fixture source', 'wechatauto/assets/required.png': 'fixture program image' };
  for (const [name, bytes] of Object.entries(vendor)) put(catalog, 'vendor/' + name, bytes);
  const manifestText = Object.entries(vendor).map(([name, bytes]) => hash(bytes) + '  ' + name).join('\n') + '\n';
  put(catalog, 'vendor/MANIFEST.sha256', manifestText);
  const files = [];
  for (const label of ['傲娇', '开心', '炸毛']) for (let i = 0; i < 9; i++) {
    const file = label + '/whale-' + (files.length + 1).toString(16).padStart(16, '0') + '.png';
    const bytes = 'fixture preset ' + files.length;
    files.push({ file, sha256: hash(bytes) }); put(catalog, 'assets/stickers/' + file, bytes);
  }
  put(catalog, 'assets/stickers/manifest.json', JSON.stringify({ version: 1, files }));
  fs.mkdirSync(stage); put(catalog, 'user-photo.png', 'user image must not be restored');
  return { base, catalog, stage, put, manifestHash: hash(manifestText) };
}
test('source restores/validates complete vendor and all presets, excluding unlisted user images', (t) => {
  const { restoreSource, verifyTree } = require('../scripts/release-resources'); const f = fixture(t);
  restoreSource(f.stage, f.catalog);
  assert.equal(verifyTree(f.stage, { role: 'source', catalogRoot: f.catalog }).checked, 29);
  assert.equal(fs.existsSync(path.join(f.stage, 'user-photo.png')), false);
  assert.throws(() => restoreSource(f.catalog, f.catalog), /overlap|重叠/);
  fs.unlinkSync(path.join(f.stage, 'vendor/wechatauto/assets/required.png'));
  assert.throws(() => verifyTree(f.stage, { role: 'source', catalogRoot: f.catalog }), /required.png/);
});
test('source rejects corruption, additional vendor cache and live-data roots', (t) => {
  const { restoreSource, verifyTree } = require('../scripts/release-resources'); const f = fixture(t);
  restoreSource(f.stage, f.catalog); f.put(f.stage, 'vendor/wechatauto/module.py', 'corrupted');
  assert.throws(() => verifyTree(f.stage, { role: 'source', catalogRoot: f.catalog }), /module.py/);
  restoreSource(f.stage, f.catalog); f.put(f.stage, 'vendor/wechatauto/__pycache__/x.pyc', 'cache');
  assert.throws(() => verifyTree(f.stage, { role: 'source', catalogRoot: f.catalog }), /unlisted|额外/);
  fs.rmSync(path.join(f.stage, 'vendor/wechatauto/__pycache__'), { recursive: true });
  f.put(f.stage, 'assets/stickers/user-photo.png', 'unlisted user image');
  assert.throws(() => verifyTree(f.stage, { role: 'source', catalogRoot: f.catalog }), /unlisted|额外/);
  fs.unlinkSync(path.join(f.stage, 'assets/stickers/user-photo.png')); f.put(f.stage, 'config.json', '{}');
  assert.throws(() => verifyTree(f.stage, { role: 'source', catalogRoot: f.catalog }), /config.json/);
});
test('actual bounded ZIP verification accepts fixture and rejects a missing program image', (t) => {
  const { resourcePlan, restoreSource } = require('../scripts/release-resources'); const f = fixture(t);
  restoreSource(f.stage, f.catalog);
  const plan = path.join(f.base, 'plan.json'), zip = path.join(f.base, 'fixture.zip');
  fs.writeFileSync(plan, JSON.stringify(resourcePlan(f.catalog, 'source')));
  const build = fs.readFileSync(path.resolve(__dirname, '../scripts/build-release.ps1'), 'utf8');
  const block = build.slice(build.indexOf('foreach ($zipPath in @($srcZip, $fullZip)'), build.indexOf('\nRemove-Item $build'));
  assert.ok(block.length > 100 && !/Compress-Archive|robocopy|Remove-Item|ISCC|dotnet publish/.test(block), 'run only read-only archive verification');
  const q = (text) => "'" + text.replace(/'/g, "''") + "'";
  const prelude = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$srcZip=${q(zip)}; $fullZip=$null; $pkgName='stage'; $pkgNameFull='unused'; $checks=@(); $root=${q(f.catalog)}; $stage=${q(f.stage)}
$script:planJson=[IO.File]::ReadAllText(${q(plan)})
function T22FixturePlan { $script:planJson }
$node='T22FixturePlan'; $global:LASTEXITCODE=0
`;
  const run = (script) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  const good = run(prelude + `[IO.Compression.ZipFile]::CreateFromDirectory(${q(f.stage)},$srcZip,[IO.Compression.CompressionLevel]::Optimal,$true)\n` + block);
  assert.equal(good.status, 0, good.stderr);
  const bad = run(prelude + `$archive=[IO.Compression.ZipFile]::Open($srcZip,[IO.Compression.ZipArchiveMode]::Update)\ntry { $archive.GetEntry('stage/vendor/wechatauto/assets/required.png').Delete() } finally { $archive.Dispose() }\n` + block);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /required\.png/);
});
for (const role of ['full', 'installer']) test(`${role} checks runtime images/provenance without raw vendor-source assumptions`, (t) => {
  const { resourcePlan, verifyTree } = require('../scripts/release-resources'); const f = fixture(t);
  const plan = resourcePlan(f.catalog, role);
  for (const entry of plan.files) f.put(f.stage, entry.path, fs.readFileSync(path.join(f.catalog, entry.source)));
  f.put(f.stage, 'assets/stickers/manifest.json', fs.readFileSync(path.join(f.catalog, 'assets/stickers/manifest.json')));
  f.put(f.stage, 'runtime/.built', 'fixture|vendor=' + f.manifestHash + '|schema=3');
  f.put(f.stage, 'runtime/python/Lib/site-packages/wechatauto/module.py', 'prepared runtime may differ');
  assert.equal(verifyTree(f.stage, { role, catalogRoot: f.catalog }).checked, 28);
  if (role === 'installer') {
    fs.unlinkSync(path.join(f.stage, 'runtime/.built'));
    assert.equal(verifyTree(f.stage, { role, catalogRoot: f.catalog, payload: true }).metadataChecked, 1);
    assert.throws(() => verifyTree(f.stage, { role, catalogRoot: f.catalog }), /\.built/);
  }
  f.put(f.stage, plan.files[0].path, 'corrupt');
  assert.throws(() => verifyTree(f.stage, { role, catalogRoot: f.catalog }), /hash|校验/);
});
test('catalog traversal and symlink escape fail without reading outside the fixture', (t) => {
  const { resourcePlan, restoreSource } = require('../scripts/release-resources'); const f = fixture(t);
  f.put(f.catalog, 'vendor/MANIFEST.sha256', hash('outside') + '  ../outside.txt\n');
  assert.throws(() => resourcePlan(f.catalog, 'source'), /path|路径/);
  const g = fixture(t); const outside = path.join(g.base, 'outside.png'); fs.writeFileSync(outside, 'outside');
  const outsideDir = path.join(g.base, 'outside-assets'); fs.mkdirSync(outsideDir); fs.copyFileSync(outside, path.join(outsideDir, 'required.png'));
  fs.rmSync(path.join(g.catalog, 'vendor/wechatauto/assets'), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(g.catalog, 'vendor/wechatauto/assets'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => restoreSource(g.stage, g.catalog), /escape|越界/);
});
test('build entrypoints validate resources before packaging/signing and archive checks use the same plan', () => {
  const root = path.resolve(__dirname, '..'); const build = fs.readFileSync(path.join(root, 'scripts/build-release.ps1'), 'utf8');
  assert.match(build, /release-resources\.js' restore-source/); assert.match(build, /release-resources\.js' verify-tree/);
  assert.match(build, /release-resources\.js' plan/);
  assert.ok(build.indexOf('verify-tree') < build.indexOf('Compress-Archive'));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/installer.yml'), 'utf8');
  assert.match(workflow, /release-resources\.js verify-tree installer/);
  assert.ok(workflow.indexOf('release-resources.js verify-tree installer') < workflow.indexOf('& $env:ISCC'));
});
