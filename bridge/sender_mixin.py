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
