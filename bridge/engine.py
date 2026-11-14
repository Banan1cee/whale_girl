# -*- coding: utf-8 -*-
"""
鲸鲸 · 微信 4.x 桥接（不注入、不修改微信）

原理：
  - 读消息：解密微信 4.x 本地 SQLite 数据库（只读，需要微信处于登录状态）
  - 发消息：驱动微信窗口（UI 自动化 + 剪贴板），相当于有人替你打字发送

前置：
  1. WeChat 4.x 已登录（建议用小号）
  2. 依赖按 bridge/requirements.txt 安装；wechatauto 用仓库 vendor/wechatauto（启动器运行时已内置）
  3. 鲸鲸服务已启动（启动器状态页显示「运行中」）
  4. config.json 里 gateway.wechat.enabled = true（脚本会读 token）

用法：
  python examples/wechatauto_bridge.py

发送通道（按优先级，前一条失败才试下一条）：
  0. 零焦点通道  PostMessage 伪焦点 + GBK 字节 WM_CHAR + 点发送按钮
                 （bridge/bg_sender.py，见 docs/微信消息后台发送.md，不抢前台）
  1. UIA 通道    wechatauto 驱动控件树（默认打 quiet 补丁，但仍可能抢前台）
  2. 键盘通道    Ctrl+F 搜会话 → 剪贴板粘贴 → 回车（一定抢前台）
  3. OCR 通道    截图找发送按钮（最后兜底，可能卡在截屏）

注意：
  - 微信必须保持登录；退出登录后数据库密钥会失效。
  - 自动化不是微信官方接口，仍有账号风险，只用小号 + 测试群。
  - 零焦点通道要求：微信窗口**未最小化**、两边权限一致（都普通或都管理员）、
    中文系统（代码页 936）。任一不满足会自动退回下面的通道。
"""
import json
import random
import re
import urllib.parse
import os
os.environ.setdefault('WECHATAUTO_RHYTHM', 'off')
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
import sys
import threading
import time
_EXAMPLES_DIR = os.path.dirname(os.path.abspath(__file__))
if _EXAMPLES_DIR not in sys.path:
    sys.path.insert(0, _EXAMPLES_DIR)
from reminder_watch import start_reminder_watch
import voice_reply
import voice_send_test
from sticker_transport import guarded_send as guarded_sticker_send, read_enabled_config, resolve_target as resolve_sticker_target, result as sticker_result, WindowsDesktop, quarantined_input_value, account_evidence_allowed as sticker_account_evidence_ok, alias_match as sticker_alias_match, _is_blank as sticker_input_is_blank
from config_values import as_bool as _as_bool, as_int as _as_int, as_float as _as_float, parse_bg_send as _parse_bg_send
import mention
import mention_meta
from wechat_db import DB_ROOT_NAMES, looks_like_db_root as _looks_like_db_root, iter_drive_roots, resolve_db_dir as _resolve_db_dir, find_account_dirs as _find_account_dirs, account_wxid, resolve_account_dir as _resolve_account_dir
try:
    from bridge import uia_boot
except Exception:
    try:
        import uia_boot
    except Exception:
        uia_boot = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, 'config.json')
try:
    CONFIG_MTIME_AT_START = os.path.getmtime(CONFIG_PATH)
except OSError:
    CONFIG_MTIME_AT_START = 0.0
LOG_FILE = os.path.join(ROOT, 'data', 'wechat-bridge-4x.log')
LOG_LEVEL = 'info'
import bridge_log
from bridge_log import (log, log_debug, log_warn, log_error, boot, log_window_problem,
                        safe_id, safe_name, safe_text, safe_path, safe_url)
