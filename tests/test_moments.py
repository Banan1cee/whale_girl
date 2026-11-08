"""仅用假数据库/HTTP，不访问真实微信或朋友圈。"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from moments import collect, MomentsReader
from moments_actions import perform


class MomentsTest(unittest.TestCase):
    def test_interaction_checks_target_before_writing(self):
        moment = Mock()
        moment.find_moment.return_value = SimpleNamespace(nickname='Other', content='spring', _ensure_parsed=lambda: None)
        self.assertEqual(perform(moment, 'comment',
                                 {'publisher': 'Peer', 'keyword': 'spring', 'content': 'hello'}),
                         'target_mismatch')
        moment.Comment.assert_not_called()

    def test_like_cancel_and_comment_single_attempt(self):
        moment = Mock()
        moment.find_moment.return_value = SimpleNamespace(nickname='Peer', content='spring', _ensure_parsed=lambda: None)
        moment.Like.return_value = True
        moment.Comment.return_value = True
        query = {'publisher': 'Peer', 'keyword': 'spring', 'content': 'hello'}
        self.assertIs(perform(moment, 'unlike', query), True)
        moment.Like.assert_called_once_with(moment.find_moment.return_value, cancel=True, max_retry=1)
        self.assertIs(perform(moment, 'comment', query), True)
        moment.Comment.assert_called_once_with(moment.find_moment.return_value, 'hello', max_retry=1)

    def test_unlike_does_not_fall_back_to_like(self):
        moment = Mock()
        moment.find_moment.return_value = SimpleNamespace(nickname='Peer', content='spring', _ensure_parsed=lambda: None)
        moment.Like.return_value = None
        self.assertEqual(perform(moment, 'unlike', {'publisher': 'Peer', 'keyword': 'spring'}),
                         'cancel_not_found')

    def test_bounded_read_and_own_account(self):
        reader = Mock()
        reader.get_moments.return_value = [{'tid': 123, 'text': '测试', 'images': [1], 'location': 'private'}]
        db = SimpleNamespace(wxid='test-account')
        factory = Mock(return_value=reader)
        items = collect(db, {'limit': 2, 'keyword': '测试', 'own': True, 'username': 'other'}, factory)
        factory.assert_called_once_with(db)
        reader.get_moments.assert_called_once_with(limit=2, keyword='测试', username='test-account')
        self.assertEqual(items[0]['id'], '123')
        self.assertEqual(items[0]['imageCount'], 1)
        self.assertNotIn('location', items[0])

    def test_reject_unbounded_scan(self):
        factory = Mock()
        for limit in (0, 51, True, -1, '20'):
            with self.assertRaises(ValueError):
                collect(SimpleNamespace(wxid='test'), {'limit': limit}, factory)
        factory.assert_not_called()

    def test_no_task_no_database_read(self):
        http, factory = Mock(), Mock()
        http.post.return_value = SimpleNamespace(status_code=200, json=lambda: {'job': None})
        MomentsReader(SimpleNamespace(wxid='test'), http, '', {}, Mock(), factory).tick()
        factory.assert_not_called()
        self.assertEqual(http.post.call_count, 1)

    def test_error_is_safe_and_not_retried(self):
        http, factory, log = Mock(), Mock(side_effect=RuntimeError('private text')), Mock()
        http.post.return_value = SimpleNamespace(status_code=200, json=lambda: {'job': {'id': 'j', 'query': {}}})
        MomentsReader(SimpleNamespace(wxid='test'), http, '', {}, log, factory).tick()
        payload = http.post.call_args.kwargs['json']
        self.assertEqual(payload['error'], 'read_failed')
        self.assertNotIn('private', str(log.call_args))
        self.assertEqual(factory.call_count, 1)

    def test_claim_uses_account_directory_for_binding(self):
        http = Mock()
        http.post.return_value = SimpleNamespace(status_code=200, json=lambda: {'job': None})
        db = SimpleNamespace(account='account-dir', wxid='wxid-1')
        MomentsReader(db, http, '', {}, Mock(), Mock()).tick()
        self.assertEqual(http.post.call_args.kwargs['json']['account'], 'account-dir')

    def test_claim_http_error_is_logged_without_reading(self):
        http, factory, log = Mock(), Mock(), Mock()
        http.post.return_value = SimpleNamespace(status_code=403)
        reader = MomentsReader(SimpleNamespace(wxid='test'), http, '', {}, log, factory)
        reader.tick()
        reader.tick()
        factory.assert_not_called()
        self.assertEqual(log.call_count, 1)
        self.assertIn('403', str(log.call_args))

    def test_complete_http_error_is_logged(self):
        http, factory, log = Mock(), Mock(), Mock()
        factory.return_value.get_moments.return_value = []
        http.post.side_effect = [
            SimpleNamespace(status_code=200, json=lambda: {'job': {'id': 'j', 'action': 'read', 'query': {}}}),
            SimpleNamespace(status_code=409),
        ]
        MomentsReader(SimpleNamespace(wxid='test'), http, '', {}, log, factory).tick()
        self.assertIn('409', str(log.call_args))

    def test_interaction_failure_uses_action_code(self):
        http, factory, log = Mock(), Mock(), Mock()
        http.post.return_value = SimpleNamespace(
            status_code=200, json=lambda: {'job': {'id': 'j', 'action': 'like', 'query': {}}})
        interact = Mock(side_effect=RuntimeError('private text'))
        MomentsReader(SimpleNamespace(wxid='test'), http, '', {}, log, factory, interact=interact).tick()
        payload = http.post.call_args.kwargs['json']
        self.assertEqual(payload['error'], 'interaction_failed')
        self.assertNotIn('performed', payload)
        self.assertIn('互动', str(log.call_args))
        self.assertNotIn('private', str(log.call_args))


if __name__ == '__main__':
    unittest.main()
