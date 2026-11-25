# -*- coding: utf-8 -*-
"""拍一拍发送：拍不到就跳过，绝不能让全局发送锁 / 消息 worker 跟着卡死。

BUGS #127 的真实故障：当前会话里没有「可右键的对方消息行」时，拍一拍的失败
路径反而要把判行做三遍、再翻两屏找、最后调上游无超时的 `_find_friend_row()`
（逐行截屏），而这些全都在 `with self.send_lock` 里。上游任意一次原生界面
调用不返回，`send_lock` 就永远不释放 —— 所有会话的回复一起卡死，而心跳还在
正常上报，用户看到的就是「在线但一句话都不回」。

修复后的契约（这几条就是回归线）：
  1. 判行探测在守护线程里限时跑：上游卡住也只丢掉这一条拍一拍，绝不跟着卡死；
  2. 探测期间不占全局 send_lock，其它会话必须还能发消息；
  3. 当前界面没有可拍对象、或者目标会话根本不是当前会话时，直接跳过：
     不右键、不点击、不留锁、不抛异常；
  4. 失败后要退避，不能每条消息都把截屏/翻屏这套重活重来一遍。
"""

import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'bridge') not in sys.path:
    sys.path.insert(0, str(ROOT / 'bridge'))

import engine  # noqa: E402
import sender_mixin  # noqa: E402
import window_mixin  # noqa: E402


def _stub_third_party():
    """假掉 wechatauto / uiautomation 这类要真微信环境才能用的模块。

    和 tests/test_uia_recovery.py 的做法一致：只伪造 OS / 第三方边界，
    被测的 sender_mixin 用的是仓库里的真实代码。
    """
    rhythm = types.ModuleType('wechatauto.rhythm')
    rhythm.nap = lambda seconds=0.0: None          # 拟人节奏在测试里不能真睡
    wechatauto = types.ModuleType('wechatauto')
    wechatauto.rhythm = rhythm
    guia = types.ModuleType('wechatauto.guia')
    guia.ScreenOCR = types.SimpleNamespace(recognize=lambda image: [])
    wechatauto.guia = guia
    wechatauto.uia_driver = types.ModuleType('wechatauto.uia_driver')
    uiautomation = types.ModuleType('uiautomation')
    uiautomation.SendKeys = lambda keys: None
    return {
        'wechatauto': wechatauto,
        'wechatauto.rhythm': rhythm,
        'wechatauto.guia': guia,
        'wechatauto.uia_driver': wechatauto.uia_driver,
        'uiautomation': uiautomation,
    }


class _Logs:
    def __init__(self):
        self.lines = []

    def __call__(self, *args, **kwargs):
        self.lines.append(' '.join(str(a) for a in args if not isinstance(a, (dict, list))))

    def clear(self):
        del self.lines[:]

    def text(self):
        return '\n'.join(self.lines)


class _Acks:
    """假的内核 HTTP 客户端：记录桥接回执（/api/pat/ack）。"""

    def __init__(self):
        self.calls = []

    def post(self, url, headers=None, json=None, timeout=None, **kwargs):
        self.calls.append({'url': url, 'headers': headers or {}, 'json': json or {}, 'timeout': timeout})
        return types.SimpleNamespace(status_code=200, json=lambda: {'ok': True})

    def pat_acks(self):
        return [c for c in self.calls if 'pat/ack' in c['url']]


class _MessageList:
    """消息列表控件：真机上的 GetChildren / WheelUp 都可能卡在原生 UIA 上。"""

    def __init__(self):
        self.wheels = 0

    def WheelUp(self, **kwargs):
        self.wheels += 1
        return True