from guards import is_system_notice, duplicate_guard, rate_guard, set_system_senders
import config as bridge_config
from config import read_config, build_bot_url, wait_for_server as _wait_for_server, ensure_ffmpeg_env as _ensure_ffmpeg_env
from voice import resolve_voice_key as _resolve_voice_key, asr_transcribe, clean_transcript
bridge_log.configure(log_file=LOG_FILE, boot_log=os.path.join(ROOT, 'data', 'bridge-boot.log'), level=LOG_LEVEL)
bridge_config.configure(ROOT, CONFIG_PATH)
ONLY_CHATS = []
SKIP_OLDER_THAN = 10
MASTER_WXID = ''
# 与内核/配置模板一致；旧配置缺字段时，WAL 快照延迟不应吞掉刚收到的消息。
STALE_AFTER = float(os.environ.get('WHALE_STALE_AFTER', '120'))
_GROUP_SENDER_PREFIX_RE = re.compile('^[A-Za-z][A-Za-z0-9_\\-]{3,}:(?!/)\\s*')
CARE_ENABLED = False
CARE_ALLOW_GROUPS = False
CARE_ONLY_MASTER = True
CARE_ALLOW_OTHERS = False
CARE_QUIET_MIN = 20.0
STICKER_TEST_ON = False
STICKER_COLLECT = False
ACCOUNT_WANTED = ''
REMINDER_RUNNER = None
from send_state import SEND_STATE, ChatIdentityError, DraftDirtyError, _chat_identity_level, _SendStateScope
BG_SEND = {'enabled': True, 'charGap': 0.04, 'verify': True, 'charMode': 'auto', 'fallback': True, 'strip': True, 'unhide': True}
PIPELINE_WORKERS = 4
PIPELINE_QUEUE_LIMIT = 8
# 下面这 7 个开关必须在**读配置之前**就有默认值：config.json 解析失败时
# （手填 Windows 路径写了单反斜杠就是典型），上面那个 try 会在 json.load 处
# 整段中断，后面所有赋值一个都执行不到。以前没有默认值，main() 里一读
# QUOTE_REPLY 就 NameError → 桥接退出码 1，用户只看到一句看不懂的 traceback。
# 默认值必须和下面 try 里 _wechat.get(...) 的兜底值一模一样。
QUOTE_REPLY = False
KEYBOARD_FALLBACK = True
BACKGROUND_SEND = True
ACCOUNT_GUARD = True
WINDOW_HWND = 0
LOW_BATTERY_PCT = 5.0
GOODNIGHT_TEXT = '晚安，电量快没了，我先睡啦，明天见～'
CURRENT_CONFIG = {}
CONFIG_SNAPSHOT = None
_BOOT_CONFIG_VALID = False
_cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'config.json')
if not os.path.exists(_cfg_path):
    _example = os.path.join(os.path.dirname(_cfg_path), 'config', 'config.example.json')
    if os.path.exists(_example):
        try:
            import shutil
            shutil.copyfile(_example, _cfg_path)
            log_call = True
        except Exception:
            pass
try:
    with open(_cfg_path, 'r', encoding='utf-8-sig') as _f:
        _cfg = json.load(_f)
    _stale = (_cfg.get('wechat') or {}).get('staleAfterSec')
    if isinstance(_stale, (int, float)) and _stale > 0:
        STALE_AFTER = float(_stale)
    _BOOT_CONFIG_VALID = True
except Exception as _boot_cfg_err:
    try:
        log('启动配置解析中断：', repr(_boot_cfg_err))
    except Exception:
        print('[启动配置解析中断]', repr(_boot_cfg_err))
START_TS = time.time()
from http_client import ThreadLocalHTTP as _ThreadLocalHTTP
LOCAL_HTTP = _ThreadLocalHTTP()
bridge_config.set_local_http(LOCAL_HTTP)
os.environ['NO_PROXY'] = ','.join(filter(None, [os.environ.get('NO_PROXY', ''), '127.0.0.1,localhost,::1']))
_THROTTLE_LOG = {}
CONN_STATE = {'ok': None}

def fix_garbled(text):
    """把「GBK 字节被当成 Latin-1 解出来」的乱码还原（ÏÂÎçºÃÑ½ → 下午好呀）。

    微信 4.x 有的版本/群把正文按 GBK 存，读到内存时却被当成 Latin-1，
    于是每条消息都变成一串西欧字符，模型只能对着乱码回话。
    正常文本原样返回，不做任何改动。
    """
    if not text:
        return text
    high = sum((1 for ch in text if 128 <= ord(ch) <= 255))
    cjk = sum((1 for ch in text if 19968 <= ord(ch) <= 40959))
    if high < 2 or cjk * 2 >= high:
        return text
    try:
        raw = text.encode('latin-1')
    except UnicodeEncodeError:
        return text
    for enc in ('gbk', 'utf-8'):
        try:
            fixed = raw.decode(enc)
        except UnicodeDecodeError:
            continue
        if sum((1 for ch in fixed if 19968 <= ord(ch) <= 40959)) > cjk:
            return fixed
    return text

