# -*- coding: utf-8 -*-
"""群聊 @ 判定：账号昵称/别名/边界/结构化 atuserlist 的离线回归。"""
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bridge import mention
from bridge import mention_meta


class MentionNamesTests(unittest.TestCase):
    def test_build_names_merges_and_excludes_broadcast(self):
        names = mention.build_names(
            '鲸鲸', ['糯糯', '鲸鲸'], '许愿', '', ['许愿', '所有人'], ['wxid_self'])
        self.assertEqual(names[0], 'wxid_self')      # 最长的在前
        self.assertIn('许愿', names)
        self.assertIn('鲸鲸', names)
        self.assertNotIn('所有人', names)
        self.assertEqual(len(names), len(set(names)))

    def test_account_nickname_is_addressed_with_wechat_separator(self):
        result = mention.analyze('wxid_friend:\n@许愿\u2005你为什么总跳过我们说话',
                                 ['鲸鲸', '许愿'])
        self.assertTrue(result['addressed'])
        self.assertFalse(result['bare_self'])
        self.assertEqual(result['mentioned_names'], [])

    def test_alias_prefix_does_not_match_group_name(self):
        result = mention.analyze('@许愿Ai-1号实验室 在吗', ['许愿'])
        self.assertFalse(result['addressed'])

    def test_at_all_is_not_her_and_not_another_person(self):
        result = mention.analyze('@所有人\u2005开会了', ['鲸鲸', '许愿'])
        self.assertFalse(result['addressed'])
        self.assertEqual(result['mentioned_names'], [])

    def test_bare_mention_of_self_is_detected(self):
        result = mention.analyze('@许愿\u2005', ['鲸鲸', '许愿'])
        self.assertTrue(result['addressed'])
        self.assertTrue(result['bare_self'])
        self.assertTrue(result['bare_any'])

    def test_mention_with_space_in_nickname_uses_separator(self):
        result = mention.analyze('@许愿 的小号\u2005 在吗', ['许愿 的小号'])
        self.assertTrue(result['addressed'])

    def test_other_mentions_are_listed_and_self_is_excluded(self):
        result = mention.analyze('@许愿\u2005@张三\u2005你俩说说', ['许愿'])
        self.assertTrue(result['addressed'])
        self.assertIn('张三', result['mentioned_names'])
        self.assertNotIn('许愿', result['mentioned_names'])
        self.assertFalse(result['bare_self'])

    def test_short_alias_substring_does_not_count_as_previous_question(self):
        self.assertFalse(mention.contains_name('今天买了一条金鱼', ['鱼']))
        self.assertTrue(mention.contains_name('鲸鲸在吗', ['鲸鲸']))


class MentionMetaTests(unittest.TestCase):
    def test_atuserlist_is_parsed(self):
        source = ('<msgsource><atuserlist><![CDATA[wxid_a,wxid_b]]></atuserlist>'
                  '</msgsource>')
        self.assertEqual(mention_meta.at_usernames(source), ['wxid_a', 'wxid_b'])

    def test_structured_metadata_wins_by_wxid(self):
        row = {
            'local_id': 7, 'shard': 'message_0.db', 'source':
            '<msgsource><atuserlist>wxid_self,wxid_other</atuserlist></msgsource>',
        }
        db = SimpleNamespace(
            _run_msg_query=lambda _chat, build: build([]),
            _shard_rows=lambda _tables, _sql, _params, per_shard_limit=None: [row],
        )
        self.assertTrue(mention_meta.self_mentioned(
            db, 'room@chatroom', {'local_id': 7, 'shard': 'message_0.db'},
            {'wxid_self'}))
        self.assertFalse(mention_meta.self_mentioned(
            db, 'room@chatroom', {'local_id': 7, 'shard': 'message_0.db'},
            {'wxid_other2'}))

    def test_no_atuserlist_returns_none_for_text_fallback(self):
        row = {'local_id': 7, 'shard': 'message_0.db', 'source': '<msgsource/>'}
        db = SimpleNamespace(
            _run_msg_query=lambda _chat, build: build([]),
            _shard_rows=lambda *_a, **_k: [row],
        )
        self.assertIsNone(mention_meta.self_mentioned(
            db, 'room@chatroom', {'local_id': 7}, {'wxid_self'}))


if __name__ == '__main__':
    unittest.main()
