"""模拟同一微信窗口运行时切换编码；绝不接触真实微信或输入设备。"""
import ctypes
import os
import sys
import unittest
import tempfile
import ast
import time
from types import SimpleNamespace
from contextlib import nullcontext
from unittest.mock import patch, Mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bridge import bg_sender as bg


class LiveEncodingTests(unittest.TestCase):
    def setUp(self):
        self.state = dict(text='', actual='gbk', chat='测试群', sent=[], modes=[], clears=0,
                          unreadable=False, never_matches=False, clear_ok=True, switch_on_clear=False,
                          drop_linebreaks=False, short_first=False, stale_reads=0, replace_while_reading=False,
                          probes=[], input_tick=123, foreground=4242, manual_draft=False,
                          other_app_input=False, raise_on_clear=False, switch_on_send=False,
                          probe_lag=0, probe_lost=False, uia_ok=False, touch_during_probe=False)
        state = self.state

        class Sender:
            def __init__(self, hwnd):
                self.hwnd = hwnd

            def type_text(self, text, char_gap=0, strip_unencodable=True, mode='gbk'):
                (state['probes'] if text == '鲸' else state['modes']).append(mode)
                skipped = []
                if text == '鲸' and state['probe_lost']:
                    # 探测字根本没落进输入框，但用户这时正好动了一下键鼠
                    state['input_tick'] += 1
                    return True, []
                if text == '鲸' and state['touch_during_probe']:
                    # 探测字打进去了，同时用户动了一下鼠标/键盘
                    state['input_tick'] += 1
                if mode == 'gbk':
                    payload, skipped = bg.encode_gbk(text, strip_unencodable)
                    if payload is None:
                        return False, skipped
                    text = payload.decode('gbk')
                state['text'] = text if mode == state['actual'] and not state['never_matches'] else '¾¨乱码'
                if state['drop_linebreaks']:
                    state['text'] = state['text'].replace('\r', '').replace('\n', '')
                if text != '鲸' and state['short_first'] and len(state['modes']) == 1:
                    state['text'] = state['text'][:-1]
                if state['manual_draft']:
                    state['text'] = '用户刚输入的草稿'
                    state['input_tick'] += 1
                if state['other_app_input']:
                    state['input_tick'] += 1
                return True, skipped

            def end_input(self):
                pass

            def click_screen(self, *xy):
                state['sent'].append(state['text'])
                state['text'] = ''
                if state['switch_on_send']:
                    state['chat'] = '另一个群'

        def read(hwnd):
            value = None if state['unreadable'] and state['modes'] else state['text']
            if state['probe_lag'] and state['text'] == '鲸':
                # WM_CHAR 已经投出去，但 UIA 还没把字同步进控件模型
                state['probe_lag'] -= 1
                value = ''
            if state['modes'] and state['stale_reads']:
                state['stale_reads'] -= 1
                value = ''
            if state['modes'] and state['replace_while_reading']:
                state['text'] += '手动输入'
            return dict(nodes=[1] * 200, edit=object(), value=value, send_xy=(1, 2), chat=state['chat'])

        def clear(*args):
            if state['raise_on_clear']:
                raise RuntimeError('UIA 控件断开')
            state['clears'] += 1
            if state['clear_ok']:
                state['text'] = ''
            if state['switch_on_clear']:
                state['chat'] = '另一个群'
            return state['clear_ok']

        def uia_write(edit, text):
            if not state['uia_ok']:
                return False
            state['text'] = text
            return True

        for name, replacement in [
            ('user32', Mock(IsIconic=lambda h: False, GetForegroundWindow=lambda: state['foreground'])),
            ('WeChatSender', Sender),
            ('read_ui', read), ('_ensure_tree', lambda *a, **k: read(1)),
            ('open_chat', lambda *a, **k: True), ('_WriteGuard', nullcontext),
            ('_clear_composer', clear), ('_detect_char_mode_by_version', lambda h=0: 'utf16'),
            ('_last_input_tick', lambda: state['input_tick']),
            ('_uia_write', uia_write),
        ]:
            p = patch.object(bg, name, replacement)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(bg.time, 'sleep', lambda _: None)
        p.start()
        self.addCleanup(p.stop)
        bg._DETECTED_MODES.clear()
        bg._CONFIGURED_MODES.clear()
        p = patch.object(bg, '_MODE_STATE_FILE', None)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(bg, '_LAST_MODE_STATE', '')
        p.start()
        self.addCleanup(p.stop)
        bg._DETECT_DIRTY.clear()
        self.addCleanup(bg._DETECTED_MODES.clear)
        self.addCleanup(bg._CONFIGURED_MODES.clear)

    def send(self, **kwargs):
        return bg.send('鲸鲸测试', chat='测试群', hwnd=4242, **kwargs)

    def test_hot_switch_both_directions_uses_content_and_updates_cache(self):
        self.assertEqual(self.send(), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['utf16', 'gbk'])
        self.assertEqual(self.state['sent'], ['鲸鲸测试'])
        self.assertEqual(bg._DETECTED_MODES[4242], 'gbk')
        self.state['actual'] = 'utf16'
        self.state['modes'].clear()
        self.assertEqual(self.send(), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['gbk', 'utf16'])
        self.assertEqual(self.state['sent'], ['鲸鲸测试', '鲸鲸测试'])
        self.assertEqual(bg._DETECTED_MODES[4242], 'utf16')

    def test_verified_mode_stays_fixed_despite_original_manual_setting(self):
        self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['utf16', 'gbk'])
        self.state['modes'].clear()
        self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['gbk'])
        self.state['actual'] = 'utf16'
        self.state['modes'].clear()
        self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['gbk', 'utf16'])
        self.state['modes'].clear()
        self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['utf16'])

    def test_verified_mode_survives_bridge_restart(self):
        with tempfile.TemporaryDirectory() as root:
            file = os.path.join(root, 'encoding.json')
            bg.configure({}, state_file=file)
            self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
            bg._DETECTED_MODES.clear()
            bg._CONFIGURED_MODES.clear()
            bg._MODE_STATE_FILE = None
            bg.configure({}, state_file=file)
            self.state['modes'].clear()
            self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
            self.assertEqual(self.state['modes'], ['gbk'])

    def test_second_failure_never_clicks_send_even_if_verify_disabled(self):
        self.state['never_matches'] = True
        self.assertEqual(self.send(verify=False), (False, 'content_mismatch'))
        self.assertEqual(self.state['modes'], ['utf16'])
        self.assertEqual(self.state['probes'], ['utf16', 'gbk'])
        self.assertEqual(self.state['sent'], [])
        self.assertEqual(self.state['text'], '')

    def test_multiline_reply_stays_readable_on_input_that_drops_linebreaks(self):
        self.state.update(actual='utf16', drop_linebreaks=True)
        self.assertEqual(bg.send('第一段\r\n\r\n第二段', chat='测试群', hwnd=4242), (True, 'sent'))
        self.assertEqual(self.state['sent'], ['第一段 第二段'])
        self.assertEqual(self.state['modes'], ['utf16'])
        self.assertEqual(self.state['probes'], [])

    def test_correct_encoding_with_a_dropped_character_does_not_retype_in_gbk(self):
        self.state.update(actual='utf16', short_first=True)
        self.assertEqual(self.send(), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['utf16', 'utf16'])
        self.assertEqual(self.state['probes'], ['utf16'])
        self.assertEqual(self.state['sent'], ['鲸鲸测试'])

    def test_slow_uia_readback_does_not_clear_or_switch(self):
        self.state.update(actual='utf16', stale_reads=2)
        self.assertEqual(self.send(), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['utf16'])
        self.assertEqual(self.state['clears'], 0)

    def test_failed_recalibration_keeps_last_proven_mode(self):
        self.assertEqual(self.send(), (True, 'sent'))
        self.state.update(never_matches=True)
        self.assertEqual(self.send(), (False, 'content_mismatch'))
        self.assertEqual(bg._DETECTED_MODES[4242], 'gbk')

    def test_changing_draft_is_never_cleared_or_sent(self):
        self.state.update(actual='utf16', short_first=True, replace_while_reading=True)
        self.assertEqual(self.send(), (False, 'input_dirty'))
        self.assertEqual(self.state['clears'], 0)
        self.assertEqual(self.state['sent'], [])

    def test_user_can_finish_typing_before_first_read_without_losing_draft(self):
        self.state.update(actual='utf16', manual_draft=True)
        self.assertEqual(self.send(), (False, 'input_dirty'))
        self.assertEqual(self.state['text'], '用户刚输入的草稿')
        self.assertEqual(self.state['clears'], 0)
        self.assertEqual(self.state['sent'], [])

    def test_input_in_another_foreground_app_does_not_block_encoding_recovery(self):
        self.state.update(foreground=9876, other_app_input=True)
        self.assertEqual(self.send(), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['utf16', 'gbk'])
        self.assertEqual(self.state['sent'], ['鲸鲸测试'])

    def test_switch_after_click_does_not_treat_another_chats_empty_input_as_confirmation(self):
        self.state.update(actual='utf16', switch_on_send=True)
        self.assertEqual(self.send(), (True, 'sent_unverified'))
        self.assertEqual(self.state['sent'], ['鲸鲸测试'])

    def test_failed_initial_probe_cleanup_never_requests_foreground_fallback(self):
        self.state['raise_on_clear'] = True
        with patch.object(bg, '_detect_char_mode_by_version', return_value='gbk'):
            self.assertEqual(self.send(), (False, 'input_dirty'))
        self.assertEqual(self.state['modes'], [])
        self.assertEqual(self.state['sent'], [])

    def test_gbk_unrepresentable_message_tries_verified_utf16_before_fallback(self):
        self.state['actual'] = 'utf16'
        self.assertEqual(bg.send('😀', chat='测试群', hwnd=4242, char_mode='gbk'), (True, 'sent'))
        self.assertEqual(self.state['probes'], ['utf16'])
        self.assertEqual(self.state['sent'], ['😀'])
        self.assertEqual(bg._DETECTED_MODES[4242], 'utf16')

    def test_unreadable_after_typing_does_not_guess_encoding_or_send(self):
        self.state['unreadable'] = True
        self.assertEqual(self.send(), (False, 'input_dirty'))
        self.assertEqual(self.state['clears'], 0)
        self.assertEqual(self.state['sent'], [])

    def test_probe_char_that_lands_late_is_still_cleared(self):
        # 现场日志：探测后回读到空框，紧接着收尾时字才落进来 → 探测字残留在框里，
        # 下一次发送直接 input_not_empty，这台机器就再也发不出去。
        self.state.update(actual='utf16', probe_lag=5)
        with patch.object(bg, '_detect_char_mode_by_version', return_value='gbk'):
            self.assertEqual(self.send(), (True, 'sent'))
        self.assertEqual(self.state['probes'], ['utf16'])
        self.assertEqual(self.state['sent'], ['鲸鲸测试'])
        self.assertEqual(self.state['text'], '')

    def test_user_activity_during_probe_does_not_brick_sending(self):
        # 探测字已经打进输入框，用户这时动了鼠标：框里只有探测字，不是他的草稿。
        self.state.update(actual='utf16', touch_during_probe=True)
        with patch.object(bg, '_detect_char_mode_by_version', return_value='gbk'):
            self.assertEqual(self.send(), (True, 'sent'))
        self.assertEqual(self.state['sent'], ['鲸鲸测试'])
        self.assertEqual(self.state['text'], '')

    def test_probe_that_writes_nothing_still_sends_via_uia_setvalue(self):
        # 探测字没打进输入框（WM_CHAR 没落到控件里），用户这时又动了一下键鼠：
        # 以前会被当成「探测留下的脏框」拦住所有发送；框是空的就该继续走。
        self.state.update(actual='utf16', probe_lost=True, uia_ok=True)
        with patch.object(bg, '_detect_char_mode_by_version', return_value='gbk'):
            self.assertEqual(self.send(), (True, 'sent'))
        self.assertEqual(self.state['sent'], ['鲸鲸测试'])
        self.assertEqual(self.state['clears'], 0)

    def test_existing_draft_is_preserved(self):
        self.state['text'] = '用户正在编辑的草稿'
        self.assertEqual(self.send(), (False, 'input_not_empty'))
        self.assertEqual(self.state['modes'], [])
        self.assertEqual(self.state['clears'], 0)
        self.assertEqual(self.state['text'], '用户正在编辑的草稿')

    def test_clear_failure_stops_without_appending_another_encoding(self):
        self.state['clear_ok'] = False
        self.assertEqual(self.send(), (False, 'input_dirty'))
        self.assertEqual(self.state['modes'], ['utf16'])
        self.assertEqual(self.state['sent'], [])

    def test_chat_switch_during_clear_never_types_into_other_chat(self):
        self.state['switch_on_clear'] = True
        self.assertEqual(self.send(), (False, 'input_dirty'))
        self.assertEqual(self.state['modes'], ['utf16'])
        self.assertEqual(self.state['sent'], [])

    def test_gbk_skipped_emoji_is_compared_against_actual_payload(self):
        self.assertEqual(bg.send('鲸鲸😀', chat='测试群', hwnd=4242, char_mode='gbk'), (True, 'sent_partial'))
        self.assertEqual(self.state['sent'], ['鲸鲸'])
        self.assertEqual(self.state['clears'], 0)

    def test_correct_utf16_sends_emoji_without_switching(self):
        self.state['actual'] = 'utf16'
        self.assertEqual(bg.send('鲸鲸😀', chat='测试群', hwnd=4242), (True, 'sent'))
        self.assertEqual(self.state['sent'], ['鲸鲸😀'])
        self.assertEqual(self.state['modes'], ['utf16'])