def log_throttled(key, *args, ttl=600, emit=None):
    from runtime_log_throttle import log_throttled as bounded_log
    bounded_log(_THROTTLE_LOG, key, *args, ttl=ttl, emit=emit or log,
                folded=log, clock=getattr(time, 'monotonic', time.time))

def _publish_runtime_config(cfg, snapshot):
    global CURRENT_CONFIG, CONFIG_SNAPSHOT
    values = dict(snapshot['values'])
    VOICE_BASE_URL = values['VOICE_BASE_URL']
    values['VOICE_API_KEY'] = _resolve_voice_key(cfg, VOICE_BASE_URL, ROOT)
    values['SYSTEM_SENDER_NAMES'] = set(BASE_SYSTEM_SENDERS) | set(snapshot['ignoreSenders'])
    # Resolve all derived values before publishing: a failed read/parse keeps
    # the previous coherent configuration rather than half-updated globals.
    globals().update(values)
    set_system_senders(SYSTEM_SENDER_NAMES)
    bridge_log.set_level(LOG_LEVEL)
    CURRENT_CONFIG, CONFIG_SNAPSHOT = cfg, snapshot


def restart_for_config_change():
    log('桥接配置需要重启，等待在途发送结束（最多 15 秒）…')
    time.sleep(3)
    deadline = time.monotonic() + 15
    while SEND_STATE.get('active') and time.monotonic() < deadline:
        time.sleep(1)
    if SEND_STATE.get('active'):
        log('⚠️ 仍有发送未结束就重启了，输入框可能留有半截草稿，请手动清一下')
    os._exit(7)


def reload_config(path=None, *, config=None):
    """把 config.json 重新读一遍，覆盖上面这些「启动时定型」的开关。

    为什么需要：启动器改的是 config.json，但桥接以前只在启动时读一次，
    用户在启动器里关掉「主动搭话」、改「忽略名单」、调「群聊开关」……全都没反应，
    只能在启动器里手动重启桥接，表现出来就是「调了没用，还是默认」。
    可热更字段在 5 秒内生效；连接、账号和线程池参数变更需安全重启。

    返回是否真的重新加载了。
    """
    global QUOTE_REPLY, KEYBOARD_FALLBACK, BACKGROUND_SEND, LOW_BATTERY_PCT, GOODNIGHT_TEXT
    global BG_SEND, PIPELINE_WORKERS, PIPELINE_QUEUE_LIMIT
    global ACCOUNT_GUARD, WINDOW_HWND, STICKER_TEST_ON, STICKER_COLLECT
    global CARE_ENABLED, CARE_QUIET_MIN
    global STALE_AFTER, SYSTEM_SENDER_NAMES, BASE_SYSTEM_SENDERS, MASTER_WXID
    global VOICE_ENABLED, VOICE_BASE_URL, VOICE_MODEL, VOICE_API_KEY, VOICE_TIMEOUT, VOICE_MAX_SECONDS
    global CARE_ENABLED, CARE_ALLOW_GROUPS, CARE_ONLY_MASTER, CARE_ALLOW_OTHERS
    try:
        if config is None:
            with open(path or CONFIG_PATH, 'r', encoding='utf-8-sig') as f:
                cfg = json.load(f)
        else:
            cfg = config
        snapshot = bridge_config.runtime_snapshot(cfg)
        if CONFIG_SNAPSHOT is not None and bridge_config.restart_fields(CONFIG_SNAPSHOT, snapshot):
            restart_for_config_change()
            return False
        _publish_runtime_config(cfg, snapshot)
    except Exception as exc:
        log('重读配置失败（继续用旧值）：', type(exc).__name__)
        return False
    # Keep the compatibility assignment fed by the normalized snapshot.
    w = {'staleAfterSec': snapshot['values']['STALE_AFTER']}
    STALE_AFTER = float(w.get('staleAfterSec') or STALE_AFTER or 120)
    return True
