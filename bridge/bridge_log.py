# -*- coding: utf-8 -*-
"""桥接日志：文件全量、控制台按级别过滤。

原来这些函数混在 engine.py 里，和启动流程、配置解析互相看见。拆出来后：

- 只依赖 `configure()` 传进来的日志路径和级别；
- `log_throttled` 兼容入口仍留在 engine，有界抑制规则由 runtime_log_throttle 共享；
  这里只提供最底层的
  `log` / `log_warn` / `log_error` / `boot` / `log_window_problem`；
- warn/error 继续带「文件:行」调用点，拆模块后也不会丢。
"""

import faulthandler
import hashlib
import os
import json
import re
import sys
import time
from urllib.parse import urlsplit

LOG_FILE = ""
BOOT_LOG = ""
LOG_LEVEL = "info"

# 日志里只留结构证据：id/昵称用短哈希，正文用长度，路径只说有没有。
# 调用点仍应主动调用这些函数；_emit_log 里的 scrub 只是最后一道兜底。
def _short_hash(value):
    # 摘要的是 wxid/昵称等敏感值，短哈希也够定位，但弱算法会被 CodeQL 拦下。
    return hashlib.sha256(str(value or "").encode("utf-8", "replace")).hexdigest()[:8]


def safe_id(value):
    text = str(value or "")
    return "#" + _short_hash(text) if text else "-"


def safe_name(value):
    text = str(value or "")
    return "#%s(%d字)" % (_short_hash(text), len(text)) if text else "-"


def safe_text(value):
    return "len=%d" % len(str(value or ""))


def safe_path(value):
    text = str(value or "")
    return "path(len=%d)" % len(text) if text else "-"


def safe_url(value):
    try:
        return urlsplit(str(value or "")).hostname or "-"
    except Exception:                                  # noqa: BLE001
        return "-"


_SCRUB_RULES = (
    (re.compile(r"\b(Bearer\s+)[A-Za-z0-9._-]{12,}"), r"\1***"),
    (re.compile(r"\b(?:sk|oc_sk|ak|ghp|xox[baprs]|brz)[-_][A-Za-z0-9_-]{8,}"), "***"),
    (re.compile(r"([?&](?:token|key|secret|signature|password|api_key)=)[^&\s]+", re.IGNORECASE), r"\1***"),
    (re.compile(r"\bwxid_[A-Za-z0-9_-]+"), "wxid_***"),
    (re.compile(r"\b\d{9,}@chatroom\b"), "***@chatroom"),
    (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "1**********"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "***@***"),
    (re.compile(r"([A-Za-z]:\\Users\\)[^\\\s\"']+", re.IGNORECASE), r"\1***"),
)


def scrub(text):
    out = str(text or "")
    for pattern, replacement in _SCRUB_RULES:
        out = pattern.sub(replacement, out)
    return out

# 老的 log() 没有级别，只能按关键词猜「这句算不算报错」；显式级别优先。
_LOG_ERROR_HINT = ("错误", "失败", "异常", "超时", "Traceback", "Exception", "Error", "error:", "?")
_LOG_DEBUG_HINT = ("调试", "详细", "等级=", "窗口", "查询", "缓存", "装载", "收到")

_LOGGER_CODES = set()
_last_rotate_check = [0.0]
_win_problem_ts = {}
_secrets = set()
_secret_files = []
_secret_refresh = 0.0
_secret_field = re.compile(r'api.?key|token|secret|password|authorization|cookie|^key$|^spell$', re.I)


def _register_secrets(value, sensitive=False):
    if isinstance(value, str):
        if sensitive and len(value) >= 4 and value.strip('*'):
            _secrets.add(value)
    elif isinstance(value, dict):
        for key, child in value.items():
            _register_secrets(child, sensitive or str(key).lower() == 'keys' or bool(_secret_field.search(str(key))))
    elif isinstance(value, (list, tuple)):
        for child in value:
            _register_secrets(child, sensitive)


def redact_secrets(text):
    global _secret_refresh
    if time.monotonic() >= _secret_refresh:
        _secret_refresh = time.monotonic() + 1
        for path in _secret_files:
            try:
                with open(path, encoding='utf-8-sig') as f:
                    _register_secrets(json.load(f))
            except (OSError, ValueError):
                pass
        _register_secrets(dict(os.environ))
    from urllib.parse import quote
    text = str(text)
    for value in sorted(_secrets.copy(), key=len, reverse=True):
        text = text.replace(value, '***')
        try:
            text = text.replace(quote(value, safe=''), '***')
        except UnicodeError:
            pass
    text = re.sub(r'\b(?:sk|brz|oc_sk|ak|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}', '***', text, flags=re.I)
    text = re.sub(r'\bBearer\s+[^\s\"\'<>},]+', 'Bearer ***', text, flags=re.I)
    text = re.sub(r'\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b', '***', text, flags=re.I)
    return re.sub(r'((?:api[_ -]?key|access[_ -]?token|password|secret|authorization|[?&](?:key|token))\s*[\"\']?\s*[:=]\s*[\"\']?)[^\s\"\'&,}\]]+', r'\1***', text, flags=re.I)


def configure(log_file=None, boot_log=None, level=None):
    """启动时注入路径和级别；之后再改只用 set_level / set_file。"""
    global LOG_FILE, BOOT_LOG
    if log_file:
        LOG_FILE = log_file
        data = os.path.dirname(os.path.abspath(log_file))
        _secret_files[:] = [os.path.join(os.path.dirname(data), 'config.json'), os.path.join(data, 'settings.json')]
    if boot_log:
        BOOT_LOG = boot_log
    set_level(level)


