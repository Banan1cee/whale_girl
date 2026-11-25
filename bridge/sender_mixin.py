# -*- coding: utf-8 -*-
"""Bridge runtime mixin: SenderMixin."""
import engine as G


class SenderMixin:

    def bg_send(self, text, chat_display_name, chat_username=''):
        """零焦点通道：用窗口消息打字 + 点发送，全程不抢前台。

        见 `bridge/bg_sender.py` 与 `docs/微信消息后台发送.md`。只有确认未输入才可回退；
        不透明或可能已发送的结果按 handled 终止。**不动 gui、不碰 win32gui**，
        所以即使 wechatauto 的 UIA 引擎挂了这条也能用。
        """
        from send_attempt import operation_for_call, bind_runtime_identity
        import time as elapsed_time
        operation = operation_for_call(len(text))
        if not bind_runtime_identity(operation, self, chat_username):
            raise G.ChatIdentityError('后台通道账号或目标改变')
        clock = getattr(G.time, 'monotonic', elapsed_time.monotonic)
        if not G.BG_SEND.get('enabled', True) or self.BG_STATS['disabled']:
            return False
        hwnd = self._bg_hwnd()
        if not hwnd:
            return False
        allow_foreground = G.BG_SEND.get('fallback', True)
        if allow_foreground and self.BG_STATS.get('residueHwnd') == hwnd:
            operation.record('not_sent', 'background_residue_session')
            return False
        if clock() < self.BG_STATS['cooldownUntil']:
            return False
        if not operation.reserve('background'):
            return operation.result.handled
        try:
            import bg_sender
        except Exception:
            try:
                from . import bg_sender
            except Exception as e:
                self.BG_STATS['disabled'] = True
                G.log('后台通道：模块导入失败，本次运行内关闭这条通道：', repr(e))
                return False
        try:
            bg_sender.configure(G.BG_SEND, state_file=G.os.path.join(G.ROOT, 'data', 'wechat-encoding.json'))
        except Exception:
            pass
        if chat_username:
            keys = self.aliases_for(chat_username, chat_display_name) or [chat_display_name]
        else:
            keys = [chat_display_name]
        t0 = clock()
        try:
            ok, why = bg_sender.send(text, chat=keys, hwnd=hwnd, log=G.log,
                                     char_gap=G.BG_SEND.get('charGap', 0.04),
                                     strip_unencodable=G.BG_SEND.get('strip', True),
                                     verify=G.BG_SEND.get('verify', True), unhide=G.BG_SEND.get('unhide', True),
                                     char_mode=G.BG_SEND.get('charMode') or 'auto',
                                     allow_legacy_invoke=not allow_foreground)
        except Exception as e:
            ok, why = (False, 'exception:' + type(e).__name__)
            G.log_warn('后台通道异常：', repr(e))
        self.BG_STATS['tried'] += 1
        self.BG_STATS['last'] = why
        self.BG_STATS['lastAt'] = G.time.time()
        status = 'uncertain' if why == 'sent_unverified' else 'submitted' if ok else 'failed'
        G.log('[delivery] stage=background result=%s reason=%s' % (status, why))
        if why == 'chat_mismatch':
            operation.record('identity_mismatch', why)
            raise G.ChatIdentityError('后台通道：当前会话不是目标 %s' % G.safe_name(chat_display_name))
        if why == 'content_mismatch':
            operation.record('draft_dirty', why)
            raise G.DraftDirtyError('正文回读校验未通过，本次输入已清理，未发送（%s）' % why)
        if why == 'input_not_empty':
            operation.record('draft_dirty', why)
            raise G.DraftDirtyError('目标输入框已有草稿，本条未输入也未发送，请先手动处理草稿（input_not_empty）')
        if why == 'input_dirty':
            operation.record('draft_dirty', why)
            raise G.DraftDirtyError('本次输入中断或清理未确认，已暂停发送，请检查目标输入框（input_dirty）')
        if why == 'residue_left':
            # 等待不会修好同一窗口的后台提交。前台兜底只适用于后续新消息。
            self.BG_STATS['residueHwnd'] = hwnd
            if not allow_foreground:
                self.BG_STATS['cooldownUntil'] = clock() + 120
            operation.record('draft_dirty', why)
            raise G.DraftDirtyError('已尝试点击发送但输入框未清空，请先核对微信是否已收到，避免重复补发（residue_left）')
        if ok:
            operation.effect_started = True
            operation.record('uncertain' if why == 'sent_unverified' else 'submitted', why)
            self.BG_STATS['ok'] += 1
            self.BG_STATS['treeFails'] = 0
            G.log('后台通道已处理（%s，未确认送达，%.1fs）' % (why, clock() - t0))
            return True
        if not operation.can_continue() and not operation.effect_started:
            return False
        safe_before_input = {'empty', 'no_window', 'minimized', 'tree_not_ready', 'chat_not_found',
                             'no_input_field', 'no_send_button', 'send_point_unavailable',
                             'gbk_unsupported', 'uipi_denied', 'input_unreadable', 'foreground_required'}
        if why not in safe_before_input:
            operation.effect_started = True
            operation.record('uncertain', str(why))
            G.log('后台通道结果不确定，禁止换通道重发：', str(why))
            return True
        operation.record('not_sent', why)
        G.log('后台通道确认未输入（%s，%.1fs），可准备其它通道：%s' % (why, clock() - t0, G.safe_name(chat_display_name)))
        if why == 'tree_not_ready':
            self.BG_STATS['treeFails'] += 1
            if self.BG_STATS['treeFails'] >= 3:
                self.BG_STATS['cooldownUntil'] = clock() + 600
                self.BG_STATS['treeFails'] = 0
                G.log_throttled('bg-tree-cooldown', '后台通道连续 3 次读不到控件树，先停 10 分钟再试（其余通道不受影响）。排查：python -m bridge --bg-probe')
        if why == 'uipi_denied':
            G.log_throttled('bg-uipi', '后台通道被 UIPI 拒绝：微信是管理员权限、桥接不是。把两边权限调成一样（都用管理员，或都不用）即可。')
        elif why == 'minimized':
            G.log_throttled('bg-min', '微信最小化了：零焦点通道要求窗口显示出来（用「显示但不激活」拉出来，不抢前台）。')
        elif why == 'tree_not_ready':
            G.log_throttled('bg-tree', '后台通道读不到控件树：确认微信没缩在托盘；4.2 需要 wechatauto 的 gate 热激活，必要时提权重试。诊断：python -m bridge --bg-probe')
        elif why == 'chat_not_found' and chat_username:
            G.log('后台通道：%s 不在会话列表里，改用会搜索的通道' % G.safe_name(chat_display_name))
        return False

    def uia_send(self, text, who, username='', *, require_foreground=False):
        """UIA 单次不透明调用；True 表示已处理，不等于确认送达。"""
        from send_attempt import operation_for_call, bind_runtime_identity
        from send_input import is_blank, input_value
        operation = operation_for_call(len(text))
        if not operation.reserve('uia'):
            return operation.result.handled
        if not self.account_send_allowed('UIA'):
            operation.record('identity_mismatch', 'uia_account')
            return False
        if not self.wechat_window_alive():
            with self.gui_lock:
                self.UIA_CACHE['u'] = None
            return False
        u = self.UIA_CACHE['u']
        try:
            with self.gui_lock:
                fresh = self.gui._get_uia() if self.gui is not None else None
            if fresh is not None:
                u = fresh
            self.UIA_CACHE['u'] = u
        except Exception:
            u = self.UIA_CACHE['u']
        if u is None:
            operation.record('not_sent', 'uia_unavailable')
            return False
        if G.BACKGROUND_SEND:
            self.install_quiet_uia(u)
        keys = self.aliases_for(username, who) if username else [who]
        try:
            cur = None
            try:
                cur = u.current_chat()
            except Exception:
                pass
            hit_cur = cur == who or any((cur == k for k in keys if k))
            if not hit_cur and username:
                hit_cur = bool(cur) and self.open_cache.get(username) == cur
            if not hit_cur:
                if not u.open_chat(keys):
                    try:
                        u.back_to_chat_tab()
                    except Exception:
                        pass
                    if not operation.reserve('uia_reopen') or not u.open_chat(keys):
                        return False
                if username:
                    try:
                        self.open_cache[username] = u.current_chat() or ''
                        G.log('UIA 已切到会话：', G.safe_name(self.open_cache[username]))
                    except Exception:
                        pass
            self._require_chat_identity(u, who, keys, 'UIA')
            if not bind_runtime_identity(operation, self, username):
                raise G.ChatIdentityError('UIA 准备期间账号或目标改变')
            if (not self.account_send_allowed('UIA 复核') or not self.send_policy_allows(username, who)
                    or not self.sticker_quarantine_allows(username, who)):
                operation.record('cancelled', 'uia_gate_changed')
                return False
            if not is_blank(input_value(u)):
                raise G.DraftDirtyError('UIA 输入框有草稿或不可读，本条不输入')
            if require_foreground or getattr(G, 'MOMENTS_FORCE_FOREGROUND', False):
                window = self.snapshot_win_state()
                if not window['hwnd'] or window['fg'] != window['hwnd']:
                    operation.record('cancelled', 'uia_foreground_lost')
                    return False
            handled = operation.opaque('uia_send_text', lambda: u.send_text(text))
            if operation.result.status == 'submitted' and not is_blank(input_value(u)):
                operation.record('uncertain', 'uia_composer_unverified_after_submit')
            G.log('UIA 发送阶段=%s（不确定结果不重发）' % operation.result.status)
            return handled
        except (G.ChatIdentityError, G.DraftDirtyError) as exc:
            operation.record('identity_mismatch' if isinstance(exc, G.ChatIdentityError) else 'draft_dirty', type(exc).__name__)
            raise
        except Exception as e:
            operation.record('not_sent', 'uia_preparation:' + type(e).__name__)
            G.log_warn('UIA 发送异常：', repr(e))
        return False

    def recover_uia(self, reason=''):
        """强制重新热激活 UIA（rewrite gate byte + 校验），成功返回 True。

        微信跑久了会把 accessibility gate byte 归零，UIA 引擎就变成「假死」：
        能读消息、发不出去。以前只能重启桥接；这里让它自己救回来。
        """
        try:
            if self.gui is None:
                return False
            if not self.wechat_window_alive():
                with self.gui_lock:
                    self.UIA_CACHE['u'] = None
                G.log('UIA 重新热激活跳过（微信主窗当前不存在）')
                return False
            with self.gui_lock:
                u = self.gui._get_uia(refresh=True)
            self.UIA_CACHE['u'] = u
            if u is not None:
                G.log('UIA 已重新热激活%s' % ('（' + reason + '）' if reason else ''))
                return True
            G.log_warn('UIA 重新热激活失败%s' % ('（' + reason + '）' if reason else ''))
        except Exception as e:
            G.log('UIA 重新热激活异常：', repr(e))
        return False

    def keyboard_send(self, text, chat_display_name, chat_username=''):
        """键盘输入通道：只读核对会话/草稿 → 粘贴 → 回车 → 回读数据库确认。

        为什么需要它：UIA 依赖微信的 accessibility gate，微信跑久了/窗口状态怪的时候
        整条路都会挂（见 recover_uia 的注释）。键盘通道只用 Win32 按键 + 剪贴板，
        输入走微信搜索框；发送前仍须取得只读身份和空输入框证据。
        代价：会抢前台、慢一些，所以只在 UIA 真的发不出去时用。
        """
        from send_attempt import operation_for_call, bind_runtime_identity
        from send_input import is_blank, input_value
        operation = operation_for_call(len(text))
        if not operation.reserve('keyboard'):
            return operation.result.handled
        if not self.account_send_allowed('键盘通道'):
            operation.record('identity_mismatch', 'keyboard_account')
            return False
        try:
            import ctypes
            import win32api
            import win32clipboard
            import win32con
            import win32gui
            user32 = ctypes.windll.user32
        except Exception as e:
            G.log('键盘通道不可用（缺少 win32 模块）：', repr(e))
            return False
        hwnd = int(self.ACCOUNT.get('hwnd') or 0) or self.find_weixin_hwnd()
        if not hwnd:
            G.log('键盘通道：找不到微信主窗')
            return False

        def fg():
            return user32.GetForegroundWindow()
        if fg() != hwnd:
            user32.keybd_event(win32con.VK_MENU, 0, 0, 0)
            G.time.sleep(0.05)
            user32.SetForegroundWindow(hwnd)
            G.time.sleep(0.2)
            user32.keybd_event(win32con.VK_MENU, 0, 2, 0)
            G.time.sleep(0.2)
        if fg() != hwnd:
            try:
                user32.SwitchToThisWindow(hwnd, True)
                G.time.sleep(0.3)
            except Exception:
                pass
        if fg() != hwnd:
            G.log('键盘通道：抢不到前台，放弃这次（UIA 也不可用时这条就发不出去了）')
            return False

        def set_clip(t):
            opened = False
            for _ in range(5):
                try:
                    win32clipboard.OpenClipboard()
                    opened = True
                    break
                except Exception:
                    G.time.sleep(0.1)
            if not opened:
                raise RuntimeError('剪贴板打不开（可能被别的程序占用）')
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, t)
            finally:
                win32clipboard.CloseClipboard()

        def get_clip():
            """读出剪贴板当前文本；没有文本/读不到返回 None（M6 还原用）。"""
            for _ in range(5):
                try:
                    win32clipboard.OpenClipboard()
                    try:
                        return win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
                    finally:
                        win32clipboard.CloseClipboard()
                except Exception:
                    G.time.sleep(0.1)
            return None

        def restore_clip(saved):
            """发完把用户剪贴板还回去（M6）：以前发完剪贴板里一直留着要发的内容。"""
            if saved is None:
                return
            try:
                set_clip(saved)
            except Exception as e:
                G.log('键盘通道：还原剪贴板失败：', repr(e))

        def tap(vk, mods=()):
            for m in mods:
                user32.keybd_event(m, 0, 0, 0)
            user32.keybd_event(vk, 0, 0, 0)
            user32.keybd_event(vk, 0, 2, 0)
            for m in reversed(mods):
                user32.keybd_event(m, 0, 2, 0)
            G.time.sleep(0.12)

        def confirmed_target():
            """打开会话后确认「现在开着的到底是谁」。

            键盘通道是模拟按键，搜不到人时回车会落到「当前那个会话」上，
            正文就直接发给别人了 —— 2026-10-25 12:21 的日志里就出现过
            「键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话）」。
            这里用 UIA 的只读能力核对（读会话名在「能读不能发」的假死状态下依然可用）；
            读不到就宁可这条失败，也不盲发 —— 私聊内容发错人比晚回一条严重得多。
            返回 (是否匹配, 当前会话名)。
            """
            try:
                u = self.gui._get_uia() if self.gui is not None else None
                cur = u.current_chat() if u is not None else None
            except Exception:
                cur = None
            if not cur:
                return (None, None)
            cands = {chat_display_name}
            try:
                if chat_username:
                    cands.update(self.aliases_for(chat_username, chat_display_name))
                    cached = self.open_cache.get(chat_username)
                    if cached:
                        cands.add(cached)
            except Exception:
                pass
            self._require_chat_identity(u, chat_display_name, cands, '键盘')
            matched = G._chat_identity_level(cur, cands) is not None
            if matched and not is_blank(input_value(u)):
                raise G.DraftDirtyError('键盘通道输入框有草稿或不可读')
            return (matched, cur)
        t_start = G.time.time()
        from sticker_transport import db_identity, _outgoing
        try:
            database_identity = db_identity(self.db)
        except Exception:
            database_identity = None
        saved_clip = get_clip()
        try:
            tap(ord('F'), (win32con.VK_CONTROL,))
            G.time.sleep(0.5)
            set_clip(chat_display_name)
            tap(ord('V'), (win32con.VK_CONTROL,))
            G.time.sleep(0.8)
            tap(win32con.VK_RETURN)
            G.time.sleep(0.9)
            matched, cur = confirmed_target()
            if matched is None:
                G.log('键盘通道：读不到当前会话名，为防发错人这次不发')
                raise G.ChatIdentityError('键盘通道读不到当前会话名')
            if not matched:
                G.log('键盘通道：打开的是「%s」而不是「%s」，为防发错人这次不发' % (G.safe_name(cur), G.safe_name(chat_display_name)))
                raise G.ChatIdentityError('键盘通道打开的是 %s 而不是 %s' % (G.safe_name(cur), G.safe_name(chat_display_name)))
            if not bind_runtime_identity(operation, self, chat_username):
                raise G.ChatIdentityError('键盘准备期间账号或目标改变')
            if (not self.account_send_allowed('键盘复核') or not self.send_policy_allows(chat_username, chat_display_name)
                    or not self.sticker_quarantine_allows(chat_username, chat_display_name)):
                operation.record('cancelled', 'keyboard_gate_changed')
                return False
            def paste_and_confirm():
                set_clip(text)
                tap(ord('V'), (win32con.VK_CONTROL,))
                G.time.sleep(0.4)
                tap(win32con.VK_RETURN)
                want = str(text).strip()
                for _ in range(8):
                    G.time.sleep(0.5)
                    try:
                        msgs = self.db.get_messages(chat_username or chat_display_name, limit=5) or []
                    except Exception:
                        msgs = []
                    for m in msgs:
                        try:
                            if float(m.get('create_time') or 0) <= t_start:
                                continue
                        except Exception:
                            continue
                        if (database_identity is not None and db_identity(self.db) == database_identity
                                and _outgoing(self.db, m, database_identity[1])
                                and str(m.get('content') or '').strip() == want):
                            return True
                G.log_error('键盘通道：按键发了，但数据库里没确认到，结果不确定且禁止重发')
                return False
            return operation.opaque('keyboard_paste', paste_and_confirm, true_status='confirmed')
        except (G.ChatIdentityError, G.DraftDirtyError) as exc:
            operation.record('identity_mismatch' if isinstance(exc, G.ChatIdentityError) else 'draft_dirty', type(exc).__name__)
            raise
        except Exception as e:
            if operation.effect_started:
                operation.record('uncertain', 'keyboard_exception')
                return True
            G.log('键盘通道按键失败：', repr(e))
            return False
        finally:
            restore_clip(saved_clip)

    # 连续发送失败只是暂时停发：以前一旦停掉就永久跳过，要重启桥接才恢复。
    def chat_paused(self, chat_username):
        """这个会话要不要停发：被移出群是长期失效，连续失败只停一会儿。"""
        if not chat_username:
            return False
        if chat_username in self.dead_chats:
            return True
        until = (self.dead_chat_until or {}).get(chat_username) or 0
        if until and G.time.time() < until:
            return True
        if until:
            self.dead_chat_until.pop(chat_username, None)
            G.log('重新尝试发送（停发时间已到）：', G.safe_name(chat_username))
        return False

    def pause_chat(self, chat_username, display):
        retry_sec = 300
        if not chat_username:
            return
        self.dead_chat_until[chat_username] = G.time.time() + retry_sec
        G.log('连续发送失败，先停掉这个会话 %d 分钟：%s'
              % (retry_sec // 60, G.safe_name(display)))

    def send_policy_allows(self, chat_username, chat_display_name):
        # 排队、模型生成或语音合成期间都可能改名单，发送前向内核核对当前规则。
        base = self.bot_url.rsplit('/webhook', 1)[0]
        headers = {'x-whale-bridge': '1', 'x-bot-token': self.token}
        try:
            response = G.LOCAL_HTTP.post(base + '/api/wechat/send-permission', headers=headers,
                                         json={'chatId': chat_username, 'name': chat_display_name}, timeout=3)
            policy = response.json() if response.status_code == 200 else None
            if isinstance(policy, dict) and policy.get('ok') is True:
                if policy.get('allowed') is True:
                    return True
                reason = {'not_whitelisted': '不在白名单内', 'unresolved_chat': '无法确认会话 ID'}.get(policy.get('reason'), '已静音')
                G.log_throttled('send-policy-' + reason, '发言范围：' + reason + '，跳过发送', ttl=60)
                return False
        except Exception:
            pass
        G.log_throttled('send-policy-unavailable', '发言范围：内核未确认允许发送，已暂停', ttl=60)
        return False

    # ---------- 拍一拍：定位对方消息行 + 右键菜单 ----------

    @staticmethod
    def _pat_message_list(u):
        """当前会话的消息列表控件。

        wechatauto 的 ``_message_list`` 优先；它的递归深度上限在 4.1.8 的
        层级里刚好够，但换版本可能差一层，所以再兜底按类名找一次。
        """
        try:
            lst = u._message_list()
        except Exception:
            lst = None
        if lst is not None:
            return lst
        win = getattr(u, '_win', None)
        if win is None:
            return None

        def walk(c, depth=0):
            if depth > 25:
                return None
            try:
                kids = c.GetChildren()
            except Exception:
                return None
            for ch in kids:
                try:
                    if (ch.ClassName or '') == 'mmui::RecyclerListView':
                        return ch
                except Exception:
                    continue
                hit = walk(ch, depth + 1)
                if hit is not None:
                    return hit
            return None

        return walk(win)

    def _pat_friend_row(self, u):
        """找一条「对方」消息行（供右键头像）。

        wechatauto 的 ``_find_friend_row`` 用「接近白色 = 背景」算内容重心，
        暗色主题下整个背景都被当成内容，重心恒在中间，永远判不出对方行——
        本机微信是暗色主题，所以这里改成「消息区出现最多的颜色 = 背景」，
        再看每一行左半/右半的内容量：对方消息靠左，自己的靠右。
        """
        lst = self._pat_message_list(u)
        if lst is None:
            return None
        try:
            import numpy as np
            from PIL import ImageGrab as IG
        except Exception as exc:
            G.log_warn('拍一拍失败：像素统计依赖不可用', repr(exc))
            return None
        try:
            lr = lst.BoundingRectangle
            img = IG.grab(bbox=(lr.left, lr.top, lr.right, lr.bottom)).convert('RGB')
            arr = np.array(img)
        except Exception as exc:
            G.log_warn('拍一拍失败：消息区截不到图', repr(exc))
            return None
        try:
            quant = (arr // 8).reshape(-1, 3)
            values, counts = np.unique(quant, axis=0, return_counts=True)
            background = values[int(counts.argmax())] * 8 + 4
            mask = (np.abs(arr.astype(int) - background.astype(int)).max(axis=2) > 24)
        except Exception:
            return None
        best = None
        try:
            children = lst.GetChildren()
        except Exception:
            return None
        for ch in children:
            try:
                cls = ch.ClassName or ''
                if not cls.startswith('mmui::Chat'):
                    continue
                # 系统提示行没有头像；ChatItemView 是分组容器
                if cls in ('mmui::ChatItemView', 'mmui::ChatSystemInfoItemView'):
                    continue
                r = ch.BoundingRectangle
                top = max(r.top, lr.top) - lr.top
                bottom = min(r.bottom, lr.bottom) - lr.top
                if bottom - top < 40:
                    continue
                cols = mask[top:bottom].sum(axis=0)
                width = int(cols.shape[0])
                if width <= 0:
                    continue
                left = int(cols[:width // 2].sum())
                right = int(cols[width // 2:].sum())
                if left < 1500 or left <= right * 1.25:
                    continue
                rank = (2 if cls == 'mmui::ChatTextItemView' else 1, left - right)
                if best is None or rank > best[0]:
                    best = (rank, (r.left, r.top, r.right, r.bottom))
            except Exception:
                continue
        return best[1] if best is not None else None

    @staticmethod
    def _pat_popup_set(hwnd):
        """微信进程当前可见的弹出窗句柄集合（菜单是独立的顶层窗）。"""
        try:
            import win32gui
            import win32process
        except Exception:
            return set()
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
        except Exception:
            return set()
        found = set()

        def cb(h, _):
            try:
                _, wpid = win32process.GetWindowThreadProcessId(h)
                if wpid == pid and h != hwnd and win32gui.IsWindowVisible(h):
                    found.add(h)
            except Exception:
                pass
            return True

        try:
            win32gui.EnumWindows(cb, None)
        except Exception:
            return set()
        return found

    @classmethod
    def _pat_menu_rects(cls, hwnd, before):
        """右键之后新出现的菜单窗矩形（按大小过滤，排除提示气泡等）。"""
        try:
            import win32gui
        except Exception:
            return []
        rects = []
        for h in cls._pat_popup_set(hwnd) - set(before):
            try:
                left, top, right, bottom = win32gui.GetWindowRect(h)
                width, height = right - left, bottom - top
                if 40 <= width <= 600 and 30 <= height <= 800:
                    rects.append((left, top, right, bottom))
            except Exception:
                continue
        return rects

    @staticmethod
    def _pat_click_menu_item(rect, u, who):
        """在菜单矩形里 OCR 找「拍一拍」并点它（2 倍/3 倍各试一次）。"""
        try:
            from PIL import Image, ImageGrab as IG
            from wechatauto.guia import ScreenOCR
        except Exception as exc:
            G.log_warn('拍一拍失败：OCR 依赖不可用', repr(exc))
            return False
        seen = []
        for scale in (2, 3):
            try:
                img = IG.grab(bbox=rect).convert('RGB')
                big = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
                items = ScreenOCR.recognize(big)
            except Exception as exc:
                G.log_warn('拍一拍菜单 OCR 异常（x%d）：' % scale, repr(exc))
                continue
            for text, x, y, width, height in items:
                clean = (text or '').replace(' ', '')
                if clean:
                    seen.append(clean)
                if '拍一拍' in clean:
                    sx = rect[0] + (x + width / 2.0) / float(scale)
                    sy = rect[1] + (y + height / 2.0) / float(scale)
                    u._click_at(int(sx), int(sy))
                    G.log('[pat] menu item clicked %s' % G.safe_name(who))
                    return True
        G.log('拍一拍菜单没认出「拍一拍」：%s' % (' / '.join(seen[:8]) or '（OCR 为空）'))
        return False

    def _pat_ensure_foreground(self):
        """把微信拉到前台，成功才允许右键。

        桥接的 ``window_activation.activate`` 只调 SetForegroundWindow，
        刚点过启动器/浏览器时会被前台锁拒绝；这时右键会点到别的窗口上，
        所以这里用 AttachThreadInput + 临时取消前台锁超时，结束后恢复全局值。
        """
        try:
            import ctypes
            import win32api
            import win32con
            import win32gui
            hwnd = int(self.ACCOUNT.get('hwnd') or 0) or self.find_weixin_hwnd()
            if not hwnd:
                return False
            user32 = ctypes.windll.user32
            if user32.GetForegroundWindow() == hwnd:
                return True
            prev_lock = ctypes.c_uint32(0)
            got_lock = user32.SystemParametersInfoW(0x2000, 0, ctypes.byref(prev_lock), 0)
            user32.SystemParametersInfoW(0x2001, 0, ctypes.c_void_p(0), 0)
            try:
                for _ in range(6):
                    if user32.GetForegroundWindow() == hwnd:
                        break
                    fg = user32.GetForegroundWindow()
                    tid_fg = user32.GetWindowThreadProcessId(fg, None) if fg else 0
                    tid_t = user32.GetWindowThreadProcessId(hwnd, None)
                    if tid_fg:
                        user32.AttachThreadInput(tid_fg, tid_t, True)
                    try:
                        if win32gui.IsIconic(hwnd):
                            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                        user32.SetWindowPos(hwnd, ctypes.c_void_p(-1), 0, 0, 0, 0,
                                            0x2 | 0x1 | 0x40)  # TOPMOST, 不改大小, SHOW
                        user32.SetForegroundWindow(hwnd)
                        user32.SetActiveWindow(hwnd)
                        user32.BringWindowToTop(hwnd)
                    finally:
                        if tid_fg:
                            user32.AttachThreadInput(tid_fg, tid_t, False)
                    if user32.GetForegroundWindow() != hwnd:
                        # 用户正在操作别的窗口时，AttachThreadInput 也会被前台锁挡；
                        # 按一下 ALT 再抢一次（实测这一下就能过）。
                        try:
                            win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
                            win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
                        except Exception:
                            pass
                        try:
                            user32.SetForegroundWindow(hwnd)
                        except Exception:
                            pass
                    G.time.sleep(0.35)
                if user32.GetForegroundWindow() != hwnd:
                    try:
                        user32.SwitchToThisWindow(hwnd, True)
                    except Exception:
                        pass
                    G.time.sleep(0.2)
            finally:
                if got_lock:
                    user32.SystemParametersInfoW(0x2001, 0, ctypes.c_void_p(prev_lock.value), 0)
            return user32.GetForegroundWindow() == hwnd
        except Exception as exc:
            G.log_warn('拍一拍抢前台异常：', repr(exc))
            return False

    def _pat_scroll_for_friend_row(self, u, rhythm):
        """当前视口只有自己的消息时，往上翻两屏再找对方消息行。"""
        lst = self._pat_message_list(u)
        for _ in range(2):
            if lst is None:
                return None
            try:
                lst.WheelUp(ratioX=0.5, ratioY=0.5, wheelTimes=3)
            except Exception:
                return None
            rhythm.nap(0.6)
            row = self._pat_friend_row(u)
            if row is not None:
                return row
        return None

    def _uia_poke(self, u, who):
        """右键对方头像 → 找到菜单窗 → OCR 点「拍一拍」。

        为什么不用 wechatauto 的 ``u.poke``：它把整屏丢给 Windows OCR，
        暗色主题下「拍一拍」三个字经常认不出来；而且在 4.1.8 上它依赖的
        ``_find_friend_row`` 找不到暗色主题里的对方消息行。
        这里：自己判断对方行（按背景色 + 左右内容量），右键后按「新出现的
        顶层小窗」锁定菜单矩形，只 OCR 菜单本身，2 倍/3 倍各试一次。
        """
        try:
            from wechatauto import rhythm
            import uiautomation as auto
        except Exception as exc:
            G.log_warn('拍一拍失败：UIA/节奏依赖不可用', repr(exc))
            return False
        if not self._pat_ensure_foreground():
            G.log('拍一拍失败：微信没能抢到前台，这次不右键（避免点到别的窗口）')
            return False
        try:
            if not u.ensure_window():
                G.log('拍一拍失败：微信窗口不可用')
                return False
        except Exception as exc:
            G.log_warn('拍一拍失败：ensure_window 异常', repr(exc))
            return False
        scrolled = False
        try:
            row = self._pat_friend_row(u)
            if row is None:
                row = self._pat_scroll_for_friend_row(u, rhythm)
                scrolled = row is not None
            if row is None:
                # wechatauto 自己的判定也试一次（亮色主题下它更准）
                try:
                    ctl = u._find_friend_row()
                    if ctl is not None:
                        rr = ctl.BoundingRectangle
                        row = (rr.left, rr.top, rr.right, rr.bottom)
                except Exception:
                    row = None
            if row is None:
                G.log('拍一拍失败：当前会话里没有可右键的对方消息')
                return False
            left, top, right, bottom = row
            try:
                hwnd = int(u._win.NativeWindowHandle or 0)
            except Exception:
                hwnd = 0
            # 头像在消息行左上，实测微信 4.x：行内偏移 x≈+56、y≈+40
            # （不能按行中心：带引用/多行的行很高，中心会点到气泡或空白）。
            ax = int(left + 56)
            ay = int(min(bottom - 15, top + 40))
            for attempt in range(2):
                try:
                    before = self._pat_popup_set(hwnd) if hwnd else set()
                    u._set_cursor(ax, ay)
                    rhythm.nap(0.2)
                    u._right_click()
                    rhythm.nap(0.9)
                    rects = self._pat_menu_rects(hwnd, before) if hwnd else []
                    if not rects:
                        G.log('拍一拍：右键后没看到菜单窗（第 %d 次）' % (attempt + 1))
                    for rect in rects:
                        if self._pat_click_menu_item(rect, u, who):
                            rhythm.nap(0.5)
                            return True
                except Exception as exc:
                    G.log_warn('拍一拍菜单处理异常（第 %d 次）：' % (attempt + 1), repr(exc))
                try:
                    auto.SendKeys('{ESC}')
                except Exception:
                    pass
                rhythm.nap(0.4)
            return False
        finally:
            if scrolled:
                try:
                    u.scroll_message_list_to_bottom(max_rounds=8)
                except Exception:
                    pass

    def _pat_drop_topmost(self):
        """撤销 _pat_ensure_foreground 加的置顶，别让微信一直挂在最前面。"""
        try:
            import ctypes
            hwnd = int(self.ACCOUNT.get('hwnd') or 0) or self.find_weixin_hwnd()
            if not hwnd:
                return
            ctypes.windll.user32.SetWindowPos(
                hwnd, ctypes.c_void_p(-2), 0, 0, 0, 0, 0x2 | 0x1)  # HWND_NOTOPMOST
        except Exception:
            pass

    def send_pat(self, chat_display_name, chat_username=''):
        """在微信里对当前会话的对方发起「拍一拍」（右键头像 → 拍一拍菜单）。

        拍一拍不是消息：它不经过输入框和发送按钮，走 wechatauto 的
        「右键对方消息头像 + OCR 找拍一拍菜单」。失败只记日志，不补发文字，
        避免把「没拍到」伪装成「拍到了」。
        """
        import time as _time
        target = str(chat_display_name or '').strip()
        key = str(chat_username or target or '').strip()
        if not key or not target:
            return False
        if not self._pat_feature_on():
            G.log('拍一拍功能已关闭，跳过发送：', G.safe_name(target))
            return False
        pat_last = getattr(self, 'PAT_LAST', None)
        if pat_last is None:
            pat_last = self.PAT_LAST = {}
        now = _time.monotonic()
        last = float(pat_last.get(key) or 0.0)
        cooldown = 8.0
        cfg = getattr(G, 'CURRENT_CONFIG', None) or {}
        if isinstance(cfg, dict):
            try:
                cooldown = float((cfg.get('pat') or {}).get('cooldownSec', 8) or 0)
            except Exception:
                cooldown = 8.0
        cooldown = max(0.0, min(3600.0, cooldown))
        if cooldown > 0 and now - last < cooldown:
            G.log('拍一拍冷却中（%.0f 秒），跳过：%s' % (cooldown, G.safe_name(target)))
            return False
        if chat_username and self.chat_paused(chat_username):
            G.log('跳过已失效的会话（拍一拍）：', G.safe_name(target))
            return False
        if chat_username and self.is_self_chat(chat_username):
            G.log('拍一拍跳过：文件传输助手不支持拍一拍')
            return False
        if str(chat_username or '').lower().endswith('@chatroom'):
            # 群聊里右键只能拍到「当前可见的一条好友消息」的头像，无法保证是目标人；
            # 宁可不拍，也不要在群里拍错人。
            G.log('拍一拍跳过：群聊不主动拍（避免拍到别人）')
            return False
        resolved = self.ui_chat_name(chat_username, target)
        if not resolved:
            G.log('拍一拍跳过：会话名不可用：', G.safe_id(chat_username or target))
            return False
        if not self.account_send_allowed('拍一拍'):
            return False
        with self.send_lock:
            if (not self.account_send_allowed('拍一拍复核')
                    or not self.send_policy_allows(chat_username, resolved)):
                return False
            try:
                with self.gui_lock:
                    if self.gui is None:
                        G.log('初始化微信窗口驱动…（拍一拍会抢一下焦点，约 5~10 秒）')
                        self.gui = self.new_window_driver()
                    gui = self.gui
                self.bind_gui_window(gui)
                u = gui._get_uia()
                if u is None:
                    G.log('拍一拍失败：UIA 不可用')
                    return False
                keys = self.aliases_for(chat_username, resolved) or [resolved]
                cur = ''
                try:
                    cur = u.current_chat() or ''
                except Exception:
                    cur = ''
                if cur not in keys:
                    if not u.open_chat(keys):
                        G.log('拍一拍失败：打不开会话', G.safe_name(resolved))
                        return False
                    cur = u.current_chat() or ''
                self._require_chat_identity(u, resolved, keys, '拍一拍')
                # 拍一拍靠右键头像 + 菜单 OCR，必须让微信真的在前台；
                # 抢前台由 _uia_poke 自己做（前台锁下更可靠），抢不到就不右键。
                try:
                    ok = bool(self.with_window_on_top(lambda: self._uia_poke(u, resolved),
                                                      require_foreground=False))
                finally:
                    self._pat_drop_topmost()
                if ok:
                    pat_last[key] = _time.monotonic()
                    sent_at = getattr(self, 'PAT_SENT', None)
                    if sent_at is None:
                        sent_at = self.PAT_SENT = {}
                    sent_at[key] = _time.time()
                    G.log('[delivery] stage=pat result=sent target=%s' % G.safe_name(resolved))
                else:
                    G.log('[delivery] stage=pat result=failed reason=no_friend_row_or_menu target=%s'
                          % G.safe_name(resolved))
                return ok
            except G.ChatIdentityError as exc:
                G.log_error('拍一拍会话核对没通过：%s' % exc)
            except Exception as exc:
                G.log_warn('拍一拍异常：', repr(exc))
        return False

    def send_text(self, text, chat_display_name, chat_username='', force=False):
        from send_attempt import logical_operation, prepared_adapter, bind_runtime_identity
        pending = getattr(self, '_text_send_inflight', None)
        if pending is not None and pending.is_alive():
            G.log('前一次不透明发送尚未结束，本条不进入输入框')
            return False
        if chat_username and self.chat_paused(chat_username):
            G.log('跳过已失效的会话：', G.safe_name(chat_display_name))
            return False
        if chat_username and (not self.group_is_alive(chat_username)):
            self.dead_chats.add(chat_username)
            G.log('群里已经没有我了（被移出？），以后跳过：', G.safe_name(chat_display_name))
            return False
        if chat_username and self.is_self_chat(chat_username):
            # 微信里没有「和自己聊天」，只能发文件传输助手；否则会拿 wxid 去搜会话。
            chat_username, chat_display_name = 'filehelper', '文件传输助手'
        # 所有发送入口统一把「内部 id 当会话名」挡在这里。以前只有 care 会传 wxid，
        # 现在不管调用方是谁，都先换成昵称/备注；换不出来就放弃，别让 open_chat 空转。
        resolved = self.ui_chat_name(chat_username, chat_display_name)
        if not resolved:
            G.log('[delivery] stage=resolve_target result=failed reason=chat_name_unresolved chat=%s' % G.safe_id(chat_username or chat_display_name))
            hint = ('请为该群设置可搜索的群名或群备注'
                    if str(chat_username or chat_display_name).lower().endswith('@chatroom')
                    else '请为该联系人设置可搜索的备注')
            G.log_throttled('send-no-name-' + str(chat_username or chat_display_name)[:18],
                            '发送跳过：%s 没有可核对的会话名称，%s后重试'
                            % (G.safe_id(chat_username or chat_display_name), hint),
                            ttl=600)
            return False
        chat_display_name = resolved
        display = G.safe_name(chat_display_name)
        if not self.account_send_allowed('发送'):
            return False
        with self.send_lock, G._SendStateScope(len(text)), logical_operation(len(text)) as operation:
            if not bind_runtime_identity(operation, self, chat_username):
                return False
            pending = getattr(self, '_text_send_inflight', None)
            if pending is not None and pending.is_alive():
                return False
            if not self.send_policy_allows(chat_username, chat_display_name):
                return False
            if not self.sticker_quarantine_allows(chat_username, chat_display_name):
                return False
            t_start = G.time.time()
            allow_mark_dead = True
            foreground_fallback = False
            if G.BACKGROUND_SEND and G.BG_SEND.get('enabled', True):
                G.SEND_STATE['start'] = G.time.time()
                try:
                    if self.bg_send(text, chat_display_name, chat_username):
                        self.fail_streak.pop(chat_username, None)
                        if operation.result.status == 'uncertain':
                            G.log('后台发送结果未知，禁止重发（%.1fs）→ %s' % (G.time.time() - t_start, display))
                        elif operation.result.status == 'submitted':
                            G.log('后台发送已提交（%.1fs）→ %s' % (G.time.time() - t_start, display))
                        elif operation.result.status == 'confirmed':
                            G.log('后台发送已确认（%.1fs）→ %s' % (G.time.time() - t_start, display))
                        else:
                            G.log('后台发送已处理，结果尚未确认（阶段=%s，%.1fs）→ %s' % (operation.result.status, G.time.time() - t_start, display))
                        return True
                except G.DraftDirtyError as e:
                    allow_mark_dead = False
                    G.log_error('发送暂停：%s' % e)
                    return False
                except (G.ChatIdentityError, G.DraftDirtyError) as e:
                    G.log_error('会话核对没通过，这条不发（%s）：%s' % (display, e))
                    return False
                except Exception as e:
                    operation.effect_started = True
                    operation.record('uncertain', 'background_exception:' + type(e).__name__)
                    G.log('后台通道结果不确定，不再换通道：', type(e).__name__)
                    return True
                if not G.BG_SEND.get('fallback', True):
                    allow_mark_dead = False
                    G.log_error('后台通道失败且已关闭前台兜底，这条不发：', display)
                    return False
                foreground_fallback = operation.result.reason in ('foreground_required', 'background_residue_session')
                if foreground_fallback:
                    G.log('[delivery] stage=foreground result=prepare reason=%s' % operation.result.reason)
            if not operation.can_continue():
                return operation.result.handled
            with self.gui_lock:
                if self.gui is None:
                    G.log('初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）')
                    self.gui = self.new_window_driver()
            self.bind_gui_window(self.gui)
            uia_available = False
            try:
                uia_available = self.gui._get_uia() is not None
            except Exception:
                uia_available = False

            def send_uia():
                if foreground_fallback:
                    return self.uia_send(text, chat_display_name, chat_username, require_foreground=True)
                return self.uia_send(text, chat_display_name, chat_username)

            G.SEND_STATE['start'] = G.time.time()
            try:
                if self.with_window_on_top(lambda: prepared_adapter(operation, 'uia', send_uia),
                                           require_foreground=foreground_fallback):
                    self.fail_streak.pop(chat_username, None)
                    G.log('UIA 已处理，阶段=%s（不等于确认送达）' % operation.result.status)
                    return True
            except (G.ChatIdentityError, G.DraftDirtyError) as e:
                operation.record('identity_mismatch' if isinstance(e, G.ChatIdentityError) else 'draft_dirty', type(e).__name__)
                G.log_error('会话或草稿核对没通过，这条不发（%s）' % display)
                return False
            except Exception as e:
                if operation.effect_started:
                    operation.record('uncertain', 'uia_exception')
                    return True
                G.log('UIA 准备未完成：', type(e).__name__)
            if not operation.can_continue():
                return operation.result.handled
            if operation.reserve('recovery'):
                if self.recover_uia('发送失败'):
                    try:
                        if self.with_window_on_top(lambda: prepared_adapter(operation, 'uia_recovery', send_uia),
                                                   require_foreground=foreground_fallback):
                            self.fail_streak.pop(chat_username, None)
                            if operation.result.status == 'uncertain':
                                G.log('重新激活后的发送结果不确定，禁止重发：', display)
                            else:
                                G.log('重新激活 UIA 后已提交（未确认送达）→ %s' % display)
                            return True
                    except (G.ChatIdentityError, G.DraftDirtyError) as e:
                        operation.record('identity_mismatch' if isinstance(e, G.ChatIdentityError) else 'draft_dirty', type(e).__name__)
                        G.log_error('会话或草稿核对没通过，这条不发（%s）' % display)
                        return False
                    except Exception as e:
                        if operation.effect_started:
                            operation.record('uncertain', 'recovery_send_exception')
                            return True
                        G.log('重新激活后仍未准备好：', type(e).__name__)
            if not operation.can_continue():
                return operation.result.handled
            if not foreground_fallback and operation.reserve('foreground_preparation'):
                try:
                    # The previous attempts are proved pre-input failures.
                    # Preparation may now move the window, then invoke once.
                    if self.with_window_on_top(lambda: self.force_send_foreground(
                            lambda: prepared_adapter(operation, 'uia_foreground', lambda: self.uia_send(text, chat_display_name, chat_username)))):
                        self.fail_streak.pop(chat_username, None)
                        G.log('安全前台准备后的发送阶段=%s' % operation.result.status)
                        return True
                except (G.ChatIdentityError, G.DraftDirtyError) as e:
                    operation.record('identity_mismatch' if isinstance(e, G.ChatIdentityError) else 'draft_dirty', type(e).__name__)
                    return False
                except Exception as e:
                    if operation.effect_started:
                        operation.record('uncertain', 'foreground_send_exception')
                        return True
                    G.log('前台准备未完成，尚未输入：', type(e).__name__)
            if not operation.can_continue():
                return operation.result.handled
            if uia_available:
                G.log('UIA 发不出去，跳过 OCR 兜底：', display)
            else:
                G.log_throttled('uia-unavailable', 'UIA 不可用：先试键盘通道；如果一直这样，到启动器「诊断」页点「UIA 自检」看原因（常见：微信需要重新登录、鲸鱼娘不是管理员而微信是、微信缩在托盘）', ttl=600)
                G.log('UIA 不可用，走 OCR 兜底')
            if G.KEYBOARD_FALLBACK:
                G.SEND_STATE['start'] = G.time.time()
                try:
                    if prepared_adapter(operation, 'keyboard', lambda: self.keyboard_send(text, chat_display_name, chat_username)):
                        self.fail_streak.pop(chat_username, None)
                        G.log('键盘发送阶段=%s（未确认结果不重发）' % operation.result.status)
                        return True
                except (G.ChatIdentityError, G.DraftDirtyError) as e:
                    G.log_error('会话核对没通过，这条不发（%s）：%s' % (display, e))
                    return False
            if not operation.can_continue():
                return operation.result.handled
            if not uia_available:
                G.SEND_STATE['start'] = G.time.time()
                try:
                    from send_input import is_blank, input_value
                    if not operation.reserve('ocr'):
                        return operation.result.handled
                    with self.gui_lock:
                        try:
                            self.gui = self.new_window_driver()
                        except Exception as e:
                            G.log('重建窗口驱动失败：', repr(e))
                    self.bind_gui_window(self.gui)
                    target_gui = self.gui
                    u = target_gui._get_uia()
                    if u is None:
                        raise G.ChatIdentityError('OCR 准备后仍读不到当前会话，本条不输入')
                    self._require_chat_identity(u, chat_display_name, self.aliases_for(chat_username, chat_display_name), 'OCR')
                    if not is_blank(input_value(u)):
                        raise G.DraftDirtyError('OCR 输入框有草稿或不可读')
                    if not bind_runtime_identity(operation, self, chat_username):
                        raise G.ChatIdentityError('OCR 准备期间账号或目标改变')
                    if (not self.account_send_allowed('OCR 复核') or not self.send_policy_allows(chat_username, chat_display_name)
                            or not self.sticker_quarantine_allows(chat_username, chat_display_name)):
                        operation.record('cancelled', 'ocr_gate_changed')
                        return False
                    _box = {}
                    _ocr_cancel = G.threading.Event()

                    def _ocr_send():
                        try:
                            if _ocr_cancel.is_set():
                                return
                            _box['r'] = self.with_window_on_top(lambda: not _ocr_cancel.is_set() and operation.opaque(
                                'ocr_send', lambda: target_gui.send_msg(text, chat_display_name, True)))
                        except Exception as _e:
                            _box['e'] = _e
                        finally:
                            operation.finish_inflight()
                    _th = G.threading.Thread(target=_ocr_send, daemon=True)
                    self._text_send_inflight = _th
                    operation.begin_inflight()
                    try:
                        _th.start()
                    except Exception:
                        operation.finish_inflight()
                        raise
                    _th.join(min(8.0, max(0.0, operation.budget - (operation.clock() - operation.started))))
                    if _th.is_alive():
                        G.log('OCR 兜底未返回，结果不确定；禁止重复及并行发送')
                        _ocr_cancel.set()
                        operation.record('uncertain', 'ocr_inflight_timeout')
                        return True
                    else:
                        if 'e' in _box:
                            raise _box['e']
                        resp = _box.get('r')
                    if bool(resp):
                        self.fail_streak.pop(chat_username, None)
                        return True
                    G.log('兜底发送失败：%s' % resp)
                except (G.ChatIdentityError, G.DraftDirtyError) as e:
                    operation.record('identity_mismatch' if isinstance(e, G.ChatIdentityError) else 'draft_dirty', type(e).__name__)
                    return False
                except Exception as e:
                    pending = getattr(self, '_text_send_inflight', None)
                    if pending is not None and pending.is_alive():
                        _ocr_cancel.set()
                        operation.record('uncertain', 'ocr_wait_exception')
                        return True
                    if operation.effect_started:
                        operation.record('uncertain', 'ocr_exception')
                        return True
                    G.log('兜底准备异常：%s' % type(e).__name__)
            if not operation.can_continue():
                return operation.result.handled
            if chat_username and allow_mark_dead:
                if G.time.time() - float(self.ACCOUNT.get('blockedAt') or 0) < 30:
                    G.log('账号窗口没确认，这条不算会话失效，先不发：', display)
                    return False
                self.fail_streak[chat_username] = self.fail_streak.get(chat_username, 0) + 1
                if self.fail_streak[chat_username] >= 2:
                    self.fail_streak[chat_username] = 0
                    self.pause_chat(chat_username, chat_display_name)
            G.log_error('发送最终失败，请把微信窗口保持在桌面、别最小化（这条 %d 字，正文不写日志）' % len(text))
            return False

    def send_at(self, member, text, chat_display_name, chat_username=''):
        """真 @；仅已知未输入的失败可回退，进入不透明调用后按 handled 终止。"""
        from send_attempt import logical_operation, bind_runtime_identity
        from send_input import is_blank, input_value
        pending = getattr(self, '_text_send_inflight', None)
        if pending is not None and pending.is_alive():
            return False
        if not member or not text:
            return False
        # 和 send_text 同一道闸：群名/成员名可能是 wxid，@ 的时候同样搜不到。
        chat_display_name = self.ui_chat_name(chat_username, chat_display_name)
        if not chat_display_name:
            return False
        if chat_username and (self.chat_paused(chat_username) or not self.group_is_alive(chat_username)):
            return False
        if not self.account_send_allowed('@ 成员'):
            return False
        with self.send_lock, G._SendStateScope(len(text)), logical_operation(len(text)) as operation:
            if not bind_runtime_identity(operation, self, chat_username):
                return False
            pending = getattr(self, '_text_send_inflight', None)
            if pending is not None and pending.is_alive():
                return False
            if not self.send_policy_allows(chat_username, chat_display_name):
                return False
            if not self.sticker_quarantine_allows(chat_username, chat_display_name):
                return False
            with self.gui_lock:
                if self.gui is None:
                    G.log('初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）')
                    self.gui = self.new_window_driver()
            self.bind_gui_window(self.gui)
            try:
                if not operation.reserve('mention'):
                    return operation.result.handled
                u = self.gui._get_uia()
                if u is None:
                    raise G.ChatIdentityError('@ 读不到当前会话')
                self._require_chat_identity(u, chat_display_name, self.aliases_for(chat_username, chat_display_name), '@')
                if not is_blank(input_value(u)):
                    raise G.DraftDirtyError('@ 输入框有草稿或不可读')
                if not bind_runtime_identity(operation, self, chat_username):
                    raise G.ChatIdentityError('@ 准备期间账号或目标改变')
                if (not self.account_send_allowed('@ 复核') or not self.send_policy_allows(chat_username, chat_display_name)
                        or not self.sticker_quarantine_allows(chat_username, chat_display_name)):
                    operation.record('cancelled', 'mention_gate_changed')
                    return False
                ok = bool(self.with_window_on_top(lambda: operation.opaque('mention', lambda: self.gui.at_member(member, text, who=chat_display_name, verify=False))))
                if ok:
                    G.log('@ 已处理，阶段=%s → %s' % (operation.result.status, G.safe_name(chat_display_name)))
                    return True
                G.log('@ 成员失败（%s），改用普通发送' % G.safe_name(member))
            except (G.ChatIdentityError, G.DraftDirtyError) as e:
                operation.record('identity_mismatch' if isinstance(e, G.ChatIdentityError) else 'draft_dirty', type(e).__name__)
                return False
            except Exception as e:
                if operation.effect_started:
                    operation.record('uncertain', 'mention_exception')
                    return True
                G.log('@ 成员异常：', repr(e))
        return False
