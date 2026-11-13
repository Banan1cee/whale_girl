'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/test-inventory.js'), 'utf8');
const root = path.resolve('isolated-t23-inventory');
function resolve(program, { included = true, extra = {} } = {}) {
  const files = { 'Program.cs': program, 'Unused.cs': 'class Unused { public static void Run() {} }',
    'Checks.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="Program.cs" />${included ? '<Compile Include="Unused.cs" />' : ''}</ItemGroup></Project>`, ...extra };
  const module = { exports: {} };
  const mockFs = { existsSync: () => true, statSync: () => ({ isDirectory: () => false }),
    readdirSync: () => Object.keys(files), readFileSync: (file) => files[path.basename(file)] || '' };
  vm.runInNewContext(source, { module, require: (id) => id === 'node:fs' ? mockFs : require(id), __dirname: path.join(root, 'scripts') });
  return module.exports.resolveRef('tests/checks/Unused.cs', {
    projects: new Set(['tests/checks/Checks.csproj']), globs: [], scripts: new Set(), files: new Set(),
  }, root);
}
for (const [name, program, options] of [
  ['comment', '// Unused.Run();'],
  ['string', 'System.Console.WriteLine("Unused.Run();");'],
  ['dead branch', 'if (false) { Unused.Run(); }'],
  ['uncalled method', 'class Program { static void Main() {} static void Never() { Unused.Run(); } }'],
  ['uncalled local method', 'class Program { static void Main() { void Never() { Unused.Run(); } } }'],
  ['uncalled lambda', 'class Program { static void Main() { Action never = () => { Unused.Run(); }; } }'],
  ['conditional compilation', '#if OMITTED\nUnused.Run();\n#endif'],
  ['raw string', 'System.Console.WriteLine("""Unused.Run();""");'],
  ['uncompiled file', 'Unused.Run();', { included: false }],
  ['call in another uncompiled file', 'System.Console.WriteLine("fixture");', { extra: { 'Excluded.cs': 'class Never { void Call() { Unused.Run(); } }' } }],
]) {
  test(`C# inventory rejects ${name} as case wiring`, () => { assert.equal(resolve(program, options).ok, false); });
}
test('a compiled direct entry call is a declaration, never a verified execution receipt', () => {
  const result = resolve('class Program { static void Main() { Unused.Run(); } }');
  assert.equal(result.ok, true);
  assert.equal(result.executionVerified, false);
  assert.equal(result.evidence, 'declared-entry');
});
