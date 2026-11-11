"""对已安装 wechatauto 的最小兼容补丁。

桥接运行时加载的是 runtime/python 里的 wechatauto，不一定是仓库 vendor；
这里集中处理运行期必须的补丁，避免把兼容代码散落在朋友圈互动流程里，
也避免直接修改 vendor/wechatauto 的上游源码。

当前补丁：
1. 新版 OpenCV 对非连续数组做 matchTemplate 会访问违规；
2. 朋友圈「发布者 + 关键词」必须同时匹配，避免同一发布者的旧动态永远命中最新一条；
3. 取消赞只找「取消」，找不到就失败，绝不回退点「赞」把取消变成点赞；
4. MomentDB.parse_feed 接收调用方传入的真实 tid，不用发布者 wxid 顶替；
5. Like/Comment 的右键单元格兜底一律关闭，只走已确认浮层的 “…” 路线。
"""

import logging


log = logging.getLogger("wechatauto.moment_compat")
_INSTALLED = False


def _install_contiguous_patch():
    """新版 OpenCV 对非连续数组做 matchTemplate 会访问违规。"""
    try:
        from wechatauto.moment import Moment
    except Exception:
        return False
    original = getattr(Moment, '_match_template_multi', None)
    if original is None:
        return False
    if getattr(original, '_whale_contiguous', False):
        return True

    def fixed(self, scr, tpl, rleft, rtop, rw, rh, scales=None, min_ncc=0.65):
        try:
            import cv2
            import numpy as np
        except Exception:
            return None
        if scales is None:
            scales = (0.6, 0.7, 0.8, 0.9, 1.0, 1.05, 1.1, 1.15, 1.2)
        sub = np.ascontiguousarray(scr[rtop:rtop + rh, rleft:rleft + rw])
        best = (0.0, None)
        for scale in scales:
            tw, th = int(tpl.shape[1] * scale), int(tpl.shape[0] * scale)
            if tw < 8 or th < 8 or tw >= sub.shape[1] or th >= sub.shape[0]:
                continue
            tmp = cv2.resize(np.ascontiguousarray(tpl), (tw, th), interpolation=cv2.INTER_AREA)
            res = cv2.matchTemplate(sub, tmp, cv2.TM_CCOEFF_NORMED)
            _, score, _, loc = cv2.minMaxLoc(res)
            if score > best[0]:
                best = (score, (int(rleft + loc[0] + tw // 2), int(rtop + loc[1] + th // 2), scale))
        if best[0] < min_ncc:
            return None
        score, (cx, cy, scale) = best
        return (score, cx, cy, scale)

    fixed._whale_contiguous = True
    Moment._match_template_multi = fixed
    return True


def _install_moment_match_patch():
    """发布者 + 关键词必须同时匹配；只给一个条件时才退化为单条件。"""
    try:
        from wechatauto.moment import Moment
    except Exception:
        return False
    if getattr(Moment._target_idx, '_whale_identity_match', False):
        return True

    def target_idx(self, db_posts, publisher, keyword):
        for i, f in enumerate(db_posts):
            if publisher and f.get('nickname') != publisher:
                continue
            if keyword and keyword not in (f.get('text') or ''):
                continue
            return i
        return None

    def matches(self, item, publisher, keyword):
        if not publisher and not keyword:
            return False
        try:
            name = item.control.Name or ''
        except Exception:
            name = ''
        if publisher:
            try:
                nick = item.publisher
            except Exception:
                nick = ''
            if nick != publisher and publisher not in name:
                return False
        if keyword:
            try:
                text = item.text or ''
            except Exception:
                text = ''
            if keyword not in text and keyword not in name:
                return False
        return True

    target_idx._whale_identity_match = True
    matches._whale_identity_match = True
    Moment._target_idx = target_idx
    Moment._matches = matches
    return True


def _install_like_patch():
    """取消赞只找「取消」；找不到就失败，不回退点「赞」。"""
    try:
        from wechatauto import rhythm
        from wechatauto.moment import Moment, MomentActionMenu, _lang, MOMENTS
        from wechatauto.param import WxResponse
    except Exception:
        return False
    if getattr(Moment._like_open, '_whale_cancel_safe', False):
        return True

    original_like_open = Moment._like_open

    def like_open(self, cancel=False):
        if not cancel:
            return original_like_open(self, False)
        rhythm.gate('like')
        for nm in [_lang(MOMENTS, '取消')]:
            if self._click_float_button(nm, timeout=2.5):
                return True
        return False

    original_menu_like = MomentActionMenu.like

    def menu_like(self, cancel=False):
        if not cancel:
            return original_menu_like(self, False)
        button = self._find_button([_lang(MOMENTS, '取消')])
        if not button:
            return WxResponse.failure('未找到取消点赞按钮')
        rhythm.gate('like')
        button.Click()
        return WxResponse.success('操作成功')

    like_open._whale_cancel_safe = True
    menu_like._whale_cancel_safe = True
    Moment._like_open = like_open
    MomentActionMenu.like = menu_like
    return True


def _install_db_tid_patch():
    """让 parse_feed 接收数据库里的真实 tid，而不是用发布者 wxid 顶替。"""
    try:
        from wechatauto.moment import MomentDB
    except Exception:
        return False
    if getattr(MomentDB.parse_feed, '_whale_tid_patch', False):
        return True

    original_parse_feed = MomentDB.parse_feed

    def parse_feed(self, xml, fallback_user='', tid=None):
        data = original_parse_feed(self, xml, fallback_user)
        if tid is not None:
            data['tid'] = tid
        return data

    def get_moments(self, limit=20, offset=0, username=None,
                    since=None, until=None, keyword=None):
        want_since = since is not None
        want_until = until is not None
        want_key = bool(keyword)
        if want_since or want_until or want_key:
            internal_limit = 0 if limit == 0 else max(limit * 20, 200)
        else:
            internal_limit = limit
        limit_clause = '' if internal_limit == 0 else 'LIMIT ? OFFSET ?'
        bind = () if internal_limit == 0 else (internal_limit, offset)

        conn = self._open_sns()
        try:
            if username:
                rows = conn.execute(
                    "SELECT tid, user_name, content FROM SnsTimeLine "
                    "WHERE user_name=? ORDER BY tid DESC " + limit_clause,
                    (username,) + bind,
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT tid, user_name, content FROM SnsTimeLine "
                    "ORDER BY tid DESC " + limit_clause,
                    bind,
                ).fetchall()
        finally:
            conn.close()

        feeds = [self.parse_feed(r['content'], r['user_name'], r['tid']) for r in rows]
        if want_since or want_until or want_key:
            out = []
            for f in feeds:
                if want_since and f['create_time'] < since:
                    continue
                if want_until and f['create_time'] > until:
                    continue
                if want_key and keyword and keyword not in f['text']:
                    continue
                out.append(f)
            if limit and len(out) > limit:
                return out[:limit]
            return out
        return feeds

    def get_moment(self, tid):
        conn = self._open_sns()
        try:
            r = conn.execute(
                "SELECT tid, user_name, content FROM SnsTimeLine WHERE tid=?",
                (tid,),
            ).fetchone()
        finally:
            conn.close()
        return self.parse_feed(r['content'], r['user_name'], r['tid']) if r else None

    parse_feed._whale_tid_patch = True
    get_moments._whale_tid_patch = True
    get_moment._whale_tid_patch = True
    MomentDB.parse_feed = parse_feed
    MomentDB.get_moments = get_moments
    MomentDB.get_moment = get_moment
    return True


def _install_no_right_click_patch():
    """Like/Comment 不再右键动态单元格。

    上游在“…”浮层弹不出来时会回退 ``_invoke_action_menu``：有 ButtonControl 就
    左键，没有就 ``RightClick`` 整条动态。用户明确要求宁可失败也不要右键，
    这里把回退入口直接封掉，让 Like/Comment 只走已经验证浮层的
    ``_locate_more_click`` 那条路。
    """
    try:
        from wechatauto.moment import Moment
    except Exception:
        return False
    if getattr(Moment._invoke_action_menu, '_whale_no_right_click', False):
        return True

    def invoke_action_menu(self, item):
        log.debug('跳过右键兜底：朋友圈互动只走 “…” 浮层')
        return None

    invoke_action_menu._whale_no_right_click = True
    Moment._invoke_action_menu = invoke_action_menu
    return True


def install():
    """幂等安装；wechatauto 不可用时安静返回 False，不影响桥接启动。"""
    global _INSTALLED
    if _INSTALLED:
        return True
    try:
        import wechatauto.moment  # noqa: F401  确认目标版本已可导入
    except Exception as exc:
        log.debug('moment_compat: wechatauto 不可用，跳过：%s', exc)
        return False

    patches = (
        ('contiguous', _install_contiguous_patch),
        ('identity', _install_moment_match_patch),
        ('cancel-like', _install_like_patch),
        ('db-tid', _install_db_tid_patch),
        ('no-right-click', _install_no_right_click_patch),
    )
    applied = []
    failed = []
    for name, installer in patches:
        try:
            (applied if installer() else failed).append(name)
        except Exception as exc:  # 上游结构变了也不能拖垮桥接，但要留下证据
            failed.append(name)
            log.warning('moment_compat: %s 补丁未生效 type=%s', name, type(exc).__name__)
    _INSTALLED = True
    if failed:
        log.warning('moment_compat: 已生效 %s；未生效 %s（wechatauto 可能升级了）',
                    ','.join(applied) or '-', ','.join(failed))
    else:
        log.debug('moment_compat: 全部生效 %s', ','.join(applied))
    return True