class PausedChatTests(unittest.TestCase):
    """连续发送失败只停一会儿，不再永久跳过会话。"""

    def build(self):
        from bridge_ast import init, load_function
        clock = {'now': 1000.0}
        env = dict(dead_chats=set(), dead_chat_until={}, log=Mock(),
                   safe_name=lambda v: v,
                   time=SimpleNamespace(time=lambda: clock['now']))
        init(env)
        load_function('chat_paused', env)
        load_function('pause_chat', env)
        return env, clock

    def test_failed_chat_is_retried_after_cooldown(self):
        env, clock = self.build()
        env['pause_chat']('peer', 'Peer')
        self.assertTrue(env['chat_paused']('peer'))
        clock['now'] += 299
        self.assertTrue(env['chat_paused']('peer'))
        clock['now'] += 2
        self.assertFalse(env['chat_paused']('peer'))

    def test_removed_group_stays_stopped(self):
        env, clock = self.build()
        env['dead_chats'].add('group')
        clock['now'] += 10 ** 6
        self.assertTrue(env['chat_paused']('group'))


class DirtyDraftPipelineTests(unittest.TestCase):
    def test_bridge_does_not_fall_back_or_disable_chat_after_dirty_draft(self):
        # 只提取发送闭包，避开 main 的真实微信连接；执行的仍是实际桥接代码。
        from bridge_ast import init, load_chat_name_helpers, load_function
        for reason in ('input_dirty', 'residue_left', 'input_not_empty', 'content_mismatch'):
            with self.subTest(reason=reason):
                draft_error = type('DraftDirtyError', (RuntimeError,), {})
                fallback = Mock(side_effect=AssertionError('不能进入会抢前台的下一条发送通道'))
                env = dict(time=time, BG_SEND={'enabled': True},
                    BG_STATS=dict(disabled=False, cooldownUntil=0, tried=0),
                    _bg_hwnd=lambda: 4242, log=Mock(), log_error=Mock(),
                    DraftDirtyError=draft_error, ChatIdentityError=type('ChatIdentityError', (RuntimeError,), {}),
                    dead_chats=set(), dead_chat_until={}, fail_streak={}, account_send_allowed=lambda *a: True,
                    chat_paused=lambda u: u in env['dead_chats'],
                    send_policy_allows=lambda *a: True,
                    sticker_quarantine_allows=lambda *a: True, send_lock=nullcontext(),
                    _SendStateScope=lambda n: nullcontext(), STICKER_TEST_ON=False,
                    SEND_STATE={}, gui=None, WeChatGUI=fallback)
                module = SimpleNamespace(configure=Mock(), send=Mock(return_value=(False, reason)))
                with patch.dict(sys.modules, {'bg_sender': module}):
                    init(env)
                    load_chat_name_helpers(env)
                    load_function('bg_send', env)
                    load_function('send_text', env)
                    self.assertFalse(env['send_text']('测试正文', '测试群'))
                fallback.assert_not_called()
                self.assertEqual(env['dead_chats'], set())
                self.assertEqual(env['fail_streak'], {})
                messages = '\n'.join(str(call.args[0]) for call in env['log_error'].call_args_list)
                self.assertNotIn('草稿或正文校验失败', messages)
                events = '\n'.join(str(call.args[0]) for call in env['log'].call_args_list)
                self.assertIn('stage=background result=failed reason=' + reason, events)


