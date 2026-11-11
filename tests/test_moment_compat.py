"""朋友圈兼容层测试：补丁必须在 bridge/moment_compat.py，而不是改 vendor。"""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
# 这个测试直接从 vendor 导入，禁止生成 __pycache__（vendor 必须保持上游原样）
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'vendor'))
sys.path.insert(0, str(ROOT / 'bridge'))

AVAILABLE = True
SKIP_REASON = ''
try:
    import moment_compat
    moment_compat.install()
    from wechatauto.moment import Moment, MomentActionMenu, MomentDB
    from wechatauto.param import WxResponse
except Exception as exc:  # CI 的纯 Python 环境可能没装 pywin32
    AVAILABLE = False
    SKIP_REASON = 'wechatauto runtime unavailable: %s' % exc


@unittest.skipUnless(AVAILABLE, SKIP_REASON)
class MomentCompatTest(unittest.TestCase):
    def test_publisher_and_keyword_must_both_match(self):
        posts = [
            {'nickname': 'Peer', 'text': 'winter'},
            {'nickname': 'Peer', 'text': 'spring'},
            {'nickname': 'Other', 'text': 'spring'},
        ]
        self.assertEqual(Moment._target_idx(None, posts, 'Peer', 'spring'), 1)
        self.assertEqual(Moment._target_idx(None, posts, 'Peer', 'winter'), 0)
        self.assertIsNone(Moment._target_idx(None, posts, 'Nobody', 'spring'))

        item = SimpleNamespace(
            publisher='Peer', text='spring',
            control=SimpleNamespace(Name='Peer spring'),
        )
        self.assertTrue(Moment._matches(None, item, 'Peer', 'spring'))
        self.assertFalse(Moment._matches(None, item, 'Peer', 'winter'))
        self.assertFalse(Moment._matches(None, item, None, None))

    def test_cancel_like_only_looks_for_cancel(self):
        menu = object.__new__(MomentActionMenu)
        menu._find_button = Mock(return_value=None)
        with patch('wechatauto.rhythm.gate'):
            result = MomentActionMenu.like(menu, True)
        self.assertIsInstance(result, WxResponse)
        menu._find_button.assert_called_once()
        self.assertEqual(menu._find_button.call_args.args[0], ['取消'])

    def test_like_fails_instead_of_right_clicking(self):
        moment = object.__new__(Moment)
        item = SimpleNamespace(control=Mock())
        with patch.object(Moment, '_locate_more_click', return_value=False):
            result = Moment.Like(moment, item, max_retry=1)
        self.assertIsInstance(result, WxResponse)
        self.assertFalse(result)
        item.control.RightClick.assert_not_called()
        item.control.Click.assert_not_called()

    def test_parse_feed_uses_database_tid(self):
        db = object.__new__(MomentDB)
        feed = MomentDB.parse_feed(db, '<id>42</id><username>wxid_peer</username>', 'wxid_fallback', 99)
        self.assertEqual(feed['id'], '42')
        self.assertEqual(feed['tid'], 99)

    def test_get_moments_passes_database_tid(self):
        class Conn:
            def execute(self, _sql, _params=()):
                return self
            def fetchall(self):
                return [{'tid': 99, 'user_name': 'wxid_peer',
                         'content': '<id>42</id><username>wxid_peer</username>'}]
            def close(self):
                pass

        db = object.__new__(MomentDB)
        db.db = SimpleNamespace(get_nickname=lambda _u: 'Peer')
        db._open_sns = lambda: Conn()
        feeds = MomentDB.get_moments(db, limit=1)
        self.assertEqual(feeds[0]['tid'], 99)

    def test_install_is_idempotent(self):
        before = Moment._target_idx
        moment_compat.install()
        self.assertIs(Moment._target_idx, before)


if __name__ == '__main__':
    unittest.main()
