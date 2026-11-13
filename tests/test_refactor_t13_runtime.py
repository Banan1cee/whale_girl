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
from concurrent.futures import ThreadPoolExecutor

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
    def watch(self, before, current, token='change-me-wechat', invalid=False, rounds=1):
        sleeps = [0]

        def sleep(_seconds):
            sleeps[0] += 1
            if sleeps[0] > rounds:
                raise StopWatch()

        restart = Mock(side_effect=RequestedRestart())
        parser_path = ROOT / 'bridge/runtime_config.py'
        parser = load_pure_module('runtime_config') if parser_path.exists() else SimpleNamespace()
        g = SimpleNamespace(CONFIG_MTIME_AT_START=0, CONFIG_PATH='fixture-config',
            time=SimpleNamespace(sleep=sleep),
            os=SimpleNamespace(path=SimpleNamespace(getmtime=Mock(return_value=1)), _exit=restart),
            read_config=Mock(side_effect=invalid if isinstance(invalid, list) else
                             ValueError('fixture invalid JSON') if invalid else None,
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
        for text in ('{invalid JSON', '[]'):
            with self.subTest(text_kind='array' if text == '[]' else 'invalid-json'):
                read = load_function('bridge/config.py', 'read_config', {
                    'CONFIG_PATH': 'fixture-config', 'json': json, 'log_error': Mock(),
                    'os': SimpleNamespace(path=SimpleNamespace(exists=lambda _: True)),
                    'open': lambda *args, **kwargs: io.StringIO(text),
                })
                with self.assertRaises(ValueError):
                    read(strict=True)
                self.assertEqual(read(), {})

    def test_same_mtime_is_retried_after_an_invalid_read(self):
        current = {'wechat': {'quoteReply': True}}
        runtime, g, restart = self.watch({}, current, invalid=[ValueError('fixture invalid JSON'), current], rounds=2)
        restart.assert_not_called()
        self.assertEqual(g.read_config.call_count, 2)
        g.reload_config.assert_called_once_with(config=current)
        self.assertIs(runtime.cfg, current)


class ConfigSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict('os.environ', {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.parser = load_pure_module('runtime_config')

    def scope(self, config):
        scope = dict(self.parser.runtime_snapshot(config)['values'])
        scope.update(bridge_config=self.parser, BASE_SYSTEM_SENDERS={'fixture-system'},
            CONFIG_SNAPSHOT=self.parser.runtime_snapshot(config), CURRENT_CONFIG=config,
            _resolve_voice_key=Mock(return_value='fixture-key'), set_system_senders=Mock(),
            bridge_log=SimpleNamespace(set_level=Mock()), ROOT='fixture-root',
            log=Mock(), restart_for_config_change=Mock())
        load_function('bridge/engine.py', '_publish_runtime_config', scope)
        load_function('bridge/engine.py', 'reload_config', scope)
        return scope

    def test_startup_and_reload_publish_the_same_normalized_values(self):
        config = {'wechat': {'quoteReply': 'false', 'pipelineWorkers': '6'},
                  'voice': {'timeoutMs': '1234'}, 'care': {'allowGroups': 'false'}}
        scope = self.scope(config)
        scope['_publish_runtime_config'](config, self.parser.runtime_snapshot(config))
        expected = {key: scope[key] for key in self.parser.runtime_snapshot(config)['values']}
        scope['open'] = Mock(side_effect=AssertionError('validated config must not be reread'))
        self.assertTrue(scope['reload_config'](config=config))
        self.assertEqual({key: scope[key] for key in expected}, expected)
        scope['open'].assert_not_called()

    def test_deleted_hot_fields_return_to_defaults(self):
        before = {'wechat': {'staleAfterSec': 7, 'goodnightText': 'fixture-custom'},
                  'voice': {'model': 'fixture-model', 'enabled': False},
                  'persona': {'master': {'wxids': ['fixture-master']}}}
        scope = self.scope(before)
        self.assertTrue(scope['reload_config'](config={}))
        self.assertEqual(scope['STALE_AFTER'], 120)
        self.assertEqual(scope['VOICE_MODEL'], 'qwen3-asr-flash')
        self.assertTrue(scope['VOICE_ENABLED'])
        self.assertEqual(scope['MASTER_WXID'], '')

    def test_invalid_shape_does_not_partially_publish(self):
        before = {'wechat': {'quoteReply': True}}
        scope = self.scope(before)
        self.assertFalse(scope['reload_config'](config={'wechat': 'fixture-invalid-section'}))
        self.assertIs(scope['CURRENT_CONFIG'], before)
        self.assertTrue(scope['QUOTE_REPLY'])
        scope['_resolve_voice_key'].assert_not_called()

    def test_worker_environment_override_is_preserved_on_reload(self):
        with patch.dict('os.environ', {'WHALE_PIPELINE_WORKERS': '3'}):
            scope = self.scope({'wechat': {'pipelineWorkers': 8}})
            self.assertTrue(scope['reload_config'](config={'wechat': {'pipelineWorkers': 9}}))
            self.assertEqual(scope['PIPELINE_WORKERS'], 3)
            scope['restart_for_config_change'].assert_not_called()

    def test_restart_only_change_keeps_actual_runtime_values_until_restart(self):
        scope = self.scope({})
        self.assertFalse(scope['reload_config'](config={'wechat': {'pipelineWorkers': 9}}))
        scope['restart_for_config_change'].assert_called_once()
        self.assertEqual(scope['PIPELINE_WORKERS'], 4)
        self.assertEqual(scope['CONFIG_SNAPSHOT']['values']['PIPELINE_WORKERS'], 4)


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

    def test_compatibility_entry_keeps_its_none_return_value(self):
        fn, scope, clock = self.throttle()
        self.assertIsNone(fn('fixture-return', 'fixture log'))
        self.assertIsNone(fn('fixture-return', 'fixture suppressed'))

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

    def test_concurrent_identical_errors_emit_once_and_keep_fold_count(self):
        fn, scope, clock = self.throttle()
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: fn('fixture-concurrent', 'fixture log', ttl=10), range(200)))
        scope['log'].assert_called_once_with('fixture log')
        clock[0] += 11
        fn('fixture-concurrent', 'fixture recovered', ttl=10)
        self.assertTrue(any('199 条' in str(call.args) for call in scope['log'].call_args_list))


class KernelApiTests(unittest.TestCase):
    def test_real_thread_local_client_get_post_protocol_and_session_reuse(self):
        session = SimpleNamespace(get=Mock(), post=Mock(), close=Mock())
        result = SimpleNamespace(status_code=200, json=lambda: {'ok': True, 'items': []})
        session.get.return_value = session.post.return_value = result
        requests = SimpleNamespace(Session=Mock(return_value=session))
        with patch.dict(sys.modules, {'requests': requests}):
            http_module = load_pure_module('http_client')
            client = http_module.ThreadLocalHTTP()
            api = load_pure_module('runtime_kernel_api').KernelApi(client, 'http://127.0.0.1:9191', 'fixture-token')
            self.assertEqual(api.get('/api/reminders/due')['items'], [])
            api.post('/api/reminders/ack', json={'id': 'fixture-id', 'ok': True})
            requests.Session.assert_called_once()
            self.assertFalse(session.trust_env)
            session.get.assert_called_once()
            session.post.assert_called_once()
            self.assertFalse(session.get.call_args.kwargs['allow_redirects'])
            self.assertFalse(session.post.call_args.kwargs['allow_redirects'])
            client.close()
            session.close.assert_called_once()

    def test_failure_kinds_are_errors_and_post_is_never_retried(self):
        module = load_pure_module('runtime_kernel_api')
        for status, body in ((500, {'ok': True}), (302, {'ok': True}),
                             (200, {'ok': False, 'error': 'fixture-sensitive-content'}), (200, [])):
            with self.subTest(status=status, body_type=type(body).__name__):
                http = SimpleNamespace(post=Mock(return_value=SimpleNamespace(status_code=status, json=lambda: body)))
                api = module.KernelApi(http, 'http://127.0.0.1:9191', '')
                with self.assertRaises(module.KernelApiError) as raised:
                    api.post('/api/future-reserved', json={})
                self.assertNotIn('fixture-sensitive-content', str(raised.exception))
                http.post.assert_called_once()
                self.assertNotIn('x-bot-token', http.post.call_args.kwargs['headers'])


class PipelineLogTests(unittest.TestCase):
    def test_idle_chat_log_history_is_bounded_without_changing_business_queues(self):
        module = load_pure_module('msg_pipeline')
        with patch.object(module, 'ThreadPoolExecutor'):
            pipeline = module.MessagePipeline(workers=1, per_chat_limit=1, log=Mock())
            try:
                for index in range(1100):
                    chat = 'fixture-chat-' + str(index)
                    pipeline.submit(chat, lambda: None)
                    pipeline.submit(chat, lambda: None)
                self.assertLessEqual(len(pipeline._drop_log_at), 1024)
                self.assertLessEqual(len(pipeline._drop_count), 1024)
                self.assertEqual(len(pipeline._queues), 1100)
                self.assertEqual(pipeline.stats['dropped'], 1100)
            finally:
                pipeline.close(wait=False)

    def test_pipeline_folded_drop_count_keeps_the_existing_message_semantics(self):
        module = load_pure_module('msg_pipeline')
        clock = [10000]
        logger = Mock()
        with patch.object(module, 'ThreadPoolExecutor'), patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]):
            pipeline = module.MessagePipeline(workers=1, per_chat_limit=1, log=logger)
            try:
                for _ in range(4):
                    pipeline.submit('fixture-chat', lambda: None)
                self.assertEqual(logger.call_count, 1)
                self.assertIn('丢掉 1 条', logger.call_args.args[0])
                clock[0] += 11
                pipeline.submit('fixture-chat', lambda: None)
                self.assertEqual(logger.call_count, 2)
                self.assertIn('丢掉 3 条', logger.call_args.args[0])
                self.assertEqual(pipeline.stats['dropped'], 4)
            finally:
                pipeline.close(wait=False)


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

    def test_restart_wait_keeps_elapsed_clock_and_mock_exit_only(self):
        clock = SimpleNamespace(time=Mock(side_effect=AssertionError('wall clock used')),
            monotonic=Mock(side_effect=[0, 1]), sleep=Mock())
        state = SimpleNamespace(get=Mock(side_effect=[True, False, False]))
        exit_ = Mock()
        restart = load_function('bridge/engine.py', 'restart_for_config_change',
                                {'time': clock, 'SEND_STATE': state, 'os': SimpleNamespace(_exit=exit_), 'log': Mock()})
        restart()
        exit_.assert_called_once_with(7)
        clock.time.assert_not_called()


if __name__ == '__main__':
    unittest.main()
