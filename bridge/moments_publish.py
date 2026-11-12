"""Bounded OCR flow for the experimental Moments publisher."""
import os
import re
import time
from moments_ocr import MomentsOCRError

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
    return exact[0] if len(exact) == 1 else (near[0] if fuzzy and not exact and len(near) == 1 else None)


def menu_action(lines, image):
    names = (('发表图片', '发表图片朋友圈', '发表图文', '发表图片和视频', '发表图片或视频',
              '发表图片/视频', '发表照片和视频', '发表照片或视频', '发表照片/视频',
              '选照片或视频', '选图片或视频', '选择图片或视频', '选择图片和视频', '选择照片或视频', '选择照片和视频', '图片或视频', '照片或视频', '图片和视频', '照片和视频')
             if image else ('发表文字', '发表文字朋友圈'))
    matches = [point for name in names if (point := label(lines, name))]
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
    report = getattr(screen, 'report', lambda stage: None)
    try:
        # UIA already identified the timeline. The integrated header may only
        # show icons, and OCR of the feed can find unrelated occurrences.
        timeline = screen.capture(recognize=False)
        report('camera')
        camera = screen.camera(timeline)
        if not camera:
            return 'failed', 'camera_not_recognized'
        if not screen.allowed():
            return 'failed', 'job_cancelled'
        screen.remember_existing_inputs(timeline)
        screen.click(timeline, camera, right=True)
        pause(0.5)
        report('menu')
        menu = screen.capture_menu()
        action = screen.menu_action(menu, bool(image))
        if not action:
            # OCR 可能把背景里的朋友圈正文一起读进来，只记行数，不记文字。
            _note('朋友圈发表：右键菜单未识别（OCR 行数=%d）' % len(menu.lines))
            return 'failed', 'image_menu_not_recognized' if image else 'text_menu_not_recognized'
        _note('朋友圈发表：右键菜单已识别')
        screen.click(menu, action)
        if image:
            report('image_dialog')
            for _ in range(24):
                pause(0.25)
                if not screen.allowed():
                    return 'failed', 'job_cancelled'
                dialog = screen.capture(recognize=False)
                if dialog.cls == '#32770':
                    break
            else:
                return 'failed', 'image_dialog_not_recognized'
            if not screen.select_image(dialog, None, image):
                return 'failed', 'image_dialog_not_recognized'
            for _ in range(24):
                pause(0.25)
                if not screen.allowed():
                    return 'failed', 'job_cancelled'
                if screen.picker_closed(dialog):
                    break
            else:
                return 'failed', 'image_picker_still_open'
            report('image_selected')
        report('editor')
        for _ in range(16):
            pause(0.35)
            editor = screen.capture(recognize=False)
            if screen.find_editor(editor):
                break
        else:
            return 'failed', 'editor_not_recognized'
        if image:
            report('image_preview')
            for _ in range(8):
                pause(0.25)
                editor = screen.capture()
                if screen.image_visible(editor, image):
                    break
                if not screen.allowed():
                    return 'failed', 'job_cancelled'
            else:
                return 'failed', 'image_preview_not_recognized'
        if not screen.allowed():
            return 'failed', 'job_cancelled'
        report('draft')
        if not screen.fill_empty(editor, text):
            return 'failed', 'editor_not_empty'
        publish = None
        for _ in range(10):
            pause(0.2)
            ready = screen.capture(recognize=False, pixels=bool(image))
            if ready.hwnd != editor.hwnd:
                return 'failed', 'draft_not_verified'
            if ready.rect != editor.rect:
                # 文案/图片可能让编辑窗重新排版；对新几何重新确认控件，而非直接放弃。
                if not screen.find_editor(ready):
                    return 'failed', 'draft_not_verified'
                editor = ready
            if screen.text_matches(ready, text):
                publish = screen.publish_button(ready)
                if publish:
                    break
        try:
            getattr(screen, 'draft_probe', lambda frame, text: None)(ready, text)
        except Exception:
            pass
        if not publish:
            return 'failed', 'draft_not_verified'
        if image and not screen.image_visible(ready, image):
            return 'failed', 'image_preview_not_recognized'
        if not screen.allowed():
            return 'failed', 'job_cancelled'
        report('submit')
        clicked = True
        screen.submit(ready, publish, text)
        report('submitted')
        closed = False
        try:
            for _ in range(20):
                pause(0.25)
                if screen.editor_closed(ready):
                    closed = True
                    screen.return_to_chat()
                    break
        except Exception:
            # Submission verification still runs if the window disappears mid-scan.
            pass
        return 'unconfirmed', '' if closed else 'submit_not_observed'
    except MomentsOCRError:
        return ('unconfirmed' if clicked else 'failed'), 'ocr_transport_error'
    except TimeoutError:
        return ('unconfirmed' if clicked else 'failed'), 'image_dialog_timeout'
    except Exception:
        return ('unconfirmed' if clicked else 'failed'), 'ocr_transport_error'
    finally:
        if not clicked:
            screen.cancel_pending()


