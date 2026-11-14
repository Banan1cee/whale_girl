"""Portable PR155 regressions: execute original AST bodies, never import engine/UI."""
import ast
import copy
import html
import re
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock


ROOT = Path(__file__).resolve().parents[1]


def functions(path, names, env):
    tree = ast.parse((ROOT / path).read_text(encoding='utf-8-sig'))
    nodes = []
    for name in names:
        matches = [node for node in ast.walk(tree)
                   if isinstance(node, ast.FunctionDef) and node.name == name]
        if len(matches) != 1:
            raise AssertionError('Expected one original function: ' + name)
        nodes.append(copy.deepcopy(matches[0]))
    module = ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[]))
    exec(compile(module, str(ROOT / path), 'exec'), env)
    return env


class ProbeOwnershipTests(unittest.TestCase):
    def reset(self, value, changed=False, target=True, foreground=4242,
              clear_target=True):
        state = {'value': value, 'chat': 'fixture-chat', 'tick': 10}
        before = (foreground, state['tick'])
        if changed:
            # The user deletes our probe, then types the same visible text.
            state['value'] = ''
            state['tick'] = 20
            state['value'] = value
            state['tick'] = 30
        if not target:
            state['chat'] = 'other-chat'

        def read(_hwnd):
            return {'chat': state['chat'], 'value': state['value'], 'edit': 'fixture-edit'}

        def clear(_hwnd, _edit):
            state['value'] = ''
            if not clear_target:
                state['chat'] = 'other-chat'
            return True

        clear_spy = Mock(side_effect=clear)
        env = {'read_ui': read, '_clear_composer': clear_spy,
               '_target_composer': lambda info, chat: info['chat'] == chat,
               '_last_input_tick': lambda: state['tick'],
               'user32': SimpleNamespace(GetForegroundWindow=lambda: foreground),
               '_PROBE_TEXTS': ('鲸', '¾¨', '笢')}
        functions('bridge/bg_sender.py',
                  ['_input_snapshot', '_draft_may_have_changed', '_composer_text',
                   '_is_blank', '_reset_typed_composer'], env)
        result = env['_reset_typed_composer'](4242, 'fixture-chat', value, before)
        return result, state, clear_spy

    def test_retyped_probe_sentinels_are_user_drafts(self):
        for value in ('鲸', '¾¨', '笢'):
            with self.subTest(value=value):
                result, state, clear = self.reset(value, changed=True)
                self.assertFalse(result)
                self.assertEqual(state['value'], value)
                clear.assert_not_called()

    def test_ordinary_draft_and_other_session_remain_protected(self):
        for kwargs in ({'value': 'fixture user draft', 'changed': True},
                       {'value': '鲸', 'target': False}):
            with self.subTest(kwargs=kwargs):
                result, state, clear = self.reset(**kwargs)
                self.assertFalse(result)
                self.assertEqual(state['value'], kwargs['value'])
                clear.assert_not_called()

    def test_unchanged_probe_and_other_app_activity_can_clean(self):
        for kwargs in ({}, {'changed': True, 'foreground': 9876}):
            with self.subTest(kwargs=kwargs):
                result, state, clear = self.reset('鲸', **kwargs)
                self.assertTrue(result)
                self.assertEqual(state['value'], '')
                clear.assert_called_once()

    def test_blank_unreadable_and_switch_after_clear_controls(self):
        result, _, clear = self.reset('', changed=True)
        self.assertTrue(result)
        clear.assert_not_called()
        result, _, clear = self.reset(None)
        self.assertFalse(result)
        clear.assert_not_called()
        result, _, clear = self.reset('鲸', clear_target=False)
        self.assertFalse(result)
        clear.assert_called_once()

    def test_delayed_uia_probe_readback_is_retained(self):
        values = iter(['', '', '', '', '', '鲸'])
        reads = []

        def read(_hwnd):
            value = next(values)
            reads.append(value)
            return {'value': value, 'edit': 'fixture-edit', 'chat': 'fixture-chat'}

        env = {'read_ui': read, 'time': SimpleNamespace(sleep=lambda _: None),
               '_target_composer': lambda info, chat: info['chat'] == chat}
        functions('bridge/bg_sender.py', ['_composer_text', '_read_typed_composer'], env)
        _, value, stable = env['_read_typed_composer'](4242, 'fixture-chat', '鲸')
        self.assertEqual(value, '鲸')
        self.assertTrue(stable)
        self.assertEqual(len(reads), 6)


