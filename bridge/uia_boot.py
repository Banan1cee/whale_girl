#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UIA 自检与自动物化（微信 4.x，含 4.2.0.9）。

为什么要有这个文件，而不是直接用 wechatauto 的 `_hot_activate_accessibility`：

1. **窗口句柄会过期。** 微信更新/重启后窗口重开，桥接手里攥着旧 hwnd 时，
   第三方库会照着那个 hwnd 去取 PID，然后对着一个不相干的进程报
   「热激活 UIA 失败：PID xxx 未找到 Weixin.dll」，而且每 4 秒重试一次，
   整场退回 OCR。实测日志：连续 7 次同一个不存在的 PID。
2. **它的成功判据太弱。** `_mmui_present()` 只看根窗口类名是不是 `mmui::`，
   可 4.2 的根窗口类名本来就叫 `mmui::MainWindow`（空壳也是），于是写错字节
   也会判成功，字节留在 1，后面再也不重试。
3. **版本表没有 4.2.0.9。** 只能靠特征扫描，扫出来的第一个候选不一定是真的
   那个 gate；至少要"写进去→看会话列表有没有出来→不对就还原"地挨个试。

所以这里做三件事：挑对窗口（PID 里真有 Weixin.dll）、用真判据校验（树里真有
`mmui::ChatSessionList`）、挨个试候选 RVA 并把成功的那个写进库缓存。
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import threading
import time
from ctypes import wintypes
from typing import Dict, List, Optional

# 树里出现这些类名，才算「会话列表真的物化了」。只看根窗口类名不算。
TREE_MARKERS = (
    "mmui::ChatSessionList",
    "mmui::XTableView",
    "mmui::ChatSessionCell",
)
SESSION_MARKERS = ("mmui::ChatSessionList", "mmui::ChatSessionCell")

# 已知「扫描扫不出来、但实测可用」的兜底 RVA。键是 Weixin.dll 的版本目录名。
# 4.2.0.9 目前靠库缓存的 verified 值（0xB4F7C08）工作；表里留空是为了不写死，
# 真命中了再补。
KNOWN_GATE_RVA: Dict[str, int] = {}

_BAD_CLASS = (
    "trayicon", "messagewindow", "msctf", "sopy", "sogou", "hintwnd",
    "default ime", "notifyicon",
)

#: 同一进程内小于最大窗 40% 的顶层窗视为辅助窗（微信 4.2 的隐藏 Qt 窗）。
AUX_WINDOW_RATIO = 0.4
#: 同进程只有「最大窗 ≥ 4 倍次大窗、面积 ≥ 50 万」时才允许直接选最大窗。
LARGEST_PICK_RATIO = 4
LARGEST_PICK_MIN_AREA = 500000


# ── 挑窗口 ─────────────────────────────────────────────────────────
def is_wechat_main_title(title: str) -> bool:
    """只匹配客户端的主窗标题，避免把设置、登录提示和独立聊天窗算进去。"""
    return (title or "").strip().casefold() in ("微信", "weixin", "wechat")


def _account_window_size(win32gui, hwnd, minimized):
    rect = win32gui.GetWindowPlacement(hwnd)[4] if minimized else win32gui.GetWindowRect(hwnd)
    return rect[2] - rect[0], rect[3] - rect[1]


def is_wechat_account_window(win32gui, hwnd: int) -> bool:
    """登录账号的主窗候选。微信 4.x 的隐藏辅助窗也可能用相同标题和 Qt 类名。"""
    try:
        cls = (win32gui.GetClassName(hwnd) or "").casefold()
        if "login" in cls or not ("qwindowicon" in cls or cls == "mmui::mainwindow"):
            return False
        if not is_wechat_main_title(win32gui.GetWindowText(hwnd)):
            return False
        # 最小化时窗口矩形可能退化，使用还原后的主窗尺寸。
        width, height = _account_window_size(win32gui, hwnd, win32gui.IsIconic(hwnd))
        return width >= 250 and height >= 250
    except Exception:
        return False


