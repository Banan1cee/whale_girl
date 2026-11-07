"""Resolve FFmpeg from the installed runtime or an existing system installation."""

import os
import shutil
from pathlib import Path


def find_ffmpeg(root):
    root = Path(root)
    legacy = root / "runtime" / "ffmpeg" / "bin" / "ffmpeg.exe"
    if legacy.is_file():
        return str(legacy)
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    explicit = os.environ.get("IMAGEIO_FFMPEG_EXE")
    if explicit and os.path.isfile(explicit):
        return os.path.abspath(explicit)
    # Windows 4.0.7 把二进制装在 wheel 内，文件带版本号，光加目录到 PATH 找不到。
    binaries = root / "runtime" / "python" / "Lib" / "site-packages" / "imageio_ffmpeg" / "binaries"
    for bundled in sorted(binaries.glob("ffmpeg-win-x86_64-*.exe")):
        if bundled.is_file():
            return str(bundled)
    for directory in (
        root / "tools" / "ffmpeg" / "bin",
        *(Path(f"{drive}:/ffmpeg/bin") for drive in "CDEF"),
        Path.home() / "ffmpeg" / "bin",
        Path(os.path.expandvars(r"%LOCALAPPDATA%\Programs\ffmpeg\bin")),
        Path(r"C:\Program Files\ffmpeg\bin"),
        Path(r"D:\Program Files\ffmpeg\bin"),
    ):
        exe = directory / "ffmpeg.exe"
        if exe.is_file():
            return str(exe)
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        # 上游也支持使用源码时独立安装的 wheel。返回的可能是已失效的环境变量。
        exe = get_ffmpeg_exe()
        return shutil.which(exe) if exe else None
    except (ImportError, OSError, RuntimeError):
        return None


def configure_ffmpeg(root):
    exe = find_ffmpeg(root)
    if not exe:
        return None
    exe = os.path.abspath(exe)
    if os.path.basename(exe).lower() in ("ffmpeg.exe", "ffmpeg") and shutil.which("ffmpeg") != exe:
        os.environ["PATH"] = os.path.dirname(exe) + os.pathsep + os.environ.get("PATH", "")
    os.environ["IMAGEIO_FFMPEG_EXE"] = exe
    return exe
