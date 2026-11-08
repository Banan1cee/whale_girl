"""UIA 周期检查不能另启微信实例，也不能抢前台。"""
import os
import sys
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
from bridge_ast import load_function

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bridge import uia_boot as boot


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        boot._LAST_RESTORE[0] = 0

    def test_repeated_checks_without_main_window_never_launch_wechat(self):
        with patch.object(boot, 'pick_window', return_value=None), \
                patch.object(boot, 'launch_wechat') as launch, \
                patch.object(boot.subprocess, 'Popen') as popen:
            for _ in range(4):
                self.assertEqual(boot.ensure()['reason'], 'no_window')
            launch.assert_not_called()
            popen.assert_not_called()

    def test_hidden_existing_window_restored_without_process_or_foreground(self):
        win32gui = SimpleNamespace(IsWindowVisible=Mock(), IsIconic=Mock(), ShowWindow=Mock(), SetForegroundWindow=Mock())
        win32con = SimpleNamespace(SW_SHOWNOACTIVATE=4)
        win = dict(hwnd=123, pid=456, version='4.2.0.9')
        with patch.dict(sys.modules, {'win32gui': win32gui, 'win32con': win32con}), \
                patch.object(win32gui, 'IsWindowVisible', return_value=False), \
                patch.object(win32gui, 'IsIconic', return_value=False), \
                patch.object(win32gui, 'ShowWindow') as show, \
                patch.object(win32gui, 'SetForegroundWindow') as foreground, \
                patch.object(boot, 'pick_window', return_value=win), \
                patch.object(boot, 'tree_state', return_value='ok'), \
                patch.object(boot.subprocess, 'Popen') as popen:
            self.assertTrue(boot.restore_wechat(win))
            show.assert_called_once_with(123, win32con.SW_SHOWNOACTIVATE)
            foreground.assert_not_called()
            popen.assert_not_called()

    def test_visible_window_with_broken_tree_is_not_popped_again(self):
        win32gui = SimpleNamespace(IsWindowVisible=Mock(), IsIconic=Mock(), ShowWindow=Mock())
        with patch.dict(sys.modules, {'win32gui': win32gui, 'win32con': SimpleNamespace(SW_SHOWNOACTIVATE=4)}), \
                patch.object(win32gui, 'IsWindowVisible', return_value=True), \
                patch.object(win32gui, 'IsIconic', return_value=False), \
                patch.object(win32gui, 'ShowWindow') as show, \
                patch.object(boot.subprocess, 'Popen') as popen:
            self.assertFalse(boot.restore_wechat(dict(hwnd=123, pid=456)))
            show.assert_not_called()
            popen.assert_not_called()

    def test_only_visible_wrong_account_is_not_implicitly_selected(self):
        candidate = (111, None, ['共同会话', '另一个账号的会话'])
        env = dict(acct='selected-account', WINDOW_HWND=0, ACCOUNT={'verified': False},
                   db=SimpleNamespace(account='selected-account'),
                   _probe_wechat_windows=lambda: (None, [candidate], []),
                   _account_recent_names=lambda: ['共同会话', '所选账号的会话'],
                   _explain_unverified=lambda fallback: fallback,
                   log=Mock())
        self.assertFalse(load_function('pick_account_window', env)())
        self.assertFalse(env['ACCOUNT']['verified'])
        self.assertEqual(env['ACCOUNT']['hwnd'], 0)

    def test_database_owner_is_pinned_without_waiting_for_uia(self):
        rebind = Mock()
        env = dict(acct='selected-account', WINDOW_HWND=0, ACCOUNT={'verified': False}, log=Mock(),
                   _probe_wechat_windows=lambda: (None, [], [(222, 333)]), rebind_uia=rebind)
        self.assertTrue(load_function('pick_account_window', env)())
        self.assertEqual(env['ACCOUNT']['pid'], 333)
        rebind.assert_called_once_with(222)

    def test_account_probe_does_not_inspect_or_activate_other_windows_when_owner_is_known(self):
        windows = {
            111: ('mmui::MainWindow', '微信'),
            222: ('mmui::MainWindow', 'WeChat'),
            333: ('Qt51514QWindowIcon', 'WeChat Settings'),
            444: ('mmui::LoginWindow', 'WeChat'),
        }
        win32gui = SimpleNamespace(GetClassName=lambda hwnd: windows[hwnd][0],
                                   GetWindowText=lambda hwnd: windows[hwnd][1])
        win32process = SimpleNamespace(GetWindowThreadProcessId=lambda hwnd: (1, hwnd + 1))
        probe = Mock()
        probe._wechat_hwnds.return_value = list(windows)
        driver = SimpleNamespace(WeChatUIA=lambda: probe)
        owner = Mock(side_effect=lambda pid: pid == 223)
        env = dict(acct='selected-account', ACCOUNT={'verified': False},
                   _window_account_matches=owner, ensure_uia_ready=Mock())
        with patch.dict(sys.modules, {'win32gui': win32gui, 'win32process': win32process,
                                      'wechatauto.uia_driver': driver}):
            self.assertEqual(load_function('_probe_wechat_windows', env)()[1:], ([], [(222, 223)]))
        env['ensure_uia_ready'].assert_not_called()
        probe._hot_activate_accessibility.assert_not_called()
        probe._anchor.assert_not_called()
        self.assertEqual([c.args[0] for c in owner.call_args_list], [112, 223])

    def test_wechat_title_has_priority_over_a_large_detached_chat(self):
        windows = [
            dict(hwnd=111, pid=1, title='Detached chat', cls='QtQWindowIcon', area=900000, foreground=True),
            dict(hwnd=222, pid=2, title='WeChat', cls='QtQWindowIcon', area=100000, foreground=False),
            dict(hwnd=333, pid=3, title='WeChat', cls='mmui::LoginWindow', area=200000, foreground=True),
        ]
        gate = SimpleNamespace(_weixin_dll_module=Mock(return_value=(1, 2, 'Weixin.dll')))
        accessibility = SimpleNamespace(AccessibilityGate=gate)
        with patch.dict(sys.modules, {'wechatauto.accessibility': accessibility}), \
                patch.object(boot, '_iter_windows', return_value=windows):
            self.assertEqual(boot.pick_window()['hwnd'], 222)

    def test_known_window_is_used_for_probe_and_driver_without_generic_fallback(self):
        requested = 222
        uia = SimpleNamespace(ensure=Mock(return_value={'ok': False, 'reason': 'no_window'}),
                              describe=lambda _: '所选窗口暂不可用')
        gui = Mock()
        env = dict(acct='selected-account', ACCOUNT={'verified': False}, uia_boot=uia, WeChatGUI=gui,
                   _UIA_READY={'ts': 0}, log=Mock())
        ensure = load_function('ensure_uia_ready', env)
        new_driver = load_function('new_window_driver', env)
        self.assertFalse(ensure(force=True)['ok'])
        uia.ensure.assert_not_called()
        with self.assertRaises(RuntimeError):
            new_driver()
        gui.assert_not_called()
        env['ACCOUNT'].update(hwnd=requested, verified=True)
        self.assertFalse(ensure(force=True)['ok'])
        uia.ensure.assert_called_once_with(prefer_hwnd=requested, log=env['log'], strict=True)
        new_driver()
        gui.assert_called_once_with(hwnd=requested)

    def test_strict_probe_will_not_wake_another_wechat_window(self):
        gate = SimpleNamespace(_weixin_dll_module=Mock(return_value=(1, 2, 'Weixin.dll')))
        accessibility = SimpleNamespace(AccessibilityGate=gate)
        with patch.dict(sys.modules, {'wechatauto.accessibility': accessibility}), \
                patch.object(boot, '_iter_windows', return_value=[{'hwnd': 111, 'pid': 1, 'cls': 'mmui::MainWindow'}]), \
                patch.object(boot, 'restore_wechat') as restore:
            self.assertEqual(boot.ensure(prefer_hwnd=222, strict=True)['reason'], 'no_window')
            restore.assert_not_called()
            gate._weixin_dll_module.assert_not_called()


if __name__ == '__main__':
    unittest.main()
