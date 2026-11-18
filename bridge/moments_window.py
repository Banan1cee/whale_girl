"""朋友圈和表情包共用的限时前台切换。"""
import time


def _unlock_foreground():
    import win32api

    # 用户正按着修饰键或鼠标时，不合成 Alt 组合键，也不释放用户自己按下的键。
    if any(win32api.GetAsyncKeyState(key) & 0x8000
           for key in (0x10, 0x11, 0x12, 0x5B, 0x5C, 0x01, 0x02)):
        return False
    try:
        win32api.keybd_event(0x12, 0, 0, 0)
    finally:
        win32api.keybd_event(0x12, 0, 2, 0)
    return True


def activate_verified_window(runtime, hwnd, pid, allowed, *, pause=time.sleep,
                             unlock=None, probe=lambda details: None):
    import win32gui as win
    import win32process as process

    attempts = 0

    def valid():
        return bool(win.IsWindow(hwnd) and process.GetWindowThreadProcessId(hwnd)[1] == pid)

    def ready():
        return (valid() and win.GetForegroundWindow() == hwnd
                and win.IsWindowVisible(hwnd) and not win.IsIconic(hwnd))

    try:
        # 单窗绑定等入口只记录 HWND，此处固定第一次核验到的进程。
        if not pid and win.IsWindow(hwnd):
            pid = process.GetWindowThreadProcessId(hwnd)[1]
        if not pid or not valid() or not allowed():
            return False
        # SetForegroundWindow 可能返回失败/抛异常，但窗口其实已经在前台。
        if ready():
            return True
        previous = win.GetForegroundWindow()
        for attempt in range(2):
            if not valid() or not allowed():
                return False
            if attempt:
                if win.GetForegroundWindow() not in (0, previous, hwnd):
                    return False
                if not (unlock or _unlock_foreground)():
                    return False
                pause(0.05)
                if not valid() or not allowed():
                    return False
                if win.GetForegroundWindow() not in (0, previous, hwnd):
                    return False
            attempts += 1
            try:
                runtime.force_foreground(hwnd)
            except Exception:
                pass
            # ShowWindowAsync 只表示恢复请求已投递，必须等实际前台状态。
            for tick in range(11):
                if not valid():
                    return False
                if ready():
                    return True
                foreground = win.GetForegroundWindow()
                if foreground and foreground not in (previous, hwnd):
                    return False
                if tick < 10:
                    pause(0.05)
        return False
    except Exception:
        return False
    finally:
        try:
            foreground = win.GetForegroundWindow()
            probe({'window': True, 'attempts': attempts, 'ready': ready(),
                   'sameProcess': bool(foreground and process.GetWindowThreadProcessId(foreground)[1] == pid),
                   'visible': bool(win.IsWindowVisible(hwnd)), 'iconic': bool(win.IsIconic(hwnd))})
        except Exception:
            pass


activate_for_publish = activate_verified_window
