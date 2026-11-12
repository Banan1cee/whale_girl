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
    def test_unknown_process_owner_can_warm_uia_before_account_confirmation(self):
        for owns, same_chat, expected in [(None, True, True), (None, False, False), (False, True, False)]:
            with self.subTest(owns=owns, same_chat=same_chat):
                activated = set()
                probe = Mock()
                probe._wechat_hwnds.return_value = [222]
                probe._hot_activate_accessibility.side_effect = lambda h: activated.add(h)
                probe._anchor.return_value = SimpleNamespace(ClassName='Qt51514QWindowIcon')
                names = ['recent-one', 'recent-two'] if same_chat else ['other-one', 'other-two']
                probe._session_rows_of.side_effect = lambda _c: [(n, None) for n in names] if activated else []
                probe._row_score = None
                gui = SimpleNamespace(GetWindowThreadProcessId=None)
                process = SimpleNamespace(GetWindowThreadProcessId=lambda _h: (1, 333))
                env = dict(acct='selected-account', WINDOW_HWND=0, ACCOUNT={'verified': False},
                           db=SimpleNamespace(account='selected-account'),
                           _window_account_matches=Mock(return_value=owns),
                           _account_recent_names=lambda: ['recent-one', 'recent-two'],
                           _explain_unverified=lambda fallback: fallback, rebind_uia=Mock(), _compat_mod=lambda: None,
                           log=Mock(), uia_boot=SimpleNamespace(account_window_candidates=lambda *_: [(222, 333)]))
                env['_probe_wechat_windows'] = load_function('_probe_wechat_windows', env)
                with patch.dict(sys.modules, {'win32gui': gui, 'win32process': process,
                                              'wechatauto.uia_driver': SimpleNamespace(WeChatUIA=lambda: probe)}):
                    result = load_function('pick_account_window', env)()
                self.assertEqual(result, expected)
                self.assertEqual(env['ACCOUNT'].get('verified', False), expected)
                if owns is False:
                    probe._hot_activate_accessibility.assert_not_called()
                else:
                    probe._hot_activate_accessibility.assert_called_once_with(222)

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

    def test_hidden_existing_window_is_woken_without_process_or_foreground(self):
        win32gui = SimpleNamespace(IsWindowVisible=Mock(), IsIconic=Mock(), ShowWindow=Mock(), SetForegroundWindow=Mock())
        win32con = SimpleNamespace(SW_SHOWNOACTIVATE=4)
        win = dict(hwnd=123, pid=456, version='4.2.0.9')
        with patch.dict(sys.modules, {'win32gui': win32gui, 'win32con': win32con}), \
                patch.object(win32gui, 'IsWindowVisible', return_value=False), \
                patch.object(win32gui, 'IsIconic', return_value=False), \
                patch.object(win32gui, 'ShowWindow') as show, \
                patch.object(win32gui, 'SetForegroundWindow') as foreground, \
                patch.object(boot, 'pick_window', return_value=win), \
                patch.object(boot, 'tree_state', side_effect=['shell', 'ok']), \
                patch.object(boot, 'click_tray_icon', return_value=False), \
                patch.object(boot, 'wake_by_hotkey', return_value=True) as hotkey, \
                patch.object(boot.subprocess, 'Popen') as popen:
            self.assertTrue(boot.restore_wechat(win))
            hotkey.assert_called_once_with(123, log=None)
            show.assert_not_called()
            foreground.assert_not_called()
            popen.assert_not_called()

    def test_visible_window_with_broken_tree_is_not_popped_again(self):
        win32gui = SimpleNamespace(IsWindowVisible=Mock(), IsIconic=Mock(), ShowWindow=Mock())
        with patch.dict(sys.modules, {'win32gui': win32gui, 'win32con': SimpleNamespace(SW_SHOWNOACTIVATE=4)}), \
                patch.object(win32gui, 'IsWindowVisible', return_value=True), \
                patch.object(win32gui, 'IsIconic', return_value=False), \
                patch.object(win32gui, 'ShowWindow') as show, \
                patch.object(boot, 'tree_state', return_value='shell'), \
                patch.object(boot, 'wake_by_hotkey', return_value=False), \
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

    def test_multiple_windows_of_same_account_use_window_evidence(self):
        rebind = Mock()
        resolve = Mock(return_value=((444, 555), []))
        env = dict(acct='selected-account', WINDOW_HWND=0, ACCOUNT={'verified': False}, log=Mock(),
                   _probe_wechat_windows=lambda: (None, [], [
                       (222, 333), (444, 555)]), rebind_uia=rebind,
                   uia_boot=SimpleNamespace(resolve_account_windows=resolve))
        self.assertTrue(load_function('pick_account_window', env)())
        self.assertEqual(env['ACCOUNT']['hwnd'], 444)
        rebind.assert_called_once_with(444)

    def test_unresolved_cross_process_windows_fail_closed(self):
        resolve = Mock(return_value=(None, []))
        env = dict(acct='selected-account', WINDOW_HWND=0, ACCOUNT={'verified': False}, log=Mock(),
                   _probe_wechat_windows=lambda: (None, [], [(111, 333), (222, 444)]),
                   uia_boot=SimpleNamespace(resolve_account_windows=resolve), rebind_uia=Mock())
        self.assertFalse(load_function('pick_account_window', env)())
        self.assertFalse(env['ACCOUNT']['verified'])

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

    def test_two_unresolved_windows_with_same_ownership_fail_closed(self):
        rebind = Mock()
        resolve = Mock(return_value=(None, []))
        env = dict(acct='selected-account', WINDOW_HWND=0, ACCOUNT={'verified': False}, log=Mock(),
                   _probe_wechat_windows=lambda: (None, [], [(111, 333), (222, 333)]),
                   uia_boot=SimpleNamespace(resolve_account_windows=resolve), rebind_uia=rebind)
        self.assertFalse(load_function('pick_account_window', env)())
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

    def test_prefer_main_windows_drops_small_same_pid_helper_only(self):
        sizes = {1: (1120, 689), 2: (262, 296), 3: (262, 296)}
        gui = SimpleNamespace(IsIconic=lambda _h: False,
                              GetWindowRect=lambda h: (0, 0) + sizes[h])
        with patch.dict(sys.modules, {'win32gui': gui}):
            self.assertEqual(boot.prefer_main_windows([(1, 9), (2, 9), (3, 8)]),
                             [(1, 9), (3, 8)])

    def test_single_pid_large_and_small_window_picks_largest_with_evidence(self):
        windows = [(460366, 777), (328942, 777)]
        sizes = {460366: (1120, 689), 328942: (262, 296)}
        gui = SimpleNamespace(
            IsIconic=lambda _h: False,
            IsWindowVisible=lambda h: h == 460366,
            GetClassName=lambda _h: 'Qt51514QWindowIcon',
            GetWindowRect=lambda h: (0, 0) + sizes[h],
            GetAncestor=lambda h, _kind: h,
        )
        process = SimpleNamespace(GetWindowThreadProcessId=lambda _h: (1, 777))
        with patch.dict(sys.modules, {'win32gui': gui, 'win32process': process}), \
                patch.object(boot, 'tree_state', return_value='shell'):
            picked, evidence = boot.resolve_account_windows(windows)
            self.assertEqual(picked, (460366, 777))
            self.assertEqual(evidence[0]['picked'], 'largest_in_single_pid')
            # 跨进程同尺寸绝不合并：两个账号必须继续按会话树判断。
            process.GetWindowThreadProcessId = lambda h: (1, 777 if h == 460366 else 888)
            self.assertIsNone(boot.resolve_account_windows(windows)[0])

    def test_wake_by_hotkey_presses_twice_until_tree_recovers(self):
        with patch.object(boot, '_send_hotkey', return_value=True) as hotkey, \
                patch.object(boot.time, 'sleep', lambda _s: None):
            def tree(*_a, **_k):
                # 第一次热键可能只是把开关拨回托盘；第二次才真正打开。
                return 'ok' if hotkey.call_count >= 2 else 'shell'
            with patch.object(boot, 'tree_state', side_effect=tree):
                self.assertTrue(boot.wake_by_hotkey(123, wait=0.01))
            self.assertEqual(hotkey.call_count, 2)

    def test_wake_by_hotkey_does_nothing_when_tree_is_healthy(self):
        with patch.object(boot, 'tree_state', return_value='ok'), \
                patch.object(boot, '_send_hotkey') as hotkey:
            self.assertTrue(boot.wake_by_hotkey(123))
            hotkey.assert_not_called()

    def test_ensure_without_wake_never_opens_a_hidden_window(self):
        win = dict(hwnd=123, pid=456, version='4.2.0.9')
        with patch.object(boot, 'pick_window', return_value=win), \
                patch.object(boot, 'tree_state', return_value='shell'), \
                patch.object(boot, 'restore_wechat') as restore:
            res = boot.ensure(wake=False)
            self.assertEqual(res['reason'], 'asleep')
            restore.assert_not_called()

    def test_stray_login_window_filter_keeps_wide_or_tall_main_windows(self):
        windows = [
            dict(hwnd=100, pid=1, title='微信'),
            dict(hwnd=200, pid=2, title='微信'),   # 442x581 登录小窗：关
            dict(hwnd=300, pid=3, title='微信'),   # 1000x400：宽够，保留
            dict(hwnd=400, pid=4, title='微信'),   # 500x700：高够，保留
        ]
        sizes = {100: (1120, 689), 200: (442, 581), 300: (1000, 400), 400: (500, 700)}
        gui = SimpleNamespace(GetWindowRect=lambda h: (0, 0) + sizes[h],
                              PostMessage=Mock())
        with patch.dict(sys.modules, {'win32gui': gui}), \
                patch.object(boot, '_iter_windows', return_value=windows), \
                patch.object(boot, 'tree_state', return_value='shell'):
            boot.close_stray_login_windows(100)
        self.assertEqual([c.args[0] for c in gui.PostMessage.call_args_list], [200])

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
        # 账号未确认时仍然要允许 UIA 物化，否则「等账号确认」和「等控件树」互相死锁。
        self.assertFalse(ensure(force=True)['ok'])
        uia.ensure.assert_called_once_with(prefer_hwnd=0, log=env['log'],
                                           strict=False, wake=True)
        with self.assertRaises(RuntimeError):
            new_driver()
        gui.assert_not_called()
        uia.ensure.reset_mock()
        env['ACCOUNT'].update(hwnd=requested, verified=True)
        self.assertFalse(ensure(force=True)['ok'])
        uia.ensure.assert_called_once_with(prefer_hwnd=requested, log=env['log'],
                                           strict=True, wake=True)
        new_driver()
        gui.assert_called_once_with(hwnd=requested)

    def test_heartbeat_can_keep_wechat_asleep(self):
        uia = SimpleNamespace(ensure=Mock(return_value={'ok': False, 'reason': 'asleep'}),
                              describe=lambda _: 'UIA 待命')
        env = dict(acct='', ACCOUNT={'verified': False}, uia_boot=uia,
                   _UIA_READY={'ts': 0}, log=Mock())
        ensure = load_function('ensure_uia_ready', env)
        self.assertFalse(ensure(force=True, wake=False)['ok'])
        uia.ensure.assert_called_once_with(prefer_hwnd=0, log=env['log'],
                                           strict=False, wake=False)

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

