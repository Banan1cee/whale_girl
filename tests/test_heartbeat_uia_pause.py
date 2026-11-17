"""Execute the real heartbeat loop with inert boundaries; never import GUI/engine."""
import ast
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]


class StopLoop(Exception):
    pass


def heartbeat(rounds=8, cached=None, ready=None, ensure=None, hook=None,
              account_verified=True, moments=False, sending=False):
    """驱动真实 bridge_heartbeat。

    cached 模拟窗口驱动上的 UIA 缓存：心跳只读 `gui._uia`，不会调用
    `_get_uia()` 去热激活微信；传可调用对象可让缓存逐轮变化。
    """
    count = [0]
    runtime = SimpleNamespace(gui_lock=nullcontext(), UIA_CACHE={'u': None},
        ACCOUNT={'verified': account_verified, 'hwnd': 123, 'why': 'fixture'},
        db=SimpleNamespace(account='fixture-account', wxid='fixture-id'), _self_nick='fixture',
        token='fixture-token', bot_url='http://fixture/webhook',
        foreground_is_moments=Mock(return_value=moments),
        selected_window_ready=ready or Mock(return_value=True),
        wechat_window_alive=Mock(return_value=True), ensure_uia_ready=ensure or Mock(return_value={'ok': False}),
        listener_alive=Mock(return_value=True), ffmpeg_available=Mock(return_value=False),
        wechat_window_state=Mock(return_value='visible'))

    class CachedGui:
        _get_uia = Mock(return_value=None)

        @property
        def _uia(self):
            return cached() if callable(cached) else cached

    runtime.gui = CachedGui()
    runtime.new_window_driver = Mock(return_value=runtime.gui)

    def sleep(_seconds):
        count[0] += 1
        if hook:
            hook(runtime, count[0])
        if count[0] >= rounds:
            raise StopLoop()
    g = SimpleNamespace(time=SimpleNamespace(sleep=sleep), SEND_STATE={'active': sending},
                        ACCOUNT_GUARD=True, LOCAL_HTTP=SimpleNamespace(post=Mock(return_value=SimpleNamespace(raise_for_status=lambda: None))),
                        log=Mock(), log_warn=Mock())
    tree = ast.parse((ROOT / 'bridge/loop_mixin.py').read_text(encoding='utf-8-sig'))
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'bridge_heartbeat')
    scope = {'G': g}
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'isolated-heartbeat', 'exec'), scope)
    try:
        scope['bridge_heartbeat'](runtime)
    except StopLoop:
        pass
    return runtime, g


def paused_warnings(g):
    return [call for call in g.log_warn.call_args_list if '暂停后台' in str(call)]


