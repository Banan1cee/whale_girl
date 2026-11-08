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
            555: ('Qt51514QWindowIcon', 'Weixin'),
        }
        win32gui = SimpleNamespace(GetClassName=lambda hwnd: windows[hwnd][0],
                                   GetWindowText=lambda hwnd: windows[hwnd][1],
                                   IsIconic=lambda hwnd: hwnd == 222,
                                   GetWindowPlacement=lambda hwnd: (0, 2, (), (), (0, 0, 722, 601)),
                                   GetWindowRect=lambda hwnd: (0, 0, 175, 197) if hwnd == 555 else (0, 0, 722, 601))
        win32process = SimpleNamespace(GetWindowThreadProcessId=lambda hwnd: (1, 223 if hwnd == 555 else hwnd + 1))
        probe = Mock()
        probe._wechat_hwnds.return_value = list(windows)
        driver = SimpleNamespace(WeChatUIA=lambda: probe)
        owner = Mock(side_effect=lambda pid: pid == 223)
        env = dict(acct='selected-account', ACCOUNT={'verified': False},
                   _window_account_matches=owner, ensure_uia_ready=Mock())
        with patch.dict(sys.modules, {'win32gui': win32gui, 'win32process': win32process,
                                      'wechatauto.uia_driver': driver}):
            self.assertEqual(load_function('_probe_wechat_windows', env)()[1:], ([], [(222, 223)]))
            self.assertEqual(load_function('wechat_main_window_count', env)(), 2)
        env['ensure_uia_ready'].assert_not_called()
        probe._hot_activate_accessibility.assert_not_called()
        probe._anchor.assert_not_called()
        self.assertEqual([c.args[0] for c in owner.call_args_list], [112, 223])

    def test_two_real_windows_with_same_ownership_still_require_unique_binding(self):
        rebind = Mock()
        resolve = Mock(return_value=(None, []))
        env = dict(acct='selected-account', WINDOW_HWND=0, ACCOUNT={'verified': False}, log=Mock(),
                   _probe_wechat_windows=lambda: (None, [], [(111, 333), (222, 333)]),
                   uia_boot=SimpleNamespace(resolve_account_windows=resolve),
                   log_throttled=Mock(), rebind_uia=rebind)
        self.assertFalse(load_function('pick_account_window', env)())
        self.assertFalse(env['ACCOUNT']['verified'])
        rebind.assert_not_called()

    def test_multiple_owned_windows_bind_only_window_verified_as_main(self):
        rebind = Mock()
        resolve = Mock(return_value=((222, 333), []))
        owner = Mock(return_value=True)
        matched = [(111, 333), (222, 333)]
        env = dict(acct='selected-account', WINDOW_HWND=0, ACCOUNT={'verified': False}, log=Mock(),
                   _probe_wechat_windows=lambda: (None, [], matched),
                   _window_account_matches=owner, log_throttled=Mock(),
                   uia_boot=SimpleNamespace(resolve_account_windows=resolve), rebind_uia=rebind)
        pick = load_function('pick_account_window', env)
        self.assertTrue(pick())
        resolve.assert_called_once_with(matched)
        self.assertEqual(env['ACCOUNT']['hwnd'], 222)
        rebind.assert_called_once_with(222)

        owner.return_value = False
        rebind.reset_mock()
        self.assertFalse(pick(force=True))
        self.assertFalse(env['ACCOUNT']['verified'])
        rebind.assert_not_called()

    def test_account_tree_needs_session_controls_on_the_exact_hwnd(self):
        root = SimpleNamespace(NativeWindowHandle=222, ClassName='Qt51514QWindowIcon', GetChildren=Mock())
        child = SimpleNamespace(ClassName='mmui::XTableView', GetChildren=lambda: [])
        root.GetChildren.return_value = [child]
        auto = SimpleNamespace(ControlFromHandle=lambda _h: root)
        with patch.dict(sys.modules, {'uiautomation': auto}), patch.object(boot, '_ensure_com', return_value=True):
            self.assertEqual(boot.tree_state(222), 'ok')
            self.assertEqual(boot.tree_state(222, account_window=True), 'shell')
            child.ClassName = 'mmui::ChatSessionList'
            self.assertEqual(boot.tree_state(222, account_window=True), 'ok')
            self.assertEqual(boot.tree_state(111, account_window=True), 'unreachable')
            root.ClassName = 'mmui::LoginWindow'
            self.assertEqual(boot.tree_state(222, account_window=True), 'login')

    def test_equal_size_windows_use_chat_evidence_and_fail_closed_when_tied(self):
        windows = [(111, 333), (222, 333)]
        gui = SimpleNamespace(IsIconic=lambda _h: False, IsWindowVisible=lambda _h: True,
                              GetClassName=lambda _h: 'Qt51514QWindowIcon',
                              GetWindowRect=lambda _h: (0, 0, 900, 531), GetAncestor=lambda h, _kind: h)
        process = SimpleNamespace(GetWindowThreadProcessId=lambda _h: (1, 333))
        with patch.dict(sys.modules, {'win32gui': gui, 'win32process': process}), \
                patch.object(boot, 'tree_state', side_effect=['shell', 'ok', 'ok', 'ok']) as read:
            picked, evidence = boot.resolve_account_windows(windows)
            self.assertEqual(picked, (222, 333))
            self.assertEqual([row['size'] for row in evidence], [(900, 531)] * 2)
            self.assertIsNone(boot.resolve_account_windows(windows)[0])
        self.assertTrue(all(call.kwargs['account_window'] for call in read.call_args_list))

    def test_unique_native_main_can_warm_up_with_hidden_qt_helper(self):
        windows = [(111, 333), (222, 333)]
        gui = SimpleNamespace(IsIconic=lambda _h: False, IsWindowVisible=lambda h: h == 222,
                              GetClassName=lambda h: 'mmui::MainWindow' if h == 222 else 'Qt51514QWindowIcon',
                              GetWindowRect=lambda _h: (0, 0, 900, 531), GetAncestor=lambda h, _kind: h)
        process = SimpleNamespace(GetWindowThreadProcessId=lambda _h: (1, 333))
        with patch.dict(sys.modules, {'win32gui': gui, 'win32process': process}), \
                patch.object(boot, 'tree_state', return_value='shell'):
            self.assertEqual(boot.resolve_account_windows(windows)[0], (222, 333))
            gui.IsWindowVisible = lambda _h: True
            self.assertIsNone(boot.resolve_account_windows(windows)[0])
            gui.IsWindowVisible = lambda h: h == 222
            process.GetWindowThreadProcessId = lambda h: (1, 444 if h == 111 else 333)
            self.assertIsNone(boot.resolve_account_windows(windows)[0])

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
