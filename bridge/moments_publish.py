"""Bounded OCR flow for the experimental Moments publisher."""
import os
import time


def label(lines, wanted, *, top=None):
    matches = [(x + w // 2, y + h // 2) for value, x, y, w, h in lines
               if ''.join(value.split()) == wanted and (top is None or y <= top)]
    return matches[0] if len(matches) == 1 else None


def find_camera_icon(image, dpi):
    import cv2
    import numpy as np
    from PIL import Image

    # 只在朋友圈工具栏内匹配相机图形。右侧另一个按钮位置接近，不能按边距猜。
    width, height = image.size
    scale = dpi / 96
    left = max(0, width - round(250 * scale))
    strip = np.asarray(image.crop((left, 0, width, height)).convert('L'))
    with Image.open(os.path.join(os.path.dirname(__file__), 'moments-camera.png')) as reference:
        template = np.asarray(reference.convert('L'))
    hits = []
    for factor in (0.8, 1.0, 1.2):
        tile = cv2.resize(template, None, fx=scale * factor, fy=scale * factor)
        h, w = tile.shape
        if h > strip.shape[0] or w > strip.shape[1]:
            continue
        # 亮色和暗色主题的图形对比度方向相反。
        scores = np.abs(cv2.matchTemplate(strip, tile, cv2.TM_CCOEFF_NORMED))
        _, score, _, (x, y) = cv2.minMaxLoc(scores)
        hits.append((score, left + x + w // 2, y + h // 2))
    if not hits:
        return None
    score, x, y = max(hits)
    return (x, y) if score >= 0.85 else None


def publish_flow(screen, text, image='', *, pause=time.sleep):
    """All input is scoped to the verified WeChat process by the adapter."""
    clicked = False
    try:
        # UIA already identified the timeline. The integrated header may only
        # show icons, and OCR of the feed can find unrelated occurrences.
        timeline = screen.capture(recognize=False)
        camera = screen.camera(timeline)
        if not camera:
            return 'failed', 'camera_not_recognized'
        if not screen.allowed():
            return 'failed', 'job_cancelled'
        screen.remember_existing_inputs(timeline)
        screen.click(timeline, camera, right=True)
        pause(0.5)
        menu = screen.capture()
        actions = ('发表图片', '发表图片朋友圈', '发表图文') if image else ('发表文字', '发表文字朋友圈')
        action = next((point for name in actions if (point := label(menu.lines, name))), None)
        if not action:
            return 'failed', 'image_menu_not_recognized' if image else 'text_menu_not_recognized'
        screen.click(menu, action)
        if image:
            pause(0.5)
            dialog = screen.capture()
            filename = label(dialog.lines, '文件名:') or label(dialog.lines, '文件名：') or label(dialog.lines, '文件名')
            open_button = label(dialog.lines, '打开') or label(dialog.lines, '打开(O)')
            if not filename or not open_button or dialog.cls != '#32770':
                return 'failed', 'image_dialog_not_recognized'
            screen.select_image(dialog, open_button, image)
        for _ in range(3):
            pause(0.35)
            editor = screen.capture(recognize=bool(image))
            if screen.find_editor(editor):
                break
        else:
            return 'failed', 'editor_not_recognized'
        if image and not screen.image_visible(editor, image):
            return 'failed', 'image_preview_not_recognized'
        if not screen.allowed():
            return 'failed', 'job_cancelled'
        if not screen.fill_empty(editor, text):
            return 'failed', 'editor_not_empty'
        for _ in range(3):
            pause(0.2)
            ready = screen.capture(recognize=bool(image))
            if ready.hwnd != editor.hwnd or ready.rect != editor.rect:
                return 'failed', 'draft_not_verified'
            if screen.text_matches(ready, text):
                publish = screen.publish_button(ready)
                if publish:
                    break
        else:
            return 'failed', 'draft_not_verified'
        if image and not screen.image_visible(ready, image):
            return 'failed', 'image_preview_not_recognized'
        if not screen.allowed():
            return 'failed', 'job_cancelled'
        clicked = True
        screen.click(ready, publish)
        try:
            for _ in range(3):
                pause(0.25)
                if screen.editor_closed(ready):
                    screen.return_to_chat()
                    break
        except Exception:
            # Submission verification still runs if the window disappears mid-scan.
            pass
        return 'unconfirmed', ''
    except Exception:
        return ('unconfirmed' if clicked else 'failed'), 'ocr_transport_error'


class WeChatPostScreen:
    def __init__(self, gui, hwnd, pid, timeline, allowed, foreground):
        import win32gui
        import win32process
        import uiautomation
        from wechatauto.guia import ScreenOCR
        from PIL import ImageGrab

        self.gui, self.hwnd, self.pid, self.timeline = gui, hwnd, pid, timeline
        self.win, self.process, self.uia = win32gui, win32process, uiautomation
        self.ocr, self.grab, self.allowed = ScreenOCR, ImageGrab.grab, allowed
        self.edit = None
        self.editor_scope = None
        self.timeline_inputs = set()
        self.editor_hwnd = 0
        self.timeline_hwnd = timeline.GetTopLevelControl().NativeWindowHandle
        self.foreground = foreground
        self.chat_restored = False

    def capture(self, *, recognize=True):
        from types import SimpleNamespace

        hwnd = self.win.GetForegroundWindow()
        if self.process.GetWindowThreadProcessId(hwnd)[1] != self.pid:
            raise RuntimeError('focus changed')
        rect = self.win.GetWindowRect(hwnd)
        if rect[2] - rect[0] < 180 or rect[3] - rect[1] < 100:
            raise RuntimeError('window too small')
        image = self.grab(bbox=rect, all_screens=True) if recognize else None
        return SimpleNamespace(hwnd=hwnd, rect=rect, cls=self.win.GetClassName(hwnd),
                               image=image, lines=self.ocr.recognize(image) if recognize else [])

    def verify(self, frame, x=None, y=None):
        if (self.win.GetForegroundWindow() != frame.hwnd
                or self.process.GetWindowThreadProcessId(frame.hwnd)[1] != self.pid
                or self.win.GetWindowRect(frame.hwnd) != frame.rect):
            raise RuntimeError('focus or geometry changed')
        if x is not None:
            hit = self.win.WindowFromPoint((x, y))
            if not hit or self.process.GetWindowThreadProcessId(hit)[1] != self.pid:
                raise RuntimeError('point is covered')

    def click(self, frame, point, right=False):
        x, y = point[0] + frame.rect[0], point[1] + frame.rect[1]
        self.verify(frame, x, y)
        self.gui._input.send_input_click(x, y, right=right)

    def camera(self, frame):
        try:
            root = self.timeline.GetTopLevelControl()
            if (self.timeline.ProcessId != self.pid
                    or root.NativeWindowHandle != frame.hwnd):
                return None
            header = self.timeline
            if header.ClassName == 'mmui::TimeLineListView':
                # The list starts below the camera. Find the enclosing header.
                while header is not None and header.ClassName not in (
                    'mmui::SNSContentView', 'mmui::SNSWindow',
                ):
                    header = header.GetParentControl()
            if header is None or header.ClassName not in ('mmui::SNSContentView', 'mmui::SNSWindow'):
                return None
            r = header.BoundingRectangle
            left, top, right, bottom = frame.rect
            if not (left <= r.left < r.right <= right and top <= r.top < r.bottom <= bottom):
                return None
            dpi = self.gui._input._user32.GetDpiForWindow(frame.hwnd) or 96
            # Header offsets come from UIA; capture only the bounded toolbar band.
            toolbar_bottom = min(int(r.bottom), int(r.top) + round(75 * dpi / 96))
            if toolbar_bottom <= int(r.top):
                return None
            self.verify(frame)
            toolbar = self.grab(bbox=(int(r.left), int(r.top), int(r.right), toolbar_bottom), all_screens=True)
            point = find_camera_icon(toolbar, dpi)
            if point is None:
                return None
            return int(r.left) - left + point[0], int(r.top) - top + point[1]
        except Exception:
            return None

    def select_image(self, dialog, open_button, image):
        import win32con

        self.verify(dialog)
        # The standard Windows file dialog exposes its filename edit under 1148.
        combo = self.win.GetDlgItem(dialog.hwnd, 1148)
        edit = self.win.FindWindowEx(combo, 0, 'Edit', None) if combo else 0
        if not edit and combo and self.win.GetClassName(combo) == 'Edit':
            edit = combo
        if not edit:
            raise RuntimeError('missing filename edit')
        self.win.SendMessage(edit, win32con.WM_SETTEXT, 0, image)
        control = self.uia.ControlFromHandle(edit)
        pattern = control.GetValuePattern() if control is not None else None
        if pattern is None or pattern.Value != image:
            raise RuntimeError('filename not verified')
        self.click(dialog, open_button)

    @staticmethod
    def _controls(root):
        from collections import deque

        pending = deque([(root, 0)])
        for _ in range(350):
            if not pending:
                break
            control, depth = pending.popleft()
            yield control
            if depth < 14:
                try:
                    pending.extend((child, depth + 1) for child in control.GetChildren())
                except Exception:
                    pass

    @staticmethod
    def _edit_value(control):
        try:
            value = control.GetValuePattern().Value
            if isinstance(value, str):
                return value
        except Exception:
            pass
        try:
            return control.GetTextPattern().DocumentRange.GetText(-1)
        except Exception:
            return None

    @staticmethod
    def _edit_control(control):
        return (control.ControlTypeName in ('EditControl', 'DocumentControl')
                and control.IsKeyboardFocusable and control.IsEnabled and not control.IsOffscreen
                and '搜索' not in (control.Name or '') and 'search' not in (control.AutomationId or '').lower())

    @staticmethod
    def _publish_control(control):
        return (control.ControlTypeName == 'ButtonControl'
                and (control.Name or '').strip() in ('发表', '发布') and not control.IsOffscreen)

    @staticmethod
    def _point(frame, control):
        r = control.BoundingRectangle
        left, top, right, bottom = frame.rect
        if not (left <= r.left < r.right <= right and top <= r.top < r.bottom <= bottom):
            return None
        return int((r.left + r.right) / 2) - left, int((r.top + r.bottom) / 2) - top

    def remember_existing_inputs(self, frame):
        self.verify(frame)
        root = self.uia.ControlFromHandle(frame.hwnd)
        if root is None:
            raise RuntimeError('timeline UIA root unavailable')
        # A hidden chat input can still be present in WeChat's accessibility tree.
        self.timeline_inputs = {tuple(c.GetRuntimeId()) for c in self._controls(root)
                                if c.ControlTypeName in ('EditControl', 'DocumentControl')}

    def find_editor(self, frame):
        self.verify(frame)
        root = self.uia.ControlFromHandle(frame.hwnd)
        if root is None:
            return False
        controls = list(self._controls(root))
        buttons = [c for c in controls if self._publish_control(c) and self._point(frame, c)]
        scopes = []
        if len(buttons) == 1:
            # Prefer the smallest composer container shared by the field and button.
            parent = buttons[0].GetParentControl()
            for _ in range(6):
                if parent is None:
                    break
                scopes.append(parent)
                if parent.NativeWindowHandle == frame.hwnd:
                    break
                parent = parent.GetParentControl()
        else:
            lines = frame.lines or self.capture().lines
            if (not label(lines, '发表文字') and not label(lines, '发表')
                    and not any('这一刻的想法' in line[0] for line in lines)):
                return False
            scopes.append(root)
        for scope in scopes:
            edits = [c for c in self._controls(scope) if self._edit_control(c) and self._point(frame, c)
                     and (frame.hwnd != self.timeline_hwnd or tuple(c.GetRuntimeId()) not in self.timeline_inputs)
                     and self._edit_value(c) is not None]
            if len(edits) == 1:
                self.edit, self.editor_scope = edits[0], scope
                self.editor_hwnd = frame.hwnd
                return True
            if len(edits) > 1:
                return False
        return False

    def fill_empty(self, frame, text):
        self.verify(frame)
        edit = self.edit
        if edit is None:
            return False
        before = self._edit_value(edit)
        if before is None or before.strip():
            return False
        if not edit.HasKeyboardFocus:
            point = self._point(frame, edit)
            if point is None:
                return False
            self.click(frame, point)
        self.verify(frame)
        current = self._edit_value(edit)
        if not edit.HasKeyboardFocus or current is None or current.strip():
            return False
        if not self.allowed() or self.gui.set_clipboard(text) is False:
            return False
        self.verify(frame)
        if not edit.HasKeyboardFocus or not self.allowed():
            return False
        self.gui._input.key(0x56, ctrl=True)
        return True

    def text_matches(self, frame, text):
        self.verify(frame)
        value = self._edit_value(self.edit)
        return value is not None and value.strip() == text.strip()

    def publish_button(self, frame):
        self.verify(frame)
        buttons = [c for c in self._controls(self.editor_scope) if self._publish_control(c)]
        if buttons:
            return self._point(frame, buttons[0]) if len(buttons) == 1 and buttons[0].IsEnabled else None
        scanned = self.capture()
        if scanned.hwnd != frame.hwnd or scanned.rect != frame.rect:
            return None
        return label(scanned.lines, '发表')

    def editor_closed(self, frame):
        foreground = self.win.GetForegroundWindow()
        if foreground not in (self.hwnd, self.timeline_hwnd, frame.hwnd):
            return False
        if foreground != frame.hwnd:
            return not self.win.IsWindow(frame.hwnd) or not self.win.IsWindowVisible(frame.hwnd)
        try:
            return self.edit.IsOffscreen
        except Exception:
            # An embedded composer can disappear by invalidating its UIA element.
            # Require a working tree with a visible timeline and no composer button.
            root = self.uia.ControlFromHandle(foreground)
            if root is None:
                return False
            controls = list(self._controls(root))
            return (any(c.ClassName in ('mmui::SNSContentView', 'mmui::TimeLineListView')
                        and not c.IsOffscreen for c in controls)
                    and not any(self._publish_control(c) for c in controls))

    def return_to_chat(self):
        if self.chat_restored:
            return
        try:
            foreground = self.win.GetForegroundWindow()
            if (foreground not in (self.hwnd, self.timeline_hwnd, self.editor_hwnd)
                    or self.process.GetWindowThreadProcessId(foreground)[1] != self.pid
                    or not self.allowed()):
                return
            if foreground != self.hwnd and not self.foreground(self.hwnd):
                return
            frame = self.capture(recognize=False)
            if frame.hwnd != self.hwnd:
                return
            root = self.uia.ControlFromHandle(self.hwnd)
            if root is None:
                return
            tabbar = next((c for c in self._controls(root) if c.ClassName == 'mmui::MainTabBar'), None)
            if tabbar is None:
                return
            tabs = [c for c in self._controls(tabbar)
                    if (c.Name or '').strip() in ('微信', '聊天') and not c.IsOffscreen
                    and (c.ClassName == 'mmui::XTabBarItem' or c.ControlTypeName in ('ButtonControl', 'TabItemControl'))]
            if len(tabs) != 1:
                return
            point = self._point(frame, tabs[0])
            if point:
                self.click(frame, point)
                self.chat_restored = True
        except Exception:
            # Navigation must not change the outcome or cause a second publish.
            pass

    def image_visible(self, frame, file):
        import cv2
        import numpy as np
        from PIL import Image, ImageOps

        # A visual thumbnail match is needed in addition to a successful file dialog.
        # Unsupported crops/scales are allowed to fail closed.
        source = cv2.cvtColor(np.asarray(frame.image.convert('RGB')), cv2.COLOR_RGB2GRAY)
        with Image.open(file) as im:
            im = ImageOps.exif_transpose(im).convert('RGB')
            for size in (64, 72, 80, 88, 96, 100, 108, 112, 120, 128, 144, 160):
                tile = ImageOps.fit(im, (size, size))
                gray = cv2.cvtColor(np.asarray(tile), cv2.COLOR_RGB2GRAY)
                if float(gray.std()) < 10 or min(source.shape) < size:
                    continue
                result = cv2.matchTemplate(source, gray, cv2.TM_CCOEFF_NORMED)
                if float(result.max()) >= 0.91:
                    return True
        return False


def publish(runtime, moment, query, allowed):
    from sticker_transport import validate_path
    from moments import collect

    text = query.get('text')
    image = query.get('image', '')
    if not isinstance(text, str) or not 8 <= len(text) <= 120:
        return 'failed', 'invalid_draft'
    hwnd = int(runtime.ACCOUNT.get('hwnd') or 0)
    pid = int(runtime.ACCOUNT.get('pid') or 0)
    if not hwnd or not pid or not allowed():
        return 'failed', 'account_not_verified'
    if image:
        root = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'moments', 'post-images')
        try:
            image, _ = validate_path(image, root)
            if os.path.getsize(image) > 8 * 1024 * 1024 or not image.lower().endswith(('.png', '.jpg', '.jpeg')):
                return 'failed', 'invalid_image'
        except Exception:
            return 'failed', 'invalid_image'
    if not runtime.force_foreground(hwnd):
        return 'failed', 'wechat_not_foreground'
    started = time.time()
    switched = moment._wx.SwitchToMoments()
    # Older WeChat can open a separate SNS window, which the merged-layout
    # locator does not scan. Only accept the foreground window of this PID.
    import win32gui
    import win32process
    foreground = win32gui.GetForegroundWindow()
    if (foreground and foreground != hwnd
            and win32process.GetWindowThreadProcessId(foreground)[1] == pid
            and win32gui.GetClassName(foreground) == 'mmui::SNSWindow'):
        import uiautomation
        timeline = uiautomation.ControlFromHandle(foreground)
    else:
        timeline = moment._find_sns_window() if switched else None
    if timeline is None:
        return 'failed', 'timeline_not_recognized'
    try:
        screen = WeChatPostScreen(runtime.gui, hwnd, pid, timeline, allowed, runtime.force_foreground)
    except Exception:
        return 'failed', 'timeline_not_recognized'
    status, error = publish_flow(screen, text, image)
    if status == 'unconfirmed' and not error:
        # A matching own post with a fresh timestamp is positive evidence.
        for _ in range(3):
            time.sleep(1)
            try:
                rows = collect(runtime.db, {'own': True, 'limit': 8})
                if any(row['own'] and row['text'].strip() == text
                       and float(row['create_time']) >= int(started)
                       and row['imageCount'] == int(bool(image)) for row in rows):
                    screen.return_to_chat()
                    return 'confirmed', ''
            except Exception:
                break
    return status, error
