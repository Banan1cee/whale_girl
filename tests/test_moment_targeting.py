"""从 bridge/moment_compat.py 取出目标匹配补丁，验证 publisher+keyword 是 AND 语义。

这个测试不导入 wechatauto：CI 只装了 pillow/cryptography/requests，没有
pywin32/uiautomation。目标选择逻辑本身是纯函数，而且补丁必须待在兼容层，
vendor/wechatauto 保持上游原样。
"""
import ast
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def load_compat_methods(*names):
    source = (ROOT / 'bridge' / 'moment_compat.py').read_text('utf-8')
    tree = ast.parse(source)
    installer = next(
        n for n in tree.body
        if isinstance(n, ast.FunctionDef) and n.name == '_install_moment_match_patch'
    )
    namespace = {}
    for node in installer.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            code = 'from __future__ import annotations\n' + textwrap.dedent(ast.get_source_segment(source, node))
            exec(code, namespace)
    missing = [name for name in names if name not in namespace]
    if missing:
        raise AssertionError('兼容层缺少目标匹配方法：' + '、'.join(missing))
    return namespace


class FakeControl:
    def __init__(self, name=''):
        self.Name = name


class FakeItem:
    def __init__(self, nickname, content, raw=''):
        self.nickname = nickname
        self.content = content
        self.control = FakeControl(raw)

    @property
    def publisher(self):
        return self.nickname

    @property
    def text(self):
        return self.content


class MomentTargetingTest(unittest.TestCase):
    def setUp(self):
        self.methods = load_compat_methods('target_idx', 'matches')

    def test_target_idx_requires_publisher_and_keyword(self):
        posts = [
            {'nickname': 'Peer', 'text': 'first post'},
            {'nickname': 'Peer', 'text': 'spring is here'},
            {'nickname': 'Other', 'text': 'spring too'},
        ]
        target = self.methods['target_idx']
        self.assertEqual(target(None, posts, 'Peer', 'spring'), 1)
        self.assertEqual(target(None, posts, 'Peer', None), 0)
        self.assertEqual(target(None, posts, None, 'spring'), 1)
        self.assertIsNone(target(None, posts, 'Peer', 'missing'))

    def test_matches_requires_both_when_both_given(self):
        matches = self.methods['matches']
        self.assertTrue(matches(None, FakeItem('Peer', 'spring is here'), 'Peer', 'spring'))
        self.assertFalse(matches(None, FakeItem('Peer', 'first post'), 'Peer', 'spring'))
        self.assertFalse(matches(None, FakeItem('Other', 'spring is here'), 'Peer', 'spring'))
        self.assertTrue(matches(None, FakeItem('Peer', 'spring is here'), None, 'spring'))
        self.assertTrue(matches(None, FakeItem('Peer', 'anything'), 'Peer', None))
        self.assertFalse(matches(None, FakeItem('Peer', 'anything'), None, None))

    def test_matches_falls_back_to_raw_control_name(self):
        matches = self.methods['matches']
        item = SimpleNamespace(control=FakeControl('Peer spring is here'))
        self.assertTrue(matches(None, item, 'Peer', 'spring'))


if __name__ == '__main__':
    unittest.main()
