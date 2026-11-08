import unittest

from bridge_ast import load_function


class ChooseMainWindowTests(unittest.TestCase):
    def setUp(self):
        self.choose = load_function('choose_main_window', {})

    def test_single_window_is_returned(self):
        self.assertEqual(self.choose([(100, 7, 800, False)]), (100, 7, 800, False))

    def test_pinned_window_wins_even_if_smaller(self):
        cands = [(100, 7, 900, False), (200, 8, 100, False)]
        self.assertEqual(self.choose(cands, pinned=200), (200, 8, 100, False))

    def test_unique_foreground_window_wins(self):
        cands = [(100, 7, 900, False), (200, 8, 100, True), (300, 9, 500, False)]
        self.assertEqual(self.choose(cands), (200, 8, 100, True))

    def test_largest_window_is_stable_fallback(self):
        cands = [(100, 7, 900, False), (200, 8, 1200, False), (300, 9, 500, False)]
        self.assertEqual(self.choose(cands), (200, 8, 1200, False))

    def test_dict_candidates_and_empty_input(self):
        cands = [{'hwnd': 11, 'pid': 2, 'area': 10}, {'hwnd': 12, 'pid': 3, 'area': 20}]
        self.assertEqual(self.choose(cands), (12, 3, 20, False))
        self.assertIsNone(self.choose([]))


if __name__ == '__main__':
    unittest.main()
