import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from moments_publish import WeChatPostScreen, find_camera_icon, publish_flow


def frame(*labels, hwnd=100, cls='mmui::MainWindow'):
    return SimpleNamespace(hwnd=hwnd, cls=cls, rect=(0, 0, 800, 600), lines=[(x, 20, 12 * i, 20, 12)
                                                     for i, x in enumerate(labels)])


class PublishFlowTest(unittest.TestCase):
    def screen(self, frames):
        return SimpleNamespace(capture=Mock(side_effect=frames), click=Mock(), camera=Mock(return_value=(200, 30)),
                               select_image=Mock(), find_editor=Mock(return_value=True), fill_empty=Mock(return_value=True),
                               publish_button=Mock(return_value=(400, 450)), editor_closed=Mock(return_value=True),
                               return_to_chat=Mock(), remember_existing_inputs=Mock(),
                               text_matches=Mock(return_value=True), image_visible=Mock(return_value=True),
                               allowed=Mock(return_value=True))

    def test_text_publishes_only_after_editor_verification(self):
        screen = self.screen([frame(), frame('发表文字'), frame(), frame('发表')])
        actions = Mock()
        for name in ('fill_empty', 'text_matches', 'publish_button', 'click', 'return_to_chat'):
            actions.attach_mock(getattr(screen, name), name)
        self.assertEqual(publish_flow(screen, '测试文案', pause=lambda _: None), ('unconfirmed', ''))
        self.assertEqual(screen.click.call_count, 3)
        screen.select_image.assert_not_called()
        self.assertEqual([call[0] for call in actions.mock_calls],
                         ['click', 'click', 'fill_empty', 'text_matches', 'publish_button', 'click', 'return_to_chat'])
        self.assertEqual(screen.click.call_args.args[1], (400, 450))
        self.assertEqual(screen.capture.call_args_list[0].kwargs, {'recognize': False})
        self.assertEqual(screen.click.call_args_list[0].kwargs, {'right': True})

    def test_camera_uses_header_not_list_origin(self):
        screen = WeChatPostScreen.__new__(WeChatPostScreen)
        screen.pid = 42
        screen.gui = SimpleNamespace(_input=SimpleNamespace(
            _user32=SimpleNamespace(GetDpiForWindow=lambda _: 120)))
        container = SimpleNamespace(ClassName='mmui::SNSContentView',
                                    BoundingRectangle=SimpleNamespace(left=200, top=100, right=700, bottom=500))
        screen.timeline = SimpleNamespace(ClassName='mmui::TimeLineListView', ProcessId=42,
                                         GetParentControl=lambda: container,
                                         GetTopLevelControl=lambda: SimpleNamespace(NativeWindowHandle=10))
        screen.verify = Mock()
        screen.grab = Mock(return_value=object())
        with patch('moments_publish.find_camera_icon', return_value=(455, 35)):
            self.assertEqual(screen.camera(SimpleNamespace(hwnd=10, rect=(100, 80, 700, 500))), (555, 55))
        self.assertIsNone(screen.camera(SimpleNamespace(hwnd=11, rect=(100, 80, 700, 500))))

    def test_recognizes_camera_and_rejects_rightmost_button(self):
        try:
            import cv2
            from PIL import Image
        except ImportError:
            self.skipTest('camera recognition dependencies unavailable')
        with Image.open(Path(__file__).with_name('fixtures') / 'moments-toolbar.png') as toolbar:
            self.assertEqual(find_camera_icon(toolbar, 96), (109, 21))
            self.assertIsNone(find_camera_icon(toolbar.crop((140, 0, 196, 46)), 96))

    def test_image_picker_and_matching_preview_required(self):
        screen = self.screen([frame(), frame('发表图片'), frame('文件名', '打开', hwnd=200, cls='#32770'),
                              frame('发表'), frame('发表')])
        self.assertEqual(publish_flow(screen, '测试文案', 'fixture.jpg', pause=lambda _: None), ('unconfirmed', ''))
        screen.select_image.assert_called_once()
        self.assertEqual(screen.image_visible.call_count, 2)
        self.assertEqual(screen.click.call_count, 3)

    def test_missing_image_preview_never_publishes(self):
        screen = self.screen([frame(), frame('发表图片'), frame('文件名', '打开', hwnd=200, cls='#32770'), frame('发表')])
        screen.image_visible.return_value = False
        self.assertEqual(publish_flow(screen, '测试文案', 'fixture.jpg', pause=lambda _: None),
                         ('failed', 'image_preview_not_recognized'))
        self.assertEqual(screen.click.call_count, 2)
        screen.fill_empty.assert_not_called()

    def test_disabled_or_focus_changed_never_publishes(self):
        for changed in (True, False):
            screen = self.screen([frame('朋友圈'), frame('发表文字'), frame('发表'),
                                  frame('发表', hwnd=101 if changed else 100)])
            screen.allowed.side_effect = [True, True, False]
            self.assertEqual(publish_flow(screen, '测试文案', pause=lambda _: None)[0], 'failed')
            self.assertEqual(screen.click.call_count, 2)
            screen.return_to_chat.assert_not_called()

    def test_real_adapter_focuses_unfocused_editor_before_pasting(self):
        screen = WeChatPostScreen.__new__(WeChatPostScreen)
        screen.verify = Mock()
        screen.timeline_hwnd = 100
        screen.allowed = Mock(return_value=True)
        screen.gui = SimpleNamespace(set_clipboard=Mock(return_value=True),
                                     _input=SimpleNamespace(key=Mock()))
        value = SimpleNamespace(Value='')
        edit = SimpleNamespace(ControlTypeName='EditControl', IsKeyboardFocusable=True,
                               IsEnabled=True, IsOffscreen=False, Name='', AutomationId='',
                               HasKeyboardFocus=False, GetValuePattern=lambda: value, GetRuntimeId=lambda: [2],
                               GetChildren=lambda: [],
                               BoundingRectangle=SimpleNamespace(left=210, top=120, right=610, bottom=310))
        parent = SimpleNamespace(NativeWindowHandle=100)
        button = SimpleNamespace(ControlTypeName='ButtonControl', Name='发表', IsEnabled=False,
                                 IsOffscreen=False, GetParentControl=lambda: parent, GetChildren=lambda: [],
                                 BoundingRectangle=SimpleNamespace(left=535, top=420, right=610, bottom=458))
        parent.ControlTypeName = 'PaneControl'
        parent.GetChildren = lambda: [edit, button]
        screen.uia = SimpleNamespace(ControlFromHandle=lambda _: parent)
        screen.click = Mock(side_effect=lambda *_: setattr(edit, 'HasKeyboardFocus', True))
        blank = frame()
        screen.remember_existing_inputs(blank)
        self.assertFalse(screen.find_editor(blank), 'an existing chat input is never selected')
        edit.GetRuntimeId = lambda: [3]
        self.assertTrue(screen.find_editor(blank))
        self.assertIsNone(screen.publish_button(blank))
        self.assertTrue(screen.fill_empty(blank, '待发文案'))
        screen.click.assert_called_once_with(blank, (410, 215))
        screen.gui.set_clipboard.assert_called_once_with('待发文案')
        screen.gui._input.key.assert_called_once_with(0x56, ctrl=True)
        self.assertFalse(screen.text_matches(blank, '待发文案'))
        value.Value = '待发文案'
        button.IsEnabled = True
        self.assertTrue(screen.text_matches(blank, '待发文案'))
        self.assertEqual(screen.publish_button(blank), (572, 439))
        self.assertFalse(screen.fill_empty(blank, '另一条文案'))

    def test_returns_to_chat_once_within_verified_wechat_window(self):
        screen = WeChatPostScreen.__new__(WeChatPostScreen)
        screen.hwnd = screen.timeline_hwnd = 100
        screen.editor_hwnd, screen.pid, screen.chat_restored = 101, 42, False
        screen.allowed = lambda: True
        screen.win = SimpleNamespace(GetForegroundWindow=Mock(return_value=999))
        screen.process = SimpleNamespace(GetWindowThreadProcessId=lambda _: (1, 42))
        screen.foreground = Mock(return_value=True)
        chat = SimpleNamespace(Name='微信', IsOffscreen=False, ClassName='mmui::XTabBarItem',
                               GetChildren=lambda: [],
                               BoundingRectangle=SimpleNamespace(left=10, top=50, right=60, bottom=95))
        bar = SimpleNamespace(ClassName='mmui::MainTabBar', Name='', GetChildren=lambda: [chat])
        root = SimpleNamespace(ClassName='mmui::MainWindow', GetChildren=lambda: [bar])
        screen.uia = SimpleNamespace(ControlFromHandle=lambda _: root)
        screen.capture = Mock(return_value=frame())
        screen.click = Mock()
        screen.return_to_chat()
        screen.click.assert_not_called()
        screen.win.GetForegroundWindow.return_value = 101
        screen.return_to_chat()
        screen.return_to_chat()
        screen.foreground.assert_called_once_with(100)
        screen.click.assert_called_once_with(screen.capture.return_value, (35, 72))

    def test_does_not_leave_composer_that_stays_open_after_click(self):
        screen = self.screen([frame(), frame('发表文字'), frame(), frame('发表')])
        screen.editor_closed.return_value = False
        self.assertEqual(publish_flow(screen, '测试文案', pause=lambda _: None), ('unconfirmed', ''))
        screen.return_to_chat.assert_not_called()
        self.assertEqual(screen.click.call_count, 3)


if __name__ == '__main__':
    unittest.main()
