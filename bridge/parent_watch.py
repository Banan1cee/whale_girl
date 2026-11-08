# -*- coding: utf-8 -*-
"""启动器退出时让桥接跟着退出。

启动器把桥接的 stdin 接在一条匿名管道上，自己从不写入。正常停止会由启动器
结束进程树；但启动器崩溃或被任务管理器强杀时，只剩系统关闭管道。桥接读到
EOF 就说明父进程没了，必须自行退出，否则会留下一个还连着微信 UI 的 python
进程，下次启动还会被单实例锁挡住。

只在启动器显式设置 WHALE_CONTROL_STDIN=1 时启用；命令行手动运行时 stdin
是终端，不会误判。
"""
import os
import sys


def _stdin_stream():
    stream = getattr(sys.stdin, 'buffer', None)
    return stream or sys.stdin


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
    try:
        if on_close is not None:
            on_close()
    finally:
        (exit_func or os._exit)(0)


def start_watchdog(on_close=None, exit_func=None, stream=None):
    """启动器要求时开一个守护线程盯着父进程管道；返回线程或 None。"""
    if os.environ.get('WHALE_CONTROL_STDIN') != '1':
        return None
    if stream is None:
        stream = _stdin_stream()
    if stream is None:
        return None
    try:
        import threading
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