class _FakeUIA:
    """当前会话：有消息列表，但（默认）没有一条可右键的对方消息行。"""

    def __init__(self, chat='目标昵称', open_ok=True):
        self.chat = chat
        self.open_ok = open_ok
        self.message_list = _MessageList()
        # 上游驱动把主窗挂在 _win 上（_pat_click_row 用它取 hwnd）
        self._win = types.SimpleNamespace(NativeWindowHandle=4242)
        self.win = self._win
        self.open_calls = 0
        self.right_clicks = 0
        self.clicks = 0

    def current_chat(self):
        return self.chat

    def open_chat(self, keyword):
        self.open_calls += 1
        if self.open_ok:
            self.chat = str(keyword)
        return self.open_ok

    def ensure_window(self):
        return True

    def _message_list(self):
        return self.message_list

    def scroll_message_list_to_bottom(self, max_rounds=20):
        return True

    def _set_cursor(self, x, y):
        return None

    def _right_click(self):
        self.right_clicks += 1

    def _click_at(self, x, y):
        self.clicks += 1


def _new_bridge(u, logs):
    """把真实的 SenderMixin / WindowMixin 挂到假对象上，只替换外部协作者。"""

    class _Bridge(sender_mixin.SenderMixin, window_mixin.WindowMixin):
        pass

    bridge = _Bridge()
    bridge.send_lock = threading.Lock()
    bridge.gui_lock = threading.Lock()
    bridge.PAT_LAST = {}
    bridge.PAT_SENT = {}
    bridge.bot_url = 'http://127.0.0.1:8787/webhook/wechat'
    bridge.token = 'bridge-token-for-test'
    bridge.ACCOUNT = {'hwnd': 0, 'pid': 0, 'verified': True}
    bridge.gui = types.SimpleNamespace(_get_uia=lambda: u)
    bridge.identity_checks = []
    # 这些在真机上分别是账号 / 发言范围 / 窗口 / 会话名模块
    bridge._pat_feature_on = lambda: True
    bridge.ui_chat_name = lambda username, shown='': '目标昵称'
    bridge.aliases_for = lambda username, shown='': ['目标昵称']
    bridge.account_send_allowed = lambda where, engine=None: True
    bridge.send_policy_allows = lambda username, shown='': True
    bridge.chat_paused = lambda username: False
    bridge.is_self_chat = lambda username: False
    bridge.bind_gui_window = lambda gui: None
    bridge.find_weixin_hwnd = lambda: 0
    bridge._require_chat_identity = lambda uu, who, keys, where: bridge.identity_checks.append(where)
    # 抢前台是另一条独立安全闸（真机走 win32），这里打桩为成功
    bridge._pat_ensure_foreground = lambda: True
    bridge._pat_drop_topmost = lambda: None
    bridge._pat_popup_set = lambda hwnd: set()
    bridge._pat_menu_rects = lambda hwnd, before: []
    bridge._pat_click_menu_item = lambda rect, uu, who: False
    bridge.logs = logs
    return bridge


