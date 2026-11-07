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
    def test_bridge_token_default_matches_kernel_and_respects_explicit_values(self):
        token = load_function('wechat_token', {})
        example = Path(__file__).resolve().parents[1] / 'config.example.json'
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
