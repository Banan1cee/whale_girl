# -*- coding: utf-8 -*-
"""微信「拍一拍」提示解析。

微信 4.x 里拍一拍不是普通文本：库里存的是 appmsg（type 62）或系统消息，
显示内容大致长这样（不同版本引号可能是英文/中文/直角）：

    "初一" 拍了拍 "鲸鲸"
    "秧秧" 拍了拍 "挽霜" 的棺材说挤一挤
    "阿琨" 拍了拍我

这个模块只做纯文本解析，不 import wechatauto / engine，方便单测。
"""

import html
import re

_QUOTES_L = '"“「『'
_QUOTES_R = '"”」』'
_TITLE_RE = re.compile(r'<title[^>]*>(.*?)</title>', re.S | re.I)
_TEMPLATE_RE = re.compile(r'<template[^>]*>(.*?)</template>', re.S | re.I)
_TAG_RE = re.compile(r'<[^>]+>')
_CLOSED_TARGET_RE = re.compile(
    r'^\s*[' + _QUOTES_L + r']\s*(.{1,40}?)\s*[' + _QUOTES_R + r']\s*(.*)$', re.S)
_OPEN_TARGET_RE = re.compile(
    r'^\s*[' + _QUOTES_L + r']\s*(.+)$', re.S)
_BARE_TARGET_RE = re.compile(
    r'^(.{1,40}?)(?=\s|的|啊|呀|吧|嘛|哦|呢|$)', re.S)


def _strip_quotes(value):
    text = str(value or '').strip()
    text = text.strip(_QUOTES_L + _QUOTES_R + ' \t\r\n')
    return text.strip()


def _plain_text(content):
    """把 appmsg / sysmsg XML 或纯标题都收敛成一行可解析文本。"""
    text = html.unescape(str(content or ''))
    match = _TITLE_RE.search(text) or _TEMPLATE_RE.search(text)
    if match:
        text = html.unescape(match.group(1))
    text = _TAG_RE.sub('', text)
    return re.sub(r'\s+', ' ', text).strip()


def looks_like_pat(mtype, content):
    """这条消息像不像微信的拍一拍提示。

    普通聊天也可能说「我拍了拍他的头」，不能见「拍了拍」就当动作。
    拍一拍在库里是系统消息 / appmsg（type 62）或带引号的标题；
    普通文本必须整条以引号包裹的人名开头才算。
    """
    raw = str(content or '')
    text = _plain_text(raw)
    if '拍了拍' not in text:
        return False
    if str(mtype or '') in ('系统消息', '文件/链接/卡片'):
        return True
    if raw.lstrip().startswith('<'):
        return True
    return bool(re.match(r'^\s*[' + _QUOTES_L + r']', text))


def parse_pat(content):
    """解析拍一拍提示；不是拍一拍就返回 None。

    Returns:
        None，或 {'source': 拍人者, 'target': 被拍者, 'suffix': 自定义后缀, 'text': 原提示}
    """
    text = _plain_text(content)
    if not text or '拍了拍' not in text:
        return None
    head, rest = text.split('拍了拍', 1)
    source = _strip_quotes(head)
    rest = rest.strip()
    if not rest:
        return None
    target = ''
    suffix = ''
    quoted = _CLOSED_TARGET_RE.match(rest)
    if quoted:
        target = quoted.group(1).strip()
        suffix = quoted.group(2).strip()
    else:
        bare = _BARE_TARGET_RE.match(rest)
        if bare:
            target = bare.group(1).strip()
            suffix = rest[len(bare.group(1)):].strip()
        else:
            opened = _OPEN_TARGET_RE.match(rest)
            if opened:
                target = opened.group(1).strip()
            else:
                target = rest[:40].strip()
                suffix = rest[40:].strip()
    target = _strip_quotes(target)
    if not target:
        return None
    return {
        'source': source,
        'target': target,
        'suffix': suffix,
        'text': text,
    }


def targets_self(pat, self_names):
    """这次拍一拍拍的是不是鲸鲸本人。

    - 私聊里微信常写成「拍了拍我」，直接算；
    - 群里写的是对方看到的昵称/备注，用配置里的名字和登录昵称匹配。
    """
    if not isinstance(pat, dict):
        return False
    target = _strip_quotes(pat.get('target'))
    if not target:
        return False
    if target in ('我', '你'):
        return True
    for raw in self_names or ():
        name = _strip_quotes(raw)
        if not name:
            continue
        if target == name:
            return True
        if len(name) >= 2 and (target.endswith(name) or name.endswith(target)):
            return True
    return False
