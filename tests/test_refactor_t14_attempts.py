"""Real sender/window bodies with inert capabilities; no engine/UI imports."""
import ast
import ctypes
from contextlib import nullcontext
import importlib
import importlib.util
import atexit
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))


def load(path, name, scope):
    tree = ast.parse((ROOT / path).read_text(encoding='utf-8-sig'))
    node = next(n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(ROOT / path), 'exec'), scope)
    return scope[name]


class SafeFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='whale-t14-')
        self.addCleanup(temporary.cleanup)
        self.root = temporary.name
        self.effects = []
        for name in ('socket.socket', 'socket.create_connection', 'subprocess.Popen', 'subprocess.run',
                     'os.system', 'os.startfile', 'os.walk', 'os.scandir', 'glob.glob'):
            blocker = patch(name, side_effect=AssertionError('live capability forbidden'), create=True)
            self.effects.append(blocker.start())
            self.addCleanup(blocker.stop)
        bg = ModuleType('bg_sender')
        bg.configure, bg.send = Mock(), Mock()
        modules = {name: None for name in ('engine', 'app', 'wechatauto', 'win32gui', 'win32api',
                                          'win32con', 'pyautogui', 'uia_boot', 'parent_watch')}
        modules['bg_sender'] = bg
        blocker = patch.dict(sys.modules, modules)
        blocker.start()
        self.addCleanup(blocker.stop)
        self.bg = bg
        self.wall, self.mono = [10000.0], [100.0]
        self.state = importlib.import_module('send_state')
        for name, replacement in (('time', lambda: self.wall[0]), ('monotonic', lambda: self.mono[0])):
            blocker = patch.object(self.state.time, name, replacement)
            blocker.start()
            self.addCleanup(blocker.stop)

    def tearDown(self):
        for effect in self.effects:
            effect.assert_not_called()

    def runtime(self, background=False):
        self.state.SEND_STATE.update(active=False, start=0.0, budget=40.0)
        g = SimpleNamespace(time=SimpleNamespace(time=lambda: self.wall[0], monotonic=lambda: self.mono[0], sleep=Mock()),
            BACKGROUND_SEND=True, STICKER_TEST_ON=False, BG_SEND={'enabled': background, 'fallback': True},
            QUOTE_REPLY=False, KEYBOARD_FALLBACK=False, SEND_STATE=self.state.SEND_STATE,
            _SendStateScope=self.state._SendStateScope, ChatIdentityError=self.state.ChatIdentityError,
            DraftDirtyError=self.state.DraftDirtyError, _chat_identity_level=self.state._chat_identity_level,
            ROOT=self.root, os=SimpleNamespace(path=SimpleNamespace(join=lambda *parts: '/'.join(parts))),
            safe_name=lambda _: 'fixture-name', safe_id=lambda _: 'fixture-id',
            log=Mock(), log_error=Mock(), log_warn=Mock(), log_throttled=Mock())
        uia = SimpleNamespace(current_chat=Mock(return_value='fixture-room'), send_text=Mock(return_value=False),
                              open_chat=Mock(return_value=True), back_to_chat_tab=Mock())
        uia._chat_input = Mock(return_value=SimpleNamespace(value=''))
        r = SimpleNamespace(dead_chats=set(), dead_chat_until={}, group_is_alive=Mock(return_value=True), is_self_chat=Mock(return_value=False),
            ui_chat_name=Mock(return_value='fixture-room'), account_send_allowed=Mock(return_value=True),
            send_lock=nullcontext(), gui_lock=nullcontext(), send_policy_allows=Mock(return_value=True),
            sticker_quarantine_allows=Mock(return_value=True), fail_streak={}, open_cache={}, ACCOUNT={'blockedAt': 0},
            gui=SimpleNamespace(_get_uia=Mock(return_value=uia), quote_msg=Mock(return_value=False), at_member=Mock(return_value=False)),
            UIA_CACHE={'u': uia}, wechat_window_alive=Mock(return_value=True), install_quiet_uia=Mock(),
            aliases_for=Mock(return_value=['fixture-room']), _input_value=Mock(return_value=''), bind_gui_window=Mock(),
            recover_uia=Mock(return_value=True), snapshot_win_state=Mock(return_value='fixture-snapshot'), restore_win_state=Mock(),
            force_send_foreground=Mock(side_effect=lambda fn, **kwargs: fn()), _bg_hwnd=Mock(return_value=123),
            BG_STATS={'disabled': False, 'cooldownUntil': 0, 'tried': 0, 'last': '', 'lastAt': 0, 'ok': 0, 'treeFails': 0})
        methods = {name: load(path, name, {'G': g}) for path, name in (
            ('bridge/sender_mixin.py', 'chat_paused'), ('bridge/sender_mixin.py', 'pause_chat'),
            ('bridge/sender_mixin.py', 'send_text'), ('bridge/sender_mixin.py', 'uia_send'),
            ('bridge/sender_mixin.py', 'bg_send'), ('bridge/sender_mixin.py', 'send_at'),
            ('bridge/sender_mixin.py', 'keyboard_send'),
            ('bridge/window_mixin.py', 'with_window_on_top'), ('bridge/window_mixin.py', '_require_chat_identity'))}
        for name in ('uia_send', 'bg_send', 'with_window_on_top', '_require_chat_identity', 'chat_paused', 'pause_chat'):
            setattr(r, name, Mock(side_effect=lambda *args, _name=name, **kwargs: methods[_name](r, *args, **kwargs)))
        return r, g, uia, methods


