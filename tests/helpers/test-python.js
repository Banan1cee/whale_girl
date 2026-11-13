'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');

function selectTestPython({ env = process.env, root = ROOT, platform = process.platform,
  exists = fs.existsSync, spawn = spawnSync } = {}) {
  const explicit = env.WHALE_TEST_PYTHON || env.PYTHON;
  const bundled = path.join(root, 'runtime/python/python.exe');
  const hasBundled = platform === 'win32' && exists(bundled);
  const candidates = explicit ? [explicit] : [
    ...(hasBundled ? [bundled] : []),
    ...(platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']),
  ];
  for (const candidate of candidates) {
    let result;
    try {
      result = spawn(candidate, ['-I', '-B', '-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf8', timeout: 10000,
        env: { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
      });
    } catch { continue; }
    const executable = String(result.stdout || '').trim().split(/\r?\n/).pop();
    if (!result.error && result.status === 0 && path.isAbsolute(executable)) return executable;
  }
  if (explicit || env.CI || hasBundled) {
    const error = new Error('Required test Python is unavailable; provide a working WHALE_TEST_PYTHON/PYTHON or PATH interpreter');
    error.code = 'ERR_TEST_PYTHON_UNAVAILABLE';
    throw error;
  }
  return null;
}

function createBridgeFixture(t, { sourceRoot = ROOT } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-t23-python-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const bridgeDir = path.join(root, 'bridge');
  fs.mkdirSync(bridgeDir);
  // 只复制 Python 源码；不复制原目录的配置、数据、缓存或便携运行环境。
  for (const entry of fs.readdirSync(path.join(sourceRoot, 'bridge'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.py')) fs.copyFileSync(path.join(sourceRoot, 'bridge', entry.name), path.join(bridgeDir, entry.name));
  }
  const prelude = `import os, sys, types
_TEST_ROOT = ${JSON.stringify(root)}
_TEST_SOURCE_ROOT = ${JSON.stringify(sourceRoot)}
sys.path.insert(0, _TEST_ROOT)
sys.path.insert(0, os.path.join(_TEST_ROOT, 'bridge'))
_TEST_PROBES = {'process': 0, 'drives': 0}
def _test_no_processes(*args, **kwargs):
    _TEST_PROBES['process'] += 1
    return []
def _test_no_drives(*args, **kwargs):
    _TEST_PROBES['drives'] += 1
    return []
def _test_forbidden_process(*args, **kwargs):
    raise RuntimeError('host process access forbidden in bridge fixture')
_TEST_PSUTIL = types.ModuleType('psutil')
_TEST_PSUTIL.process_iter = _test_no_processes
_TEST_PSUTIL.disk_partitions = _test_no_drives
_TEST_PSUTIL.Process = _test_forbidden_process
sys.modules['psutil'] = _TEST_PSUTIL
_TEST_CONFIG = os.path.normcase(os.path.realpath(os.path.join(_TEST_SOURCE_ROOT, 'config.json')))
_TEST_DATA = os.path.normcase(os.path.realpath(os.path.join(_TEST_SOURCE_ROOT, 'data')))
def _test_audit(event, args):
    if event in ('subprocess.Popen', 'os.system', 'os.startfile', 'socket.connect', 'socket.getaddrinfo'):
        raise RuntimeError('external operation forbidden in bridge fixture: ' + event)
    if event == 'import' and args and str(args[0]).startswith(('win32', 'uiautomation', 'pyautogui', 'wechatauto')):
        raise RuntimeError('UI import forbidden in bridge fixture')
    if event in ('open', 'os.listdir', 'os.scandir') and args and isinstance(args[0], (str, bytes)):
        target = os.path.normcase(os.path.realpath(os.fsdecode(args[0])))
        if target == _TEST_CONFIG or target == _TEST_DATA or target.startswith(_TEST_DATA + os.sep):
            raise RuntimeError('original user configuration/data access forbidden in bridge fixture')
sys.addaudithook(_test_audit)
import wechat_db as _TEST_DB
_TEST_DB.iter_drive_roots = _test_no_drives
`;
  return { root, bridgeDir, engineFile: path.join(bridgeDir, 'engine.py'), prelude,
    env: { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
      TEMP: root, TMP: root, TMPDIR: root, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } };
}

module.exports = { selectTestPython, createBridgeFixture };
