import importlib
import unittest
from test_refactor_t14_attempts import SafeFixture, load


class IdentityTests(SafeFixture):
    def background(self, current, aliases):
        scope = {}
        for name in ('_tokens', 'name_score', '_chat_is_target'):
            load('bridge/bg_sender.py', name, scope)
        return scope['_chat_is_target'](current, aliases)[0]

    def test_member_substrings_never_authorize_a_target(self):
        current, aliases = 'fixture-a、fixture-b', ['fixture-a2、fixture-b2']
        self.assertIsNone(self.state._chat_identity_level(current, aliases))
        self.assertFalse(self.background(current, aliases))

    def test_duplicate_members_cannot_match_a_different_member_set(self):
        current, aliases = 'fixture-a、fixture-a', ['fixture-a、fixture-b']
        self.assertIsNone(self.state._chat_identity_level(current, aliases))
        self.assertFalse(self.background(current, aliases))

    def test_exact_titles_and_reordered_exact_members_keep_existing_capability(self):
        for current, aliases, expected in (('fixture-room', ['fixture-room'], 0),
            ('fixture-a、fixture-b', ['fixture-b、fixture-a'], 1), ('A B', ['A B'], 0)):
            self.assertEqual(self.state._chat_identity_level(current, aliases), expected)
            self.assertTrue(self.background(current, aliases))

    def test_subset_unknown_and_similar_titles_fail_closed(self):
        for current, aliases in (('', ['room']), ('room', []), ('room', ['room2']),
                                 ('fixture-a、fixture-b', ['fixture-a、fixture-b、fixture-c']), ('A B', ['AB'])):
            self.assertIsNone(self.state._chat_identity_level(current, aliases))
            self.assertFalse(self.background(current, aliases))

    def test_search_score_does_not_authorize_send_and_sticker_stays_stricter(self):
        scope = {}
        load('bridge/bg_sender.py', '_tokens', scope)
        score = load('bridge/bg_sender.py', 'name_score', scope)
        self.assertEqual(score('room', 'room2'), 2)
        self.assertFalse(self.background('room2', ['room']))
        exact = load('bridge/sticker_transport.py', '_alias_match', {})
        self.assertFalse(exact('fixture-a、fixture-b', ['fixture-b、fixture-a']))
        self.assertFalse(exact('A B', ['AB']))

    def test_blank_input_semantics_preserve_unknown_and_attachment(self):
        bg = load('bridge/bg_sender.py', '_is_blank', {})
        sticker = load('bridge/sticker_transport.py', '_is_blank', {})
        for value, expected in ((None, False), (0, False), (False, False), ('', True),
                                ('\n \r\n', True), ('\ufffc', False), ('\u200b', False)):
            self.assertIs(bg(value), expected)
            self.assertIs(sticker(value), expected)


if __name__ == '__main__':
    unittest.main()
