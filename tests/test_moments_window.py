import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from moments_window import activate_for_publish, _unlock_foreground


class PublishForegroundTest(unittest.TestCase):
    def setUp(self):
        self.state = {'foreground': 200, 'pid': 42, 'visible': True, 'iconic': False}
        self.win = SimpleNamespace(IsWindow=lambda h: h == 100,
                                   GetForegroundWindow=lambda: self.state['foreground'],
                                   IsWindowVisible=lambda h: self.state['visible'],
                                   IsIconic=lambda h: self.state['iconic'])
        self.process = SimpleNamespace(GetWindowThreadProcessId=lambda h: (1, self.state['pid']))
        self.runtime = SimpleNamespace(force_foreground=Mock(return_value=False))
        self.allowed = Mock(return_value=True)
        self.pause, self.unlock, self.probe = Mock(), Mock(return_value=True), Mock()

    def run_activation(self):
        with patch.dict(sys.modules, win32gui=self.win, win32process=self.process):
            return activate_for_publish(self.runtime, 100, 42, self.allowed, pause=self.pause,
                                        unlock=self.unlock, probe=self.probe)

    def test_delayed_async_restore_is_observed_despite_false_api_result(self):
        self.state.update(visible=False, iconic=True)
        self.pause.side_effect = lambda _: self.state.update(foreground=100, visible=True, iconic=False)
        self.assertTrue(self.run_activation())
        self.runtime.force_foreground.assert_called_once_with(100)
        self.unlock.assert_not_called()

    def test_foreground_lock_gets_one_local_retry(self):
        def activated(_):
            if self.runtime.force_foreground.call_count == 2:
                self.state['foreground'] = 100
        self.runtime.force_foreground.side_effect = activated
        self.assertTrue(self.run_activation())
        self.assertEqual(self.runtime.force_foreground.call_count, 2)
        self.unlock.assert_called_once_with()

    def test_activation_exception_is_not_failure_when_foreground_changed(self):
        def activated(_):
            self.state['foreground'] = 100
            raise OSError('API returned no useful error')
        self.runtime.force_foreground.side_effect = activated
        self.assertTrue(self.run_activation())
        self.unlock.assert_not_called()

    def test_foreground_never_arrives_fails_after_bounded_retry(self):
        self.assertFalse(self.run_activation())
        self.assertEqual(self.runtime.force_foreground.call_count, 2)
        self.assertLessEqual(sum(c.args[0] for c in self.pause.call_args_list), 1.06)
        self.assertFalse(self.probe.call_args.args[0]['ready'])

    def test_user_switch_to_another_window_aborts_without_unlock(self):
        self.pause.side_effect = lambda _: self.state.update(foreground=300)
        self.assertFalse(self.run_activation())
        self.unlock.assert_not_called()
        self.runtime.force_foreground.assert_called_once()

    def test_reused_window_handle_or_revoked_gate_never_retries(self):
        self.pause.side_effect = lambda _: self.state.update(pid=99)
        self.assertFalse(self.run_activation())
        self.unlock.assert_not_called()
        self.state['pid'] = 42
        self.pause.side_effect = None
        self.allowed.side_effect = [True, True, False]
        self.assertFalse(self.run_activation())
        self.unlock.assert_not_called()

    def test_foreground_probe_only_contains_counts_and_booleans(self):
        self.state['foreground'] = 100
        self.assertTrue(self.run_activation())
        fields = self.probe.call_args.args[0]
        self.assertEqual(set(fields), {'window', 'attempts', 'ready', 'sameProcess', 'visible', 'iconic'})
        self.assertTrue(all(type(value) in (int, bool) for value in fields.values()))

    def test_held_modifier_or_mouse_prevents_synthetic_alt(self):
        api = SimpleNamespace(GetAsyncKeyState=lambda key: 0x8000 if key == 0x11 else 0,
                              keybd_event=Mock())
        with patch.dict(sys.modules, win32api=api):
            self.assertFalse(_unlock_foreground())
        api.keybd_event.assert_not_called()

    def test_synthetic_alt_is_released_when_keydown_reports_error(self):
        api = SimpleNamespace(GetAsyncKeyState=lambda key: 0,
                              keybd_event=Mock(side_effect=[OSError(), None]))
        with patch.dict(sys.modules, win32api=api), self.assertRaises(OSError):
            _unlock_foreground()
        self.assertEqual([c.args[2] for c in api.keybd_event.call_args_list], [0, 2])


if __name__ == '__main__':
    unittest.main()
