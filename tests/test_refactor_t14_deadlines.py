import ast
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
import threading
from test_refactor_t14_attempts import ROOT, SafeFixture, load


class StopWatch(Exception):
    pass


class DeadlineTests(SafeFixture):
    def watchdog_once(self):
        calls = [0]
        def sleep(seconds):
            if seconds == 5:
                calls[0] += 1
                if calls[0] > 1:
                    raise StopWatch()
        exit_ = Mock()
        g = SimpleNamespace(time=SimpleNamespace(time=lambda: self.wall[0], monotonic=lambda: self.mono[0], sleep=sleep),
                            SEND_STATE=self.state.SEND_STATE, os=SimpleNamespace(_exit=exit_), log=Mock())
        run = load('bridge/loop_mixin.py', 'send_watchdog', {'G': g, 'dump_hang_trace': Mock()})
        try:
            run(SimpleNamespace())
        except StopWatch:
            pass
        return exit_

    def test_forward_wall_jump_does_not_restart_a_short_operation(self):
        with self.state._SendStateScope():
            self.assertEqual(self.state.SEND_STATE['start'], 10000)
            self.wall[0] += 10000
            self.mono[0] += 5
            self.watchdog_once().assert_not_called()

    def test_backward_wall_jump_does_not_hide_elapsed_expiry(self):
        with self.state._SendStateScope():
            self.wall[0] -= 10000
            self.mono[0] += 41
            self.watchdog_once().assert_called_once_with(7)

    def test_nested_scope_keeps_outer_watch_active_and_original_epoch(self):
        with self.state._SendStateScope(budget=110):
            epoch = self.state.SEND_STATE['start']
            self.wall[0] += 10
            with self.state._SendStateScope():
                pass
            self.assertTrue(self.state.SEND_STATE['active'])
            self.assertEqual(self.state.SEND_STATE['start'], epoch)
        self.assertFalse(self.state.SEND_STATE['active'])

    def test_late_worker_completion_cannot_clobber_or_resurrect_a_new_scope(self):
        old = self.state._SendStateScope()
        old.__enter__()
        old.operation.begin_inflight()
        old.__exit__(None, None, None)
        self.wall[0] += 10
        current = self.state._SendStateScope()
        current.__enter__()
        try:
            self.assertEqual(self.state.SEND_STATE['start'], 10010)
            old.operation.finish_inflight()
            self.assertTrue(self.state.SEND_STATE['active'])
        finally:
            current.__exit__(None, None, None)
        self.assertFalse(self.state.SEND_STATE['active'])

    def test_long_text_allowance_is_not_replaced_with_short_fixed_budget(self):
        with self.state._SendStateScope(2000):
            self.mono[0] += 100
            self.watchdog_once().assert_not_called()
            self.assertGreaterEqual(self.state.SEND_STATE['budget'], 328)

    def test_background_page_poll_is_elapsed_only_without_real_sleep(self):
        ticks = iter([0, 0, 1, 1, 1, 2])
        clock = SimpleNamespace(time=Mock(side_effect=AssertionError('wall clock used')),
                                monotonic=lambda: next(ticks), sleep=Mock())
        control = SimpleNamespace(BoundingRectangle=SimpleNamespace(left=0, top=0, right=30, bottom=30))
        info = {'rows': [], 'edit': None}
        sender = SimpleNamespace(hwnd=123, click_screen=Mock())
        page = load('bridge/bg_sender.py', '_ensure_chat_page', {'time': clock, '_noop': Mock(),
            '_chat_tab_target': lambda _: control, 'read_ui': Mock(return_value=info),
            'TIMING': {'pollSwitch': .3}, 'CHAT_TAB_NAME': 'fixture-tab'})
        self.assertIs(page(sender, info, timeout=.5), info)
        self.assertEqual(sender.click_screen.call_count, 2)
        clock.time.assert_not_called()

    def test_uia_restore_first_check_at_monotonic_zero_is_not_throttled(self):
        clock = SimpleNamespace(time=Mock(side_effect=AssertionError('wall clock used')),
                                monotonic=lambda: 0, sleep=Mock(side_effect=AssertionError('real wait forbidden')))
        restore = load('bridge/uia_boot.py', 'restore_wechat', {'time': clock, '_LAST_RESTORE': [0],
            '_RESTORE_LOCK': threading.Lock(), 'tree_state': Mock(return_value='ok')})
        self.assertTrue(restore({'hwnd': 123}))
        clock.time.assert_not_called()


if __name__ == '__main__':
    unittest.main()
