'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const [version, fileVersion] of [['4.1', '4.1.0.0'], ['4.1.3', '4.1.3.0'], ['4.1.2.1', '4.1.2.1']]) {
  test(`version metadata maps ${version} without adding an extra component`, () => {
    const { versionMetadata } = require('../scripts/version-policy');
    const value = versionMetadata(version, { tag: 'v' + version });
    assert.equal(value.version, version);
    assert.equal(value.fileVersion, fileVersion);
    assert.equal(value.setupName, `whale-girl-${version}-setup.exe`);
    assert.equal(value.sourceName, `whale-girl-${version}.zip`);
    assert.equal(value.fullName, `whale-girl-${version}-full.zip`);
  });
}
test('version mapping rejects invalid, overflow, or mismatched release identities', () => {
  const { versionMetadata } = require('../scripts/version-policy');
  for (const version of ['4', '4.1.2.3.0', '4.x.2', '4.1.-1', '4.1.65536', '4.1.3-alpha']) assert.throws(() => versionMetadata(version));
  assert.throws(() => versionMetadata('4.1.3', { tag: 'v4.1.2' }), /tag|版本/);
});
test('bump arithmetic preserves legacy ordinary style and gives hotfix an explicit fourth field', () => {
  const { bumpVersion } = require('../scripts/version-policy');
  for (const [v, level, expected] of [['3.60', 'minor', '3.61'], ['3.60', 'patch', '3.60.1'],
    ['3.60', 'hotfix', '3.60.0.1'], ['4.1.3', 'hotfix', '4.1.3.1'], ['4.1.3.1', 'hotfix', '4.1.3.2'],
    ['4.1.3.2', 'patch', '4.1.4'], ['4.1.3', 'major', '5.0.0']]) assert.equal(bumpVersion(v, level), expected);
  assert.throws(() => bumpVersion('4.1.3', 'unknown'));
});
test('both artifact workflows use the shared values and fail mismatched actual properties', () => {
  for (const file of ['.github/workflows/build.yml', '.github/workflows/installer.yml']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(text, /scripts\/version-policy\.js/);
    assert.match(text, /"-p:Version=\$\(\$meta\.version\)"/);
    assert.match(text, /"-p:FileVersion=\$\(\$meta\.fileVersion\)"/);
    assert.match(text, /FileVersion.*-ne.*\$meta\.fileVersion/);
    assert.match(text, /ProductVersion.*-ne.*\$meta\.productVersion/);
    assert.doesNotMatch(text, /-p:FileVersion=\$env:version\.0/);
  }
});
test('actual PowerShell-to-native argv renders metadata fields as four exact property arguments', () => {
  const { spawnSync } = require('node:child_process');
  const currentVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(currentVersion, '4.1.7');
  const meta = require('../scripts/version-policy').versionMetadata(currentVersion);
  assert.deepEqual([meta.version, meta.fileVersion, meta.productVersion], ['4.1.7', '4.1.7.0', '4.1.7']);
  const q = (text) => "'" + text.replace(/'/g, "''") + "'";
  for (const file of ['.github/workflows/build.yml', '.github/workflows/installer.yml']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const args = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^"?-p:(Version|FileVersion|AssemblyVersion|ProductVersion)=/.test(line)).map((line) => line.replace(/\s*`$/, ''));
    assert.equal(args.length, 4);
    const script = `$meta=${q(JSON.stringify(meta))}|ConvertFrom-Json\n& ${q(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- ${args.join(' ')}\n`;
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), ['-p:Version=' + meta.version, '-p:FileVersion=' + meta.fileVersion, '-p:AssemblyVersion=' + meta.fileVersion, '-p:ProductVersion=' + meta.productVersion]);
  }
});
test('bump CLI arithmetic and writes are exercised only through in-memory filesystem mocks', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(root, 'scripts/bump-version.js'), 'utf8');
  const writes = new Map();
  const fakeFs = { readFileSync: (file) => file.endsWith('package.json') ? '{"version":"4.1.2.1"}' : '# history\n\n## 4.1.2.1\n\nfixture old notes\n',
    writeFileSync: (file, text) => writes.set(file, text) };
  vm.runInNewContext(source, { __dirname: path.join(root, 'scripts'),
    require: (id) => id === 'node:fs' ? fakeFs : id === './version-policy' ? require('../scripts/version-policy') : require(id),
    process: { argv: ['node', 'bump-version.js', 'fixture change', '--level=hotfix'], exit(code) { throw new Error('unexpected exit ' + code); } },
    console: { log() {}, error() {} } });
  assert.equal(writes.size, 2);
  assert.equal(JSON.parse(writes.get(path.join(root, 'package.json'))).version, '4.1.2.2');
  assert.match(writes.get(path.join(root, 'docs/CHANGELOG.md')), /^## 4\.1\.2\.2\n/m);
});
test('diagnostics delegates to the existing LocalVersion and native fallback cases remain in the existing project', () => {
  const text = fs.readFileSync(path.join(root, 'launcher/Views/DiagPage.xaml.cs'), 'utf8');
  const method = text.slice(text.indexOf('private string LauncherVersion()'), text.indexOf('private static string SafeOsText'));
  assert.match(method, /UpdateManifestService\.LocalVersion\(_sup\.BaseDir\)/);
  assert.doesNotMatch(method, /Regex\.Match|-alpha|GetName\(\)\.Version/);
  const cases = fs.readFileSync(path.join(root, 'tests/launcher/UpdateChecks/Program.cs'), 'utf8');
  for (const id of ['T22 LocalVersion release', 'T22 LocalVersion development', 'T22 LocalVersion corrupt fallback', 'T22 LocalVersion missing fallback']) assert.ok(cases.includes(id), id);
});
