# -*- coding: utf-8 -*-
"""群聊 @ 解析：把「她叫什么」和「这条是不是在叫她」收敛到一处。

微信 4.2 的群消息正文形如 ``wxid_xxx:\n@许愿\u2005正文``，其中 ``\u2005``
是微信自己的 @ 分隔符。以前这里散落在 receiver_mixin 里，只认人设别名；
账号昵称、备注、群里改过的名字都不认，于是 ``at_me`` 一直是 false。

这个模块只做纯文本计算，不读配置、不碰数据库，方便直接测：
  - ``build_names`` 合并人设名、别名、账号昵称/备注、wxid 等；
  - ``analyze`` 解析 @ 名字、判断有没有叫她、裸 @、以及 @ 了别人。
"""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable, List

#: 微信 @ 的结束分隔符。不能先把它换成普通空格，否则带空格的昵称会被切断。
AT_DELIM = "\u2005"
#: 归一化时把分隔符换成私用占位符，避免 NFKC 把它变成普通空格。
_AT_SENTINEL = "\x01"
_ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\ufeff"), None)
#: 这些不是「她」，也不该算成「在跟别人说话」。
_IGNORED_MENTIONS = {"所有人", "全体成员", "all"}
#: 群消息前缀：wxid_xxx:\n
_SENDER_PREFIX_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_\-]{3,}:\s*")
#: @ 后面允许出现的结束字符（除 \u2005 占位符外）。
_AT_END = r"(?=$|[\s\x01，,：:！!~～…?？。\-—])"


def _clean(value) -> str:
    return str(value or "").translate(_ZERO_WIDTH).replace("\u00a0", " ").strip()


def normalize(value) -> str:
    """比较用的归一化：去零宽、保留 @ 分隔符、NFKC、大小写不敏感。"""
    text = _clean(value).replace(AT_DELIM, _AT_SENTINEL)
    return unicodedata.normalize("NFKC", text).casefold()


def build_names(*groups: Iterable[str]) -> List[str]:
    """合并所有「可能是她」的名字，去重并按长度倒序。

    传入的每一项可以是字符串或字符串列表。空白、``所有人`` 这类广播词会被丢掉。
    """
    out: List[str] = []
    seen = set()
    for group in groups:
        if isinstance(group, str):
            group = [group]
        for raw in group or []:
            name = _clean(raw)
            key = normalize(name)
            if not key or key in seen or key in _IGNORED_MENTIONS:
                continue
            seen.add(key)
            out.append(name)
    out.sort(key=len, reverse=True)
    return out


def _mentioned_tokens(text: str) -> List[str]:
    """从归一化文本里取出 @ 到的显示名（只用于 mentioned_names）。"""
    tokens: List[str] = []
    for match in re.finditer(r"@\s*([^\n@\x01]+?)(?=\x01|$|[\s，,：:！!~～…?？。\-—])", text):
        name = match.group(1).strip()
        if name and normalize(name) not in _IGNORED_MENTIONS:
            tokens.append(name)
    return tokens


def analyze(content, names: Iterable[str], group_title: str = "") -> dict:
    """解析一条群消息里的 @ 信息。

    返回：
      addressed       有没有 @ 她；
      bare_self       去掉「@她」之后正文是否为空（用于补上一条问题）；
      bare_any        去掉所有 @ 之后正文是否为空（结构化 @ 元数据命中时用）；
      mentioned_names @ 到的其他人（已排除她自己、所有人、全体成员、群名）。
    """
    raw = _SENDER_PREFIX_RE.sub("", _clean(content), count=1)
    text = normalize(raw)
    self_names = [normalize(n) for n in names if normalize(n)]
    self_set = set(self_names)

    if self_names:
        pattern = re.compile(
            r"@\s*(?:" + "|".join(re.escape(n) for n in sorted(self_names, key=len, reverse=True)) + r")"
            + _AT_END,
            re.IGNORECASE,
        )
        self_spans = [m.span() for m in pattern.finditer(text)]
    else:
        pattern = None
        self_spans = []

    addressed = bool(self_spans)
    # 去掉「@她」；其他 @ 保留。和旧逻辑一致：@她 @别人 不算裸 @。
    self_removed = text
    for start, end in reversed(self_spans):
        self_removed = self_removed[:start] + " " + self_removed[end:]
    bare_self = not self_removed.strip(" \t\r\n\x01，,。.!！?？…~～")

    # 去掉所有 @token；只用于结构化元数据已确认「确实 @ 了她」的场景。
    any_removed = re.sub(r"@\s*[^\n@\x01]+?(?=\x01|$|[\s，,：:！!~～…?？。\-—])", " ", text)
    bare_any = not any_removed.strip(" \t\r\n\x01，,。.!！?？…~～")

    mentioned = []
    group_key = normalize(group_title)
    for token in _mentioned_tokens(text):
        key = normalize(token)
        if key in self_set or key in _IGNORED_MENTIONS:
            continue
        if group_key and key == group_key:
            continue
        if key not in {normalize(x) for x in mentioned}:
            mentioned.append(token)

    return {
        "addressed": addressed,
        "bare_self": bare_self,
        "bare_any": bare_any,
        "mentioned_names": mentioned[:8],
        "names": self_names,
    }


def contains_name(text, names: Iterable[str]) -> bool:
    """正文里是否出现她的名字（用于「上一条已经叫过她」这类判断）。

    只做归一化后的包含比较，但要求名字至少 2 个字，避免单字别名把任意句子
    都当成在叫她。调用方再用 @ 解析判断真正的点名。
    """
    body = normalize(text)
    for name in names:
        key = normalize(name)
        if len(key) >= 2 and key in body:
            return True
    return False
