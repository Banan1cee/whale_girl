"""后台通道的页面归位：停在通讯录/收藏/发现/朋友圈时也要能点回聊天页。"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import bg_sender  # noqa: E402


def _tab(name, left=10, top=100):
    return SimpleNamespace(
        Name=name,
        ClassName='mmui::XTabBarItem',
        BoundingRectangle=SimpleNamespace(left=left, top=top, right=left + 40, bottom=top + 40),
    )


def _info(**kw):
    base = {'rows': [], 'edit': None, 'tabs': [], 'chat': None}
    base.update(kw)
    return base


class ChatTabTest(unittest.TestCase):
    def test_picks_wechat_tab_not_first(self):
        chat = _tab('微信')
        other = _tab('通讯录', left=100)
        self.assertIs(bg_sender._chat_tab_target(_info(tabs=[('通讯录', other), ('微信', chat)])), chat)

    def test_falls_back_to_first_tab(self):
        first = _tab('通讯录')
        self.assertIs(bg_sender._chat_tab_target(_info(tabs=[('通讯录', first)])), first)

    def test_no_tabs(self):
        self.assertIsNone(bg_sender._chat_tab_target(_info()))


class EnsureChatPageTest(unittest.TestCase):
    def setUp(self):
        self.clicked = []
        self.sender = SimpleNamespace(
            hwnd=1,
            click_screen=lambda x, y: self.clicked.append((x, y)),
        )

    def test_clicks_chat_tab_then_reads_session_list(self):
        chat = _tab('微信')
        before = _info(tabs=[('微信', chat)])
        after = _info(rows=[('Peer', object())], tabs=[('微信', chat)])
        with patch.object(bg_sender, 'read_ui', side_effect=[after]), \
                patch.object(bg_sender.time, 'sleep'):
            out = bg_sender._ensure_chat_page(self.sender, before, timeout=0)
        self.assertEqual(self.clicked, [(30, 120)])
        self.assertEqual(out['rows'][0][0], 'Peer')

    def test_no_tab_does_not_click(self):
        with patch.object(bg_sender, 'read_ui') as read:
            out = bg_sender._ensure_chat_page(self.sender, _info(), timeout=0)
        self.assertEqual(out['rows'], [])
        self.assertEqual(self.clicked, [])
        read.assert_not_called()

    def test_already_on_chat_page_does_not_click(self):
        info = _info(rows=[('Peer', object())], tabs=[('微信', _tab('微信'))])
        with patch.object(bg_sender, 'read_ui') as read:
            out = bg_sender._ensure_chat_page(self.sender, info)
        self.assertIs(out, info)
        self.assertEqual(self.clicked, [])
        read.assert_not_called()

    def test_force_exits_open_chat_to_reveal_list(self):
        chat = _tab('微信')
        before = _info(edit=object(), chat='Other', tabs=[('微信', chat)])
        after = _info(rows=[('Peer', object())], tabs=[('微信', chat)])
        with patch.object(bg_sender, 'read_ui', side_effect=[after]), \
                patch.object(bg_sender.time, 'sleep'):
            out = bg_sender._ensure_chat_page(self.sender, before, timeout=0, force=True)
        self.assertEqual(self.clicked, [(30, 120)])
        self.assertEqual(out['rows'][0][0], 'Peer')


if __name__ == '__main__':
    unittest.main()
