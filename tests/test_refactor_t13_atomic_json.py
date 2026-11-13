"""Atomic persistence regressions; every write targets a new temporary fixture."""
import ast
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from concurrent.futures import ThreadPoolExecutor
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))


def function(path, name, scope):
    tree = ast.parse((ROOT / path).read_text(encoding='utf-8-sig'))
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(ROOT / path), 'exec'), scope)
    return scope[name]


class ExistingPersistenceTests(unittest.TestCase):
    def account_writer(self, root):
        clock = SimpleNamespace(time=Mock(return_value=123), monotonic=Mock(return_value=10))
        scope = {'ROOT': str(root), 'os': os, 'json': json, 'time': clock,
                 'find_account_dirs': Mock(return_value=['fixture-account']),
                 'account_wxid': lambda _: 'fixture-self', 'log': Mock(),
                 'safe_name': lambda _: 'fixture-name', 'safe_id': lambda _: 'fixture-id'}
        return function('bridge/engine.py', 'write_accounts_cache', scope), clock

    def test_account_serialization_failure_preserves_original_and_cleans_temp(self):
        with tempfile.TemporaryDirectory(prefix='whale-t13-atomic-') as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            target = root / 'data/accounts.json'
            target.write_text('{"fixture-original":true}', encoding='utf-8')
            original = target.read_bytes()
            writer, clock = self.account_writer(root)
            with patch.object(json, 'dump', side_effect=ValueError('fixture serialization failure')):
                self.assertFalse(writer(str(root / 'fixture-db'), probe_others=False))
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_care_replace_failure_preserves_original_and_cleans_own_temp(self):
        with tempfile.TemporaryDirectory(prefix='whale-t13-care-') as directory:
            target = Path(directory) / 'care-state.json'
            target.write_text('{"fixture-original":true}', encoding='utf-8')
            original = target.read_bytes()
            g = SimpleNamespace(os=os, json=json, log_warn=Mock())
            save = function('bridge/loop_mixin.py', 'save_state', {'G': g, 'state_file': str(target)})
            with patch.object(os, 'replace', side_effect=OSError('fixture replace failure')):
                save({'fixture-next': True})
            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(list(target.parent.iterdir()), [target])
            g.log_warn.assert_called_once()

    def test_account_scan_deadline_is_elapsed_but_saved_time_is_epoch(self):
        with tempfile.TemporaryDirectory(prefix='whale-t13-clock-') as directory:
            root = Path(directory)
            writer, clock = self.account_writer(root)
            self.assertTrue(writer(str(root / 'fixture-db'), probe_others=False))
            clock.time.assert_called_once()
            clock.monotonic.assert_called_once()
            saved = json.loads((root / 'data/accounts.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['generatedAt'], 123000)

    def test_account_cli_failure_keeps_previous_snapshot(self):
        with tempfile.TemporaryDirectory(prefix='whale-t13-cli-') as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            target = root / 'data/accounts.json'
            target.write_text('{"fixture-original":true}', encoding='utf-8')
            scope = {'ROOT': str(root), 'os': os, 'json': json, 'time': SimpleNamespace(time=lambda: 123, monotonic=lambda: 10),
                'resolve_db_dir': lambda: str(root / 'fixture-db'), 'find_account_dirs': lambda _: [],
                'log': Mock(), 'print': Mock(), 'safe_path': lambda _: 'fixture-path'}
            cli = function('bridge/engine.py', 'list_accounts_cli', scope)
            with patch.dict(sys.modules, {'wechatauto': SimpleNamespace(WeChatDB=None)}), \
                    patch.object(json, 'dump', side_effect=ValueError('fixture serialization failure')):
                self.assertEqual(cli(), 0)
            self.assertEqual(json.loads(target.read_text(encoding='utf-8')), {'fixture-original': True})
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_concurrent_atomic_writes_use_distinct_same_directory_temps(self):
        from runtime_json import atomic_write_json
        with tempfile.TemporaryDirectory(prefix='whale-t13-concurrent-') as directory:
            target = Path(directory) / 'snapshot.json'
            real_replace = os.replace
            names = []
            lock = threading.Lock()

            def replace(source, destination):
                self.assertEqual(Path(source).parent, target.parent)
                with lock:
                    names.append(str(source))
                real_replace(source, destination)

            with patch.object(os, 'replace', side_effect=replace), ThreadPoolExecutor(max_workers=6) as pool:
                list(pool.map(lambda index: atomic_write_json(target, {'fixture-worker': index}), range(24)))
            self.assertEqual(len(names), 24)
            self.assertEqual(len(set(names)), 24)
            self.assertIn(json.loads(target.read_text(encoding='utf-8'))['fixture-worker'], range(24))
            self.assertEqual(list(target.parent.iterdir()), [target])


if __name__ == '__main__':
    unittest.main()
