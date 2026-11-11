"""朋友圈手动互动：打开朋友圈、定位动态，再交给 wechatauto 完成点赞/评论/回复。

为什么这么薄：
  - 1.2.10 的 ``_locate_more_click`` 已经负责「左键点 … → 确认浮层真的弹出」，
    并在失败时微调滚动重试；桥接再抄一份只会和上游越走越远。
  - ``Like`` / ``Comment`` 的右键兜底已由 ``bridge/moment_compat.py`` 关闭，
    所以这里直接调用它们，既不会右键动态单元格，也不会把未执行报成完成。
  - 桥接只保留三件上游不该管的事：打开朋友圈并抢前台、写操作前复核发布者/正文、
    把 ``WxResponse`` 收敛成固定错误码（日志不写昵称和评论正文）。
"""

# 手动互动只处理最近一段屏幕，避免一次点击滚太多页、把微信窗口占住。
MAX_SCREENS = 20
# 一条动态最多让“…”浮层重试几轮；再久就该让用户自己确认微信状态了。
MAX_RETRIES = 6


def _bring_foreground(moment):
    """把微信主窗拉回前台，并返回是否真的到了前台。

    库里的 ``_ensure_window_foreground`` 只做 SetForegroundWindow + 点标题栏兜底，
    在前台锁生效（刚点过启动器按钮）时经常失败。这里优先用 GUI 自己的
    ``bring_to_front``（AttachThreadInput + 临时置顶），拿不到前台也不抛异常。
    """
    try:
        gui = moment._wx._gui
        hwnd = int(gui.main_hwnd or 0)
    except Exception:
        return False
    if not hwnd:
        return False
    try:
        import ctypes
        if ctypes.windll.user32.GetForegroundWindow() == hwnd:
            return True
    except Exception:
        pass
    try:
        if hasattr(gui, 'bring_to_front'):
            gui.bring_to_front()
    except Exception:
        pass
    try:
        import ctypes
        return ctypes.windll.user32.GetForegroundWindow() == hwnd
    except Exception:
        return False


def _open_moments(moment, log=None):
    """打开朋友圈页面并把微信拉到前台；返回是否确认切换成功。

    拿不到前台不直接放弃：先让 UIA 去点导航，找不到再交给 find_moment 报错。
    """
    _bring_foreground(moment)
    try:
        opened = bool(moment._wx.SwitchToMoments())
    except Exception:
        opened = False
    if log:
        log('朋友圈互动：打开朋友圈=%s' % ('ok' if opened else 'failed'))
    _bring_foreground(moment)
    return opened


def _success(resp):
    """``WxResponse`` / bool 统一成成功与否；Mock 或未知类型一律按失败处理。"""
    if isinstance(resp, bool):
        return resp
    return getattr(resp, 'is_success', False) is True


def _failure_code(action):
    # 取消点赞找不到「取消」入口时给单独错误码，内核会提示“避免误点成点赞”。
    return 'cancel_not_found' if action == 'unlike' else 'interaction_failed'


def perform(moment, action, query, log=None):
    """执行一次朋友圈互动。

    Returns:
        True 表示界面操作已执行（不代表微信服务器已确认）；
        字符串表示固定失败码，供内核转成用户提示。
    """
    def note(reason):
        if log:
            # 只记录固定失败码，不记录昵称、正文或评论内容。
            log('朋友圈互动未执行 reason=%s' % reason)
        return reason

    def trace(message):
        if log:
            log(message)

    if action not in ('like', 'unlike', 'comment', 'reply'):
        raise ValueError('unsupported action')
    publisher = (query.get('publisher') or '').strip()
    keyword = (query.get('keyword') or '').strip()
    if not publisher or not keyword or moment is None:
        return note('target_not_found')
    if action in ('comment', 'reply') and not query.get('content'):
        return note('interaction_failed')
    if action == 'reply' and not query.get('replyTo'):
        return note('interaction_failed')

    trace('朋友圈互动：开始 action=%s' % action)
    _open_moments(moment, log)

    # 传 db 才能用数据库标尺定位；不传时库只会在当前视野附近向下扫。
    db = getattr(getattr(moment, '_wx', None), '_db', None)
    item = moment.find_moment(publisher=publisher, keyword=keyword, db=db, max_screens=MAX_SCREENS)
    trace('朋友圈互动：定位=%s' % ('found' if item is not None else 'not_found'))
    if item is None:
        return note('target_not_found')

    item._ensure_parsed()
    # 库的搜索允许模糊匹配，写操作必须再核对发布者和正文，避免命中相似昵称。
    if item.nickname.strip() != publisher or keyword not in (item.content or ''):
        return note('target_mismatch')

    # 定位只读控件树；真正的点赞/评论是鼠标点击，必须确认微信真的在前台，
    # 否则 pyautogui 会把点击投给启动器或别的窗口。
    if not _bring_foreground(moment):
        trace('朋友圈互动：微信没有切到前台，放弃点击')
        return note('interaction_failed')

    if action in ('like', 'unlike'):
        resp = moment.Like(item, cancel=action == 'unlike', max_retry=MAX_RETRIES)
    elif action == 'comment':
        resp = moment.Comment(item, query['content'], max_retry=MAX_RETRIES)
    else:
        resp = moment.ReplyComment(item, reply_to=query['replyTo'], content=query['content'])

    if _success(resp):
        trace('朋友圈互动：%s 结果=ok' % action)
        return True
    trace('朋友圈互动：%s 结果=failed' % action)
    return note(_failure_code(action))