class PatSendTests(unittest.TestCase):
    def setUp(self):
        self._modules = patch.dict(sys.modules, _stub_third_party())
        self._modules.start()
        self.addCleanup(self._modules.stop)
        self.logs = _Logs()
        self.acks = _Acks()
        self._saved = (
            engine.log, engine.log_warn, engine.log_error, engine.log_throttled,
            engine.CURRENT_CONFIG, engine.BACKGROUND_SEND, engine.MOMENTS_FORCE_FOREGROUND,
            engine.LOCAL_HTTP,
        )
        engine.log = self.logs
        engine.log_warn = self.logs
        engine.log_error = self.logs
        engine.log_throttled = lambda key, *args, **kwargs: self.logs(*args)
        engine.LOCAL_HTTP = self.acks
        # 冷却置 0，让每个用例都能真的走到发送逻辑
        engine.CURRENT_CONFIG = {'features': {'pat': True}, 'pat': {'cooldownSec': 0}}
        engine.BACKGROUND_SEND = True
        engine.MOMENTS_FORCE_FOREGROUND = False

    def tearDown(self):
        (engine.log, engine.log_warn, engine.log_error, engine.log_throttled,
         engine.CURRENT_CONFIG, engine.BACKGROUND_SEND, engine.MOMENTS_FORCE_FOREGROUND,
         engine.LOCAL_HTTP) = self._saved

    # ---- 契约 1：上游原生调用卡住时，必须放弃这一条 ----
    def test_blocked_row_probe_cannot_hang_send_pat(self):
        release = threading.Event()
        u = _FakeUIA()
        bridge = _new_bridge(u, self.logs)
        bridge._pat_friend_row = lambda uu: (release.wait(60), None)[1]
        box = {}

        def run():
            started = time.monotonic()
            try:
                box['value'] = bridge.send_pat('目标昵称', 'peer_wxid')
            except BaseException as exc:                        # noqa: BLE001
                box['error'] = exc
            box['elapsed'] = time.monotonic() - started

        worker = threading.Thread(target=run, name='pat-under-test', daemon=True)
        worker.start()
        worker.join(6.0)
        still_running = worker.is_alive()
        release.set()
        worker.join(2.0)
        self.assertFalse(still_running, '拍不出去时必须放弃这一条，不能跟着原生界面调用一起卡死')
        self.assertIsNone(box.get('error'), '拍一拍失败不能把异常抛给消息 worker')
        self.assertIs(box.get('value'), False)
        self.assertLess(box.get('elapsed', 99), 6.0, '必须在硬截止时间内返回')
        self.assertFalse(bridge.send_lock.locked(), '返回后必须放开 send_lock')
        self.assertFalse(bridge.gui_lock.locked(), '返回后必须放开 gui_lock')
        self.assertEqual(u.right_clicks, 0, '没有确认可右键的对方行时绝不能右键瞎点')

    # ---- 契约 2：判行探测期间不能占着全局 send_lock ----
    def test_row_probe_does_not_hold_the_global_send_lock(self):
        release = threading.Event()
        u = _FakeUIA()
        bridge = _new_bridge(u, self.logs)
        bridge._pat_friend_row = lambda uu: (release.wait(60), None)[1]
        worker = threading.Thread(target=lambda: bridge.send_pat('目标昵称', 'peer_wxid'),
                                  name='pat-under-test', daemon=True)
        worker.start()
        try:
            time.sleep(1.0)
            got = bridge.send_lock.acquire(timeout=0.5)
            if got:
                bridge.send_lock.release()
        finally:
            release.set()
            worker.join(5.0)
        self.assertTrue(got, '判行探测期间其它会话必须还能发消息，send_lock 不能被长期占用')

    # ---- 契约 3a：当前界面没有可拍对象 → 跳过，且没有副作用 ----
    def test_missing_friend_row_is_skipped_without_side_effects(self):
        u = _FakeUIA()
        bridge = _new_bridge(u, self.logs)
        bridge._pat_friend_row = lambda uu: None
        started = time.monotonic()
        value = bridge.send_pat('目标昵称', 'peer_wxid')
        elapsed = time.monotonic() - started
        self.assertIs(value, False)
        self.assertLess(elapsed, 1.5, '没有对方消息行时必须马上跳过，不能整屏截屏/翻屏/OCR')
        self.assertEqual(u.right_clicks, 0)
        self.assertEqual(u.clicks, 0)
        self.assertFalse(bridge.send_lock.locked() or bridge.gui_lock.locked())
        self.assertIn('reason=no_friend_row', self.logs.text())

    # ---- 契约 3b：目标会话不在当前界面且打不开 → 跳过 ----
    def test_chat_missing_from_current_view_is_skipped(self):
        u = _FakeUIA(chat='别的会话', open_ok=False)
        bridge = _new_bridge(u, self.logs)

        def never_probe(uu):
            raise AssertionError('会话没打开就不该去找对方消息行')

        bridge._pat_friend_row = never_probe
        value = bridge.send_pat('目标昵称', 'peer_wxid')
        self.assertIs(value, False)
        self.assertEqual(u.right_clicks, 0)
        self.assertIn('reason=chat_not_opened', self.logs.text())

    # ---- 契约 4：失败后要退避，别每条消息都重来一遍 ----
    def test_failed_pat_backs_off_instead_of_repeating_heavy_work(self):
        u = _FakeUIA()
        bridge = _new_bridge(u, self.logs)
        probes = []
        bridge._pat_friend_row = lambda uu: (probes.append(1), None)[1]
        self.assertIs(bridge.send_pat('目标昵称', 'peer_wxid'), False)
        first_round = len(probes)
        self.assertGreaterEqual(first_round, 1)
        self.assertIs(bridge.send_pat('目标昵称', 'peer_wxid'), False)
        self.assertEqual(len(probes), first_round, '刚失败过就不该再跑一遍判行')

    # ---- 菜单没认出来时也必须把锁还回去 ----
    def test_menu_not_found_releases_send_lock(self):
        u = _FakeUIA()
        bridge = _new_bridge(u, self.logs)
        bridge._pat_friend_row = lambda uu: (10, 20, 300, 80)
        started = time.monotonic()
        value = bridge.send_pat('目标昵称', 'peer_wxid')
        self.assertIs(value, False)
        self.assertLess(time.monotonic() - started, 3.0)
        self.assertGreaterEqual(u.right_clicks, 1)
        self.assertFalse(bridge.send_lock.locked())
        self.assertFalse(bridge.gui_lock.locked())

    # ---- BUGS #128：拍没拍到都要给内核回执 ----
    def test_failed_pat_reports_result_to_kernel(self):
        u = _FakeUIA()
        bridge = _new_bridge(u, self.logs)
        bridge._pat_friend_row = lambda uu: None
        self.assertIs(bridge.send_pat('目标昵称', 'peer_wxid', pat_id='pat-abc-1'), False)
        acks = self.acks.pat_acks()
        self.assertEqual(len(acks), 1, '拍不到也要回执，否则内核会把额度扣掉还以为是拍到了')
        payload = acks[0]['json']
        self.assertEqual(payload['patId'], 'pat-abc-1')
        self.assertEqual(payload['chatId'], 'peer_wxid')
        self.assertIs(payload['ok'], False)
        self.assertEqual(payload['reason'], 'no_friend_row')
        self.assertEqual(acks[0]['url'], 'http://127.0.0.1:8787/api/pat/ack')
        self.assertEqual(acks[0]['headers'].get('x-bot-token'), 'bridge-token-for-test')

    def test_successful_pat_reports_ok_to_kernel(self):
        u = _FakeUIA()
        bridge = _new_bridge(u, self.logs)
        bridge._pat_friend_row = lambda uu: (10, 20, 300, 80)
        bridge._pat_menu_rects = lambda hwnd, before: [(600, 300, 700, 500)]
        bridge._pat_click_menu_item = lambda rect, uu, who: True
        self.assertIs(bridge.send_pat('目标昵称', 'peer_wxid', pat_id='pat-abc-2'), True)
        acks = self.acks.pat_acks()
        self.assertEqual(len(acks), 1)
        self.assertEqual(acks[0]['json']['patId'], 'pat-abc-2')
        self.assertIs(acks[0]['json']['ok'], True)
        self.assertEqual(acks[0]['json']['reason'], 'sent')

    def test_pat_without_receipt_id_does_not_call_kernel(self):
        u = _FakeUIA()
        bridge = _new_bridge(u, self.logs)
        bridge._pat_friend_row = lambda uu: None
        bridge.send_pat('目标昵称', 'peer_wxid')
        self.assertEqual(self.acks.pat_acks(), [], '旧调用方没有单号时不要凭空造回执')


if __name__ == '__main__':
    unittest.main(verbosity=2)
