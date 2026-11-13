import ast
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
from bridge_ast import load_function


class BridgeStartupReadyTests(unittest.TestCase):
    def stale_limit(self, env=None, config=None):
        # Execute the actual default and config override, without opening the
        # user's config or starting bridge/UI work.
        file = Path(__file__).resolve().parents[1] / 'bridge' / 'engine.py'
        tree = ast.parse(file.read_text(encoding='utf-8'))
        default = next(n for n in tree.body if isinstance(n, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id == 'STALE_AFTER' for t in n.targets))
        config_block = next(n for n in tree.body if isinstance(n, ast.Try)
                            and any(isinstance(s, ast.Assign) and any(
                                isinstance(t, ast.Name) and t.id == '_stale' for t in s.targets) for s in n.body))
        index = next(i for i, n in enumerate(config_block.body) if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == '_stale' for t in n.targets))
        scope = {'os': SimpleNamespace(environ=env or {}), '_cfg': config or {}}
        exec(compile(ast.Module(body=[default] + config_block.body[index:index + 2], type_ignores=[]),
                     str(file), 'exec'), scope)
        return scope['STALE_AFTER']

    def test_missing_stale_setting_matches_kernel_default(self):
        example = Path(__file__).resolve().parents[1] / 'config' / 'config.example.json'
        expected = json.loads(example.read_text(encoding='utf-8-sig'))['wechat']['staleAfterSec']
        self.assertEqual(self.stale_limit(), expected)
        self.assertEqual(self.stale_limit(config={'wechat': {}}), expected)

    def test_explicit_message_age_limits_are_preserved(self):
        self.assertEqual(self.stale_limit(env={'WHALE_STALE_AFTER': '7'}), 7)
        self.assertEqual(self.stale_limit(config={'wechat': {'staleAfterSec': 9}}), 9)
        self.assertEqual(self.stale_limit(env={'WHALE_STALE_AFTER': '7'},
                         config={'wechat': {'staleAfterSec': 9}}), 9)

    def test_message_age_reload_preserves_override_and_uses_safe_fallback(self):
        file = Path(__file__).resolve().parents[1] / 'bridge' / 'engine.py'
        tree = ast.parse(file.read_text(encoding='utf-8'))
        reload = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'reload_config')
        assignment = next(n for n in ast.walk(reload) if isinstance(n, ast.Assign)
                          and any(isinstance(t, ast.Name) and t.id == 'STALE_AFTER' for t in n.targets))
        for config, previous, expected in (({}, 0, 120), ({}, 7, 7), ({'staleAfterSec': 9}, 7, 9)):
            with self.subTest(config=config, previous=previous):
                scope = {'w': config, 'STALE_AFTER': previous}
                exec(compile(ast.Module(body=[assignment], type_ignores=[]), str(file), 'exec'), scope)
                self.assertEqual(scope['STALE_AFTER'], expected)

    def test_delayed_snapshot_is_delivered_but_old_history_is_skipped(self):
        env = dict(STALE_AFTER=self.stale_limit(), START_TS=1000, SKIP_OLDER_THAN=0,
                   time=SimpleNamespace(time=lambda: 2000), log=Mock(), safe_text=lambda _: 'len=4',
                   batches=SimpleNamespace(push=Mock(return_value=True)),
                   pipeline=SimpleNamespace(submit=Mock(return_value=True)), flush_chat=Mock())
        receive = load_function('on_message', env)
        receive({'username': 'test-peer', 'create_time': 1987, 'content': 'test'}, None)
        env['batches'].push.assert_called_once()
        env['pipeline'].submit.assert_called_once()
        env['batches'].push.reset_mock()
        receive({'username': 'test-peer', 'create_time': 1800, 'content': 'old'}, None)
        env['batches'].push.assert_not_called()

    def test_bridge_token_default_matches_kernel_and_respects_explicit_values(self):
        token = load_function('wechat_token', {})
        example = Path(__file__).resolve().parents[1] / 'config' / 'config.example.json'
        self.assertEqual(token({}), json.loads(example.read_text(encoding='utf-8-sig'))['gateway']['wechat']['inboundToken'])
        self.assertEqual(token({'gateway': {'wechat': {'inboundToken': 'custom'}}}), 'custom')
        self.assertEqual(token({'gateway': {'wechat': {'inboundToken': ''}}}), '')

    def test_after_listener_starts_bridge_reaches_ready_marker(self):
        # 运行启动最后一段，隔离微信数据库、窗口和线程。以前残留的日志在这里访问未定义的 exc。
        file = Path(__file__).resolve().parents[1] / 'bridge' / 'app.py'
        tree = ast.parse(file.read_text(encoding='utf-8'))
        start = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == 'start')
        ready = next(i for i, node in enumerate(start.body) if 'bridge-ready.json' in ast.unparse(node))
        reminders = next(i for i, node in enumerate(start.body) if 'G.REMINDER_RUNNER = ' in ast.unparse(node))
        finish_start = ast.Module(body=start.body[reminders:ready + 1], type_ignores=[])
        with tempfile.TemporaryDirectory() as root:
            data = Path(root) / 'data'
            data.mkdir()
            runtime = SimpleNamespace(bot_url='http://127.0.0.1:9191/webhook/wechat',
                                      ffmpeg_available=lambda: True, start_reminder_watch=lambda: object())
            globals_ = {'G': SimpleNamespace(ROOT=root, os=os, log=Mock()), 'self': runtime}
            exec(compile(finish_start, str(file), 'exec'), globals_)
            ready_state = json.loads((data / 'bridge-ready.json').read_text(encoding='utf-8'))
            self.assertEqual(ready_state['botUrl'], runtime.bot_url)
            self.assertTrue(ready_state['ffmpeg'])
