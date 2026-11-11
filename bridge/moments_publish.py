"""Bounded OCR flow for the experimental Moments publisher."""
import os
import re
import time

try:
    from wechatauto import wxlog as _wxlog
except Exception:  # 纯函数测试环境没有 wechatauto
    _wxlog = None


def _note(message):
    if _wxlog is not None:
        try:
            _wxlog.info(message)
        except Exception:
            pass


def _norm(value):
    # OCR 会把菜单文字识别成「发表文字(C)」「发表文字…」或带全角括号；
    # 去掉空白和标点后再比，别因为一个括号整条菜单都认不出来。
    return re.sub(r'[^0-9A-Za-z\u4e00-\u9fff]', '', str(value or ''))


def label(lines, wanted, *, top=None, fuzzy=False):
    want = _norm(wanted)
    exact = []
    near = []
    for value, x, y, w, h in lines:
        if top is not None and y > top:
            continue
        text = _norm(value)
        if not text or not want:
            continue
        point = (x + w // 2, y + h // 2)
        if text == want:
            exact.append(point)
        elif fuzzy and (want in text or (len(text) >= 3 and text in want)):
            near.append(point)
    return exact[0] if exact else (near[0] if near else None)


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
    # 亮色/暗色主题的图形对比度方向相反；模板和反相模板都试。
    for source in (template, 255 - template):
        for factor in (0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4):
            tile = cv2.resize(source, None, fx=scale * factor, fy=scale * factor)
            h, w = tile.shape
            if h > strip.shape[0] or w > strip.shape[1]:
                continue
            scores = np.abs(cv2.matchTemplate(strip, tile, cv2.TM_CCOEFF_NORMED))
            _, score, _, (x, y) = cv2.minMaxLoc(scores)
            hits.append((score, left + x + w // 2, y + h // 2))
    if not hits:
        return None
    score, x, y = max(hits)
    _note('朋友圈发表：相机模板最佳分=%.3f' % score)
    return (x, y) if score >= 0.80 else None


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
        action = next((point for name in actions if (point := label(menu.lines, name, fuzzy=True))), None)
        if not action and hasattr(screen, 'menu_point'):
            action = screen.menu_point(menu, actions)
        if not action:
            ocr = '|'.join(str(value) for value, *_ in menu.lines[:12])
            _note('朋友圈发表：右键菜单未识别 OCR=' + (ocr or '（空）'))
            return 'failed', 'image_menu_not_recognized' if image else 'text_menu_not_recognized'
        _note('朋友圈发表：右键菜单已识别')
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
        _note('朋友圈发表：准备点击发表按钮')
        screen.click(ready, publish)
        # 点完「发表」后不再碰 UIA：微信发布瞬间 UI 线程忙，
        # editor_closed/return_to_chat 里的 GetChildren/IsOffscreen 可能无限期阻塞，
        # 表现就是「卡在点击发表按钮，然后不动」。成败交给下面的数据库核验，
        # 回聊天页也交给用户或下一次操作，不再自动导航。
        _note('朋友圈发表：点击已发送，跳过点击后的 UIA 检查')
        pause(0.6)
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

    def menu_point(self, frame, names):
        """右键菜单的 UIA 兜底：OCR 认不出文字时，按控件名找菜单项。"""
        try:
            root = self.uia.ControlFromHandle(frame.hwnd)
            if root is None:
                return None
            wanted = [_norm(name) for name in names if _norm(name)]
            for control in self._controls(root):
                text = _norm(getattr(control, 'Name', ''))
                if not text or getattr(control, 'IsOffscreen', False):
                    continue
                if any(w in text or (len(text) >= 3 and text in w) for w in wanted):
                    point = self._point(frame, control)
                    if point:
                        return point
        except Exception:
            return None
        return None

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
            point = self.camera_uia(frame, header)
            if point is not None:
                return point
            # Header offsets come from UIA; capture only the bounded toolbar band.
            toolbar_bottom = min(int(r.bottom), int(r.top) + round(110 * dpi / 96))
            if toolbar_bottom <= int(r.top):
                return None
            self.verify(frame)
            toolbar = self.grab(bbox=(int(r.left), int(r.top), int(r.right), toolbar_bottom), all_screens=True)
            point = find_camera_icon(toolbar, dpi)
            if point is None:
                _note('朋友圈发表：相机图标未识别（header=%s）' % header.ClassName)
                return None
            return int(r.left) - left + point[0], int(r.top) - top + point[1]
        except Exception:
            return None

    def camera_uia(self, frame, header):
        """UIA 兜底：相机按钮如果带「发表/相机/拍照」名字，直接点它。"""
        names = []
        try:
            for control in self._controls(header):
                if control.ControlTypeName != 'ButtonControl':
                    continue
                name = (control.Name or '').strip()
                if name:
                    names.append(name)
                if getattr(control, 'IsOffscreen', False):
                    continue
                if any(key in name for key in ('发表', '相机', '拍照', '朋友圈')):
                    point = self._point(frame, control)
                    if point:
                        _note('朋友圈发表：UIA 找到相机按钮 %s' % name[:20])
                        return point
            if names:
                _note('朋友圈发表：header buttons=' + '|'.join(names[:10]))
        except Exception:
            pass
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
