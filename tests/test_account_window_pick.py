"""Only remove positively identified hidden helper windows from account candidates."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.uia_boot import account_window_candidates


class AccountWindowCandidatesTests(unittest.TestCase):
    def test_hidden_small_same_process_helper_is_removed(self):
        windows = {
            11: (1, True, False, (0, 0, 900, 600), '微信'),
            22: (1, False, False, (0, 0, 300, 300), '微信'),
            33: (2, False, False, (0, 0, 300, 300), 'WeChat'),
            44: (1, False, True, (0, 0, 300, 300), '微信'),
            55: (1, False, False, (0, 0, 300, 300), 'WeChat Settings'),
        }
        gui = SimpleNamespace(
            GetClassName=lambda hwnd: 'Qt51514QWindowIcon',
            GetWindowText=lambda hwnd: windows[hwnd][4],
            IsWindowVisible=lambda hwnd: windows[hwnd][1],
            IsIconic=lambda hwnd: windows[hwnd][2],
            GetWindowRect=lambda hwnd: windows[hwnd][3],
            GetWindowPlacement=lambda hwnd: (0, 0, (), (), windows[hwnd][3]),
        )
        process = SimpleNamespace(GetWindowThreadProcessId=lambda hwnd: (0, windows[hwnd][0]))
        self.assertEqual(account_window_candidates(gui, process, [*windows, 11]), [(11, 1), (33, 2), (44, 1)])
        self.assertEqual(account_window_candidates(gui, process, []), [])