class AttemptTests(SafeFixture):
    def test_opaque_false_is_handled_uncertain_once_not_twelve_sends(self):
        runtime, g, uia, methods = self.runtime()
        self.assertTrue(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
        uia.send_text.assert_called_once_with('fixture text')
        runtime.recover_uia.assert_not_called()
        runtime.force_send_foreground.assert_not_called()
        self.assertFalse(g.SEND_STATE['active'])

    def test_opaque_exception_is_not_replayed_or_sent_through_another_channel(self):
        runtime, g, uia, methods = self.runtime()
        uia.send_text.side_effect = RuntimeError('fixture opaque failure')
        self.assertTrue(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
        uia.send_text.assert_called_once()
        runtime.recover_uia.assert_not_called()

    def test_legacy_adapter_without_fresh_phase_evidence_is_uncertain(self):
        for returned in (False, True, RuntimeError('fixture legacy adapter')):
            runtime, g, uia, methods = self.runtime()
            runtime.uia_send = Mock(side_effect=returned) if isinstance(returned, Exception) else Mock(return_value=returned)
            self.assertTrue(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
            runtime.uia_send.assert_called_once()
            runtime.recover_uia.assert_not_called()

    def test_window_never_replays_callback_and_always_restores(self):
        for effect in (False, RuntimeError('fixture failure'), self.state.ChatIdentityError('fixture wrong target'),
                       self.state.DraftDirtyError('fixture draft')):
            with self.subTest(kind=type(effect).__name__):
                runtime, g, uia, methods = self.runtime()
                action = Mock(return_value=effect) if effect is False else Mock(side_effect=effect)
                if effect is False:
                    self.assertFalse(runtime.with_window_on_top(action))
                else:
                    with self.assertRaises(type(effect)):
                        runtime.with_window_on_top(action)
                action.assert_called_once()
                runtime.restore_win_state.assert_called_once_with('fixture-snapshot')
                runtime.force_send_foreground.assert_not_called()

    def test_known_preparation_failure_can_recover_before_one_effect(self):
        runtime, g, uia, methods = self.runtime()
        runtime.UIA_CACHE['u'] = None
        runtime.gui._get_uia.return_value = None
        uia.send_text.return_value = True
        def recover(*args):
            runtime.gui._get_uia.return_value = uia
            return True
        runtime.recover_uia.side_effect = recover
        self.assertTrue(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
        runtime.recover_uia.assert_called_once()
        uia.send_text.assert_called_once()

    def test_known_preinput_failure_can_prepare_foreground_without_replaying(self):
        runtime, g, uia, methods = self.runtime()
        runtime.recover_uia.return_value = False
        uia.current_chat.return_value = 'fixture-other'
        uia.open_chat.return_value = False
        uia.send_text.return_value = True
        def foreground(callback, **kwargs):
            uia.current_chat.return_value = 'fixture-room'
            return callback()
        runtime.force_send_foreground.side_effect = foreground
        self.assertTrue(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
        runtime.force_send_foreground.assert_called_once()
        uia.send_text.assert_called_once()

    def test_existing_background_terminal_reasons_never_fall_back(self):
        for ok, reason in ((True, 'sent_unverified'), (False, 'residue_left'),
                           (False, 'input_dirty'), (False, 'input_not_empty')):
            with self.subTest(reason=reason):
                self.bg.send.reset_mock()
                self.bg.send.return_value = (ok, reason)
                runtime, g, uia, methods = self.runtime(background=True)
                returned = methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer')
                self.assertIs(returned, ok)
                self.bg.send.assert_called_once()
                uia.send_text.assert_not_called()

    def test_quote_and_mention_opaque_failures_are_not_plain_text_fallbacks(self):
        runtime, g, uia, methods = self.runtime()
        g.QUOTE_REPLY = True
        self.assertTrue(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer', quote_latest=True))
        runtime.gui.quote_msg.assert_called_once()
        uia.send_text.assert_not_called()
        runtime, g, uia, methods = self.runtime()
        self.assertTrue(methods['send_at'](runtime, 'fixture-member', 'fixture text', 'fixture-room', 'fixture-peer'))
        runtime.gui.at_member.assert_called_once()
        uia.send_text.assert_not_called()

    def test_identity_and_draft_guards_stop_before_opaque_effect(self):
        for error in (self.state.ChatIdentityError('fixture target'), self.state.DraftDirtyError('fixture draft')):
            runtime, g, uia, methods = self.runtime()
            runtime._require_chat_identity.side_effect = error
            self.assertFalse(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
            uia.send_text.assert_not_called()
            runtime.recover_uia.assert_not_called()

    def test_unreadable_or_nonempty_composer_never_enters_the_opaque_driver(self):
        for value in (None, 'fixture manual draft'):
            runtime, g, uia, methods = self.runtime()
            uia._chat_input.return_value = None if value is None else SimpleNamespace(value=value)
            self.assertFalse(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
            uia.send_text.assert_not_called()
            runtime.recover_uia.assert_not_called()

    def test_success_with_residue_never_presses_enter_again(self):
        runtime, g, uia, methods = self.runtime()
        control = uia._chat_input.return_value
        def submitted(_text):
            control.value = 'fixture residue'
            return True
        uia.send_text.side_effect = submitted
        runtime.press_enter = Mock(side_effect=AssertionError('duplicate Enter forbidden'))
        self.assertTrue(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
        uia.send_text.assert_called_once()
        runtime.press_enter.assert_not_called()
        operation = importlib.import_module('send_attempt')
        self.assertEqual(operation.last_result().status, 'uncertain')

    def test_wrong_account_blocks_all_payload_channels(self):
        runtime, g, uia, methods = self.runtime(background=True)
        runtime.account_send_allowed.return_value = False
        self.assertFalse(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
        self.bg.send.assert_not_called()
        uia.send_text.assert_not_called()

    def test_permission_revoked_during_preparation_stops_before_input(self):
        runtime, g, uia, methods = self.runtime()
        runtime.send_policy_allows.side_effect = [True, False]
        self.assertFalse(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
        uia.send_text.assert_not_called()
        runtime.recover_uia.assert_not_called()
        runtime.force_send_foreground.assert_not_called()

    def test_known_same_title_contacts_cannot_authorize_the_wrong_session(self):
        runtime, g, uia, methods = self.runtime()
        runtime.sessions = {'fixture-peer': {'username': 'fixture-peer', 'name': 'fixture-room'},
                            'fixture-other': {'username': 'fixture-other', 'name': 'fixture-room'}}
        self.assertFalse(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
        uia.send_text.assert_not_called()
        runtime.recover_uia.assert_not_called()

    def test_account_change_during_preparation_is_terminal(self):
        for changed in ('fixture-other-account', ''):
            with self.subTest(changed=changed):
                runtime, g, uia, methods = self.runtime()
                runtime.db = SimpleNamespace(account='fixture-account', wxid='fixture-self')
                def prepare():
                    runtime.db.account = changed
                    return uia
                runtime.gui._get_uia.side_effect = prepare
                self.assertFalse(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
                uia.send_text.assert_not_called()

    def test_ocr_timeout_blocks_another_message_until_worker_finishes(self):
        runtime, g, uia, methods = self.runtime()
        runtime.UIA_CACHE['u'] = None
        runtime.gui._get_uia.return_value = None
        runtime.recover_uia.return_value = False
        fresh = SimpleNamespace(_get_uia=Mock(return_value=uia), send_msg=Mock())
        runtime.new_window_driver = Mock(return_value=fresh)
        class Pending:
            def __init__(self, target, **kwargs):
                self.target, self.alive = target, False
            def start(self): self.alive = True
            def join(self, timeout): self.timeout = timeout
            def is_alive(self): return self.alive
            def finish(self):
                self.alive = False
                self.target()
        import threading
        g.threading = SimpleNamespace(Thread=Pending, Event=threading.Event)
        self.assertTrue(methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
        worker = runtime._text_send_inflight
        self.assertTrue(g.SEND_STATE['active'])
        self.assertLessEqual(worker.timeout, 8)
        self.assertFalse(methods['send_text'](runtime, 'fixture next', 'fixture-room', 'fixture-peer'))
        fresh.send_msg.assert_not_called()
        worker.finish()
        self.assertFalse(g.SEND_STATE['active'])
        fresh.send_msg.assert_not_called()

    def test_keyboard_requires_own_account_database_evidence_for_confirmed(self):
        module = importlib.import_module('send_attempt')
        for own, account_changes, expected in ((True, False, 'confirmed'),
                                               (False, False, 'uncertain'), (True, True, 'uncertain')):
            with self.subTest(own=own, account_changes=account_changes):
                runtime, g, uia, methods = self.runtime()
                runtime.ACCOUNT['hwnd'] = 123
                runtime.gui._get_uia.return_value = uia
                db = SimpleNamespace(account='fixture-account', wxid='fixture-self')
                def messages(*args, **kwargs):
                    if account_changes:
                        db.wxid = 'fixture-other-account'
                    return [{'create_time': 10001, 'content': 'fixture text',
                             'sender_username': 'fixture-self' if own else 'fixture-other'}]
                db.get_messages = Mock(side_effect=messages)
                runtime.db = db
                keys = Mock()
                native = SimpleNamespace(GetForegroundWindow=lambda: 123, keybd_event=keys)
                clipboard = SimpleNamespace(OpenClipboard=Mock(), CloseClipboard=Mock(), EmptyClipboard=Mock(),
                    GetClipboardData=Mock(return_value='fixture-old-clipboard'), SetClipboardData=Mock(), CF_UNICODETEXT=13)
                modules = {'win32api': SimpleNamespace(), 'win32gui': SimpleNamespace(),
                           'win32con': SimpleNamespace(VK_CONTROL=17, VK_RETURN=13), 'win32clipboard': clipboard}
                with patch.dict(sys.modules, modules), patch.object(ctypes, 'windll', SimpleNamespace(user32=native), create=True):
                    self.assertTrue(methods['keyboard_send'](runtime, 'fixture text', 'fixture-room', 'fixture-peer'))
                self.assertEqual(module.last_result().status, expected)
                enters = [call for call in keys.call_args_list if call.args[0] == 13 and call.args[2] == 0]
                self.assertEqual(len(enters), 2, 'one search Enter and one composer Enter only')
                clipboard.SetClipboardData.assert_any_call(13, 'fixture-old-clipboard')


class BudgetTests(SafeFixture):
    def test_preparation_budget_is_shared_and_not_reset_by_nested_scopes(self):
        module = importlib.import_module('send_attempt')
        with module.logical_operation() as operation:
            operation.max_steps = 2
            self.assertTrue(operation.reserve('background_setup'))
            with module.logical_operation() as nested:
                self.assertIs(nested, operation)
                self.assertTrue(nested.reserve('recovery'))
            self.assertFalse(operation.reserve('fallback'))
            payload = Mock()
            self.assertFalse(operation.opaque('late', payload))
            payload.assert_not_called()
            self.assertEqual(operation.steps, 2)


    def test_no_budget_can_retry_after_any_opaque_result(self):
        module = importlib.import_module('send_attempt')
        for returned in (False, True, RuntimeError('fixture opaque exception')):
            operation = module.SendOperation(clock=lambda: self.mono[0])
            self.assertTrue(operation.reserve('uia'))
            action = Mock(side_effect=returned) if isinstance(returned, Exception) else Mock(return_value=returned)
            self.assertTrue(operation.opaque('uia', action))
            self.assertEqual(operation.result.status, 'submitted' if returned is True else 'uncertain')
            self.assertFalse(operation.reserve('recovery'))
            self.assertTrue(operation.opaque('fallback', action))
            action.assert_called_once()

    def test_cancel_and_elapsed_expiry_prevent_input_with_unused_tickets(self):
        module = importlib.import_module('send_attempt')
        for cancel in (lambda: True, Mock(side_effect=RuntimeError('fixture predicate'))):
            operation = module.SendOperation(cancelled=cancel)
            self.assertFalse(operation.reserve('uia'))
            self.assertEqual(operation.result.status, 'cancelled')
        operation = module.SendOperation(clock=lambda: self.mono[0])
        self.mono[0] += 41
        self.assertFalse(operation.reserve('recovery'))
        action = Mock()
        self.assertFalse(operation.opaque('uia', action))
        action.assert_not_called()

    def test_deferred_worker_keeps_watch_active_until_real_completion(self):
        module = importlib.import_module('send_attempt')
        scope = self.state._SendStateScope()
        scope.__enter__()
        scope.operation.begin_inflight()
        scope.operation.record('uncertain', 'fixture worker pending')
        scope.__exit__(None, None, None)
        self.assertTrue(self.state.SEND_STATE['active'])
        self.mono[0] += 41
        self.assertTrue(module.watchdog_expired(self.state.SEND_STATE))
        scope.operation.finish_inflight()
        self.assertFalse(self.state.SEND_STATE['active'])

    def test_terminal_identity_and_draft_are_never_treated_as_confirmed(self):
        module = importlib.import_module('send_attempt')
        for status in ('identity_mismatch', 'draft_dirty', 'cancelled'):
            operation = module.SendOperation()
            operation.record(status, 'fixture guard')
            self.assertFalse(operation.result.handled)
            self.assertFalse(operation.reserve('fallback'))


class BackgroundBoundaryTests(SafeFixture):
    def backend(self):
        class Native:
            def __getattr__(self, name):
                return Mock(return_value=0)
        spec = importlib.util.spec_from_file_location('fixture_t14_bg', ROOT / 'bridge/bg_sender.py')
        module = importlib.util.module_from_spec(spec)
        with patch.object(ctypes, 'WinDLL', lambda *args, **kwargs: Native(), create=True), \
                patch.object(ctypes, 'windll', SimpleNamespace(user32=Native(), kernel32=Native()), create=True), \
                patch.object(atexit, 'register', Mock()):
            spec.loader.exec_module(module)
        value = {'value': '', 'chat': 'fixture-room', 'edit': object(), 'send_xy': (1, 2), 'nodes': [1] * 200}
        sender = SimpleNamespace(hwnd=123, end_input=Mock(), click_screen=Mock())
        module.WeChatSender = Mock(return_value=sender)
        module.user32 = SimpleNamespace(IsIconic=lambda _: False)
        module._WriteGuard = nullcontext
        module._ensure_tree = lambda *args, **kwargs: dict(value)
        module.open_chat = lambda *args, **kwargs: True
        module.read_ui = lambda *args, **kwargs: dict(value)
        module._input_snapshot = lambda: (123, 1)
        module._draft_may_have_changed = lambda *args: False
        module._remember_char_mode = Mock()
        def write(_sender, _edit, text, **kwargs):
            value['value'] = text
            return True, []
        module._type_text = Mock(side_effect=write)
        sleeper = patch.object(module.time, 'sleep', lambda _: None)
        sleeper.start()
        self.addCleanup(sleeper.stop)
        return module, sender, value

    def test_background_observes_shared_expiry_before_submission(self):
        module, sender, value = self.backend()
        original = module._type_text.side_effect
        def write(*args, **kwargs):
            returned = original(*args, **kwargs)
            self.mono[0] += 41
            return returned
        module._type_text.side_effect = write
        self.assertEqual(module.send('fixture text', chat=['fixture-room'], hwnd=123, char_mode='utf16'), (False, 'input_dirty'))
        sender.click_screen.assert_not_called()
        outcome = importlib.import_module('send_attempt').last_result()
        self.assertFalse(outcome.may_have_sent)

    def test_background_cancel_during_owned_input_never_clicks(self):
        module, sender, value = self.backend()
        attempts = importlib.import_module('send_attempt')
        cancelled = [False]
        original = module._type_text.side_effect
        with attempts.logical_operation() as operation:
            operation.cancelled = lambda: cancelled[0]
            def write(*args, **kwargs):
                returned = original(*args, **kwargs)
                cancelled[0] = True
                return returned
            module._type_text.side_effect = write
            self.assertEqual(module.send('fixture text', chat=['fixture-room'], hwnd=123, char_mode='utf16'), (False, 'input_dirty'))
            sender.click_screen.assert_not_called()
            self.assertFalse(operation.result.may_have_sent)
            self.assertFalse(operation.reserve('fallback'))

    def test_background_zero_budget_does_not_prepare_or_type(self):
        module, sender, value = self.backend()
        attempts = importlib.import_module('send_attempt')
        with attempts.logical_operation() as operation:
            operation.max_steps = 0
            self.assertEqual(module.send('fixture text', chat=['fixture-room'], hwnd=123), (False, 'error:SendPreparationStopped'))
            module.WeChatSender.assert_not_called()
            module._type_text.assert_not_called()
            self.assertEqual(operation.steps, 0)

    def test_current_probe_cleanup_preserves_retyped_and_other_drafts(self):
        module, sender, value = self.backend()
        module._input_snapshot = lambda: (123, 2)
        load('bridge/bg_sender.py', '_draft_may_have_changed', module.__dict__)
        clear = Mock(return_value=True)
        module._clear_composer = clear
        for text in ('鲸', '¾¨', '笢', 'fixture user draft'):
            with self.subTest(text=text):
                value['value'] = text
                self.assertFalse(module._reset_typed_composer(123, 'fixture-room', text, (123, 1)))
                self.assertEqual(value['value'], text)
                clear.assert_not_called()
        value.update(value='鲸', chat='other-room')
        self.assertFalse(module._reset_typed_composer(123, 'fixture-room', '鲸', (123, 2)))
        clear.assert_not_called()
        sender.click_screen.assert_not_called()

    def test_current_owned_delayed_probe_still_cleans_without_user_edit(self):
        module, sender, value = self.backend()
        value['value'] = ''
        lag = [5]
        def read(_hwnd):
            current = dict(value)
            if value['value'] == '鲸' and lag[0]:
                lag[0] -= 1
                current['value'] = ''
            return current
        def clear(_hwnd, _edit):
            value['value'] = ''
            return True
        module.read_ui = Mock(side_effect=read)
        module._clear_composer = Mock(side_effect=clear)
        module._input_snapshot = lambda: (123, 1)
        load('bridge/bg_sender.py', '_draft_may_have_changed', module.__dict__)
        sender.type_text = Mock(side_effect=lambda *_a, **_k: value.update(value='鲸'))
        self.assertEqual(module._calibrate_char_mode(sender, 'fixture-room', ('utf16',), Mock()), ('utf16', True))
        self.assertEqual(lag[0], 0)
        module._clear_composer.assert_called_once()
        self.assertEqual(value['value'], '')
        self.assertEqual(module._input_snapshot(), (123, 1))
        sender.click_screen.assert_not_called()


class CurrentCooldownTests(SafeFixture):
    def test_transient_send_pause_expires_but_removed_group_stays_stopped(self):
        runtime, _g, _uia, methods = self.runtime()
        methods['pause_chat'](runtime, 'fixture-peer', 'fixture-room')
        self.assertTrue(methods['chat_paused'](runtime, 'fixture-peer'))
        self.wall[0] += 301
        self.assertFalse(methods['chat_paused'](runtime, 'fixture-peer'))
        runtime.dead_chats.add('fixture-peer')
        self.assertTrue(methods['chat_paused'](runtime, 'fixture-peer'))


class CareReceiptTests(SafeFixture):
    def care(self, mode, *, receipt_failures=0, account='fixture-account'):
        import json
        attempts = importlib.import_module('send_attempt')
        runtime, g, uia, methods = self.runtime()
        runtime.db = SimpleNamespace(account=account, wxid='fixture-self' if account else '')
        runtime.bot_url, runtime.token = 'fixture://kernel/webhook', 'fixture-token'
        runtime.foreground_is_fullscreen = Mock(return_value=False)
        payload_effect = Mock(return_value=True)
        def send(*args):
            if mode == 'actual_uncertain':
                return methods['send_text'](runtime, *args)
            operation = attempts.operation_for_call()
            if mode == 'not_sent':
                operation.record('not_sent', 'fixture_proved_preinput_refusal')
                return False
            if mode in ('missing', 'stale_context'):
                return True
            if mode == 'other_thread':
                import threading
                def unrelated():
                    with attempts.logical_operation() as other:
                        other.reserve('other-thread')
                        other.opaque('other-thread', lambda: True, true_status='confirmed')
                worker = threading.Thread(target=unrelated)
                worker.start()
                worker.join(1)
                self.assertFalse(worker.is_alive())
                return True
            operation.reserve('fixture-care-payload')
            result = operation.opaque('fixture-care-payload', payload_effect,
                true_status='submitted' if mode == 'submitted' else 'confirmed')
            if mode == 'account_changed':
                runtime.db.account = 'other-account'
            if mode == 'account_lost':
                runtime.db.account = ''
            if mode == 'target_changed':
                operation.target_username = 'other-peer'
            return result
        runtime.send_text = Mock(side_effect=send)
        sleeps = [0]
        class StopCare(Exception):
            pass
        def sleep(seconds):
            if seconds == 60:
                sleeps[0] += 1
                if sleeps[0] > 1:
                    raise StopCare()
        g.time = SimpleNamespace(time=lambda: self.wall[0], strftime=lambda _: 'fixture-day', sleep=sleep)
        g.json, g.CARE_ENABLED, g.CARE_QUIET_MIN = json, True, 0
        g.safe_text = lambda _: 'fixture-text'
        receipt_calls = []
        def post(_url, **kwargs):
            receipt_calls.append(dict(kwargs['json']))
            ok = len(receipt_calls) > receipt_failures
            return SimpleNamespace(ok=ok, json=lambda: {'ok': ok})
        g.LOCAL_HTTP = SimpleNamespace(get=Mock(side_effect=[
            SimpleNamespace(json=lambda: {'due': True, 'target': {'wxid': 'fixture-peer', 'name': 'fixture-room'}}),
            SimpleNamespace(json=lambda: {'text': 'fixture text'})]), post=Mock(side_effect=post))
        saved = []
        writer = SimpleNamespace(atomic_write_json=lambda _path, state: saved.append(state))
        run = load('bridge/loop_mixin.py', 'care_watch', {'G': g})
        context = attempts.logical_operation() if mode == 'stale_context' else nullcontext()
        with context as existing:
            if mode == 'stale_context':
                existing.bind_identity('fixture-peer', ('fixture-account', 'fixture-self'))
                existing.reserve('previous-call')
                existing.opaque('previous-call', lambda: True, true_status='confirmed')
            # A historical last_result alone is never receipt evidence.
            attempts._LOCAL.last_result = attempts.SendResult('confirmed', 'unrelated historical call', True)
            with patch.dict(sys.modules, {'runtime_json': writer}):
                with self.assertRaises(StopCare):
                    run(runtime)
        runtime.send_text.assert_called_once_with('fixture text', 'fixture-room', 'fixture-peer')
        self.assertEqual(len(saved), 1)
        return runtime, uia, payload_effect, receipt_calls, saved

    def test_actual_opaque_uncertain_is_handled_once_without_success_receipt(self):
        _runtime, uia, effect, receipts, saved = self.care('actual_uncertain')
        uia.send_text.assert_called_once()
        effect.assert_not_called()
        self.assertEqual(receipts, [])
        self.assertEqual(saved[0]['count'], 1)

    def test_confirmed_current_account_registers_receipt(self):
        _runtime, uia, effect, receipts, saved = self.care('confirmed')
        effect.assert_called_once()
        uia.send_text.assert_not_called()
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0]['chat'], 'fixture-peer')
        self.assertEqual(saved[0]['count'], 1)

    def test_proved_not_sent_does_not_register_or_consume_count(self):
        _runtime, _uia, effect, receipts, saved = self.care('not_sent')
        effect.assert_not_called()
        self.assertEqual(receipts, [])
        self.assertEqual(saved[0]['count'], 0)

    def test_submitted_without_confirmation_is_not_success_receipt(self):
        _runtime, _uia, effect, receipts, saved = self.care('submitted')
        effect.assert_called_once()
        self.assertEqual(receipts, [])
        self.assertEqual(saved[0]['count'], 1)

    def test_missing_stale_and_other_thread_evidence_cannot_authorize_receipt(self):
        for mode in ('missing', 'stale_context', 'other_thread'):
            with self.subTest(mode=mode):
                _runtime, _uia, effect, receipts, saved = self.care(mode)
                effect.assert_not_called()
                self.assertEqual(receipts, [])
                self.assertEqual(saved[0]['count'], 1)

    def test_changed_lost_or_unknown_account_and_target_cannot_authorize_receipt(self):
        for mode, account in (('account_changed', 'fixture-account'), ('account_lost', 'fixture-account'),
                              ('target_changed', 'fixture-account'), ('confirmed', '')):
            with self.subTest(mode=mode, known=bool(account)):
                _runtime, _uia, effect, receipts, saved = self.care(mode, account=account)
                effect.assert_called_once()
                self.assertEqual(receipts, [])
                self.assertEqual(saved[0]['count'], 1)

    def test_only_receipt_registration_retries_never_payload(self):
        _runtime, _uia, effect, receipts, _saved = self.care('confirmed', receipt_failures=2)
        effect.assert_called_once()
        self.assertEqual(len(receipts), 3)
        self.assertEqual(len({r['id'] for r in receipts}), 1)
        self.assertTrue(all(r == receipts[0] for r in receipts))



class ReminderAckComponentTests(SafeFixture):
    def adapter(self, mode='unknown', *, item_changes=None, permission=True, ack_failures=0):
        from types import MethodType
        import reminder_watch
        attempts = importlib.import_module('send_attempt')
        runtime, g, uia, methods = self.runtime(background=True)
        runtime.db = SimpleNamespace(account='fixture-account', wxid='fixture-self')
        runtime.sessions = {'fixture-peer': {'username': 'fixture-peer', 'name': 'fixture-room'}}
        g.BG_SEND['fallback'] = False
        self.bg.send.return_value = (False, 'no_window' if mode == 'not_sent' else 'error:RuntimeError')
        send_text = MethodType(methods['send_text'], runtime)
        effect = Mock(return_value=True)
        if mode in ('confirmed', 'wrong_account', 'changed_account', 'wrong_target', 'foreign', 'exception_after_effect'):
            def current_send(owner, text, name, username):
                op = attempts.operation_for_call()
                if mode == 'foreign':
                    other = attempts.SendOperation()
                    other.bind_identity(username, ('other-account', 'other-self'))
                    other.reserve('other-call')
                    other.opaque('other-call', lambda: True, true_status='confirmed')
                    return other.result
                identity = ('other-account', 'other-self') if mode == 'wrong_account' else (owner.db.account, owner.db.wxid)
                op.bind_identity('other-peer' if mode == 'wrong_target' else username, identity)
                op.reserve('fixture-confirmed')
                value = op.opaque('fixture-confirmed', effect, true_status='confirmed')
                if mode == 'changed_account': owner.db.account = 'changed-account'
                if mode == 'exception_after_effect': raise RuntimeError('fixture callback lost response')
                return value
            send_text = MethodType(current_send, runtime)
        voice = Mock(return_value=True)
        send_at = MethodType(methods['send_at'], runtime)
        item = {'id': 'fixture-reminder', 'wxid': 'fixture-peer', 'name': 'fixture-room',
                'text': 'fixture text', 'chatType': 'private'}
        item.update(item_changes or {})
        calls = []
        ack_count = [0]
        class Response:
            status_code = 200
            def __init__(self, body): self.body = body
            def json(self): return self.body
        def post(url, **kwargs):
            body = dict(kwargs['json'])
            if url.endswith('/api/reminders/permission'):
                return Response({'ok': permission})
            self.assertTrue(url.endswith('/api/reminders/ack'))
            calls.append(body)
            ack_count[0] += 1
            if ack_count[0] <= ack_failures:
                raise RuntimeError('fixture ACK response lost')
            return Response({'ok': True})
        http = SimpleNamespace(get=Mock(return_value=Response({'ok': True, 'items': [item]})), post=Mock(side_effect=post))
        with patch.object(reminder_watch.threading, 'Thread'):
            runner = reminder_watch.start_reminder_watch(http=http, base='http://fixture.invalid', token='fixture-token',
                send_text=send_text, send_at=send_at, send_voice=voice, log=Mock())
        attempts._LOCAL.last_result = attempts.SendResult('confirmed', 'stale unrelated global', True)
        return runner, calls, runtime, uia, effect, voice

    def test_real_background_unknown_acks_uncertain_and_keeps_handled_no_replay(self):
        runner, calls, _runtime, _uia, _effect, _voice = self.adapter()
        self.assertEqual(runner.step()[0], 0)
        runner.step()
        self.bg.send.assert_called_once()
        self.assertEqual((runner.sent, runner.failed, runner.uncertain), (0, 0, 1))
        self.assertEqual(len(calls), 1)
        self.assertIs(calls[0]['ok'], False)
        self.assertIs(calls[0]['uncertain'], True)

    def test_confirmed_owned_account_retains_legacy_success_json(self):
        runner, calls, _runtime, _uia, effect, _voice = self.adapter('confirmed')
        self.assertEqual(runner.step()[0], 1)
        effect.assert_called_once()
        self.assertEqual(calls, [{'id': 'fixture-reminder', 'ok': True, 'error': ''}])

    def test_known_not_sent_ignores_stale_confirmed_global(self):
        runner, calls, _runtime, _uia, _effect, _voice = self.adapter('not_sent')
        self.assertEqual(runner.step()[0], 0)
        self.bg.send.assert_called_once()
        self.assertFalse(calls[0]['ok'])
        self.assertNotIn('uncertain', calls[0])
        self.assertEqual((runner.sent, runner.failed, runner.uncertain), (0, 1, 0))

    def test_foreign_wrong_target_changed_account_and_after_effect_exception_are_unknown(self):
        for mode in ('foreign', 'wrong_account', 'changed_account', 'wrong_target', 'exception_after_effect'):
            with self.subTest(mode=mode):
                runner, calls, _runtime, _uia, _effect, _voice = self.adapter(mode)
                self.assertEqual(runner.step()[0], 0)
                self.assertTrue(calls[0]['uncertain'])
                self.assertEqual(runner.sent, 0)

    def test_ack_loss_retries_only_json_not_real_background_provider(self):
        runner, calls, _runtime, _uia, _effect, _voice = self.adapter(ack_failures=2)
        for _ in range(5): runner.step()
        self.bg.send.assert_called_once()
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(row == calls[0] for row in calls))
        self.assertTrue(calls[0]['uncertain'])

    def test_real_group_at_uncertainty_never_falls_through_to_text(self):
        runner, calls, runtime, _uia, _effect, _voice = self.adapter(item_changes={'chatType': 'group', 'atName': 'FixtureMember'})
        self.assertEqual(runner.step()[0], 0)
        runtime.gui.at_member.assert_called_once()
        self.bg.send.assert_not_called()
        self.assertTrue(calls[0]['uncertain'])

    def test_plugin_permission_refusal_and_legacy_voice_cancel_seam_are_preserved(self):
        runner, calls, _runtime, _uia, _effect, voice = self.adapter(
            item_changes={'kind': 'plugin', 'delivery': 'voice'}, permission=False)
        self.assertEqual(runner.step()[0], 0)
        voice.assert_not_called()
        self.assertFalse(calls[0]['ok'])
        self.assertNotIn('uncertain', calls[0])
        runner, calls, _runtime, _uia, _effect, voice = self.adapter(
            item_changes={'kind': 'plugin', 'delivery': 'voice'}, permission=True)
        self.assertEqual(runner.step()[0], 1)
        voice.assert_called_once()
        self.assertFalse(voice.call_args.kwargs['cancelled']())
        self.assertEqual(calls, [{'id': 'fixture-reminder', 'ok': True, 'error': ''}])


class FinalSenderLogTests(SafeFixture):
    observations = {}

    def background_case(self, status):
        attempts = importlib.import_module('send_attempt')
        runtime, g, _uia, methods = self.runtime(background=True)
        runtime.db = SimpleNamespace(account='fixture-account', wxid='fixture-self')
        runtime.sessions = {'fixture-peer': {'username': 'fixture-peer', 'name': 'fixture-room'}}
        runtime.fail_streak['fixture-peer'] = 2
        self.bg.send.return_value = (False, 'error:RuntimeError') if status == 'uncertain' else (True, 'sent')
        original_bg = runtime.bg_send
        captured = {}
        def background(*args):
            handled = original_bg(*args)
            operation = attempts.operation_for_call()
            self.assertEqual(operation.result.status, 'uncertain' if status == 'uncertain' else 'submitted')
            self.assertEqual(operation.target_username, 'fixture-peer')
            self.assertEqual(operation.account_identity, ('fixture-account', 'fixture-self'))
            if status == 'confirmed':
                # Logger-selector seam only: the real background path reports submitted,
                # not confirmation. This fixture does not prove transport delivery.
                operation.result.status = 'confirmed'
            captured.update(operation=operation, log_boundary=len(g.log.call_args_list))
            return handled
        runtime.bg_send = Mock(side_effect=background)
        handled = methods['send_text'](runtime, 'fixture text', 'fixture-room', 'fixture-peer')
        self.assertIs(handled, True)
        self.bg.send.assert_called_once()
        self.assertEqual(self.bg.send.call_args.args[0], 'fixture text')
        runtime.bg_send.assert_called_once()
        original_bg.assert_called_once()
        runtime.uia_send.assert_not_called()
        runtime.recover_uia.assert_not_called()
        runtime.force_send_foreground.assert_not_called()
        self.assertNotIn('fixture-peer', runtime.fail_streak)
        outer = g.log.call_args_list[captured['log_boundary']:]
        self.assertEqual(len(outer), 1)
        line = str(outer[0].args[0])
        self.observations[status] = {'ownedStatus': captured['operation'].result.status,
            'handled': handled, 'providerCalls': self.bg.send.call_count,
            'fallbackCalls': runtime.uia_send.call_count + runtime.recover_uia.call_count,
            'outerLog': line, 'syntheticConfirmedSelectorOnly': status == 'confirmed'}
        return line

    def test_unknown_background_log_preserves_handled_once_without_success_word(self):
        line = self.background_case('uncertain')
        self.assertIn('结果未知', line)
        self.assertIn('禁止重发', line)
        self.assertNotIn('成功', line)
        self.assertNotIn('已确认', line)

    def test_submitted_background_log_claims_submission_only(self):
        line = self.background_case('submitted')
        self.assertIn('已提交', line)
        self.assertNotIn('成功', line)
        self.assertNotIn('送达', line)
        self.assertNotIn('已确认', line)

    def test_confirmed_selector_logs_confirmation_only_for_current_owned_status(self):
        line = self.background_case('confirmed')
        self.assertIn('已确认', line)
        self.assertNotIn('结果未知', line)


if __name__ == '__main__':
    unittest.main()
