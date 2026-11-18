# -*- coding: utf-8 -*-
"""发送临界区状态与会话身份错误。

`SEND_STATE` 是发送看门狗的唯一状态源：进发送区置位、出区清零。
`ChatIdentityError` 表示「当前会话不是目标会话」，只能整条放弃，不能换通道重试；
`DraftDirtyError` 表示输入框可能残留草稿，同样禁止换通道继续发。
"""

import re
import time

SEND_STATE = {"active": False, "start": 0.0, "budget": 40.0}

_CHAT_NAME_SPLIT_RE = re.compile(r"[、,，;；/]+")


class ChatIdentityError(RuntimeError):
    """当前开着的会话不是目标会话：宁可这条不发，也不能把正文打进别的群。

    发送 = 先切会话、再往「当前输入框」里打字。只要切会话没成功（名字只是相似、
    或者中途窗口被切走），正文就落到别的会话里 —— 表现就是「两个群同时回的时候
    把消息搞混」。这种错不能靠换通道兜底：换哪条通道都是往「当前那个会话」打字，
    所以整条放弃。
    """


class DraftDirtyError(RuntimeError):
    """输入框可能残留本次草稿，禁止换通道继续发送。"""


def _chat_identity_level(current, aliases):
    """当前会话名和目标候选名有多像：0 完全相同、1 成员名集合吻合，其它一律不收。

    以前用「包含」也算命中（`name in alias`），于是「群A」和「群A2」互认：
    点开 A2 也判定成「已经在 A 了」，正文就发到另一个群。这里只认两种确定情形，
    未命名的群在会话列表里显示成「成员甲、成员乙」，所以保留成员名集合这一档。
    """
    from collections import Counter
    cur = str(current or "").strip()
    if not cur:
        return None
    candidates = [aliases] if isinstance(aliases, str) else (aliases or [])
    keys = [str(a or "").strip() for a in candidates if str(a or "").strip()]
    if not keys:
        return None
    if cur in keys:
        return 0
    # Compare exact token multiplicities, never substrings or a subset. Keep
    # internal spaces: a named contact 'A B' must not merge with 'AB'.
    parts = [p.strip() for p in _CHAT_NAME_SPLIT_RE.split(cur) if p.strip()]
    if len(parts) >= 2:
        for k in keys:
            wanted = [p.strip() for p in _CHAT_NAME_SPLIT_RE.split(k) if p.strip()]
            if Counter(parts) == Counter(wanted):
                return 1
    return None


def chat_identity_fact(current, aliases, target_username='', known_chats=None):
    """Known canonical contradictions may reject, never expand alias authority."""
    level = _chat_identity_level(current, aliases)
    if level is None:
        return {'level': None, 'reason': 'title_not_authorized'}
    if target_username and known_chats:
        rows = known_chats.items() if isinstance(known_chats, dict) else ((None, row) for row in known_chats)
        candidates = set()
        for key, row in rows:
            if not isinstance(row, dict):
                continue
            username = str(row.get('username') or key or '')
            titles = [row.get(name) for name in ('nick_name', 'remark', 'name', 'display_name') if row.get(name)]
            if username and _chat_identity_level(current, titles) is not None:
                candidates.add(username)
        if candidates and candidates != {str(target_username)}:
            return {'level': None, 'reason': 'ambiguous_or_different_canonical_target'}
    return {'level': level, 'reason': 'exact_title' if level == 0 else 'exact_members'}


class _SendStateScope:
    """发送临界区的看门狗心跳（M7/H3）：进区置位、出区清零，单一 owner 写 SEND_STATE。

    预算按文本长度动态放宽：bg 通道逐字投递，长文本单打字就要一两分钟，
    旧的「固定 40 秒一刀切」会把这种合法慢发送当卡死杀掉（H3）。
    """

    def __init__(self, text_len=0, *, budget=0):
        # 编码热切换时最多输入两次（一次 GBK、一次 UTF-16），并留出回读/清理时间。
        self.budget = max(40.0, float(text_len or 0) * 0.16 + 8.0, float(budget))

    def __enter__(self):
        try:
            from send_attempt import logical_operation, begin_watch
        except ImportError:
            from .send_attempt import logical_operation, begin_watch
        self._previous = dict(SEND_STATE)
        self._operation_scope = logical_operation(budget=self.budget)
        self.operation = self._operation_scope.__enter__()
        self._watch = begin_watch(SEND_STATE, self.operation, epoch_start=time.time())
        return self

    def __exit__(self, *exc):
        try:
            from send_attempt import end_watch
        except ImportError:
            from .send_attempt import end_watch
        def restore_state():
            end_watch(self._watch, self._previous)
        # An opaque worker can outlive its caller. Keep its watch active and
        # prevent a heartbeat/rebind race until the worker actually finishes.
        self.operation.when_idle(restore_state)
        self._operation_scope.__exit__(*exc)
        return False