class WeChatPostScreen:
    def __init__(self, gui, hwnd, pid, timeline, allowed, foreground):
        import win32gui
        import win32process
        import uiautomation
        from moments_ocr import MomentsOCR
        from PIL import ImageGrab

        self.gui, self.hwnd, self.pid, self.timeline = gui, hwnd, pid, timeline
        self.win, self.process, self.uia = win32gui, win32process, uiautomation
        self.ocr, self.grab, self.allowed = MomentsOCR, ImageGrab.grab, allowed
        self.edit = None
        self.editor_scope = None
        self.timeline_inputs = set()
        self.editor_hwnd = 0
        self.timeline_hwnd = timeline.GetTopLevelControl().NativeWindowHandle
        self.foreground = foreground
        self.chat_restored = False
        self.menu_open = False
        self.picker_hwnd = 0
        self.before_menu_windows = set()
        self.publish_target = None

    def capture(self, *, recognize=True, pixels=False):
        from types import SimpleNamespace

        hwnd = self.win.GetForegroundWindow()
        if self.process.GetWindowThreadProcessId(hwnd)[1] != self.pid:
            raise RuntimeError('focus changed')
        rect = self.win.GetWindowRect(hwnd)
        # 两行的相机菜单高度可能不足 100，不能按主窗的最小尺寸拒绝它。
        if rect[2] - rect[0] < 60 or rect[3] - rect[1] < 20:
            raise RuntimeError('window too small')
        image = self.grab(bbox=rect, all_screens=True) if recognize or pixels else None
        return SimpleNamespace(hwnd=hwnd, rect=rect, cls=self.win.GetClassName(hwnd),
                               image=image, lines=self.ocr.recognize(image) if recognize else [])

    def visible_windows(self):
        windows = []
        def collect(hwnd, _):
            try:
                if (self.win.IsWindowVisible(hwnd)
                        and self.process.GetWindowThreadProcessId(hwnd)[1] == self.pid):
                    windows.append(hwnd)
            except Exception:
                # 弹窗可能在枚举过程中关闭。
                pass
        self.win.EnumWindows(collect, None)
        return windows

    def capture_menu(self):
        from types import SimpleNamespace

        foreground = self.win.GetForegroundWindow()
        if self.process.GetWindowThreadProcessId(foreground)[1] != self.pid:
            raise RuntimeError('focus changed')
        candidates = []
        for hwnd in self.visible_windows():
            if hwnd in self.before_menu_windows:
                continue
            rect = self.win.GetWindowRect(hwnd)
            if 60 <= rect[2] - rect[0] <= 700 and 20 <= rect[3] - rect[1] <= 700:
                candidates.append((hwnd, rect))
        # Qt 的菜单可能是独立弹窗，前台句柄却仍是微信主窗。
        if len(candidates) != 1:
            return self.capture()
        hwnd, rect = candidates[0]
        image = self.grab(bbox=rect, all_screens=True)
        return SimpleNamespace(hwnd=foreground, rect=rect, scope_hwnd=hwnd,
                               window_rect=self.win.GetWindowRect(foreground),
                               cls=self.win.GetClassName(hwnd), image=image,
                               lines=self.ocr.recognize(image))

    def verify(self, frame, x=None, y=None):
        if (self.win.GetForegroundWindow() != frame.hwnd
                or self.process.GetWindowThreadProcessId(frame.hwnd)[1] != self.pid
                or self.win.GetWindowRect(frame.hwnd) != getattr(frame, 'window_rect', frame.rect)):
            raise RuntimeError('focus or geometry changed')
        scope = getattr(frame, 'scope_hwnd', None)
        if scope and (not self.win.IsWindowVisible(scope)
                      or self.process.GetWindowThreadProcessId(scope)[1] != self.pid
                      or self.win.GetWindowRect(scope) != frame.rect):
            raise RuntimeError('menu changed')
        if x is not None:
            hit = self.win.WindowFromPoint((x, y))
            if not hit or self.process.GetWindowThreadProcessId(hit)[1] != self.pid:
                raise RuntimeError('point is covered')

    def click(self, frame, point, right=False):
        x, y = point[0] + frame.rect[0], point[1] + frame.rect[1]
        self.verify(frame, x, y)
        self.gui._input.send_input_click(x, y, right=right)
        self.menu_open = right

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

    def menu_action(self, frame, image):
        self.verify(frame)
        recognized = menu_action(frame.lines, image)
        if recognized:
            return recognized
        if frame.image is not None and frame.image.width <= 700 and frame.image.height <= 700:
            # 小字号会漏掉菜单末尾的「视频」。只对已核实的菜单重做两倍 OCR，
            # 仍要求完整文字精确命中，再把坐标换回原图，不能按半句猜入口。
            from PIL import Image
            enlarged = frame.image.resize((frame.image.width * 2, frame.image.height * 2),
                                          Image.Resampling.LANCZOS)
            recognized = menu_action(self.ocr.recognize(enlarged), image)
            if recognized:
                self.verify(frame)
                return recognized[0] // 2, recognized[1] // 2
        root = self.uia.ControlFromHandle(getattr(frame, 'scope_hwnd', frame.hwnd))
        points = []
        if root is not None:
            for control in self._controls(root):
                if control.ControlTypeName not in ('MenuItemControl', 'ButtonControl') or control.IsOffscreen:
                    continue
                point = self._point(frame, control)
                if point and menu_action([(control.Name or '', *point, 0, 0)], image):
                    points.append(point)
        return points[0] if len(points) == 1 else menu_action(frame.lines, image)

    @staticmethod
    def _filename_field(control):
        if (control.ControlTypeName not in ('EditControl', 'ComboBoxControl') or control.IsOffscreen
                or not control.IsEnabled):
            return False
        node = control
        for _ in range(5):
            if node is None:
                break
            identifier = str(node.AutomationId or '').lower()
            name = str(node.Name or '').replace('&', '').lower()
            if 'search' in identifier or '搜索' in name:
                return False
            if identifier in ('1148', '1152', 'filenamecontrolhost') or '文件名' in name or 'file name' in name:
                return True
            node = node.GetParentControl()
        return False

    @staticmethod
    def _picker_controls(root):
        from collections import deque
        pending = deque([(root, 0)])
        for _ in range(350):
            if not pending:
                break
            control, depth = pending.popleft()
            yield control
            try:
                # 文件条目与目录树不是文件名输入框；遍历它们会耗尽节点预算。
                if depth < 14 and control.ControlTypeName not in (
                        'ListControl', 'TreeControl', 'DataGridControl', 'TableControl'):
                    pending.extend((child, depth + 1) for child in control.GetChildren())
            except Exception:
                pass

    def _native_picker_fields(self, dialog):
        fields = []
        def inspect(hwnd, _):
            if (self.win.GetClassName(hwnd) != 'Edit' or not self.win.IsWindowVisible(hwnd)
                    or not self.win.IsWindowEnabled(hwnd)):
                return
            parent = hwnd
            for _ in range(6):
                if not parent or parent == dialog.hwnd:
                    break
                if self.win.GetDlgCtrlID(parent) in (1148, 1152):
                    fields.append(hwnd)
                    break
                parent = self.win.GetParent(parent)
        self.win.EnumChildWindows(dialog.hwnd, inspect, None)
        return list(dict.fromkeys(fields))

    def _picker_elements(self, dialog):
        root = self.uia.ControlFromHandle(dialog.hwnd)
        root_matches = root is not None and root.ProcessId == self.pid
        fields, buttons = [], []
        description = []
        for control in self._picker_controls(root) if root_matches else ():
            try:
                role = control.ControlTypeName
                if role in ('EditControl', 'ComboBoxControl', 'ButtonControl', 'SplitButtonControl'):
                    identifier = str(control.AutomationId or '')
                    # 不采集 Name / Value：它们可能含文件名、搜索词和本机路径。
                    if len(description) < 24:
                        description.append({'type': role, 'id': identifier if identifier.isascii()
                                            and identifier.replace('_', '').isalnum() and len(identifier) <= 60 else ''})
                if self._filename_field(control):
                    fields.append(control)
                elif (role in ('ButtonControl', 'SplitButtonControl') and not control.IsOffscreen
                      and str(control.AutomationId) == '1'):
                    buttons.append(control)
            except Exception:
                continue
        # 原生 HWND 能直接定位标准对话框控件，不依赖 UIA 树是否展开了组合框内部。
        try:
            native_fields = self._native_picker_fields(dialog)
            if len(native_fields) == 1:
                native_field = self.uia.ControlFromHandle(native_fields[0])
                if native_field is not None:
                    fields = [native_field]
            native_button = self.win.GetDlgItem(dialog.hwnd, 1)
            if native_button and self.win.IsWindowVisible(native_button):
                control = self.uia.ControlFromHandle(native_button)
                if control is not None:
                    buttons = [control]
        except Exception:
            pass
        edits = [field for field in fields if field.ControlTypeName == 'EditControl']
        if len(edits) == 1:
            fields = edits
        probe = getattr(self, 'probe', lambda details: None)
        probe({'fields': len(fields), 'buttons': len(buttons), 'controls': description})
        return fields, buttons

    def select_image(self, dialog, open_button, image):
        self.verify(dialog)
        if dialog.cls != '#32770' or not self.allowed():
            return False
        self.picker_hwnd = dialog.hwnd
        report = getattr(self, 'report', lambda stage: None)
        report('file_field')
        for attempt in range(3):
            self.verify(dialog)
            if not self.allowed():
                return False
            fields, buttons = self._picker_elements(dialog)
            if len(fields) == 1 and len(buttons) == 1:
                break
            if attempt < 2:
                time.sleep(0.5)
        else:
            return False
        field, button = fields[0], buttons[0]
        self.verify(dialog)
        if not self.allowed():
            return False
        report('file_path')
        try:
            if field.GetValuePattern().SetValue(image) is False:
                raise RuntimeError('filename provider rejected input')
        except Exception:
            # 不支持 ValuePattern 时仍通过控件取得焦点，不再按坐标点击文件名框。
            field.SetFocus()
            self.verify(dialog)
            if not field.HasKeyboardFocus or not self.allowed():
                return False
            if self.gui.set_clipboard(image) is False:
                return False
            self.gui._input.key(0x41, ctrl=True)
            self.gui._input.key(0x56, ctrl=True)
        for _ in range(4):
            time.sleep(0.1)
            self.verify(dialog)
            if self._edit_value(field) == image:
                break
        else:
            return False
        if not self.allowed():
            return False
        self.verify(dialog)
        report('file_open')
        if not button.IsEnabled:
            return False
        button.GetInvokePattern().Invoke()
        return True

    def picker_closed(self, dialog):
        return not self.win.IsWindow(dialog.hwnd) or not self.win.IsWindowVisible(dialog.hwnd)

    def cancel_pending(self):
        # 只关闭已核实属于本次微信操作的菜单/选图框，编辑器正文留给用户处理。
        try:
            frame = self.capture(recognize=False)
            if not self.allowed():
                return
            if frame.cls == '#32770' and frame.hwnd == self.picker_hwnd:
                self.verify(frame)
                self.gui._input.key(0x1B)
            elif self.menu_open and not self.editor_hwnd:
                self.verify(frame)
                self.gui._input.key(0x1B)
            if not self.editor_hwnd:
                self.return_to_chat()
        except Exception:
            pass

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
        self.before_menu_windows = set(self.visible_windows())
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
        if not self.allowed():
            return False
        self.verify(frame)
        current = self._edit_value(edit)
        if current is None or current.strip():
            return False
        try:
            if edit.GetValuePattern().SetValue(text) is False:
                raise RuntimeError('value provider rejected input')
            return True
        except Exception:
            current = self._edit_value(edit)
            if current and current.strip():
                return current.strip() == text.strip()
        if not edit.HasKeyboardFocus:
            edit.SetFocus()
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
        self.publish_target = None
        buttons = [c for c in self._controls(self.editor_scope) if self._publish_control(c)]
        if buttons:
            if len(buttons) == 1 and buttons[0].IsEnabled:
                point = self._point(frame, buttons[0])
                if point:
                    self.publish_target = buttons[0]
                    return point
            return None
        scanned = self.capture()
        if scanned.hwnd != frame.hwnd or scanned.rect != frame.rect:
            return None
        return label(scanned.lines, '发表')

    def draft_probe(self, frame, text):
        value = self._edit_value(self.edit)
        buttons = [c for c in self._controls(self.editor_scope) if self._publish_control(c)]
        getattr(self, 'probe', lambda details: None)({'draft': True, 'readable': value is not None,
            'length': len(value or ''), 'expected': len(text),
            'matches': value is not None and value.strip() == text.strip(),
            'buttons': len(buttons), 'enabled': len(buttons) == 1 and buttons[0].IsEnabled})

    def submit(self, frame, point, text):
        self.verify(frame)
        if not self.allowed() or not self.text_matches(frame, text):
            raise RuntimeError('draft changed before submit')
        target = self.publish_target
        if target is not None:
            if (not self._publish_control(target) or not target.IsEnabled
                    or self._point(frame, target) != point):
                raise RuntimeError('publish control changed')
            # 微信自绘按钮的 Invoke 可返回成功但没有触发发布。
            # UIA 只用于确认按钮及边界；本次任务只发送一次真实点击。
        getattr(self, 'probe', lambda details: None)({'submit': True, 'x': int(point[0]), 'y': int(point[1]),
            'width': int(frame.rect[2] - frame.rect[0]), 'height': int(frame.rect[3] - frame.rect[1])})
        self.click(frame, point)

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
        dpi = self.gui._input._user32.GetDpiForWindow(frame.hwnd) or 96
        sizes = sorted({round(size * dpi / 96) for size in (64, 72, 80, 88, 96, 100, 108, 112, 120, 128, 144, 160)})
        with Image.open(file) as im:
            im = ImageOps.exif_transpose(im).convert('RGB')
            for size in sizes:
                tile = ImageOps.fit(im, (size, size))
                gray = cv2.cvtColor(np.asarray(tile), cv2.COLOR_RGB2GRAY)
                if float(gray.std()) < 10 or min(source.shape) < size:
                    continue
                result = cv2.matchTemplate(source, gray, cv2.TM_CCOEFF_NORMED)
                if float(result.max()) >= 0.91:
                    return True
        return False