def prefer_main_windows(candidates, *, ratio: float = AUX_WINDOW_RATIO, win32gui=None):
    """同一进程内按面积去掉辅助窗；跨进程绝不合并。

    微信 4.2 会在同一个进程里再挂一个 262x296 的隐藏 Qt 顶层窗，类名和标题
    都和主窗一样。只按「可见/最小化」过滤时，这个辅助窗仍可能混进候选，
    最后变成「两个候选无法确认」。这里按面积统一处理：不到同进程最大窗
    40% 的一律当辅助窗。分属不同进程的窗口互不影响，多账号安全底线不变。
    """
    rows = []
    for item in (candidates or []):
        try:
            key = (int(item[0]), int(item[1]))
        except (TypeError, ValueError, IndexError):
            continue
        if key not in rows:
            rows.append(key)
    if len(rows) <= 1:
        return rows

    if win32gui is None:
        try:
            import win32gui
        except Exception:
            return rows

    areas = {}
    minimized_windows = set()
    for hwnd, pid in rows:
        try:
            minimized = bool(win32gui.IsIconic(hwnd))
            if minimized:
                # 最小化的窗口矩形会退化，不能拿它和主窗比面积；保留给会话树证据判断。
                minimized_windows.add((hwnd, pid))
            width, height = _account_window_size(win32gui, hwnd, minimized)
            areas[(hwnd, pid)] = max(0, width) * max(0, height)
        except Exception:
            areas[(hwnd, pid)] = 0

    largest = {}
    for (hwnd, pid), area in areas.items():
        if pid:
            largest[pid] = max(largest.get(pid, 0), area)

    kept = []
    for hwnd, pid in rows:
        area = areas.get((hwnd, pid), 0)
        top = largest.get(pid, 0)
        if (hwnd, pid) in minimized_windows:
            kept.append((hwnd, pid))
            continue
        # 读不到面积的窗口不能误杀，保留下来交给会话树证据判断。
        if top and area and area < top * ratio:
            continue
        kept.append((hwnd, pid))
    return kept or rows


def account_window_candidates(win32gui, win32process, hwnds):
    """微信 4.2 的小型隐藏 Qt 窗也可能使用主窗标题和类名。"""
    candidates = {}
    for hwnd in dict.fromkeys(map(int, hwnds)):
        if not is_wechat_account_window(win32gui, hwnd):
            continue
        try:
            pid = int(win32process.GetWindowThreadProcessId(hwnd)[1] or 0)
        except Exception:
            pid = 0
        try:
            minimized = bool(win32gui.IsIconic(hwnd))
            visible = bool(win32gui.IsWindowVisible(hwnd)) or minimized
            width, height = _account_window_size(win32gui, hwnd, minimized)
            candidates[hwnd] = (pid, visible, width * height)
        except Exception:
            candidates[hwnd] = (pid, None, 0)

    # 独立进程和双开仍全部保留；只有同一 PID 内的面积辅助窗会被去掉。
    return prefer_main_windows(
        [(hwnd, pid) for hwnd, (pid, _v, _a) in candidates.items()],
        win32gui=win32gui,
    )


def _iter_windows() -> List[dict]:
    """所有候选主窗（不过滤 PID 有没有 Weixin.dll）。"""
    try:
        import win32gui
        import win32process
        import psutil
    except Exception:
        return []

    out: List[dict] = []
    BAD = _BAD_CLASS

    def cb(h, _):
        try:
            title = (win32gui.GetWindowText(h) or "").strip()
            cls = win32gui.GetClassName(h) or ""
            low = cls.lower()
            if any(b in low for b in BAD):
                return True
            _, pid = win32process.GetWindowThreadProcessId(h)
            if pid <= 0:
                return True
            try:
                name = psutil.Process(pid).name().lower()
            except Exception:
                return True
            if not name.startswith("weixin"):
                return True
            rect = win32gui.GetWindowRect(h)
            area = max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])
            out.append({
                "hwnd": int(h),
                "pid": int(pid),
                "title": title,
                "cls": cls,
                "area": area,
                "foreground": bool(win32gui.GetForegroundWindow() == h),
                "minimized": bool(win32gui.IsIconic(h)),
            })
        except Exception:
            pass
        return True

    try:
        win32gui.EnumWindows(cb, None)
    except Exception:
        return []
    return out


def pick_window(prefer_hwnd: int = 0, *, strict: bool = False) -> Optional[dict]:
    """挑一个「PID 里真的加载了 Weixin.dll」的微信主窗。

    优先级：调用方钉住的窗口 → 标题正好是「微信」→ 前台 → 面积大。
    任何一个候选只要 PID 里没有 Weixin.dll（渲染子进程/辅助进程/已被回收的
    句柄），直接排除 —— 这正是旧日志里「未找到 Weixin.dll」的来源。
    """
    try:
        from wechatauto.accessibility import AccessibilityGate as G
    except Exception:
        return None

    wins = _iter_windows()
    if not wins:
        return None

    scored = []
    for w in wins:
        if strict and w["hwnd"] != prefer_hwnd:
            continue
        if "login" in w["cls"].lower():
            continue
        mod = G._weixin_dll_module(w["pid"])
        if not mod:
            continue
        base, _size, dll = mod
        try:
            import os
            version = os.path.basename(os.path.dirname(dll))
        except Exception:
            version = ""
        w = dict(w)
        w["base"] = int(base)
        w["dll"] = dll
        w["version"] = version
        score = 0
        if prefer_hwnd and w["hwnd"] == int(prefer_hwnd):
            score += 10 ** 9
        if is_wechat_main_title(w["title"]):
            score += 10 ** 6
        if w["foreground"]:
            score += 10 ** 4
        if "QWindowIcon" in w["cls"] or w["cls"].startswith("mmui::"):
            score += 10 ** 3
        score += min(w["area"], 10 ** 6)
        scored.append((score, w))

    if not scored:
        return None
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0][1]



