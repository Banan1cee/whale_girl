import io
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import parent_watch


class PoisonStream:
    """被读就炸：用来证明走父进程 PID 时不会碰 stdin（碰了就会在 numpy 上死锁）。"""

    def read(self, _n=1):
        raise AssertionError('watchdog must not read stdin when WHALE_PARENT_PID is set')

    def fileno(self):
        raise AssertionError('watchdog must not touch the stdin fd')


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

    @unittest.skipUnless(os.name == 'nt', 'Windows 进程句柄')
    def test_parent_pid_watch_does_not_read_stdin(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        exited = []
        try:
            with patch.dict(os.environ, {'WHALE_CONTROL_STDIN': '1',
                                         'WHALE_PARENT_PID': str(child.pid)}):
                thread = parent_watch.start_watchdog(
                    stream=PoisonStream(), on_close=lambda: exited.append('closed'),
                    exit_func=exited.append)
            self.assertIsNotNone(thread)
            self.assertTrue(thread.is_alive())
            child.terminate()
            child.wait(10)
            thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(exited, ['closed', 0])
        finally:
            if child.poll() is None:
                child.kill()

    @unittest.skipUnless(os.name == 'nt', 'Windows 命名管道探测')
    def test_pipe_poll_exits_when_writer_closes(self):
        read_fd, write_fd = os.pipe()
        events = []
        thread = threading.Thread(
            target=parent_watch.watch_pipe_poll,
            kwargs={'stream': os.fdopen(read_fd, 'rb'),
                    'on_close': lambda: events.append('closed'),
                    'exit_func': events.append},
            daemon=True)
        thread.start()
        time.sleep(0.4)
        self.assertTrue(thread.is_alive())
        os.close(write_fd)
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(events, ['closed', 0])


if __name__ == '__main__':
    unittest.main()
