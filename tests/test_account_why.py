# -*- coding: utf-8 -*-
"""「账号未确认」必须说清是哪个号没登录。

现场（4.0.8）：用户配的是鲸鲸，微信里登录的却是另一个号，另一个窗口停在登录页。
桥接只回一句「账号未确认 / 请打开已选账号的主窗口」，用户点窗口、刷新都没用。
这里锁住三件事：
  1. 选中的号没登录时，原因里要同时出现「选中的号」和「实际登录的号」；
  2. 一个号都没登录时，要提示先登录微信；
  3. 选中的号确实登录着的，保留原来的原因，不要乱改。
"""
import json
import os
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'bridge'))

# account_mixin 顶部是 `import engine as G`；engine 会拉起整条运行时（requests / win32），
# 单元测试只需要 G.os / G.json / G.ROOT，所以先塞一个最小替身。
#
# 用完必须把 sys.modules['engine'] 还原：unittest discover 是同一个进程跑完所有
# test_*.py，替身留在全局会污染后面的 bridge_ast（它 import engine 拿真实模块，
# 拿到替身就会报 `module 'engine' has no attribute ...`）。
_prev_engine = sys.modules.get('engine')
if _prev_engine is None:
    _stub = types.ModuleType('engine')
    _stub.os = os
    _stub.json = json
    _stub.ROOT = ROOT
    sys.modules['engine'] = _stub

import account_mixin  # noqa: E402

if _prev_engine is None:
    sys.modules.pop('engine', None)
else:
    sys.modules['engine'] = _prev_engine


class _FakeDB:
    def __init__(self, account):
        self.account = account


class _FakeBot(account_mixin.AccountMixin):
    """只替换掉需要碰进程/文件的两个取值口，其余走真实实现。"""

    def __init__(self, selected, logged, labels=None):
        self.db = _FakeDB(selected)
        self.logged = set(logged)
        self.labels = dict(labels or {})

    def _logged_in_account_dirs(self):
        return set(self.logged)

    def _account_label(self, account):
        return self.labels.get(account, account)


class ExplainUnverifiedTest(unittest.TestCase):
    def test_selected_account_not_logged_in_names_both_sides(self):
        bot = _FakeBot(
            'wxid_aaa_111',
            ['wxid_bbb_222'],
            {
                'wxid_aaa_111': '鲸鲸(wxid_aaa)',
                'wxid_bbb_222': '另一个人(wxid_bbb)',
            },
        )
        why = bot._explain_unverified('每个微信窗口都读不到会话列表')
        self.assertIn('鲸鲸', why)
        self.assertIn('另一个人', why)
        self.assertIn('没登录', why)
        self.assertNotIn('读不到会话列表', why, '不要把内部原因原样丢给用户')

    def test_no_account_logged_in(self):
        bot = _FakeBot('wxid_aaa_111', [])
        why = bot._explain_unverified('没扫到微信主窗')
        self.assertIn('没登录', why)
        self.assertIn('没扫到其它已登录', why)

    def test_selected_account_logged_in_keeps_original_reason(self):
        bot = _FakeBot('wxid_aaa_111', ['wxid_aaa_111'])
        self.assertEqual(
            bot._explain_unverified('每个微信窗口都读不到会话列表'),
            '每个微信窗口都读不到会话列表',
        )

    def test_without_selected_account_keeps_original_reason(self):
        bot = _FakeBot('', ['wxid_aaa_111'])
        self.assertEqual(bot._explain_unverified('没扫到微信主窗'), '没扫到微信主窗')


class AccountLabelTest(unittest.TestCase):
    def test_label_uses_nick_from_accounts_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, 'data'))
            with open(os.path.join(tmp, 'data', 'accounts.json'), 'w', encoding='utf-8') as f:
                json.dump({'accounts': [{'account': 'wxid_aaa_111', 'nick': '鲸鲸'}]}, f)
            old = account_mixin.G.ROOT
            account_mixin.G.ROOT = tmp
            try:
                self.assertEqual(
                    account_mixin.AccountMixin()._account_label('wxid_aaa_111'),
                    '鲸鲸(wxid_aaa)',
                )
            finally:
                account_mixin.G.ROOT = old

    def test_label_falls_back_to_wxid(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = account_mixin.G.ROOT
            account_mixin.G.ROOT = tmp  # 没有 accounts.json
            try:
                self.assertEqual(
                    account_mixin.AccountMixin()._account_label('wxid_aaa_111'),
                    'wxid_aaa',
                )
            finally:
                account_mixin.G.ROOT = old


if __name__ == '__main__':
    unittest.main()