# 每个线程都要先 CoInitialize 才能用 UIA；不然会刷
# "Can not load UIAutomationCore.dll" 并且永远拿不到控件。
_UIA_THREADS = set()


def _ensure_com() -> bool:
    try:
        import uiautomation as auto
    except Exception:
        return False
    import threading
    tid = threading.get_ident()
    if tid in _UIA_THREADS:
        return True
    try:
        auto.InitializeUIAutomationInCurrentThread()
    except Exception:
        try:
            import comtypes
            comtypes.CoInitializeEx()
        except Exception:
            return False
    _UIA_THREADS.add(tid)
    return True

# ── 判据 ───────────────────────────────────────────────────────────
def tree_state(hwnd: int, timeout: float = 1.0, max_nodes: int = 1200, *, account_window=False) -> str:
    """看控件树到底物化了没有：'ok' / 'shell' / 'unreachable'。

    账号择窗只接受指定句柄自己的会话列表，通用表格不能证明这是聊天主窗。
    """
    try:
        import uiautomation as auto
    except Exception:
        return "unreachable"
    if not _ensure_com():
        return "unreachable"
    deadline = time.monotonic() + max(0.2, timeout)
    while True:
        try:
            root = auto.ControlFromHandle(hwnd)
        except Exception:
            root = None
        if root is not None:
            break
        if time.monotonic() >= deadline:
            return "unreachable"
        time.sleep(0.15)

    markers = TREE_MARKERS
    if account_window:
        try:
            if int(root.NativeWindowHandle or 0) != hwnd:
                return "unreachable"
            if (root.ClassName or "").casefold().endswith("loginwindow"):
                return "login"
        except Exception:
            return "unreachable"
        markers = SESSION_MARKERS

    seen = 0
    stack = [(root, 0)]
    while stack and seen < max_nodes:
        node, depth = stack.pop()
        try:
            kids = node.GetChildren()
        except Exception:
            kids = []
        if account_window:
            kids = kids[:max_nodes - seen]
        seen += len(kids)
        for k in kids:
            if account_window and time.monotonic() >= deadline:
                return "unreachable"
            try:
                cn = getattr(k, "ClassName", "") or ""
            except Exception:
                cn = ""
            if cn in markers:
                return "ok"
            if depth < 12:
                stack.append((k, depth + 1))
    return "shell"


def resolve_account_windows(candidates):
    """进程已确认归属后，用窗口级证据区分主窗与辅助窗。"""
    if len(candidates) > 6:
        return None, [{"count": len(candidates), "tree": "too_many"}]
    import win32gui
    import win32process

    evidence = []
    for hwnd, pid in candidates:
        row = {"hwnd": hwnd, "pid": pid, "tree": "unreachable"}
        evidence.append(row)
        try:
            if win32process.GetWindowThreadProcessId(hwnd)[1] != pid:
                row["tree"] = "changed"
                continue
            minimized = bool(win32gui.IsIconic(hwnd))
            row.update(cls=win32gui.GetClassName(hwnd), visible=bool(win32gui.IsWindowVisible(hwnd)),
                       minimized=minimized, size=_account_window_size(win32gui, hwnd, minimized))
        except Exception:
            continue
        try:
            row["root_owner"] = win32gui.GetAncestor(hwnd, 3)  # GA_ROOTOWNER
        except Exception:
            pass
        row["tree"] = tree_state(hwnd, timeout=0.5, max_nodes=500, account_window=True)
        try:
            if win32process.GetWindowThreadProcessId(hwnd)[1] != pid:
                row["tree"] = "changed"
        except Exception:
            row["tree"] = "changed"

    chat = [row for row in evidence if row["tree"] == "ok"]
    if chat:
        return ((chat[0]["hwnd"], chat[0]["pid"]) if len(chat) == 1 else None), evidence

    # UIA 尚未预热时，要求唯一的原生主窗；隐藏的通用 Qt 句柄不能独立作为证据。
    native = [row for row in evidence if (row.get("cls") or "").casefold() == "mmui::mainwindow"
              and row["tree"] not in ("login", "changed")]
    if len(native) == 1:
        main = native[0]
        if main.get("root_owner") == main["hwnd"] and (main.get("visible") or main.get("minimized")):
            for other in evidence:
                if other is main or other["tree"] == "login":
                    continue
                if other["tree"] == "changed" or other["pid"] != main["pid"]:
                    break
                if other.get("root_owner") == main["hwnd"]:
                    continue
                if other.get("visible") is not False or other.get("minimized") is not False:
                    break
            else:
                return (main["hwnd"], main["pid"]), evidence

    # 兜底：同进程里只有一个「正常大小」的主窗，另一个是明显的小辅助窗。
    # 判据必须同时满足「同 PID + 最大窗 ≥ 4 倍次大窗 + 面积 ≥ 50 万」，
    # 跨进程（多账号）绝不走这条，避免把另一个号吞掉。
    sized = [row for row in evidence if row.get("size")]
    if len(evidence) >= 2 and len(sized) == len(evidence):
        pids = {row.get("pid") for row in evidence}
        blocked = any(row.get("tree") in ("login", "changed") for row in evidence)
        if len(pids) == 1 and not blocked:
            ranked = sorted(
                sized,
                key=lambda row: max(0, row["size"][0]) * max(0, row["size"][1]),
                reverse=True,
            )
            main = ranked[0]
            main_area = max(0, main["size"][0]) * max(0, main["size"][1])
            second_area = max(0, ranked[1]["size"][0]) * max(0, ranked[1]["size"][1])
            if (main_area >= LARGEST_PICK_MIN_AREA
                    and main_area >= LARGEST_PICK_RATIO * max(second_area, 1)):
                main["picked"] = "largest_in_single_pid"
                return (main["hwnd"], main["pid"]), evidence
    return None, evidence



