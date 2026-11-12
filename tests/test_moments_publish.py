import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch, call

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from moments_publish import WeChatPostScreen, find_camera_icon, publish_flow, menu_action


def frame(*labels, hwnd=100, cls='mmui::MainWindow'):
    return SimpleNamespace(hwnd=hwnd, cls=cls, rect=(0, 0, 800, 600), lines=[(x, 20, 12 * i, 20, 12)
                                                     for i, x in enumerate(labels)])


class PublishFlowTest(unittest.TestCase):
    def screen(self, frames):
        capture = Mock(side_effect=frames)
        screen = SimpleNamespace(capture=capture, capture_menu=capture, click=Mock(), camera=Mock(return_value=(200, 30)),
                               select_image=Mock(return_value=True), menu_action=lambda f, image: menu_action(f.lines, image),
                               picker_closed=Mock(return_value=True),
                               cancel_pending=Mock(), find_editor=Mock(return_value=True), fill_empty=Mock(return_value=True),
                               publish_button=Mock(return_value=(400, 450)), editor_closed=Mock(return_value=True),
                               return_to_chat=Mock(), remember_existing_inputs=Mock(),
                               text_matches=Mock(return_value=True), image_visible=Mock(return_value=True),
                               allowed=Mock(return_value=True))
        screen.submit = lambda ready, point, text: screen.click(ready, point)
        return screen

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
        screen.editor_closed.assert_called_once()
        screen.return_to_chat.assert_called_once()

    def test_menu_label_tolerates_ocr_suffix(self):
        from moments_publish import label
        lines = [('发表文字(C)', 10, 20, 40, 12), ('发表图片', 70, 20, 40, 12)]
        self.assertEqual(label(lines, '发表文字', fuzzy=True), (30, 26))
        self.assertIsNone(label(lines, '发表文字'))
        self.assertIsNone(label(lines, '发表文字', top=10, fuzzy=True))

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
                              frame('发表'), frame('发表'), frame('发表')])
        self.assertEqual(publish_flow(screen, '测试文案', 'fixture.jpg', pause=lambda _: None), ('unconfirmed', ''))
        screen.select_image.assert_called_once()
        self.assertEqual(screen.image_visible.call_count, 2)
        self.assertEqual(screen.click.call_count, 3)

    def test_photo_video_menu_label_and_unrecognized_menu_cleanup(self):
        screen = self.screen([frame(), frame('发表图片和视频'), frame(hwnd=200, cls='#32770'),
                              frame('发表'), frame('发表'), frame('发表')])
        self.assertEqual(publish_flow(screen, '测试文案', 'fixture.png', pause=lambda _: None),
                         ('unconfirmed', ''))
        screen.select_image.assert_called_once()
        screen.cancel_pending.assert_not_called()
        screen = self.screen([frame(), frame('其他按钮')])
        self.assertEqual(publish_flow(screen, '测试文案', 'fixture.png', pause=lambda _: None),
                         ('failed', 'image_menu_not_recognized'))
        screen.cancel_pending.assert_called_once()
        screen.fill_empty.assert_not_called()

    def test_real_menu_adapter_captures_popup_outside_foreground_main_window(self):
        screen = WeChatPostScreen.__new__(WeChatPostScreen)
        screen.pid = 42
        screen.before_menu_windows = {100}
        rectangles = {100: (0, 0, 800, 600), 200: (900, 50, 1100, 160)}
        screen.win = SimpleNamespace(
            EnumWindows=lambda callback, data: [callback(h, data) for h in (100, 200)],
            IsWindowVisible=lambda hwnd: True,
            GetForegroundWindow=lambda: 100,
            GetWindowRect=lambda hwnd: rectangles[hwnd],
            GetClassName=lambda hwnd: 'QtPopup' if hwnd == 200 else 'mmui::MainWindow',
            WindowFromPoint=lambda point: 200)
        screen.process = SimpleNamespace(GetWindowThreadProcessId=lambda hwnd: (1, 42))
        screen.grab = Mock(return_value=object())
        screen.ocr = SimpleNamespace(recognize=lambda image: [('选照片或视频', 10, 20, 140, 22)])
        screen.gui = SimpleNamespace(_input=SimpleNamespace(send_input_click=Mock()))
        popup = screen.capture_menu()
        screen.grab.assert_called_once_with(bbox=rectangles[200], all_screens=True)
        point = screen.menu_action(popup, True)
        self.assertEqual(point, (80, 31))
        screen.click(popup, point)
        screen.gui._input.send_input_click.assert_called_once_with(980, 81, right=False)
        screen.gui._input.send_input_click.reset_mock()
        rectangles[200] = (901, 50, 1101, 160)
        with self.assertRaises(RuntimeError):
            screen.click(popup, point)
        screen.gui._input.send_input_click.assert_not_called()

    def test_actual_wechat_menu_photo_label_is_recognized(self):
        self.assertEqual(menu_action(frame('选照片或视频', '发表文字').lines, True), (30, 6))
        self.assertEqual(menu_action(frame('选照片或视频', '发表文字').lines, False), (30, 18))

    def test_ocr_failure_is_not_reported_as_file_dialog_timeout(self):
        from moments_ocr import MomentsOCRError
        screen = self.screen([frame()])
        screen.capture_menu = Mock(side_effect=MomentsOCRError('recognition failed'))
        self.assertEqual(publish_flow(screen, '测试文案', 'fixture.png', pause=lambda _: None),
                         ('failed', 'ocr_transport_error'))
        screen.select_image.assert_not_called()
        screen.cancel_pending.assert_called_once()

    def test_verified_window_without_cached_pid_can_reach_timeline(self):
        from moments_publish import publish
        runtime = SimpleNamespace(ACCOUNT={'hwnd': 100, 'verified': True},
                                  force_foreground=Mock(return_value=True))
        moment = SimpleNamespace(_wx=SimpleNamespace(SwitchToMoments=Mock(return_value=False)))
        modules = {
            'sticker_transport': SimpleNamespace(validate_path=Mock()),
            'moments': SimpleNamespace(collect=Mock()),
            'win32gui': SimpleNamespace(IsWindow=lambda hwnd: True, GetForegroundWindow=lambda: 100),
            'win32process': SimpleNamespace(GetWindowThreadProcessId=lambda hwnd: (1, 42)),
        }
        with patch.dict(sys.modules, modules):
            self.assertEqual(publish(runtime, moment, {'text': '这是一条有效的朋友圈文案'}, lambda: True),
                             ('failed', 'timeline_not_recognized'))
            moment._wx.SwitchToMoments.assert_called_once()
            moment._wx.SwitchToMoments.reset_mock()
            runtime.ACCOUNT['pid'] = 999
            self.assertEqual(publish(runtime, moment, {'text': '这是一条有效的朋友圈文案'}, lambda: True),
                             ('failed', 'account_not_verified'))
            moment._wx.SwitchToMoments.assert_not_called()
            runtime.ACCOUNT.pop('pid')
            self.assertEqual(publish(runtime, moment, {'text': '这是一条有效的朋友圈文案'}, lambda: False),
                             ('failed', 'account_not_verified'))
            moment._wx.SwitchToMoments.assert_not_called()

    def test_manual_publish_bypasses_fullscreen_avoidance_but_not_account_check(self):
        from bridge_ast import load_function
        fake_module = SimpleNamespace(publish_isolated=Mock(return_value=('unconfirmed', '')))
        lock = __import__('threading').RLock()
        env = dict(
            send_lock=lock, gui_lock=lock, foreground_is_fullscreen=Mock(return_value=True),
            account_send_allowed=Mock(return_value=True),
            ACCOUNT={'verified': True, 'hwnd': 100}, db=object(), wechat_window_alive=lambda: True,
            gui=SimpleNamespace(main_hwnd=100, use_window=lambda hwnd: True))
        with patch.dict(sys.modules, {'moments_worker': fake_module}):
            publish = load_function('moments_publish', env)
            self.assertEqual(publish({'manual': False}, lambda: True), ('failed', 'fullscreen_blocked'))
            self.assertEqual(publish({'manual': True}, lambda: True), ('unconfirmed', ''))
            env['account_send_allowed'].return_value = False
            self.assertEqual(publish({'manual': True}, lambda: True), ('failed', 'account_not_verified'))
        self.assertEqual(fake_module.publish_isolated.call_count, 1)

    def test_capture_accepts_small_native_camera_menu(self):
        screen = WeChatPostScreen.__new__(WeChatPostScreen)
        screen.pid = 42
        screen.win = SimpleNamespace(GetForegroundWindow=lambda: 200,
                                     GetWindowRect=lambda _: (10, 20, 212, 112),
                                     GetClassName=lambda _: 'QtPopup')
        screen.process = SimpleNamespace(GetWindowThreadProcessId=lambda _: (1, 42))
        screen.grab = Mock(return_value=object())
        screen.ocr = SimpleNamespace(recognize=lambda image: [('选照片或视频', 10, 10, 140, 18)])
        menu = screen.capture()
        self.assertEqual(menu.rect, (10, 20, 212, 112))
        self.assertEqual(menu_action(menu.lines, True), (80, 19))

    def test_menu_retries_small_ocr_and_maps_coordinates_without_guessing_prefix(self):
        from PIL import Image
        screen = WeChatPostScreen.__new__(WeChatPostScreen)
        screen.verify = Mock()
        screen.ocr = SimpleNamespace(recognize=Mock(return_value=[('选照片或视频', 32, 30, 196, 36)]))
        screen.uia = SimpleNamespace(ControlFromHandle=Mock(return_value=None))
        menu = frame('选照片或')
        menu.image = Image.new('RGB', (202, 92))
        self.assertIsNone(menu_action(menu.lines, True))
        self.assertEqual(screen.menu_action(menu, True), (65, 24))
        self.assertEqual(screen.ocr.recognize.call_args.args[0].size, (404, 184))
        screen.uia.ControlFromHandle.assert_not_called()
        screen.ocr.recognize.return_value = [('选照片或', 32, 30, 140, 36)]
        self.assertIsNone(screen.menu_action(menu, True))

    def test_image_flow_checks_selection_preview_text_then_publish_and_chat(self):
        screen = self.screen([frame(), frame('选择图片或视频'), frame(hwnd=200, cls='#32770'),
                              frame(), frame(), frame('发表')])
        actions = Mock()
        for name in ('select_image', 'find_editor', 'image_visible', 'fill_empty',
                     'text_matches', 'publish_button', 'click', 'return_to_chat'):
            actions.attach_mock(getattr(screen, name), name)
        self.assertEqual(publish_flow(screen, '完整流程文案', 'C:/图片/预设.png', pause=lambda _: None),
                         ('unconfirmed', ''))
        self.assertEqual([call[0] for call in actions.mock_calls],
                         ['click', 'click', 'select_image', 'find_editor', 'image_visible',
                          'fill_empty', 'text_matches', 'publish_button', 'image_visible',
                          'click', 'return_to_chat'])

    def picker(self):
        def control(kind='PaneControl', identifier='', name=''):
            return SimpleNamespace(ControlTypeName=kind, AutomationId=identifier, Name=name,
                                   IsOffscreen=False, IsEnabled=True, GetChildren=lambda: [],
                                   GetParentControl=lambda: None)
        root = control()
        root.ProcessId = 42
        host = control(identifier='1148')
        field = control('EditControl', '1001')
        field.GetParentControl = lambda: host
        field.HasKeyboardFocus = False
        def focus():
            field.HasKeyboardFocus = True
        field.SetFocus = Mock(side_effect=focus)
        value = SimpleNamespace(Value='')
        value.SetValue = Mock(side_effect=lambda text: setattr(value, 'Value', text))
        field.GetValuePattern = lambda: value
        host.GetChildren = lambda: [field]
        search = control('EditControl', 'SearchBox', '搜索')
        button = control('ButtonControl', '1', '打开(O)')
        invoke = Mock()
        button.GetInvokePattern = lambda: SimpleNamespace(Invoke=invoke)
        root.GetChildren = lambda: [search, host, button]
        screen = WeChatPostScreen.__new__(WeChatPostScreen)
        screen.pid = 42
        screen.verify = Mock()
        screen.allowed = Mock(return_value=True)
        screen.click = Mock(side_effect=AssertionError('选图不应走坐标点击'))
        screen.uia = SimpleNamespace(ControlFromHandle=lambda hwnd: root)
        screen.gui = SimpleNamespace(set_clipboard=Mock(return_value=True), _input=SimpleNamespace(key=Mock()))
        return screen, field, value, invoke

    def test_uia_picker_sets_path_and_invokes_open_without_clicking_coordinates(self):
        screen, field, value, invoke = self.picker()
        self.assertTrue(screen.select_image(frame(hwnd=200, cls='#32770'), None, 'C:/图片/鲸鲸.png'))
        self.assertEqual(value.Value, 'C:/图片/鲸鲸.png')
        invoke.assert_called_once()
        screen.click.assert_not_called()
        screen.gui._input.key.assert_not_called()

    def test_uia_picker_does_not_open_when_value_readback_is_wrong(self):
        screen, field, value, invoke = self.picker()
        value.SetValue.side_effect = lambda text: None
        self.assertFalse(screen.select_image(frame(hwnd=200, cls='#32770'), None, 'fixture.png'))
        invoke.assert_not_called()

    def test_picker_waits_for_controls_to_materialize_before_writing_path(self):
        screen, field, value, invoke = self.picker()
        button = screen.uia.ControlFromHandle(200).GetChildren()[-1]
        screen._picker_elements = Mock(side_effect=[([], []), ([field], [button])])
        with patch('moments_publish.time.sleep'):
            self.assertTrue(screen.select_image(frame(hwnd=200, cls='#32770'), None, 'fixture.png'))
        self.assertEqual(screen._picker_elements.call_count, 2)
        invoke.assert_called_once()

    def test_uia_picker_can_focus_and_paste_if_value_pattern_cannot_write(self):
        screen, field, value, invoke = self.picker()
        value.SetValue.side_effect = RuntimeError('read only provider')
        screen.gui._input.key.side_effect = lambda vk, **kw: setattr(value, 'Value', 'fixture.png') if vk == 0x56 else None
        self.assertTrue(screen.select_image(frame(hwnd=200, cls='#32770'), None, 'fixture.png'))
        field.SetFocus.assert_called_once()
        invoke.assert_called_once()
        screen.click.assert_not_called()

    def test_uia_picker_refuses_ambiguous_fields_and_wrong_process(self):
        screen, field, value, invoke = self.picker()
        screen.pid = 999
        self.assertFalse(screen.select_image(frame(hwnd=200, cls='#32770'), None, 'fixture.png'))
        value.SetValue.assert_not_called()
        invoke.assert_not_called()
        screen.pid = 42
        screen._picker_controls = lambda root: [field, field]
        self.assertFalse(screen.select_image(frame(hwnd=200, cls='#32770'), None, 'fixture.png'))
        value.SetValue.assert_not_called()
        invoke.assert_not_called()

    def test_picker_accepts_editable_combobox_and_split_open_button(self):
        screen, field, value, invoke = self.picker()
        root = screen.uia.ControlFromHandle(200)
        search, host, button = root.GetChildren()
        host.ControlTypeName = 'ComboBoxControl'
        host.GetValuePattern = field.GetValuePattern
        host.GetChildren = lambda: []
        button.ControlTypeName = 'SplitButtonControl'
        self.assertTrue(screen.select_image(frame(hwnd=200, cls='#32770'), None, 'fixture.png'))
        self.assertEqual(value.Value, 'fixture.png')
        invoke.assert_called_once()

    def test_picker_prunes_file_items_so_filename_is_not_lost_to_node_budget(self):
        screen, field, value, invoke = self.picker()
        root = screen.uia.ControlFromHandle(200)
        original = root.GetChildren()
        entries = SimpleNamespace(ControlTypeName='ListControl', GetChildren=Mock(side_effect=AssertionError('do not enumerate files')),
                                  IsOffscreen=False, IsEnabled=True, AutomationId='Items', Name='')
        root.GetChildren = lambda: [entries, *original]
        self.assertTrue(screen.select_image(frame(hwnd=200, cls='#32770'), None, 'fixture.png'))
        entries.GetChildren.assert_not_called()
        invoke.assert_called_once()

    def test_picker_can_bind_native_field_when_uia_tree_omits_it(self):
        screen, field, value, invoke = self.picker()
        root = screen.uia.ControlFromHandle(200)
        search, host, button = root.GetChildren()
        root.GetChildren = lambda: []
        screen.uia.ControlFromHandle = lambda hwnd: {200: root, 10: field, 50: button}[hwnd]
        parents = {10: 20, 20: 30, 30: 200}
        screen.win = SimpleNamespace(
            EnumChildWindows=lambda hwnd, callback, data: [callback(10, data)],
            GetClassName=lambda hwnd: 'Edit', IsWindowVisible=lambda hwnd: True,
            IsWindowEnabled=lambda hwnd: True, GetDlgCtrlID=lambda hwnd: 1148 if hwnd == 30 else 0,
            GetParent=lambda hwnd: parents.get(hwnd, 0), GetDlgItem=lambda hwnd, item: 50)
        self.assertTrue(screen.select_image(frame(hwnd=200, cls='#32770'), None, 'fixture.png'))
        self.assertEqual(value.Value, 'fixture.png')
        invoke.assert_called_once()

    def test_file_picker_must_close_before_editor_is_touched(self):
        screen = self.screen([frame(), frame('选照片或视频'), frame(hwnd=200, cls='#32770')])
        screen.picker_closed.return_value = False
        self.assertEqual(publish_flow(screen, '测试发图文案', 'fixture.png', pause=lambda _: None),
                         ('failed', 'image_picker_still_open'))
        screen.find_editor.assert_not_called()
        screen.fill_empty.assert_not_called()

    def test_picker_timeout_reports_failure_and_cleans_up_without_publishing(self):
        screen = self.screen([frame(), frame('发表图片/视频'), frame(hwnd=200, cls='#32770')])
        screen.select_image.side_effect = TimeoutError()
        self.assertEqual(publish_flow(screen, '测试文案', 'fixture.png', pause=lambda _: None),
                         ('failed', 'image_dialog_timeout'))
        screen.fill_empty.assert_not_called()
        screen.cancel_pending.assert_called_once()

    def test_missing_image_preview_never_publishes(self):
        screen = self.screen([frame(), frame('发表图片'), frame('文件名', '打开', hwnd=200, cls='#32770'), frame('发表')])
        screen.image_visible.return_value = False
        screen.capture.side_effect = [frame(), frame('发表图片'), frame(hwnd=200, cls='#32770'), frame('发表')] + [frame('发表')] * 8
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
        screen.visible_windows = Mock(return_value=[100])
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
        edit.SetFocus = Mock(side_effect=lambda: setattr(edit, 'HasKeyboardFocus', True))
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
        edit.SetFocus.assert_called_once()
        screen.click.assert_not_called()
        screen.gui.set_clipboard.assert_called_once_with('待发文案')
        screen.gui._input.key.assert_called_once_with(0x56, ctrl=True)
        self.assertFalse(screen.text_matches(blank, '待发文案'))
        value.Value = '待发文案'
        button.IsEnabled = True
        self.assertTrue(screen.text_matches(blank, '待发文案'))
        self.assertEqual(screen.publish_button(blank), (572, 439))
        self.assertFalse(screen.fill_empty(blank, '另一条文案'))

    def test_composer_resize_rebinds_editor_before_verified_submit(self):
        resized = frame('发表')
        resized.rect = (0, 0, 800, 640)
        screen = self.screen([frame(), frame('发表文字'), frame(), resized])
        self.assertEqual(publish_flow(screen, '正文已确认', pause=lambda _: None), ('unconfirmed', ''))
        self.assertEqual(screen.find_editor.call_count, 2)
        self.assertEqual(screen.click.call_args.args[0].rect, resized.rect)

    def test_waits_for_delayed_text_readback_without_typing_again(self):
        screen = self.screen([frame(), frame('发表文字'), frame()] + [frame('发表')] * 5)
        screen.text_matches.side_effect = [False] * 4 + [True]
        self.assertEqual(publish_flow(screen, '文案等待回读', pause=lambda _: None), ('unconfirmed', ''))
        screen.fill_empty.assert_called_once()
        self.assertEqual(screen.text_matches.call_count, 5)

    def test_publish_clicks_verified_button_once_and_refuses_changed_draft(self):
        screen = WeChatPostScreen.__new__(WeChatPostScreen)
        screen.verify = Mock()
        screen.allowed = Mock(return_value=True)
        screen.text_matches = Mock(return_value=True)
        screen._point = lambda frame, target: (400, 450)
        invoke = Mock()
        screen.publish_target = SimpleNamespace(ControlTypeName='ButtonControl', Name='发表', IsOffscreen=False,
            IsEnabled=True, GetInvokePattern=lambda: SimpleNamespace(Invoke=invoke))
        screen.click = Mock()
        screen.submit(frame(), (400, 450), '完整文案')
        invoke.assert_not_called()
        screen.click.assert_called_once()
        screen.text_matches.return_value = False
        with self.assertRaises(RuntimeError):
            screen.submit(frame(), (400, 450), '完整文案')
        invoke.assert_not_called()
        screen.click.assert_called_once()

    def test_fill_uses_uia_value_pattern_and_does_not_replace_existing_draft(self):
        screen = WeChatPostScreen.__new__(WeChatPostScreen)
        screen.verify, screen.allowed = Mock(), Mock(return_value=True)
        value = SimpleNamespace(Value='')
        value.SetValue = Mock(side_effect=lambda text: setattr(value, 'Value', text))
        screen.edit = SimpleNamespace(GetValuePattern=lambda: value)
        self.assertTrue(screen.fill_empty(frame(), '准备发表的文案'))
        self.assertEqual(value.Value, '准备发表的文案')
        self.assertFalse(screen.fill_empty(frame(), '不能覆盖原文'))
        value.SetValue.assert_called_once()

    def test_fill_preserves_user_input_arriving_during_gate_check(self):
        screen = WeChatPostScreen.__new__(WeChatPostScreen)
        value = SimpleNamespace(Value='')
        value.SetValue = Mock(side_effect=lambda text: setattr(value, 'Value', text))
        screen.edit = SimpleNamespace(GetValuePattern=lambda: value)
        screen.verify = Mock()
        def user_types():
            value.Value = '用户正在手动编辑'
            return True
        screen.allowed = user_types
        self.assertFalse(screen.fill_empty(frame(), '自动生成的文案'))
        value.SetValue.assert_not_called()
        self.assertEqual(value.Value, '用户正在手动编辑')

    def test_image_preview_recognition_uses_windows_display_scale(self):
        try:
            import cv2
            from PIL import Image, ImageOps
        except ImportError:
            self.skipTest('image recognition dependencies unavailable')
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            image = Image.effect_noise((240, 180), 70).convert('RGB')
            file = str(Path(directory) / 'preview.png')
            image.save(file)
            screenshot = Image.new('RGB', (600, 400), 'white')
            screenshot.paste(ImageOps.fit(image, (192, 192)), (50, 90))
            screen = WeChatPostScreen.__new__(WeChatPostScreen)
            screen.gui = SimpleNamespace(_input=SimpleNamespace(
                _user32=SimpleNamespace(GetDpiForWindow=lambda hwnd: 192)))
            self.assertTrue(screen.image_visible(SimpleNamespace(hwnd=100, image=screenshot), file))
            self.assertFalse(screen.image_visible(SimpleNamespace(hwnd=100,
                image=Image.new('RGB', (600, 400), 'white')), file))

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
        self.assertEqual(publish_flow(screen, '测试文案', pause=lambda _: None), ('unconfirmed', 'submit_not_observed'))
        screen.return_to_chat.assert_not_called()
        self.assertEqual(screen.click.call_count, 3)
        self.assertEqual(screen.editor_closed.call_count, 20)


if __name__ == '__main__':
    unittest.main()
