"""Group UI targets must come from the group's own contact, never a member."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from bridge_ast import load_function
from test_care_target_name import env_with


class GroupSendResolutionTests(unittest.TestCase):
    def environment(self, contact_name='', group_name=''):
        env = env_with()
        env.update(db=SimpleNamespace(get_nickname=Mock(return_value=contact_name),
                                      group_id_to_name=Mock(return_value=group_name),
                                      get_group_members=Mock(return_value=[])),
                   name_cache={}, alias_cache={}, sessions={}, me='self-test')
        load_function('display_name', env)
        load_function('aliases_for', env)
        return env

    def test_group_with_only_local_remark_is_a_searchable_target(self):
        env = self.environment(contact_name='本地群备注', group_name='12345@chatroom')
        self.assertEqual(env['ui_chat_name']('12345@chatroom', '12345@chatroom'), '本地群备注')
        self.assertIn('本地群备注', env['aliases_for']('12345@chatroom', '本地群备注'))
        env['db'].get_nickname.assert_called_with('12345@chatroom')

    def test_last_group_sender_is_never_used_as_group_title(self):
        env = self.environment()
        env['sessions']['12345@chatroom'] = {'last_sender': '某位群友'}
        self.assertEqual(env['ui_chat_name']('12345@chatroom', ''), '')
        self.assertNotIn('12345@chatroom', env['name_cache'])

    def test_empty_alias_lookup_is_retried_when_contact_snapshot_catches_up(self):
        env = self.environment()
        self.assertEqual(env['aliases_for']('12345@chatroom'), [])
        env['db'].group_id_to_name.return_value = '后来读取到的群名'
        self.assertEqual(env['aliases_for']('12345@chatroom'), ['后来读取到的群名'])

    def test_unavailable_contact_api_can_use_exact_group_name(self):
        env = self.environment(group_name='测试群')
        env['db'].get_nickname.side_effect = RuntimeError('mock contact snapshot unavailable')
        self.assertEqual(env['ui_chat_name']('12345@chatroom'), '测试群')

    def test_internal_id_is_never_cached_as_a_group_name(self):
        env = self.environment(contact_name='12345@chatroom', group_name='12345@chatroom')
        self.assertEqual(env['ui_chat_name']('12345@chatroom'), '')
        self.assertEqual(env['name_cache'], {})


if __name__ == '__main__':
    unittest.main()
