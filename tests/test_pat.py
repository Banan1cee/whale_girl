# -*- coding: utf-8 -*-
"""拍一拍解析单元测试：不需要微信、不需要桥接运行时。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import pat as pat_core  # noqa: E402
parse_pat = pat_core.parse_pat
targets_self = pat_core.targets_self
looks_like_pat = pat_core.looks_like_pat


class ParsePatTest(unittest.TestCase):
    def test_plain_title(self):
        pat = parse_pat('"初一" 拍了拍 "鲸鲸"')
        self.assertEqual(pat['source'], '初一')
        self.assertEqual(pat['target'], '鲸鲸')
        self.assertEqual(pat['suffix'], '')

    def test_custom_suffix_stripped(self):
        pat = parse_pat('"秧秧" 拍了拍 "挽霜" 的棺材说挤一挤')
        self.assertEqual(pat['target'], '挽霜')
        self.assertEqual(pat['suffix'], '的棺材说挤一挤')

    def test_me_target(self):
        pat = parse_pat('"测试好友" 拍了拍我')
        self.assertEqual(pat['target'], '我')
        self.assertTrue(targets_self(pat, ['鲸鲸']))


class TargetsSelfTest(unittest.TestCase):
    def test_alias(self):
        self.assertTrue(targets_self({'target': '小鲸娘'}, ['鲸鲸', '小鲸娘']))
        self.assertFalse(targets_self({'target': '初七'}, ['鲸鲸', '小鲸娘']))

    def test_xml(self):
        pat = parse_pat('<msg><appmsg><title>"A" 拍了拍 "鲸鲸"</title></appmsg></msg>')
        self.assertEqual(pat['target'], '鲸鲸')

    def test_not_pat(self):
        self.assertIsNone(parse_pat('普通消息'))
        self.assertIsNone(parse_pat(''))
        # 普通聊天里说「拍了拍」不能被当成动作吞掉
        self.assertFalse(looks_like_pat('文本', '我今天拍了拍他的头'))
        self.assertFalse(looks_like_pat('文本', '拍了拍你'))
        self.assertTrue(looks_like_pat('系统消息', '"A" 拍了拍 "鲸鲸"'))
        self.assertTrue(looks_like_pat('文本', '"A" 拍了拍 "鲸鲸"'))
        self.assertTrue(looks_like_pat('文件/链接/卡片', '<msg><appmsg><title>"A" 拍了拍 "鲸鲸"</title></appmsg></msg>'))


if __name__ == '__main__':
    unittest.main()