# ── 让微信把窗口"正常打开" ──────────────────────────────────────────
_LAST_RESTORE = [0.0]
_RESTORE_LOCK = threading.Lock()   # 「检查 15 秒冷却 + 占坑」必须原子（L6）


def _release_restore_slot() -> None:
    """唤起失败时把冷却占坑回滚成 0（L6）：失败不算「刚唤起过」，下一轮能立刻重试。"""
    with _RESTORE_LOCK:
        _LAST_RESTORE[0] = 0.0


def _send_hotkey(log=None) -> bool:
    """按一次微信自己的「打开微信」热键 Ctrl+Alt+W。

    为什么不用 ShowWindow：微信缩托盘时只恢复窗口框，Qt 的渲染面和无障碍树
    不会重建，日志里就是「窗口可见但只有 1 个节点」。热键走的是微信自己的
    恢复逻辑，实测能同时把界面和控件树拉回来。
    """
    def say(msg):
        if callable(log):
            try:
                log(msg)
            except Exception:
                pass

    try:
        u32 = ctypes.windll.user32
        keys = (0x11, 0x12, 0x57)          # Ctrl / Alt / W
        for vk in keys:
            u32.keybd_event(vk, 0, 0, 0)
            time.sleep(0.03)
        for vk in reversed(keys):
            u32.keybd_event(vk, 0, 2, 0)   # KEYEVENTF_KEYUP
            time.sleep(0.03)
        return True
    except Exception as e:                  # noqa: BLE001
        say("UIA 自检：按 Ctrl+Alt+W 失败：%r" % (e,))
        return False


def wake_by_hotkey(hwnd: int, log=None, wait: float = 3.0) -> bool:
    """用 Ctrl+Alt+W 唤醒微信并等控件树重建。

    热键是**开关式**的：窗口正常时按一下会把微信缩回托盘。所以只在树坏掉时
    调用，并且按两次再判断——第一次可能恰好把它切回托盘，第二次才真正打开。
    """
    def say(msg):
        if callable(log):
            try:
                log(msg)
            except Exception:
                pass

    if not hwnd:
        return False
    if tree_state(hwnd, timeout=0.6) == "ok":
        return True

    for attempt in range(2):
        if not _send_hotkey(log=log):
            return False
        deadline = time.monotonic() + max(0.8, float(wait))
        while time.monotonic() < deadline:
            if tree_state(hwnd, timeout=0.5) == "ok":
                say("UIA 自检：Ctrl+Alt+W 已唤醒微信，控件树恢复")
                return True
            time.sleep(0.25)
        if attempt == 0:
            say("UIA 自检：第一次热键后控件树仍是空壳，再按一次（热键是开关式）")
    return False


class _NotifyIconIdentifier(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD),
                ("hWnd", wintypes.HWND),
                ("uID", wintypes.UINT),
                ("guidItem", ctypes.c_byte * 16)]


