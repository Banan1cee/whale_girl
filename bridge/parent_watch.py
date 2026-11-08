# -*- coding: utf-8 -*-
"""启动器退出时让桥接跟着退出。

启动器把桥接的 stdin 接在一条匿名管道上，自己从不写入。正常停止会由启动器
结束进程树；但启动器崩溃或被任务管理器强杀时，只剩系统关闭管道。桥接读到
EOF 就说明父进程没了，必须自行退出，否则会留下一个还连着微信 UI 的 python
进程，下次启动还会被单实例锁挡住。

为什么优先盯父进程而不是读 stdin
--------------------------------
v4.1.0 之后加的主进程看门狗在**子线程里阻塞读 stdin**。实测（本机，2026-11-08）
这个「常驻读管道」的线程会让随后 `import numpy`（wechatauto.accessibility 要用）
在 Windows 上死锁：`_multiarray_umath` 的 DLL 初始化卡住，40 秒都不返回，
桥接永远到不了「已启动」，启动器就一直显示「桥接连接中」。
（复现：先起一个线程读 stdin 管道，再 `import numpy` → 卡死；同样的线程换成
`sleep` 或什么都不做则正常。）

所以现在优先用启动器已经传下来的 `WHALE_PARENT_PID`：打开父进程句柄，在
可等待对象上等它退出（不碰 stdin，也不会占用管道）。只有拿不到父进程 PID
（老启动器 / 手动调用）时才退回原来的 stdin EOF 监听。

只在启动器显式设置 WHALE_CONTROL_STDIN=1 时启用；命令行手动运行时 stdin
是终端，不会误判。
"""
import os
import sys


def _stdin_stream():
    stream = getattr(sys.stdin, 'buffer', None)
    return stream or sys.stdin


def _finish(on_close, exit_func):
    try:
        if on_close is not None:
            on_close()
    finally:
        (exit_func or os._exit)(0)


def watch_pipe(stream=None, on_close=None, exit_func=None):
    """阻塞读取 stdin，直到 EOF 后退出。非 EOF 的读取异常直接返回，不误杀桥接。"""
    stream = _stdin_stream() if stream is None else stream
    if stream is None:
        return
    try:
        while True:
            chunk = stream.read(1)
            if not chunk:
                break
    except Exception:
        # 管道读失败不等于父进程已退出，宁可留着也不能误杀。
        return
    _finish(on_close, exit_func)


def watch_pipe_poll(stream=None, on_close=None, exit_func=None, interval=0.25):
    """非阻塞地盯着 stdin 管道：父进程没关就继续等，关了（ERROR_BROKEN_PIPE）才退出。

    只在拿不到父进程 PID、又确实接的是管道时用。和 `watch_pipe` 的区别是
    **不在读调用里阻塞**，因此不会踩到「常驻读线程 + import numpy」的 Windows 死锁。
    """
    import time

    stream = _stdin_stream() if stream is None else stream
    if stream is None:
        return
    try:
        import ctypes
        import msvcrt
        from ctypes import wintypes

        handle = msvcrt.get_osfhandle(stream.fileno())
    except Exception:
        # 不是管道（测试里的 BytesIO、终端等）：退回原来的阻塞读。
        return watch_pipe(stream, on_close, exit_func)
    try:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        peek = kernel32.PeekNamedPipe
        peek.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                         wintypes.LPVOID, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        peek.restype = wintypes.BOOL
        available = wintypes.DWORD()
        while True:
            if not peek(handle, None, 0, None, ctypes.byref(available), None):
                # 109 = ERROR_BROKEN_PIPE：写端已关，父进程没了。
                # 其它错误说明我们没权限/句柄不对，宁可留着也不误杀。
                if ctypes.get_last_error() == 109:
                    break
                return
            time.sleep(max(0.05, interval))
    except Exception:
        return
    _finish(on_close, exit_func)


def _open_parent_handle(pid):
    """打开父进程的「等它退出」句柄；打不开返回 None。

    权限不足或父进程已经退出都会失败。这里**不能**当成「父进程没了」直接退出：
    手动以普通权限跑桥接、而启动器是管理员时也会打不开。
    """
    if os.name != 'nt':
        return None
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        # SYNCHRONIZE：只需要等它退出，不要 PROCESS_TERMINATE 之类的高权限。
        handle = kernel32.OpenProcess(0x00100000, False, int(pid))
        return handle or None
    except Exception:
        return None


def watch_parent_handle(handle, on_close=None, exit_func=None, interval=0.5):
    """等父进程句柄变成有信号（父进程退出）后退出。异常时返回，不误杀。"""
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        wait_object_0 = 0
        wait_timeout = 258
        try:
            while True:
                rc = kernel32.WaitForSingleObject(handle, max(100, int(interval * 1000)))
                if rc == wait_object_0:
                    break
                if rc == wait_timeout:
                    continue
                return
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        return
    _finish(on_close, exit_func)


def _pid_alive(pid):
    """非 Windows 兜底：signal 0 只探测不发送。"""
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except Exception:
        return True


def watch_parent_pid(pid, on_close=None, exit_func=None, interval=0.5):
    import time
    while _pid_alive(pid):
        time.sleep(interval)
    _finish(on_close, exit_func)


def start_watchdog(on_close=None, exit_func=None, stream=None):
    """启动器要求时开一个守护线程盯着父进程；返回线程或 None。

    优先按 WHALE_PARENT_PID 等父进程句柄；拿不到 PID/句柄时才退回 stdin EOF。
    """
    if os.environ.get('WHALE_CONTROL_STDIN') != '1':
        return None
    try:
        import threading
    except Exception:
        return None

    pid = 0
    try:
        pid = int(str(os.environ.get('WHALE_PARENT_PID') or '0').strip() or '0')
    except Exception:
        pid = 0

    if pid > 0:
        handle = _open_parent_handle(pid)
        if handle:
            thread = threading.Thread(
                target=watch_parent_handle,
                kwargs={'handle': handle, 'on_close': on_close, 'exit_func': exit_func},
                daemon=True,
                name='launcher-parent-watch',
            )
            thread.start()
            return thread
        if os.name != 'nt':
            thread = threading.Thread(
                target=watch_parent_pid,
                kwargs={'pid': pid, 'on_close': on_close, 'exit_func': exit_func},
                daemon=True,
                name='launcher-parent-watch',
            )
            thread.start()
            return thread
        # Windows 上打不开父进程句柄（极少数权限组合）：退回原来的 stdin 监听。

    if stream is None:
        # 生产路径（启动器没有给 PID / 句柄打不开）：用非阻塞轮询，别在子线程里
        # 常驻阻塞读 stdin——那会让随后的 import numpy 死锁。
        target = watch_pipe_poll if os.name == 'nt' else watch_pipe
        try:
            thread = threading.Thread(
                target=target,
                kwargs={'on_close': on_close, 'exit_func': exit_func},
                daemon=True,
                name='launcher-parent-watch',
            )
            thread.start()
            return thread
        except Exception:
            return None
    # 测试/旧调用显式给了 stream：保持原来的阻塞读语义。
    try:
        thread = threading.Thread(
            target=watch_pipe,
            kwargs={'stream': stream, 'on_close': on_close, 'exit_func': exit_func},
            daemon=True,
            name='launcher-parent-watch',
        )
        thread.start()
        return thread
    except Exception:
        return None
