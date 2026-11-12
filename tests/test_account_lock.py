"""账号锁包装必须从调用现场取实例，否则择窗永远抛 account_lock 的 AttributeError。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from bridge.account_mixin import AccountMixin


class RecordingLock:
    """记录有没有被真正 `with` 进去。"""

    def __init__(self):
        self.entered = 0
        self.exited = 0

    def __enter__(self):
        self.entered += 1
        return self

    def __exit__(self, *exc):
        self.exited += 1
        return False


class AccountLockTests(unittest.TestCase):
    def test_wrapper_uses_the_call_site_instance(self):
        """回归：包装器曾闭包捕获类体里的 None。

        旧写法 `_account_locked(None, pick_account_window)` 在类体里执行，那时没有实例，
        包装器却把 self 闭包成了 None，于是任何一次择窗都在 `with self.account_lock` 处抛
        AttributeError('NoneType' object has no attribute 'account_lock')，
        桥接一直停在「等待微信主窗可用」。
        """
        lock = RecordingLock()
        stub = type('Stub', (), {'account_lock': lock, 'tag': 'x'})()
        seen = {}

        def body(self, value, extra=None):
            seen.update(tag=getattr(self, 'tag', None), value=value, extra=extra)
            return 'ok'

        wrapped = AccountMixin._account_locked(body)
        self.assertEqual(wrapped(stub, 7, extra='e'), 'ok')
        self.assertEqual((lock.entered, lock.exited), (1, 1))
        self.assertEqual(seen['tag'], 'x')
        self.assertEqual((seen['value'], seen['extra']), (7, 'e'))

    def test_pick_account_window_never_raises_nonetype_lock(self):
        """真实函数上复现：不允许再出现 NoneType.account_lock。"""
        lock = RecordingLock()
        stub = type('Stub', (), {
            'account_lock': lock,
            'ACCOUNT': {'verified': False},
        })()
        try:
            AccountMixin.pick_account_window(stub, force=True, quiet=True)
        except AttributeError as error:
            self.assertNotIn('account_lock', str(error))
        except Exception:
            # 缺少 UIA / 引擎属性是预期内的，这里只关心锁有没有拿到。
            pass
        self.assertEqual(lock.entered, 1, '择窗时必须先拿到账号锁')
