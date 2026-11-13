'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
function audit(input) {
  return spawnSync(process.env.PYTHON || 'python', ['-B', 'scripts/check-python-tests.py', '--stdin', 'fixture.py'],
    { cwd: ROOT, input, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' } });
}
test('Python AST audit rejects shadowing, including nested suites and async methods', () => {
  const result = audit('class Suite:\n def test_same(self): pass\n async def test_same(self): pass\n');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /duplicate-test/);
  assert.match(result.stdout, /Suite.test_same/);
});
test('Python AST audit allows separate classes and reports syntax errors without importing', () => {
  const safe = audit('raise RuntimeError("must not import")\nclass A:\n def test_same(self): pass\nclass B:\n def test_same(self): pass\n');
  assert.equal(safe.status, 0, safe.stderr);
  assert.equal(JSON.parse(safe.stdout).declaredTests, 2);
  const broken = audit('class Broken(:\n');
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /syntax-error/);
});
test('both formerly shadowed user-flow bodies remain intact and execute all assertions in isolation', () => {
  const script = `import ast, pathlib, unittest, json, copy
p=pathlib.Path('tests/test_user_flows.py')
t=ast.parse(p.read_text(encoding='utf-8-sig'))
c=next(n for n in t.body if isinstance(n,ast.ClassDef) and n.name=='BridgeUserFlows')
methods=[n for n in c.body if isinstance(n,ast.FunctionDef) and n.name.startswith('test_garbled_gbk_text_is_restored_before_sending')]
assert len(methods)==2
assert len({n.name for n in methods})==2, 'duplicate test is still shadowed'
assert all(sum(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='assertEqual' for n in ast.walk(m))==5 for m in methods)
left,right=copy.deepcopy(methods[0]),copy.deepcopy(methods[1]);left.name=right.name='same'
assert ast.dump(left,include_attributes=False)==ast.dump(right,include_attributes=False), 'original method bodies changed'
engine=ast.parse(pathlib.Path('bridge/engine.py').read_text(encoding='utf-8-sig'))
fix=next(n for n in engine.body if isinstance(n,ast.FunctionDef) and n.name=='fix_garbled')
env={};exec(compile(ast.fix_missing_locations(ast.Module(body=[fix],type_ignores=[])),'isolated-fix','exec'),env)
namespace={'unittest':unittest,'function':lambda name,scope:env[name]}
cls=ast.ClassDef(name='IsolatedCases',bases=[ast.Attribute(value=ast.Name(id='unittest',ctx=ast.Load()),attr='TestCase',ctx=ast.Load())],keywords=[],body=methods,decorator_list=[])
exec(compile(ast.fix_missing_locations(ast.Module(body=[cls],type_ignores=[])),'isolated-cases','exec'),namespace)
namespace['IsolatedCases'].env=lambda self:({},None,[],None,None)
suite=unittest.defaultTestLoader.loadTestsFromTestCase(namespace['IsolatedCases']);result=unittest.TestResult();suite.run(result)
assert result.testsRun==2 and not result.errors and not result.failures, (result.errors,result.failures)
print(json.dumps({'testsRun':result.testsRun,'assertionsPreserved':10,'productionImports':0}))
`;
  const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-c', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).testsRun, 2);
  assert.ok(fs.existsSync(path.join(ROOT, 'tests/test_user_flows.py')));
});
