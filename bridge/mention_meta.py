# -*- coding: utf-8 -*-
"""读取微信消息 source 里的 ``atuserlist``，按 wxid 判断有没有 @ 自己。

文本匹配昵称最大的问题是「显示名会变」：账号昵称、群昵称、备注、空格、emoji。
微信自己的 @ 元数据里存的是 wxid，不受这些影响。vendor 的 ``get_messages``
没有把 ``source`` 带出来，但查询本身已经 SELECT 了这一列；这里用只读的兼容层
按 ``(会话, local_id, shard)`` 回读一条，不改 vendor 源码。

读不到、没有 atuserlist、或字段格式变化时返回 None，调用方继续用显示名兜底。
"""
from __future__ import annotations

import re

_ATUSERS_RE = re.compile(r"<atuserlist[^>]*>(.*?)</atuserlist>", re.I | re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_SPLIT_RE = re.compile(r"[,;\s]+")


def _decode(source) -> str:
    if source is None:
        return ""
    if isinstance(source, str):
        return source
    if isinstance(source, (bytes, bytearray)):
        raw = bytes(source)
        for encoding in ("utf-8", "utf-16-le", "gb18030"):
            try:
                return raw.decode(encoding)
            except (UnicodeDecodeError, LookupError):
                continue
    return str(source)


def at_usernames(source) -> list:
    """从 source XML/文本里取出 atuserlist 的 wxid 列表。"""
    text = _decode(source)
    match = _ATUSERS_RE.search(text)
    if not match:
        return []
    body = re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", match.group(1), flags=re.S)
    body = _TAG_RE.sub("", body)
    return [part.strip() for part in _SPLIT_RE.split(body) if part.strip()]


def self_mentioned(db, chat_username, msg, self_ids) -> bool:
    """返回 True/False；没有结构化证据时返回 None。

    ``self_ids`` 是可能的自己：真 wxid、账号目录推出来的 wxid、账号目录名。
    """
    ids = {str(x or "").strip() for x in (self_ids or []) if str(x or "").strip()}
    if not db or not chat_username or not msg or not ids:
        return None
    local_id = msg.get("local_id")
    if local_id is None:
        return None
    try:
        local_id = int(local_id)
    except (TypeError, ValueError):
        return None

    def build(tables):
        return db._shard_rows(tables, "WHERE local_id=?", (local_id,), per_shard_limit=2)

    try:
        rows = db._run_msg_query(chat_username, build) or []
    except Exception:
        return None

    shard = msg.get("shard")
    row = None
    for item in rows:
        if not shard or str(item["shard"]) == str(shard):
            row = item
            break
    if row is None:
        return None

    try:
        usernames = at_usernames(row["source"])
    except (KeyError, IndexError, TypeError):
        return None
    if not usernames:
        return None
    return bool(ids & set(usernames))
