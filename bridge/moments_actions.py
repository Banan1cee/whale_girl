"""朋友圈手动交互适配：复用库 API，限制搜索范围，不重试发送。"""

# 交互只处理最近一段屏幕，避免一次点击滚动太多页、把微信窗口占住。
MAX_SCREENS = 20


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

    # 传 db 才能用数据库标尺定位；不传时库只会在当前视野附近向下扫。
    db = getattr(getattr(moment, '_wx', None), '_db', None)
    item = moment.find_moment(publisher=publisher, keyword=keyword, db=db, max_screens=MAX_SCREENS)
    if item is None:
        return note('target_not_found')
    item._ensure_parsed()
    # 库的搜索允许模糊匹配，写操作必须再核对发布者和正文，避免命中相似昵称。
    if item.nickname.strip() != publisher or keyword not in (item.content or ''):
        return note('target_mismatch')

    if action in ('like', 'unlike'):
        resp = moment.Like(item, cancel=action == 'unlike', max_retry=1)
        if resp:
            return True
        # 取消点赞找不到「取消」入口时必须失败，绝不能回退成点赞。
        return note('cancel_not_found' if action == 'unlike' else 'interaction_failed')
    if action == 'comment':
        return True if moment.Comment(item, query['content'], max_retry=1) else note('interaction_failed')
    return True if moment.ReplyComment(item, reply_to=query['replyTo'], content=query['content']) else note('interaction_failed')
