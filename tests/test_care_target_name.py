# -*- coding: utf-8 -*-
"""主动搭话的目标名解析：绝不能把 wxid 当会话名去搜。

现场（2026-11-08 21:35，data/bridge-hang.log）：
白名单里填的是账号目录名（wxid_xxx_c248），联系人缓存里没有这条，
服务端只能把 wxid 当名字给桥接；桥接拿 wxid 去开会话，
uia_compat 先翻会话列表、再搜搜索框，一轮十几秒，连试两轮，
发送锁一直占着，日志里就是「会话列表里没有 'wxid_...'，回退搜索框」刷屏。
"""
import ast
import re
import unittest

from bridge_ast import find_assignment, load_function


def env_with(names=None, me='wxid_self_test'):
    names = names or {}
    env = {
        're': re,
        'me': me,
        'display_name': lambda username: names.get(username, username),
    }
    # 单函数抽取不会带上模块级常量，这里按名字把正则也取过来。
    for const in ('_RAW_CHAT_ID_RE', '_ACCOUNT_HASH_RE'):
        path, node = find_assignment(const)
        env[const] = eval(compile(ast.Expression(node), path, 'eval'), env)
    env['is_raw_chat_id'] = load_function('is_raw_chat_id', env)
    env['same_account'] = load_function('same_account', env)
    env['ui_chat_name'] = load_function('ui_chat_name', env)
    env['is_self_chat'] = load_function('is_self_chat', env)
    return env


class RawChatId(unittest.TestCase):
    def test_recognizes_internal_ids(self):
        env = env_with()
        raw = env['is_raw_chat_id']
        self.assertTrue(raw('wxid_master_test'))
        self.assertTrue(raw('12345@chatroom'))
        self.assertFalse(raw('星野'))
        self.assertFalse(raw('filehelper'))
        self.assertFalse(raw(''))

    def test_ui_chat_name_prefers_nickname_over_wxid(self):
        env = env_with({'wxid_master_test': '星野'})
        self.assertEqual(env['ui_chat_name']('wxid_master_test', 'wxid_master_test'), '星野')
        self.assertEqual(env['ui_chat_name']('wxid_master_test', ''), '星野')
        self.assertEqual(env['ui_chat_name']('wxid_master_test', '小星'), '小星')

    def test_ui_chat_name_refuses_to_return_ids(self):
        env = env_with()          # display_name 读不到昵称时会退回 wxid
        self.assertEqual(env['ui_chat_name']('wxid_master_test', 'wxid_master_test'), '')
        self.assertEqual(env['ui_chat_name']('12345@chatroom', ''), '')

    def test_filehelper_maps_to_searchable_name(self):
        env = env_with()
        self.assertEqual(env['ui_chat_name']('filehelper', ''), '文件传输助手')

    def test_self_chat_accepts_account_dir_hash(self):
        env = env_with(me='wxid_master_test')
        self.assertTrue(env['is_self_chat']('wxid_master_test_c248'))
        self.assertTrue(env['is_self_chat']('wxid_master_test'))
        self.assertFalse(env['is_self_chat']('wxid_other_test'))
        self.assertFalse(env['is_self_chat'](''))


if __name__ == '__main__':
    unittest.main()

