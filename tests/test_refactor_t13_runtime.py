"""T13 runtime regressions: exact function bodies, no engine import/live root."""
import ast
import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))


def load_function(path, name, scope):
    tree = ast.parse((ROOT / path).read_text(encoding='utf-8-sig'))
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(ROOT / path), 'exec'), scope)
    return scope[name]


def load_pure_module(name):
    path = ROOT / 'bridge' / (name + '.py')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    with patch.object(sys, 'path', [str(ROOT / 'bridge')] + sys.path):
        spec.loader.exec_module(module)
    return module


class StopWatch(Exception):
    pass


class RequestedRestart(Exception):
    pass


class ConfigWatchTests(unittest.TestCase):
    def watch(self, before, current, token='change-me-wechat', invalid=False):
        sleeps = [0]

        def sleep(_seconds):
            sleeps[0] += 1
            if sleeps[0] > 1:
                raise StopWatch()

        restart = Mock(side_effect=RequestedRestart())
        parser_path = ROOT / 'bridge/runtime_config.py'
        parser = load_pure_module('runtime_config') if parser_path.exists() else SimpleNamespace()
        g = SimpleNamespace(CONFIG_MTIME_AT_START=0, CONFIG_PATH='fixture-config',
            time=SimpleNamespace(sleep=sleep),
            os=SimpleNamespace(path=SimpleNamespace(getmtime=Mock(return_value=1)), _exit=restart),
            read_config=Mock(side_effect=ValueError('fixture invalid JSON') if invalid else None,
                             return_value=current),
            reload_config=Mock(return_value=True), bridge_config=parser,
            restart_for_config_change=restart,
            build_bot_url=lambda cfg: 'http://127.0.0.1:9191/webhook/wechat', log=Mock())
        scope = {'G': g}
        watch = load_function('bridge/loop_mixin.py', 'config_watch', scope)
        runtime = SimpleNamespace(cfg=before, token=token, bot_url=g.build_bot_url(before))
        with patch.dict('os.environ', {}, clear=True):
            try:
                watch(runtime)
            except (StopWatch, RequestedRestart):
                pass
        return runtime, g, restart

    def test_omitted_token_does_not_restart_on_unrelated_mtime(self):
        runtime, g, restart = self.watch({}, {})
        restart.assert_not_called()
        g.reload_config.assert_called_once()

    def test_explicit_empty_token_keeps_its_meaning(self):
        config = {'gateway': {'wechat': {'inboundToken': ''}}}
        _, g, restart = self.watch(config, config, token='')
        restart.assert_not_called()
        g.reload_config.assert_called_once()

    def test_invalid_read_keeps_snapshot_and_does_not_restart(self):
        before = {'gateway': {'wechat': {'inboundToken': 'fixture-token'}}}
        runtime, g, restart = self.watch(before, None, token='fixture-token', invalid=True)
        self.assertIs(runtime.cfg, before)
        restart.assert_not_called()
        g.reload_config.assert_not_called()

    def test_pipeline_workers_require_restart_before_mutating_globals(self):
        auth = {'wechat': {'inboundToken': ''}}
        _, g, restart = self.watch({'gateway': auth}, {'gateway': auth, 'wechat': {'pipelineWorkers': 9}}, token='')
        restart.assert_called_once()
        g.reload_config.assert_not_called()

    def test_pipeline_queue_limit_requires_restart(self):
        auth = {'wechat': {'inboundToken': ''}}
        _, g, restart = self.watch({'gateway': auth}, {'gateway': auth, 'wechat': {'pipelineQueueLimit': 12}}, token='')
        restart.assert_called_once()
        g.reload_config.assert_not_called()

    def test_hot_reload_reuses_the_validated_read(self):
        current = {'wechat': {'quoteReply': True}}
        runtime, g, restart = self.watch({}, current)
        restart.assert_not_called()
        g.read_config.assert_called_once()
        self.assertIs(g.reload_config.call_args.kwargs.get('config'), current)
        self.assertIs(runtime.cfg, current)

    def test_restart_comparison_uses_normalized_values(self):
        _, _, restart = self.watch({'wechat': {'pipelineWorkers': 4}}, {'wechat': {'pipelineWorkers': '4'}})
        restart.assert_not_called()

    def test_strict_reader_does_not_publish_bad_json_as_empty_config(self):
        read = load_function('bridge/config.py', 'read_config', {
            'CONFIG_PATH': 'fixture-config', 'json': json, 'log_error': Mock(),
            'os': SimpleNamespace(path=SimpleNamespace(exists=lambda _: True)),
            'open': lambda *args, **kwargs: io.StringIO('{invalid JSON'),
        })
        with self.assertRaises(ValueError):
            read(strict=True)


class LogThrottleTests(unittest.TestCase):
    def throttle(self, now=10000):
        clock = [now]
        scope = {'time': SimpleNamespace(time=lambda: clock[0], monotonic=lambda: clock[0]),
                 '_THROTTLE_LOG': {}, 'log': Mock()}
        fn = load_function('bridge/engine.py', 'log_throttled', scope)
        return fn, scope, clock

    def test_first_error_is_visible_even_at_monotonic_zero(self):
        fn, scope, clock = self.throttle(now=0)
        fn('fixture-error', 'fixture log')
        scope['log'].assert_called_once_with('fixture log')

    def test_unique_log_keys_are_bounded(self):
        fn, scope, clock = self.throttle()
        for index in range(2000):
            fn('fixture-key-' + str(index), 'fixture log')
        self.assertLessEqual(len(scope['_THROTTLE_LOG']), 1024)

    def test_expired_keys_are_reclaimed_and_fold_count_survives(self):
        fn, scope, clock = self.throttle()
        fn('fixture-key', 'fixture log', ttl=10)
        fn('fixture-key', 'fixture log', ttl=10)
        clock[0] += 11
        fn('fixture-key', 'fixture recovered', ttl=10)
        self.assertTrue(any('1 条' in str(call.args) for call in scope['log'].call_args_list))
        clock[0] += 11
        fn('fixture-new-key', 'fixture new log', ttl=10)
        self.assertEqual(len(scope['_THROTTLE_LOG']), 1)


class ElapsedClockTests(unittest.TestCase):
    def test_server_wait_uses_elapsed_clock(self):
        fake_time = SimpleNamespace(time=Mock(side_effect=AssertionError('wall clock used for elapsed wait')),
                                    monotonic=Mock(side_effect=[0, 0, 6]), sleep=Mock())
        scope = {'LOCAL_HTTP': SimpleNamespace(get=Mock(side_effect=OSError('fixture offline'))),
                 'log': Mock(), 'log_error': Mock()}
        wait = load_function('bridge/config.py', 'wait_for_server', scope)
        with patch.dict(sys.modules, {'time': fake_time}):
            self.assertFalse(wait('http://127.0.0.1:9191/webhook/wechat', timeout=5))
        fake_time.time.assert_not_called()
        fake_time.sleep.assert_called_once_with(1)


if __name__ == '__main__':
    unittest.main()
