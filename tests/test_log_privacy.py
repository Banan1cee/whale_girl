# -*- coding: utf-8 -*-
"""桥接日志脱敏：正文只留长度，id/昵称只留哈希，常见敏感格式兜底打码。"""
import hashlib
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'bridge') not in sys.path:
    sys.path.insert(0, str(ROOT / 'bridge'))

import bridge_log  # noqa: E402


class LogPrivacyTests(unittest.TestCase):
    def test_bridge_log_calls_do_not_reintroduce_names_or_text(self):
        checks = {
            'receiver_mixin.py': [
                "'群聊称呼：%s' % (' / '.join(names[:10]))",
                "G.log('这一分钟回太多了，先停一下：', target)",
            ],
            'sender_mixin.py': [
                "G.log('UIA 已切到会话：', self.open_cache[username])",
                "G.log('@ 成员失败（%s），改用普通发送' % member)",
            ],
            'msg_pipeline.py': [
                'self.log("消息调度已关闭，这条没能排上：", chat)',
            ],
        }
        for name, patterns in checks.items():
            text = (ROOT / 'bridge' / name).read_text(encoding='utf-8')
            for pattern in patterns:
                self.assertNotIn(pattern, text, '%s 又把隐私写回日志了' % name)

    def test_uia_logs_hash_conversation_names(self):
        compat = (ROOT / 'examples' / 'uia_compat.py').read_text(encoding='utf-8')
        self.assertIn('def _log_name(', compat)
        self.assertNotIn('log.info("uia_compat: 会话列表 %d 项：%s", len(rows),\n                     " | ".join(n[:16]', compat)
        selftest = (ROOT / 'examples' / 'uia_selftest.py').read_text(encoding='utf-8')
        self.assertIn('def _log_name(', selftest)
        self.assertNotIn('log.info("  最近消息[%d] = %r", i, c[:60])', selftest)

    def test_scrub_masks_common_private_patterns(self):
        phone = '138' + '12345678'
        raw = (
            'sender=wxid_test_secret123456 chat=111111111@chatroom '
            'phone=' + phone + ' mail=someone@example.com '
            'path=C:\\Users\\placeholder_user\\whale\\data token=Bearer abcdefghijklmnop '
            'url=https://example.com/hook?token=verysecretvalue&x=1'
        )
        out = bridge_log.scrub(raw)
        for leaked in ('wxid_test_secret', '111111111@chatroom', phone,
                       'someone@example.com', 'placeholder_user', 'abcdefghijklmnop',
                       'verysecretvalue'):
            self.assertNotIn(leaked, out)

    def test_safe_helpers_never_return_raw_text(self):
        self.assertRegex(bridge_log.safe_id('wxid_secret'), r'^#[0-9a-f]{8}$')
        self.assertEqual(bridge_log.safe_id('wxid_secret'), bridge_log.safe_id('wxid_secret'))
        # 敏感值不能用弱摘要：短哈希必须是 SHA-256 的前 8 位（CodeQL 会拦 SHA-1）。
        expected = hashlib.sha256('wxid_secret'.encode('utf-8')).hexdigest()[:8]
        self.assertEqual(bridge_log.safe_id('wxid_secret'), '#' + expected)
        self.assertRegex(bridge_log.safe_name('张三'), r'^#[0-9a-f]{8}\(2字\)$')
        self.assertEqual(bridge_log.safe_text('银行卡密码'), 'len=5')
        self.assertEqual(bridge_log.safe_path('C:\\Users\\test_user\\w'), 'path(len=20)')
        self.assertEqual(bridge_log.safe_url('https://example.com/secret?token=abc'), 'example.com')


if __name__ == '__main__':
    unittest.main()