SYSTEM_SENDER_NAMES = {'微信团队', '微信支付', '服务通知', '订阅号消息', '文件传输助手', '微信运动', '微信公众平台', '腾讯客服', '微信安全中心', '微信广告'}
BASE_SYSTEM_SENDERS = set(SYSTEM_SENDER_NAMES)
set_system_senders(SYSTEM_SENDER_NAMES)

def looks_like_db_root(p):
    """兼容旧调用：实现在 wechat_db.py。"""
    return _looks_like_db_root(p)

def resolve_db_dir(config_path=None, drives='CDEFGHIJK'):
    """兼容旧调用：实现在 wechat_db.py。"""
    return _resolve_db_dir(config_path, drives, default_config_path=CONFIG_PATH)

def find_account_dirs(db_dir):
    """兼容旧调用：实现在 wechat_db.py。"""
    return _find_account_dirs(db_dir)

def resolve_account_dir(db_dir, wanted):
    """兼容旧调用：实现在 wechat_db.py。"""
    return _resolve_account_dir(db_dir, wanted)

def list_accounts_cli():
    """--list-accounts：扫描本机所有微信账号，写 data/accounts.json 给启动器下拉用。

    昵称要开库读 contact.db（必须微信在登录、能取到密钥），所以是「尽力而为」：
    单个账号失败就留空，整件事最多花 20 秒，绝不因为读不到昵称就报错。
    """
    db_dir = resolve_db_dir()
    rows = []
    names = find_account_dirs(db_dir) if db_dir else []
    deadline = time.monotonic() + 20
    try:
        from wechatauto import WeChatDB
    except Exception as e:
        log('列账号：wechatauto 不可用，只列目录名：', repr(e))
        WeChatDB = None
    for n in names:
        item = {'account': n, 'wxid': account_wxid(n), 'nick': '', 'lastActive': 0}
        base = os.path.join(db_dir, n, 'db_storage')
        try:
            newest = 0.0
            for root, _dirs, files in os.walk(base):
                for f in files:
                    if f.endswith('.db') and (not f.endswith(('-wal', '-shm'))):
                        newest = max(newest, os.path.getmtime(os.path.join(root, f)))
            item['lastActive'] = int(newest * 1000)
        except Exception:
            pass
        if WeChatDB is not None and time.monotonic() < deadline:
            try:
                probe = WeChatDB(db_dir=db_dir, account=n)
                if probe.account == n:
                    info = probe.get_self_info() or {}
                    item['nick'] = str(info.get('nick_name') or info.get('remark') or '').strip()
            except Exception:
                pass
        rows.append(item)
    rows.sort(key=lambda x: -x['lastActive'])
    payload = {'dbDir': db_dir or '', 'generatedAt': int(time.time() * 1000), 'accounts': rows}
    path = os.path.join(ROOT, 'data', 'accounts.json')
    try:
        from runtime_json import atomic_write_json
        atomic_write_json(path, payload, indent=2)
        log('列账号完成：%d 个（%s）' % (len(rows), '、'.join((safe_id(r['account']) for r in rows)) or '无'))
    except Exception as e:
        log('列账号：写 %s 失败：%r' % (safe_path(path), e))
    print(json.dumps(payload, ensure_ascii=False))
    return 0

