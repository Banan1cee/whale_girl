# -*- coding: utf-8 -*-
"""连续消息收集：安静窗口重置、群聊最大等待不重置、配置热更。"""
import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'bridge') not in sys.path:
    sys.path.insert(0, str(ROOT / 'bridge'))

from msg_pipeline import SettleScheduler  # noqa: E402


class SettleSchedulerTests(unittest.TestCase):
    def make(self, settle=80, maximum=300):
        events = []
        lock = threading.Lock()
        wait = {'settle': settle, 'max': maximum}

        def flush(chat):
            with lock:
                events.append((chat, time.monotonic()))

        scheduler = SettleScheduler(
            flush,
            get_wait=lambda: (wait['settle'], wait['max']),
            log=lambda *a: None,
        )
        self.addCleanup(scheduler.close)
        return scheduler, events, wait, lock

    def test_private_quiet_window_resets_and_flushes_once(self):
        scheduler, events, _, lock = self.make(settle=80)
        scheduler.touch('私聊')
        time.sleep(0.04)
        scheduler.touch('私聊')
        time.sleep(0.05)
        with lock:
            self.assertEqual(len(events), 0, '续句应重置安静计时')
        time.sleep(0.08)
        with lock:
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0][0], '私聊')

    def test_group_max_wait_is_not_reset_by_new_messages(self):
        scheduler, events, _, lock = self.make(settle=120, maximum=220)
        start = time.monotonic()
        for _ in range(4):
            scheduler.touch('群聊', group=True)
            time.sleep(0.06)
        time.sleep(0.16)
        with lock:
            self.assertEqual(len(events), 1, '群聊到首条最大等待后必须封批')
            self.assertLess(events[0][1] - start, 0.5)
        scheduler.touch('群聊', group=True)
        time.sleep(0.16)
        with lock:
            self.assertEqual(len(events), 2, '后续消息应另开一批')

    def test_reconcile_uses_existing_messages_instead_of_restarting_from_now(self):
        scheduler, events, wait, lock = self.make(settle=500, maximum=1000)
        scheduler.touch('私聊')
        wait['settle'] = 40
        scheduler.reconcile()
        time.sleep(0.08)
        with lock:
            self.assertEqual(len(events), 1, '热更后应按原到达时间计算，不能重新等 40ms 以外的旧窗口')

    def test_zero_settle_uses_immediate_path(self):
        scheduler, events, _, lock = self.make(settle=0, maximum=5000)
        scheduler.touch('私聊')
        with lock:
            self.assertEqual(len(events), 1)


if __name__ == '__main__':
    unittest.main()