class InputChannelTests(unittest.TestCase):
    def test_uia_value_pattern_is_preferred_over_wm_char(self):
        edit = Mock()
        sender = SimpleNamespace(hwnd=4242, type_text=Mock())
        bg._UIA_WRITE_LOGGED.clear()
        ok, skipped = bg._type_text(sender, edit, '鲸鲸测试', mode='utf16', log=Mock())
        self.assertTrue(ok)
        self.assertEqual(skipped, [])
        edit.GetValuePattern.return_value.SetValue.assert_called_once_with('鲸鲸测试')
        sender.type_text.assert_not_called()

    def test_wm_char_is_used_when_value_pattern_fails(self):
        edit = Mock()
        edit.GetValuePattern.side_effect = RuntimeError('no ValuePattern')
        sender = SimpleNamespace(hwnd=4242, type_text=Mock(return_value=(True, [])))
        bg._UIA_WRITE_LOGGED.clear()
        ok, _skipped = bg._type_text(sender, edit, '鲸鲸测试', mode='utf16',
                                     log=Mock())
        self.assertTrue(ok)
        sender.type_text.assert_called_once()

    def test_open_chat_refuses_fuzzy_row_and_lets_search_channel_handle_it(self):
        clicked = []
        sender = SimpleNamespace(hwnd=4242, click_screen=lambda *xy: clicked.append(xy))
        ctrl = SimpleNamespace(BoundingRectangle=SimpleNamespace(left=0, top=0, right=200, bottom=40))
        info = dict(nodes=[1] * 200, edit=object(), value='', send_xy=(1, 2),
                    chat='另一个群', rows=[('群A2', ctrl)], tabs=[])
        with patch.object(bg, 'read_ui', return_value=info):
            self.assertFalse(bg.open_chat(sender, ['群A'], log=Mock()))
        self.assertEqual(clicked, [])

    def test_tree_shell_wakes_before_running_spi_or_gate(self):
        shell = dict(nodes=[1], edit=None, value=None, send_xy=None, chat=None, rows=[], tabs=[])
        healthy = dict(nodes=[1] * 200, edit=object(), value='', send_xy=(1, 2),
                       chat='测试群', rows=[], tabs=[])
        with patch.object(bg, 'read_ui', side_effect=[shell, healthy]), \
                patch.object(bg, '_wake_with_hotkey', return_value=True) as wake, \
                patch.object(bg._ScreenReader, 'enable') as enable:
            info = bg._ensure_tree(4242, wake=True)
        self.assertEqual(len(info['nodes']), 200)
        wake.assert_called_once()
        enable.assert_not_called()

    def test_tree_shell_stays_quiet_when_wake_is_disabled(self):
        shell = dict(nodes=[1], edit=None, value=None, send_xy=None, chat=None, rows=[], tabs=[])
        with patch.object(bg, 'read_ui', return_value=shell), \
                patch.object(bg, '_wake_with_hotkey') as wake, \
                patch.object(bg.user32, 'IsWindowVisible', return_value=True), \
                patch.object(bg.user32, 'IsIconic', return_value=False), \
                patch.object(bg._ScreenReader, 'enable', return_value=True), \
                patch.object(bg, '_gate_pulse', return_value=False), \
                patch.object(bg.time, 'sleep', lambda _s: None):
            bg._ensure_tree(4242, wake=False)
        wake.assert_not_called()

    def test_screen_reader_write_checks_flags_and_readback(self):
        calls = []

        def spi(action, _ui, param, flags):
            calls.append((action, param.value if hasattr(param, 'value') else param, flags))
            if action == bg.SPI_GETSCREENREADER:
                ctypes.cast(param, ctypes.POINTER(ctypes.c_uint))[0] = 1
            return True

        with patch.object(bg.user32, 'SystemParametersInfoW', side_effect=spi), \
                patch.object(bg._ScreenReader, '_on', False), \
                patch.object(bg._ScreenReader, '_verified', False):
            self.assertTrue(bg._ScreenReader._set(True))
        set_call = [c for c in calls if c[0] == bg.SPI_SETSCREENREADER][0]
        self.assertEqual(set_call[2], bg.SPIF_UPDATEINIFILE | bg.SPIF_SENDCHANGE)
        self.assertEqual(set_call[1], 1)


if __name__ == '__main__':
    unittest.main()