def publish(runtime, moment, query, allowed, *, report=lambda stage: None, probe=lambda details: None, confirm=True):
    from sticker_transport import validate_path
    from moments import collect

    text = query.get('text')
    image = query.get('image', '')
    if not isinstance(text, str) or not 8 <= len(text) <= 120:
        return 'failed', 'invalid_draft'
    hwnd = int(runtime.ACCOUNT.get('hwnd') or 0)
    if not hwnd or not allowed():
        return 'failed', 'account_not_verified'
    import win32gui
    import win32process
    # 部分账号识别路径只保存 hwnd 和 verified，缺少缓存 PID 不代表未认证。
    # 从已认证的窗口取实际 PID；有旧绑定时仍拒绝进程不一致。
    if not win32gui.IsWindow(hwnd):
        return 'failed', 'window_unavailable'
    pid = int(win32process.GetWindowThreadProcessId(hwnd)[1])
    bound_pid = int(runtime.ACCOUNT.get('pid') or 0)
    if not pid or (bound_pid and bound_pid != pid):
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
    report('timeline')
    switched = moment._wx.SwitchToMoments()
    # Older WeChat can open a separate SNS window, which the merged-layout
    # locator does not scan. Only accept the foreground window of this PID.
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
        screen.report = report
        screen.probe = probe
    except Exception:
        return 'failed', 'timeline_not_recognized'
    status, error = publish_flow(screen, text, image)
    if confirm and status == 'unconfirmed' and not error:
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
