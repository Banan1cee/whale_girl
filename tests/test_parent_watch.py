import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import parent_watch


class ParentWatchTests(unittest.TestCase):
    def test_eof_closes_bridge(self):
        exited = []
        parent_watch.watch_pipe(stream=io.BytesIO(b''), on_close=lambda: exited.append('closed'),
                                exit_func=exited.append)
        self.assertEqual(exited, ['closed', 0])

    def test_data_then_eof_waits_until_pipe_closes(self):
        exited = []
        parent_watch.watch_pipe(stream=io.BytesIO(b'shutdown\n'), exit_func=exited.append)
        self.assertEqual(exited, [0])

    def test_watchdog_only_starts_when_launcher_requests_it(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(parent_watch.start_watchdog(stream=io.BytesIO(b'x')))

    def test_watchdog_starts_for_launcher_pipe(self):
        exited = []
        with patch.dict(os.environ, {'WHALE_CONTROL_STDIN': '1'}):
            thread = parent_watch.start_watchdog(stream=io.BytesIO(b''), exit_func=exited.append)
        self.assertIsNotNone(thread)
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(exited, [0])


if __name__ == '__main__':
    unittest.main()
