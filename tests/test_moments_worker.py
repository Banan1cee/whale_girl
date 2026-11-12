import io
import json
import sys
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from moments_worker import run_worker, bootstrap_paths
from send_state import SEND_STATE, _SendStateScope


class WorkerTests(unittest.TestCase):
    def test_embedded_entry_resolves_both_bridge_and_examples_modules(self):
        from importlib.machinery import PathFinder
        bridge = str(Path(__file__).resolve().parents[1] / 'bridge')
        with patch.object(sys, 'path', [bridge]):
            self.assertIsNone(PathFinder.find_spec('uia_compat', sys.path))
            bootstrap_paths()
            self.assertIsNotNone(PathFinder.find_spec('uia_compat', sys.path))
            self.assertIsNotNone(PathFinder.find_spec('moments_publish', sys.path))

    def process(self, events, code=0):
        # 主进程持有句柄；原生崩溃只会关闭子进程的管道。
        child = SimpleNamespace(stdin=io.StringIO(), stdout=io.StringIO(
            ''.join(json.dumps(event) + '\n' for event in events)), returncode=code,
            poll=Mock(return_value=code), wait=Mock(return_value=code), kill=Mock())
        child.kill.side_effect = lambda: setattr(child.poll, 'return_value', -9)
        self.child = child
        return Mock(return_value=child)

    def test_camera_crash_is_failed_and_does_not_take_bridge_down(self):
        log = Mock()
        spawn = self.process([{'event': 'stage', 'stage': 'menu'}], code=-1073741819)
        self.assertEqual(run_worker({'query': {'text': '不应出现在日志里的正文'}}, lambda: True, log, spawn=spawn),
                         ('failed', 'publish_worker_exited'))
        self.assertIn('stage=menu code=-1073741819', str(log.call_args))
        self.assertNotIn('不应出现在日志里的正文', str(log.mock_calls))

    def test_startup_diagnostics_keep_type_and_location_without_exception_body(self):
        log = Mock()
        spawn = self.process([{'event': 'diagnostic', 'type': 'ModuleNotFoundError',
                               'module': 'uia_compat', 'file': 'moments_worker.py', 'line': 187}], code=1)
        self.assertEqual(run_worker({}, lambda: True, log, spawn=spawn), ('failed', 'publish_worker_exited'))
        self.assertTrue(any('type=ModuleNotFoundError module=uia_compat' in str(call) for call in log.mock_calls))

    def test_worker_protocol_uses_explicit_utf8(self):
        spawn = self.process([{'event': 'result', 'status': 'failed', 'error': 'job_cancelled'}])
        run_worker({}, lambda: True, Mock(), spawn=spawn)
        self.assertEqual(spawn.call_args.args[0][1:3], ['-X', 'utf8'])

    def test_picker_probe_logs_structure_without_names_values_or_paths(self):
        log = Mock()
        spawn = self.process([
            {'event': 'picker_probe', 'fields': 1, 'buttons': 1, 'controls': [
                {'type': 'EditControl', 'id': '1148', 'Name': 'private-filename', 'Value': 'private-path'},
                {'type': 'ButtonControl', 'id': '1'},
                {'type': 'EditControl', 'id': 'C:/private-path'}]},
            {'event': 'result', 'status': 'unconfirmed', 'error': ''}])
        self.assertEqual(run_worker({}, lambda: True, log, spawn=spawn), ('unconfirmed', ''))
        self.assertIn('fields=1 buttons=1 controls=EditControl:1148,ButtonControl:1', str(log.mock_calls))
        self.assertNotIn('private', str(log.mock_calls))

    def test_crash_after_submit_is_uncertain_and_never_retried(self):
        spawn = self.process([{'event': 'stage', 'stage': 'submit'}], code=-1073741819)
        self.assertEqual(run_worker({}, lambda: True, Mock(), spawn=spawn),
                         ('unconfirmed', 'publish_worker_exited'))
        spawn.assert_called_once()

    def test_gate_revocation_stops_before_publishing(self):
        spawn = self.process([{'event': 'gate'}])
        self.assertEqual(run_worker({}, lambda: False, Mock(), spawn=spawn),
                         ('failed', 'job_cancelled'))

    def test_revocation_drains_submit_marker_before_releasing_quota(self):
        spawn = self.process([{'event': 'gate'}, {'event': 'stage', 'stage': 'submit'}])
        self.assertEqual(run_worker({}, lambda: False, Mock(), spawn=spawn),
                         ('unconfirmed', 'job_cancelled'))

    def test_result_and_each_gate_are_received_with_private_payload_only_on_stdin(self):
        allowed = Mock(return_value=True)
        spawn = self.process([{'event': 'gate'}, {'event': 'stage', 'stage': 'menu'},
                              {'event': 'gate'}, {'event': 'stage', 'stage': 'submit'},
                              {'event': 'result', 'status': 'unconfirmed', 'error': ''}])
        log = Mock()
        self.assertEqual(run_worker({'query': {'text': '本地私有正文'}}, allowed, log, spawn=spawn),
                         ('unconfirmed', ''))
        self.assertEqual(allowed.call_count, 2)
        self.assertNotIn('本地私有正文', str(spawn.call_args) + str(log.mock_calls))

    def test_start_failure_is_explicit_and_timeout_kills_only_owned_child(self):
        self.assertEqual(run_worker({}, lambda: True, Mock(), spawn=Mock(side_effect=OSError())),
                         ('failed', 'publish_worker_exited'))
        spawn = self.process([])
        self.child.poll.return_value = None
        self.assertEqual(run_worker({}, lambda: True, Mock(), spawn=spawn, timeout=0),
                         ('failed', 'publish_worker_timeout'))
        self.child.kill.assert_called_once()

    def test_moments_send_scope_suppresses_warmup_and_clears_after_failure(self):
        try:
            with _SendStateScope(budget=110):
                self.assertTrue(SEND_STATE['active'])
                self.assertGreaterEqual(SEND_STATE['budget'], 110)
                raise RuntimeError('worker failed')
        except RuntimeError:
            pass
        self.assertFalse(SEND_STATE['active'])

    def test_real_process_pipe_handshake_and_abrupt_exit(self):
        # 真实管道回归，不启动微信：复现菜单打开后子进程突然退出。
        program = '''
import json,os,sys
payload=json.loads(sys.stdin.readline())
print(json.dumps({'event':'gate'}),flush=True)
answer=json.loads(sys.stdin.readline())
if not answer.get('allowed'): sys.exit(1)
print(json.dumps({'event':'stage','stage':payload['stage']}),flush=True)
os._exit(23)
'''
        def spawn(command, **options):
            return subprocess.Popen([sys.executable, '-u', '-c', program], **options)
        for stage, status in [('menu', 'failed'), ('submit', 'unconfirmed')]:
            with self.subTest(stage=stage):
                allowed = Mock(return_value=True)
                log = Mock()
                self.assertEqual(run_worker({'stage': stage}, allowed, log, spawn=spawn, timeout=5),
                                 (status, 'publish_worker_exited'))
                self.assertGreaterEqual(allowed.call_count, 1)
                self.assertIn('code=23', str(log.call_args))


if __name__ == '__main__':
    unittest.main()
