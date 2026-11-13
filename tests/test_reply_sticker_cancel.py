"""Execute actual reply delivery branches with fake HTTP and no WeChat/UI."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from bridge_ast import init, load_function

ROOT = Path(__file__).resolve().parents[1]


class ReplyStickerCancelTests(unittest.TestCase):
    def setUp(self):
        self.item = {'id': 'reply-job', 'generation': 'generation-one', 'chatUsername': 'peer-test'}
        self.http = Mock(return_value=SimpleNamespace(status_code=200, json=lambda: {
            'ok': True, 'item': {**self.item, 'status': 'cancelled'}}))
        self.env = dict(sticker_config_now=Mock(return_value={}),
                        LOCAL_HTTP=SimpleNamespace(post=self.http),
                        sticker_base='http://test.invalid', sticker_headers={'x-bot-token': 'test-only'},
                        log=Mock(), QUOTE_REPLY=False, time=SimpleNamespace(sleep=Mock()),
                        data={'sticker': self.item}, username='peer-test', target='测试会话',
                        first=True, mention=None, is_group=False,
                        bubbles=['first', 'second'], send_text=Mock(return_value=False))
        init(self.env)
        load_function('cancel_reply_sticker', self.env)

    def run_branch(self, kind):
        source = ROOT / 'bridge' / 'receiver_mixin.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        if kind == 'text':
            node = next(n for n in ast.walk(tree) if isinstance(n, ast.For)
                        and isinstance(n.iter, ast.Name) and n.iter.id == 'bubbles')
        else:
            node = next(n for n in ast.walk(tree) if isinstance(n, ast.If)
                        and isinstance(n.test, ast.Call) and isinstance(n.test.func, ast.Attribute)
                        and n.test.func.attr == 'send_voice_reply')
        wrapper = ast.parse('def deliver():\n    pass\n').body[0]
        first = next(n for n in ast.walk(tree) if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == 'first' for t in n.targets)
                     and isinstance(n.value, ast.Constant) and n.value.value is True)
        wrapper.body = [first, node]
        module = ast.fix_missing_locations(ast.Module(body=[wrapper], type_ignores=[]))
        exec(compile(module, str(source), 'exec'), self.env)
        self.env['deliver']()

    def test_text_failure_cancels_reserved_job_and_stops_remaining_bubbles(self):
        self.run_branch('text')
        self.env['send_text'].assert_called_once()
        self.http.assert_called_once_with('http://test.invalid/api/stickers/cancel',
            json={'id': 'reply-job', 'generation': 'generation-one', 'chatUsername': 'peer-test'},
            headers=self.env['sticker_headers'], timeout=3)

    def test_voice_handled_reply_also_releases_unused_sticker(self):
        self.env.update(send_voice_reply=Mock(return_value=True), spoken='test voice')
        self.run_branch('voice')
        self.http.assert_called_once()
        self.env['send_text'].assert_not_called()

    def test_failure_after_one_bubble_cancels_sticker_and_stops_later_text(self):
        self.env['bubbles'] = ['first', 'second', 'third']
        self.env['send_text'].side_effect = [True, False]
        self.run_branch('text')
        self.assertEqual(self.env['send_text'].call_count, 2)
        self.http.assert_called_once()

    def test_unrelated_cancellation_response_is_not_reported_as_success(self):
        self.http.return_value = SimpleNamespace(status_code=200, json=lambda: {
            'ok': True, 'item': {**self.item, 'id': 'other-job', 'status': 'cancelled'}})
        self.assertFalse(self.env['cancel_reply_sticker'](self.item, 'peer-test'))

    def test_cancellation_of_claimed_job_is_not_retried_or_sent(self):
        self.http.return_value = SimpleNamespace(status_code=409)
        self.run_branch('text')
        self.http.assert_called_once()

    def test_disabled_or_wrong_chat_never_requests_cancellation(self):
        self.assertFalse(self.env['cancel_reply_sticker'](self.item, 'another-peer'))
        self.env['sticker_config_now'].return_value = None
        self.assertFalse(self.env['cancel_reply_sticker'](self.item, 'peer-test'))
        self.http.assert_not_called()

    def test_text_failure_without_sticker_never_calls_sticker_api(self):
        self.env['data'] = {}
        self.run_branch('text')
        self.http.assert_not_called()


if __name__ == '__main__':
    unittest.main()