class _TrayRect(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def click_tray_icon(hwnd: int = 0, log=None) -> bool:
    """真实点击同一个微信进程的托盘图标，返回是否点中。

    优先用 ``Shell_NotifyIconGetRect`` 找图标位置，再移动鼠标点击。只尝试
    目标窗口所在进程，避免多开时点到另一个账号的托盘图标。
    """
    def say(msg):
        if callable(log):
            try:
                log(msg)
            except Exception:
                pass

    try:
        import win32process
        import win32gui
    except Exception:
        return False

    target_pid = 0
    if hwnd:
        try:
            target_pid = int(win32process.GetWindowThreadProcessId(hwnd)[1] or 0)
        except Exception:
            target_pid = 0

    handles = []
    for win in _iter_windows():
        if target_pid and int(win.get("pid") or 0) != target_pid:
            continue
        if int(win.get("hwnd") or 0) not in handles:
            handles.append(int(win["hwnd"]))
    if not handles:
        return False

    try:
        shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        shell32.Shell_NotifyIconGetRect.argtypes = [
            ctypes.POINTER(_NotifyIconIdentifier), ctypes.POINTER(_TrayRect)]
        shell32.Shell_NotifyIconGetRect.restype = ctypes.c_long
    except Exception:
        return False

    for handle in handles:
        for uid in (0, 1, 2):
            ident = _NotifyIconIdentifier()
            ident.cbSize = ctypes.sizeof(_NotifyIconIdentifier)
            ident.hWnd = handle
            ident.uID = uid
            rect = _TrayRect()
            try:
                hr = shell32.Shell_NotifyIconGetRect(ctypes.byref(ident), ctypes.byref(rect))
            except Exception:
                continue
            if hr != 0:
                continue
            x = (rect.left + rect.right) // 2
            y = (rect.top + rect.bottom) // 2
            if rect.right <= rect.left or rect.bottom <= rect.top:
                continue
            try:
                u32 = ctypes.windll.user32
                old = wintypes.POINT()
                u32.GetCursorPos(ctypes.byref(old))
                u32.SetCursorPos(int(x), int(y))
                u32.mouse_event(0x0002, 0, 0, 0, 0)    # LEFTDOWN
                time.sleep(0.05)
                u32.mouse_event(0x0004, 0, 0, 0, 0)    # LEFTUP
                u32.SetCursorPos(int(old.x), int(old.y))
                say("UIA 自检：已点击微信托盘图标（hwnd=%s uid=%s）" % (handle, uid))
                return True
            except Exception as e:              # noqa: BLE001
                say("UIA 自检：点击托盘图标失败：%r" % (e,))
                return False
    return False


def _wechat_hidden(hwnd: int) -> bool:
    try:
        import win32gui
        return (not win32gui.IsWindowVisible(hwnd)) or bool(win32gui.IsIconic(hwnd))
    except Exception:
        return False


def restore_wechat(win: dict, log=None, wait: float = 15.0) -> bool:
    """唤醒已存在的微信窗口，不另启实例，也不抢前台。

    关键区别：``ShowWindow`` 只能恢复窗口框，微信缩托盘时 Qt 的渲染面和
    无障碍树不会重建（现象是窗口发暗、只有 1 个节点）。所以优先点托盘图标 /
    按微信自己的 Ctrl+Alt+W；两步都失败才退回 ShowWindow 兜底。
    """
    def say(msg):
        if callable(log):
            try:
                log(msg)
            except Exception:
                pass

    if not win:
        return False

    hwnd = win["hwnd"]
    # 15 秒内只唤起一次：两次 ensure 并发时重复拉起会被微信忽略，反而拖慢。
    # 检查 + 占坑放进同一把锁（L6）：否则两个线程能同时通过检查、各拉起一次。
    now = time.time()
    with _RESTORE_LOCK:
        recent = now - _LAST_RESTORE[0] < 15
        if not recent:
            _LAST_RESTORE[0] = now
    if recent:
        deadline = now + 2.0
        while time.time() < deadline:
            if tree_state(hwnd, timeout=0.5) == "ok":
                return True
            time.sleep(0.3)
        return False

    if tree_state(hwnd, timeout=0.5) == "ok":
        return True

    hidden = _wechat_hidden(hwnd)
    acted = False
    # 1) 托盘图标：真实点击微信自己的托盘按钮，比 ShowWindow 更能触发重建。
    if hidden and click_tray_icon(hwnd, log=log):
        acted = True
        deadline = time.time() + max(1.0, wait)
        while time.time() < deadline:
            if tree_state(hwnd, timeout=0.5) == "ok":
                return _restore_result(win, hwnd, log)
            time.sleep(0.3)
        say("UIA 自检：托盘图标点过了，控件树还没恢复，改用热键")

    # 2) 全局热键：微信自己的「打开微信」，对隐藏和冻结空壳都有效。
    if wake_by_hotkey(hwnd, log=log):
        return _restore_result(win, hwnd, log)

    # 3) 最后的兜底：只显示已有窗口，绝不运行 Weixin.exe（多实例会另开登录窗）。
    if hidden:
        acted = True
        try:
            import win32gui
            import win32con
            win32gui.ShowWindow(hwnd, win32con.SW_SHOWNOACTIVATE)
            say("UIA 自检：热键没恢复，仅显示已有微信窗口并等待控件树（不启动新进程）")
        except Exception as e:                  # noqa: BLE001
            say("UIA 自检：显示微信窗口失败：%r" % (e,))

    if not acted:
        # 窗口本来就可见，热键也没恢复，再等也等不出界面，直接把问题交给 gate 分支。
        _release_restore_slot()
        return False

    deadline = time.time() + max(1.0, wait)
    while time.time() < deadline:
        if tree_state(hwnd, timeout=0.5) == "ok":
            return _restore_result(win, hwnd, log)
        time.sleep(0.4)

    say("UIA 自检：唤起了微信，但 %.0f 秒内控件树没出来" % wait)
    _release_restore_slot()
    return False


def _restore_result(win: dict, hwnd: int, log=None) -> bool:
    """恢复成功后确认窗口句柄仍是同一个进程，必要时更新调用方字典。"""
    w2 = pick_window(prefer_hwnd=hwnd, strict=True)
    if w2 and int(w2.get("pid") or 0) == int(win.get("pid") or 0):
        win.update(w2)
    return True


def _weixin_exe() -> str:
    """从正在运行的 Weixin.exe 里取安装路径（窗口消失时 pick_window 拿不到 pid）。"""
    try:
        import psutil
    except Exception:
        return ""
    for p in psutil.process_iter(["name", "exe"]):
        try:
            if (p.info.get("name") or "").lower() == "weixin.exe":
                exe = p.info.get("exe") or ""
                if exe and os.path.exists(exe):
                    return exe
        except Exception:
            continue
    # 兜底：常见安装路径
    for cand in (r"C:\Program Files\Tencent\Weixin\Weixin.exe",
                 r"C:\Program Files (x86)\Tencent\Weixin\Weixin.exe"):
        if os.path.exists(cand):
            return cand
    return ""


def _weixin_running() -> bool:
    try:
        import psutil
    except Exception:
        return False
    for p in psutil.process_iter(["name"]):
        try:
            if (p.info.get("name") or "").lower() == "weixin.exe":
                return True
        except Exception:
            continue
    return False


def launch_wechat(log=None, wait: float = 15.0):
    """微信没有主窗（彻底缩在托盘/窗口被销毁）时，把它拉起来。

    只在微信进程根本没运行时才运行 exe。进程还在时反复运行会另开登录实例
    （多开环境下用户当场就能看到第二个登录窗），所以改成唤醒已有窗口。

    返回 (win, already_ok)。win 是拉起后 pick_window() 的结果，可能为 None。
    """
    def say(msg):
        if callable(log):
            try:
                log(msg)
            except Exception:
                pass

    if _weixin_running():
        win = pick_window()
        if win and wake_by_hotkey(win["hwnd"], log=log):
            return win, True
        say("UIA 自检：微信进程还在，不另开实例；已尝试唤醒现有窗口")
        return win, bool(win and tree_state(win["hwnd"], 0.6) == "ok")

    exe = _weixin_exe()
    if not exe:
        say("UIA 自检：找不到 Weixin.exe，无法打开微信窗口")
        return None, False
    say("UIA 自检：微信没有主窗（缩在托盘），自动打开一次…")
    try:
        subprocess.Popen([exe], cwd=os.path.dirname(exe), close_fds=True)
    except Exception as e:                      # noqa: BLE001
        say("UIA 自检：打开微信失败：%r" % (e,))
        return None, False

    deadline = time.time() + max(2.0, wait)
    win = None
    while time.time() < deadline:
        win = pick_window()
        if win and tree_state(win["hwnd"], timeout=0.6) == "ok":
            close_stray_login_windows(win["hwnd"])
            return win, True
        time.sleep(0.4)
    return win, False

# ── 物化 ───────────────────────────────────────────────────────────
# kernel32 按 use_last_error=True 加载（对照 bg_sender.py 的 user32 写法）：
# 只有这样 ctypes.get_last_error() 才拿得到 OpenProcess 的真实错误码，
# err==5 的「桥接需要提权」提示才可信（L6；旧的 ctypes.windll 拿到的是假值）。
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


def _open_process(pid: int):
    k32 = kernel32
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = ctypes.c_void_p
    k32.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                      ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k32.WriteProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                       ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    # PROCESS_QUERY_INFORMATION | VM_OPERATION | VM_READ | VM_WRITE
    handle = k32.OpenProcess(0x0400 | 0x0008 | 0x0010 | 0x0020, False, pid)
    return (handle or 0), ctypes.get_last_error()


def _read_byte(h, addr: int) -> Optional[int]:
    # 必须用设置过 argtypes 的模块级 kernel32；ctypes.windll.kernel32 是另一个
    # 对象，64 位 HANDLE 会按默认 int 传参，读失败后会被误判成「候选 RVA 不对」。
    buf = (ctypes.c_ubyte * 1)()
    n = ctypes.c_size_t()
    ok = kernel32.ReadProcessMemory(
        wintypes.HANDLE(h), ctypes.c_void_p(addr), buf, 1, ctypes.byref(n))
    return int(buf[0]) if ok else None


def _write_byte(h, addr: int, value: int) -> bool:
    buf = (ctypes.c_ubyte * 1)(value)
    n = ctypes.c_size_t()
    return bool(kernel32.WriteProcessMemory(
        wintypes.HANDLE(h), ctypes.c_void_p(addr), buf, 1, ctypes.byref(n)))


def _close(h) -> None:
    try:
        kernel32.CloseHandle(wintypes.HANDLE(h))
    except Exception:
        pass


def candidate_rvas(dll: str, version: str) -> List[int]:
    """候选 gate RVA：版本表 → 已知兜底 → 库的扫描结果（去重保序）。"""
    out: List[int] = []
    try:
        from wechatauto.accessibility import (
            AccessibilityGate as G,
            QACCESSIBLE_ACTIVE_RVA_BY_VERSION,
        )
        known = QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(version)
        if known is not None:
            out.append(int(known))
        if version in KNOWN_GATE_RVA:
            out.append(int(KNOWN_GATE_RVA[version]))
        try:
            out.extend(int(x) for x in (G._qaccessible_candidate_rvas(dll) or ()))
        except Exception:
            pass
    except Exception:
        return []
    seen = set()
    uniq = []
    for rva in out:
        if rva in seen or rva <= 0:
            continue
        seen.add(rva)
        uniq.append(rva)
    return uniq




def close_stray_login_windows(keep_hwnd: int) -> None:
    """关掉「多拉起来的那一个」登录小窗。

    拉起 Weixin.exe 偶尔会另开一个实例（主实例正在退出/重建时会这样），
    留下一个 442x581 的登录窗。只要宽 ≥ 900 或高 ≥ 620 就当成正经主窗放过，
    其余「标题是微信 + 树是空壳」的小窗才关，避免误杀第二个真账号。
    """
    try:
        import win32gui
        import os
        try:
            import win32process
        except Exception:
            win32process = None
        target_pid = 0
        if win32process is not None:
            try:
                target_pid = int(win32process.GetWindowThreadProcessId(int(keep_hwnd))[1] or 0)
            except Exception:
                target_pid = 0
        for w in _iter_windows():
            if int(w["hwnd"]) == int(keep_hwnd) or w["title"] != "微信":
                continue
            # 只清理刚拉起的同一进程里的杂窗；别的账号窗口即使很小也不能碰。
            if target_pid and int(w.get("pid") or 0) != target_pid:
                continue
            rect = win32gui.GetWindowRect(w["hwnd"])
            bw, bh = rect[2] - rect[0], rect[3] - rect[1]
            if bw >= 900 or bh >= 620:
                continue          # 像正经主窗，不碰
            if tree_state(w["hwnd"], 0.4) == "ok":
                continue          # 已经有树，是正在用的号
            try:
                win32gui.PostMessage(w["hwnd"], 0x0010, 0, 0)   # WM_CLOSE
            except Exception:
                pass
    except Exception:
        pass


def _keep_visible(win: dict, log=None) -> None:
    """把窗口摆回可见位置并显示出来（测试期间可能被挪到屏幕外）。"""
    try:
        import win32gui
        import win32con
        hwnd = int(win["hwnd"])
        rect = win32gui.GetWindowRect(hwnd)
        x, y = rect[0], rect[1]
        # 只改位置和可见性，**绝不改尺寸**：实测改尺寸会让微信重建窗口、
        # 控件树直接塌回空壳（这一条把发送测试坑了一整轮）。
        if x < -200 or y < -200 or rect[2] <= rect[0]:
            x, y = 120, 80
            win32gui.SetWindowPos(hwnd, 0, x, y, 0, 0,
                                  win32con.SWP_NOZORDER | win32con.SWP_NOSIZE |
                                  win32con.SWP_SHOWWINDOW)
        else:
            win32gui.SetWindowPos(hwnd, 0, x, y, 0, 0,
                                  win32con.SWP_NOZORDER | win32con.SWP_NOSIZE |
                                  win32con.SWP_SHOWWINDOW)
        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
        if callable(log):
            log("UIA 自检：微信窗口已显示并留在屏幕上")
    except Exception:
        pass


def ensure(prefer_hwnd: int = 0, log=None, max_candidates: int = 6,
           settle: float = 1.2, *, strict: bool = False, wake: bool = True) -> dict:
    """确保 UIA 树可用。返回 {ok, reason, hwnd, pid, version, rva, tree}。

    reason 取值：
      already          本来就好
      asleep           树没出来，但调用方要求安静待命（wake=False）
      activated        本次写 gate 成功，树出来了
      no_window        没找到「PID 里带 Weixin.dll」的微信主窗
      denied           OpenProcess 被拒（微信是管理员，桥接不是）
      no_candidates    这个版本没有可用的候选 RVA
      not_materialized 候选都写了，树还是空壳
    """
    def say(msg):
        if callable(log):
            try:
                log(msg)
            except Exception:
                pass

    win = pick_window(prefer_hwnd, strict=strict)
    if not win:
        say("UIA 自检：没找到微信主窗，请手动打开已登录的微信；不会另启微信进程")
        return {"ok": False, "reason": "no_window"}

    hwnd, pid, version = win["hwnd"], win["pid"], win.get("version") or ""
    state = tree_state(hwnd, timeout=0.8)
    if state == "ok":
        return {"ok": True, "reason": "already", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": state}

    if not wake:
        # 心跳/巡检只读状态，不能把微信窗口弹出来吓用户；真正发送时再唤醒。
        return {"ok": False, "reason": "asleep", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": state}

    # 4.2 上最常见的情形：窗口缩在托盘里，UI 子树被销毁 → 先让它正常打开一次
    if restore_wechat(win, log=log):
        # restore 内部 win.update(w2) 可能已经换到新窗口（H6）：返回值必须从
        # 更新后的 win 重新取，别用上面 504 行的旧局部变量（对照下面延迟分支
        # 拿 w2["hwnd"] 的写法），否则 engine 会把过期 hwnd 写进 ACCOUNT。
        hwnd, pid = win["hwnd"], win["pid"]
        version = win.get("version") or version
        say(f"UIA 自检：微信 {version} 窗口已唤起，控件树重建成功")
        return {"ok": True, "reason": "restored", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": "ok"}

    handle, err = _open_process(pid)
    if not handle:
        say(f"UIA 自检：打不开 Weixin.exe PID {pid}（WinError {err}）"
            + ("——桥接需要和微信同级，请用管理员权限启动桥接" if err == 5 else ""))
        return {"ok": False, "reason": "denied", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": state, "winerror": err}

    rvas = candidate_rvas(win["dll"], version)
    if not rvas:
        _close(handle)
        say(f"UIA 自检：微信 {version} 没有可用候选 RVA（库版本表 + 特征扫描都空）")
        return {"ok": False, "reason": "no_candidates", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": state}

    base = win["base"]
    read_failed = []
    write_failed = []
    try:
        for rva in rvas[:max_candidates]:
            addr = base + rva
            current = _read_byte(handle, addr)
            if current is None:
                read_failed.append(rva)
                continue
            wrote = False
            if current != 1:
                if not _write_byte(handle, addr, 1):
                    write_failed.append(rva)
                    continue
                wrote = True
            # 等树长出来（有的机器要 0.5~1 秒）
            deadline = time.time() + settle
            ok = False
            while time.time() < deadline:
                if tree_state(hwnd, timeout=0.5) == "ok":
                    ok = True
                    break
                time.sleep(0.2)
            if ok:
                _remember(win["dll"], rva)
                say(f"UIA 自检：微信 {version} 物化成功（Weixin.dll+0x{rva:x}），"
                    f"gate 字节 {current} -> 1")
                return {"ok": True, "reason": "activated", "hwnd": hwnd, "pid": pid,
                        "version": version, "rva": rva, "tree": "ok"}
            if wrote:
                _write_byte(handle, addr, current)   # 不对就还原，别留副作用
        # 唤起/写字节都可能慢一拍：最后再挑一次窗口确认一遍，别急着判死
        w2 = pick_window(prefer_hwnd, strict=strict)
        if w2 and (not strict or w2["pid"] == pid) and tree_state(w2["hwnd"], timeout=1.0) == "ok":
            win.update(w2)
            say(f"UIA 自检：延迟生效，微信 {version} 控件树已就绪")
            return {"ok": True, "reason": "restored", "hwnd": w2["hwnd"], "pid": w2["pid"],
                    "version": version, "tree": "ok"}
        if read_failed or write_failed:
            say("UIA 自检：gate 字节读写失败（候选读失败 %d / 写失败 %d），"
                "多半是权限或进程句柄问题；不是候选 RVA 不对"
                % (len(read_failed), len(write_failed)))
        say(f"UIA 自检：微信 {version} 试了 {len(rvas[:max_candidates])} 个候选 RVA，"
            f"树仍是空壳（候选：{[hex(x) for x in rvas[:max_candidates]]}）")
        return {"ok": False, "reason": "not_materialized", "hwnd": hwnd, "pid": pid,
                "version": version, "tree": state}
    finally:
        _close(handle)


def _remember(dll: str, rva: int) -> None:
    """把验证成功的 RVA 写进 wechatauto 的 gate 缓存，下次启动零扫描直接命中。"""
    try:
        from wechatauto.accessibility import _dll_identity, _gate_cache_put
        _gate_cache_put(_dll_identity(dll), verified=int(rva))
    except Exception:
        pass


def describe(res: dict) -> str:
    """把 ensure() 的结果翻成一句人话，给桥接日志用。"""
    if not res:
        return "UIA 自检：没有结果"
    if res.get("ok"):
        if res.get("reason") == "already":
            return "UIA 可用（树本来就在）"
        if res.get("reason") == "restored":
            return f"UIA 可用（微信窗口原本在托盘里，已自动唤起并重建控件树，{res.get('version')}）"
        return f"UIA 可用（已物化，微信 {res.get('version')}，RVA {hex(res.get('rva') or 0)}）"
    reason = res.get("reason")
    if reason == "asleep":
        return "UIA 待命（微信窗口未唤醒，真正发送时再打开）"
    if reason == "no_window":
        return "UIA 不可用：没找到微信主窗（微信没开？或用的是别的账号窗口）"
    if reason == "denied":
        return "UIA 不可用：没有权限改微信进程标志位（桥接要以管理员运行）"
    if reason == "no_candidates":
        return f"UIA 不可用：微信 {res.get('version')} 这个版本库还不支持（等库更新）"
    if reason == "not_materialized":
        return f"UIA 不可用：候选 RVA 都没让控件树出来（微信 {res.get('version')}）"
    return "UIA 不可用：" + str(reason)