def write_accounts_cache(db_dir, account='', nick='', probe_others=True, deadline_sec=8):
    """桥接自己补写 data/accounts.json（启动器「微信桥接」页的账号卡从这读）。

    为什么要写：用户删掉 data/ 之后缓存就没了，而旧版启动器的「刷新账号」按钮
    只重新读缓存、不会再扫一次，双开用户就只剩桥接上报的那一张兜底卡。
    这里在启动时补一份：dbDir + 所有账号目录，当前号的昵称已知，其它号尽力开库读。

    只做只读扫描，失败一律吞掉（不能因为列账号失败影响收消息）。
    """
    try:
        if not db_dir:
            return False
        names = find_account_dirs(db_dir)
        if not names:
            return False
        wechat_db = None
        if probe_others:
            try:
                from wechatauto import WeChatDB as wechat_db
            except Exception:
                wechat_db = None
        deadline = time.monotonic() + max(1, deadline_sec)
        rows = []
        for n in names:
            item = {'account': n, 'wxid': account_wxid(n), 'nick': '', 'lastActive': 0}
            if n == account:
                item['nick'] = nick or ''
            newest = 0.0
            try:
                for root, _dirs, files in os.walk(os.path.join(db_dir, n, 'db_storage')):
                    for f in files:
                        if f.endswith('.db') and (not f.endswith(('-wal', '-shm'))):
                            newest = max(newest, os.path.getmtime(os.path.join(root, f)))
            except Exception:
                pass
            item['lastActive'] = int(newest * 1000)
            if not item['nick'] and wechat_db is not None and (time.monotonic() < deadline):
                try:
                    probe = wechat_db(db_dir=db_dir, account=n)
                    if probe.account == n:
                        info = probe.get_self_info() or {}
                        item['nick'] = str(info.get('nick_name') or info.get('remark') or '').strip()
                except Exception:
                    pass
            rows.append(item)
        rows.sort(key=lambda x: -x['lastActive'])
        payload = {'dbDir': db_dir, 'generatedAt': int(time.time() * 1000), 'accounts': rows}
        path = os.path.join(ROOT, 'data', 'accounts.json')
        from runtime_json import atomic_write_json
        atomic_write_json(path, payload, indent=2)
        log('账号缓存已补写：%d 个号（%s）' % (len(rows), '、'.join((safe_name(r['nick']) if r['nick'] else safe_id(r['account']) for r in rows))))
        return True
    except Exception as e:
        log('账号缓存补写失败（不影响收发）：', repr(e))
        return False
BRIDGE_LOCK_PORT = 47821
VOICE_ENABLED = True
VOICE_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
VOICE_MODEL = 'qwen3-asr-flash'
VOICE_API_KEY = ''
VOICE_TIMEOUT = 90
VOICE_MAX_SECONDS = 120
VOICE_SAMPLE_RATE = 16000
if _BOOT_CONFIG_VALID:
    try:
        _publish_runtime_config(_cfg, bridge_config.runtime_snapshot(_cfg))
    except Exception as exc:
        log('启动配置解析中断：', type(exc).__name__)
MOCK_NOTICED = {'done': False}
boot('脚本开始执行')

def wait_for_server(url, timeout=30):
    """兼容旧调用：实现在 config.py。"""
    return _wait_for_server(url, timeout)

def ensure_ffmpeg_env():
    """兼容旧调用：实现在 config.py。"""
    return _ensure_ffmpeg_env()
try:
    from .msg_pipeline import MessagePipeline, MessageBatches, split_runs, mergeable
except ImportError:
    from msg_pipeline import MessagePipeline, MessageBatches, split_runs, mergeable

def _bg_cli(argv=None):
    """零焦点通道的命令行自检 / 发送。

    ```
    python -m bridge --bg-probe                 只读自检：物化、读控件、前后前台
    python -m bridge --bg-send "测试" --to 文件传输助手
    ```

    放在 main() 最前面（和 --list-accounts 一样），不抢单实例锁，
    所以桥接正跑着的时候也能用。
    """
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        import bg_sender
    except Exception:
        try:
            from . import bg_sender
        except Exception as e:
            log_warn('导入 bg_sender 失败：', repr(e))
            return 1
    if '--bg-send' in argv:
        i = argv.index('--bg-send')
        text = argv[i + 1] if len(argv) > i + 1 else ''
        to = None
        if '--to' in argv:
            j = argv.index('--to')
            to = argv[j + 1] if len(argv) > j + 1 else None
        ok, why = bg_sender.send(text, chat=to, log=log, char_gap=BG_SEND['charGap'], strip_unencodable=BG_SEND['strip'], verify=BG_SEND['verify'], unhide=BG_SEND['unhide'], char_mode=BG_SEND.get('charMode') or 'auto')
        log('发送 = %s（%s）' % (ok, why))
        return 0 if ok else 1
    res = bg_sender.probe(log=log)
    return 0 if res.get('edit') else 1

def main():
    # 兼容标记：实现已拆到 app.py / *_mixin.py，release-check 仍按这些关键词
    # 确认「wxgf 转码」（_wxgf_to_jpg）、「失败原因解释」（explain_uia_failure）
    # 和「路径里有中文」的提醒没有在重构中丢失。
    from app import BridgeRuntime
    return BridgeRuntime().start()
if __name__ == '__main__':
    sys.exit(main())
