# -*- coding: utf-8 -*-
"""接收侧引用回复：把微信的 refermsg XML 拆成能进提示词的正文。

现场：微信 4.x 的「引用一条消息再回复」是 appmsg（57<<32|49，类型名落到
「文件/链接/卡片」），正文里没有 <url>，原来的分支直接 return，机器人像
压根没收到这条消息。这里守住解析本身，不碰真实微信。
"""
import html
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bridge_ast import init, load_function  # noqa: E402


def quote_env():
    env = {'re': re, 'html': html}
    init(env)
    for name in ('_nested_quote_text', 'parse_quote_content', 'quote_content_text'):
        load_function(name, env)
    return env


class ParseQuoteContentTests(unittest.TestCase):
    def setUp(self):
        self.env = quote_env()

    def parse(self, content):
        return self.env['parse_quote_content'](content)

    def text(self, content):
        return self.env['quote_content_text'](content)

    def test_wechat4_reply_uses_title_for_new_text(self):
        content = (
            '<msg><appmsg appid="" sdkver="0"><title>你怎么不回我</title>'
            '<des></des><type>57</type>'
            '<refermsg><type>1</type><svrid>123</svrid><fromusr>wxid_a</fromusr>'
            '<chatusr>wxid_b</chatusr><displayname>鲸鲸</displayname>'
            '<content>晚安啦</content><msgid>999</msgid></refermsg></appmsg></msg>'
        )
        self.assertEqual(self.parse(content), ('鲸鲸', '晚安啦', '你怎么不回我'))
        self.assertEqual(self.text(content), '（引用鲸鲸「晚安啦」）你怎么不回我')

    def test_old_format_takes_text_after_last_msg_tag(self):
        content = (
            '<msg><appmsg><type>57</type><refermsg><displayname>阿明</displayname>'
            '<content>今天吃啥</content></refermsg></appmsg></msg>那就吃面'
        )
        self.assertEqual(self.parse(content), ('阿明', '今天吃啥', '那就吃面'))
        self.assertEqual(self.text(content), '（引用阿明「今天吃啥」）那就吃面')

    def test_nested_quote_is_unwrapped_to_plain_text(self):
        inner = ('&lt;msg&gt;&lt;appmsg&gt;&lt;title&gt;外面下雨&lt;/title&gt;'
                 '&lt;refermsg&gt;&lt;displayname&gt;小李&lt;/displayname&gt;'
                 '&lt;content&gt;带伞&lt;/content&gt;&lt;/refermsg&gt;'
                 '&lt;/appmsg&gt;&lt;/msg&gt;')
        content = ('<msg><appmsg><title>收到</title><refermsg>'
                   '<displayname>阿明</displayname><content>%s</content>'
                   '</refermsg></appmsg></msg>' % inner)
        self.assertEqual(self.parse(content), ('阿明', '带伞', '收到'))
        self.assertEqual(self.text(content), '（引用阿明「带伞」）收到')

    def test_reply_without_quoted_text_still_reaches_the_model(self):
        content = ('<msg><appmsg><title>在吗</title><refermsg>'
                   '<displayname>鲸鲸</displayname><content></content>'
                   '</refermsg></appmsg></msg>')
        self.assertEqual(self.parse(content), ('鲸鲸', '', '在吗'))
        self.assertEqual(self.text(content), '在吗')

    def test_quote_without_new_text_keeps_the_quoted_line_only(self):
        content = ('<msg><appmsg><title></title><refermsg>'
                   '<displayname>鲸鲸</displayname><content>早点睡</content>'
                   '</refermsg></appmsg></msg>')
        self.assertEqual(self.text(content), '（引用鲸鲸「早点睡」）')

    def test_html_entities_are_unescaped(self):
        content = ('<msg><appmsg><title>a&amp;b</title><refermsg>'
                   '<displayname>鲸鲸</displayname><content>1 &lt; 2</content>'
                   '</refermsg></appmsg></msg>')
        self.assertEqual(self.text(content), '（引用鲸鲸「1 < 2」）a&b')

    def test_non_quote_messages_are_left_alone(self):
        self.assertIsNone(self.parse('<msg><appmsg><title>链接</title>'
                                     '<url>https://example.com</url></appmsg></msg>'))
        self.assertIsNone(self.text('普通文本'))

    def test_quote_with_nothing_usable_reports_empty(self):
        # 调用方看到空串就不回话，不能把原始 XML 塞进提示词
        self.assertEqual(self.text('<msg><refermsg></refermsg></msg>'), '')


if __name__ == '__main__':
    unittest.main()