class QuoteDiscriminationTests(unittest.TestCase):
    VALID = ('<msg><appmsg><type>57</type><title>fixture reply</title>'
             '<refermsg><displayname>Fixture</displayname>'
             '<content>fixture original</content></refermsg></appmsg></msg>')

    def setUp(self):
        self.env = functions('bridge/receiver_mixin.py',
                             ['_nested_quote_text', 'parse_quote_content',
                              'quote_content_text', 'on_message_inner'],
                             {'html': html, 're': re})

    def receive(self, content, mtype='文本', only_chats=()):
        post = Mock(return_value=SimpleNamespace(
            status_code=200, json=lambda: {'ok': True, 'action': 'ignore'}))
        log = Mock()
        self.env['G'] = SimpleNamespace(
            fix_garbled=lambda value: value, ONLY_CHATS=only_chats,
            is_system_notice=lambda *_: False, duplicate_guard=lambda *_: False,
            mention=SimpleNamespace(analyze=lambda *_: {
                'addressed': False, 'bare_any': False, 'bare_self': False,
                'mentioned_names': []}), LOCAL_HTTP=SimpleNamespace(post=post),
            CONN_STATE={'ok': True}, log=log, log_throttled=Mock(), log_error=Mock(),
            safe_name=str, safe_text=str, safe_id=str)
        runtime = SimpleNamespace(
            me='fixture-self', token='', bot_url='fixture-kernel',
            db=SimpleNamespace(get_nickname=lambda _: 'Fixture'),
            display_name=lambda _: 'Fixture conversation',
            self_identity_ids=lambda: {'fixture-self'}, dead_chats=set())
        msg = {'username': 'fixture-chat', 'sender_username': 'fixture-peer',
               'type': mtype, 'content': content, 'local_id': 1}
        self.env['on_message_inner'](runtime, msg, None)
        self.assertFalse(any(call.args and call.args[0] == '提交消息处理失败：'
                             for call in log.call_args_list), log.call_args_list)
        return post

    def test_literal_code_and_malformed_quotes_remain_ordinary_text(self):
        cases = ('请解释 <refermsg> 标签',
                 '代码示例：<refermsg>placeholder</refermsg>',
                 '<refermsg>placeholder</refermsg>',
                 '<msg><appmsg><type>57</type><refermsg>unfinished',
                 '<msg><appmsg><type>6</type><title>fixture attachment</title>'
                 '<refermsg><content>fixture</content></refermsg></appmsg></msg>',
                 self.VALID)
        for text in cases:
            with self.subTest(text=text):
                post = self.receive(text)
                post.assert_called_once()
                self.assertEqual(post.call_args.kwargs['json']['text'], text)

    def test_parser_rejects_literal_malformed_and_nonquote_structure(self):
        cases = ('请解释 <refermsg> 标签',
                 '代码示例：<refermsg>placeholder</refermsg>',
                 '<refermsg><content>fixture</content></refermsg>',
                 '<msg><appmsg><type>57</type><refermsg>unfinished',
                 '<msg><appmsg><type>6</type><title>fixture attachment</title>'
                 '<refermsg><content>fixture</content></refermsg></appmsg></msg>')
        for text in cases:
            with self.subTest(text=text):
                self.assertIsNone(self.env['parse_quote_content'](text))
                self.assertIsNone(self.env['quote_content_text'](text))

    def test_valid_quotes_still_reach_kernel_with_original_sender(self):
        for mtype in ('文件', '链接', '卡片'):
            with self.subTest(mtype=mtype):
                post = self.receive(self.VALID, mtype)
                post.assert_called_once()
                payload = post.call_args.kwargs['json']
                self.assertEqual(payload['text'],
                                 '（引用Fixture「fixture original」）fixture reply')
                self.assertEqual(payload['sender_id'], 'fixture-peer')
                self.assertEqual(payload['chat_id'], 'fixture-chat')

    def test_attachment_and_quote_allowlist_controls(self):
        text = ('<msg><appmsg><type>6</type><title>fixture attachment</title>'
                '<url>https://example.invalid/fixture</url></appmsg></msg>')
        post = self.receive(text, '文件')
        post.assert_called_once()
        self.assertEqual(post.call_args.kwargs['json']['text'],
                         '分享了一个链接：fixture attachment https://example.invalid/fixture')
        self.receive(self.VALID, '文件', only_chats=('other-chat',)).assert_not_called()


if __name__ == '__main__':
    unittest.main()