def set_level(level):
    global LOG_LEVEL
    value = str(level or "").strip().lower()
    LOG_LEVEL = value if value in ("debug", "info", "error") else "info"


def set_file(path):
    global LOG_FILE
    LOG_FILE = str(path or "")


def boot(msg):
    """启动诊断：只写文件，不依赖控制台（控制台被选中时 print 会卡住）。"""
    if not BOOT_LOG:
        return
    try:
        os.makedirs(os.path.dirname(BOOT_LOG), exist_ok=True)
        with open(BOOT_LOG, "a", encoding="utf-8") as f:
            f.write("%s [pid %s] %s\n" % (time.strftime("%H:%M:%S"), os.getpid(), scrub(redact_secrets(msg))))
    except Exception:
        pass


def dump_hang_trace():
    """由检测到超时的 Python 线程持有 GIL 同步记录堆栈。"""
    if not BOOT_LOG:
        return
    try:
        path = os.path.join(os.path.dirname(BOOT_LOG), 'bridge-hang.log')
        with open(path, 'a', encoding='utf-8') as hang_file:
            hang_file.write('\n==== %s 处理超时（pid=%d）====\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), os.getpid()))
            faulthandler.dump_traceback(file=hang_file, all_threads=True)
    except (OSError, RuntimeError) as exc:
        boot('超时堆栈记录失败 type=%s' % type(exc).__name__)


def _log_allowed(level, text):
    """控制台过滤：显式级别优先；老的 log() 命中报错词时抬成 warn，保持可读性。"""
    if LOG_LEVEL == "debug":
        return True
    hinted = level == "info" and any(h in text for h in _LOG_ERROR_HINT)
    if LOG_LEVEL == "error":
        return level == "error" or hinted
    if level in ("warn", "error") or hinted:
        return True
    return not any(h in text for h in _LOG_DEBUG_HINT)


def _caller_where():
    """warn/error 用：调用点「文件:行」，跳过 logger 自己的包装帧。"""
    try:
        frame = sys._getframe(1)
        while frame is not None and frame.f_code in _LOGGER_CODES:
            frame = frame.f_back
        if frame is None:
            return ""
        name = os.path.basename(frame.f_code.co_filename)
        if name.endswith(".py"):
            name = name[:-3]
        return "%s:%d" % (name, frame.f_lineno)
    except Exception:                                  # noqa: BLE001
        return ""


def _fmt_log_arg(a):
    """日志参数不省略：异常展开完整 traceback，容器用 repr，字符串原样。"""
    if isinstance(a, BaseException):
        import traceback
        return "".join(traceback.format_exception(type(a), a, a.__traceback__)).strip()
    if isinstance(a, (dict, list, tuple, set)):
        return repr(a)
    return str(a)


def _rotate_bridge_log():
    """日志文件超过 10MB 就轮转成 .1（只留一份）。"""
    import time as _t
    now = _t.time()
    if now - _last_rotate_check[0] < 60:
        return
    _last_rotate_check[0] = now
    if not LOG_FILE:
        return
    try:
        if os.path.getsize(LOG_FILE) <= 10 * 1024 * 1024:
            return
        bak = LOG_FILE + ".1"
        if os.path.exists(bak):
            os.remove(bak)
        os.replace(LOG_FILE, bak)
    except Exception:
        pass


def _emit_log(level, args, where=""):
    for arg in args:
        if isinstance(arg, (dict, list, tuple)):
            _register_secrets(arg)
    text = scrub(redact_secrets(" ".join(_fmt_log_arg(a) for a in args)))
    head = time.strftime("[%H:%M:%S] ") + level.upper()
    line = head + " " + (("[" + where + "] ") if where else "") + text
    # 文件：永远记全量；界面/启动器控制台按 LOG_LEVEL 过滤。
    if LOG_FILE:
        try:
            os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
            _rotate_bridge_log()
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:                              # noqa: BLE001
            pass
    if not _log_allowed(level, text):
        return
    try:
        print(line, flush=True)
    except Exception:                                  # noqa: BLE001
        pass


def log(*args):
    """老调用：info 级。"""
    _emit_log("info", args)


def log_debug(*args):
    _emit_log("debug", args)


def log_warn(*args):
    """已降级/已自愈，但值得记一笔（切通道、跳过一次、重试成功）。"""
    _emit_log("warn", args, _caller_where())


def log_error(*args):
    """这次功能真的坏了（发送彻底失败、写盘失败、配置读不出来）。"""
    _emit_log("error", args, _caller_where())


def log_window_problem(where, err):
    """窗口操作失败两分钟内只报一次。

    挪不动/置顶不了窗口不该让整条发送失败（UIA 还能把字打进去），
    更不该让看门狗以为“发送卡住”把桥接反复重启——那会一直弹「拒绝访问」。
    """
    try:
        from runtime_log_throttle import log_throttled as bounded_log
    except ImportError:
        from .runtime_log_throttle import log_throttled as bounded_log
    bounded_log(_win_problem_ts, where, where + "：", repr(err),
                ttl=120, emit=log_warn, folded=log, clock=time.monotonic)


for _fn in (log, log_debug, log_warn, log_error, _emit_log):
    _LOGGER_CODES.add(_fn.__code__)
del _fn