class HeartbeatPauseTests(unittest.TestCase):
    def test_repeated_empty_cache_pauses_background_probe_without_rebuilding(self):
        runtime, g = heartbeat(cached=None)
        self.assertEqual(runtime.selected_window_ready.call_count, 3)
        self.assertEqual(runtime.ensure_uia_ready.call_count, 3)
        runtime.new_window_driver.assert_not_called()
        runtime.gui._get_uia.assert_not_called()
        self.assertEqual(g.LOCAL_HTTP.post.call_count, 8)
        self.assertEqual(len(paused_warnings(g)), 1)

    def test_probe_exceptions_are_bounded_and_heartbeats_continue(self):
        ensure = Mock(side_effect=ValueError('fixture invalid PID'))
        runtime, g = heartbeat(cached=None, ensure=ensure)
        self.assertEqual(ensure.call_count, 3)
        runtime.new_window_driver.assert_not_called()
        self.assertEqual(g.LOCAL_HTTP.post.call_count, 8)
        self.assertTrue(runtime.ACCOUNT['verified'])

    def test_repeated_account_probe_failure_also_stops_background_probing(self):
        ready = Mock(return_value=False)
        runtime, g = heartbeat(ready=ready, account_verified=False)
        self.assertEqual(ready.call_count, 3)
        runtime.ensure_uia_ready.assert_not_called()
        runtime.new_window_driver.assert_not_called()
        self.assertFalse(runtime.ACCOUNT['verified'])
        self.assertTrue(all(not call.kwargs['json']['account_ok'] for call in g.LOCAL_HTTP.post.call_args_list))

    def test_cached_driver_recovery_resets_misses_without_rebuilding(self):
        uia = object()
        holder = {'value': None}

        def ensure_ready(**_kwargs):
            holder['value'] = uia
            return {'ok': True}

        ensure = Mock(side_effect=ensure_ready)
        runtime, g = heartbeat(cached=lambda: holder['value'], ensure=ensure)
        self.assertEqual(ensure.call_count, 1)
        runtime.new_window_driver.assert_not_called()
        self.assertIs(runtime.UIA_CACHE['u'], uia)
        self.assertEqual(runtime.selected_window_ready.call_count, 8)
        self.assertTrue(g.LOCAL_HTTP.post.call_args.kwargs['json']['uia'])
        self.assertEqual(paused_warnings(g), [])

    def test_window_recovery_without_send_never_rebuilds_driver(self):
        # 窗口恢复后心跳不会替用户重建驱动；真正的恢复留给实际发送流程。
        ready = Mock(side_effect=[False, False] + [True] * 6)
        runtime, g = heartbeat(cached=None, ready=ready)
        self.assertEqual(ready.call_count, 3)
        self.assertEqual(runtime.ensure_uia_ready.call_count, 1)
        runtime.new_window_driver.assert_not_called()
        self.assertEqual(len(paused_warnings(g)), 1)

    def test_success_between_failures_resets_the_counter(self):
        uia = object()
        values = iter([None, uia, None, uia, None, uia, None, uia])
        runtime, g = heartbeat(cached=lambda: next(values))
        self.assertEqual(runtime.selected_window_ready.call_count, 8)
        runtime.new_window_driver.assert_not_called()
        self.assertIs(runtime.UIA_CACHE['u'], uia)
        self.assertEqual(paused_warnings(g), [])

    def test_pause_message_is_logged_once_and_account_guard_is_preserved(self):
        runtime, g = heartbeat()
        self.assertEqual(len(paused_warnings(g)), 1)
        for call in g.LOCAL_HTTP.post.call_args_list:
            self.assertTrue(call.kwargs['json']['account_guard'])
            self.assertEqual(call.kwargs['headers']['x-bot-token'], 'fixture-token')
        # 新桥接的心跳线程从正常巡检重新开始，不把暂停状态落到用户配置中。
        recovered, new_g = heartbeat(rounds=1, cached=object())
        recovered.selected_window_ready.assert_called_once()
        self.assertTrue(new_g.LOCAL_HTTP.post.call_args.kwargs['json']['uia'])

    def test_healthy_connection_and_busy_sends_are_unaffected(self):
        for moments, sending in [(False, False), (True, False), (False, True)]:
            with self.subTest(moments=moments, sending=sending):
                runtime, g = heartbeat(cached=object(), moments=moments, sending=sending)
                self.assertEqual(g.LOCAL_HTTP.post.call_count, 8)
                self.assertEqual(paused_warnings(g), [])
                runtime.new_window_driver.assert_not_called()
                runtime.gui._get_uia.assert_not_called()
                if moments or sending:
                    runtime.selected_window_ready.assert_not_called()

    def test_after_pause_explicit_send_recovered_cache_is_reported_without_probing(self):
        uia = object()
        def send_completed(runtime, round_number):
            if round_number == 4:
                runtime.UIA_CACHE['u'] = uia
        runtime, g = heartbeat(cached=None, hook=send_completed)
        self.assertEqual(runtime.selected_window_ready.call_count, 3)
        self.assertEqual(runtime.ensure_uia_ready.call_count, 3)
        self.assertTrue(g.LOCAL_HTTP.post.call_args.kwargs['json']['uia'])
        self.assertIs(runtime.UIA_CACHE['u'], uia)


if __name__ == '__main__':
    unittest.main()
