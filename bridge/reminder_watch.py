"""提醒的准点调度器（桥接侧）。

为什么不用轮询：用户要求「必须准点」。桥接每轮问服务端「有哪些到点的 + 下一条什么时候到」，
然后睡到那个时刻（不是固定 10 秒）。新提醒进来时由 Event 提前唤醒重算。

分工：
  - 服务端负责状态（pending / retrying / done / failed / expired）和「过点不补发」；
  - 这里只负责：到点 → 让微信发出去 → 回执。发送失败的重试由服务端在 5 分钟后
    重新放出来（本模块不自己计时重试，避免两边各算一套）。
"""
import threading
import inspect
try:
    from bridge_log import safe_text
except ImportError:  # 测试里按 `bridge.reminder_watch` 导入时走包内相对路径
    from .bridge_log import safe_text
try:
    from runtime_kernel_api import KernelApi
except ImportError:
    from .runtime_kernel_api import KernelApi

try:
    from send_attempt import SendResult, logical_operation
except ImportError:
    try:
        from .send_attempt import SendResult, logical_operation
    except ImportError:  # 独立注入 bool 的旧调度器不依赖 T14 模块。
        SendResult = logical_operation = None


def _owned_reminder_send(callback, args, wxid, text, **kwargs):
    """仅本次 lexical operation 的新结果可作为证据；旧 bool 注入维持原契约。"""
    if logical_operation is None:
        return callback(*args, **kwargs)
    runtime = getattr(callback, '__self__', None)
    def account():
        db = getattr(runtime, 'db', None)
        if db is None:
            return None
        return (str(getattr(db, 'account', '') or ''), str(getattr(db, 'wxid', '') or ''))
    before_account = account()
    with logical_operation(len(text)) as operation:
        before_result, before_steps = operation.result, operation.steps
        before_effect = operation.effect_started
        try:
            returned = callback(*args, **kwargs)
        except Exception:
            if operation.effect_started:
                return SendResult('uncertain', 'reminder_callback_exception', True)
            raise
        observed = (operation.result is not before_result or operation.steps != before_steps
                    or operation.effect_started or bool(operation.target_username)
                    or bool(operation.account_identity) or before_result.terminal)
        # Foreign rich results are not proof from this call, even if truthy/confirmed.
        if isinstance(returned, SendResult) and returned is not operation.result:
            return SendResult('uncertain', 'reminder_foreign_result', True)
        if not observed:
            return bool(returned)  # Existing pure bool/voice injections remain compatible.
        fresh = operation.result is not before_result and not before_effect and operation.effect_started
        identity = operation.target_username == wxid and bool(operation.account_identity)
        if before_account is not None:
            identity = identity and all(before_account) and before_account == account() == operation.account_identity
        if bool(returned) and fresh and identity and operation.result.status == 'confirmed':
            return True
        if operation.result.handled or operation.effect_started or bool(returned):
            if operation.result.status == 'uncertain':
                return operation.result
            return SendResult('uncertain', 'reminder_delivery_not_confirmed', True)
        return False


def start_reminder_watch(*, http, base, token, send_text, send_at, log,
                         send_voice=None, display_name=None):
    """连接实际桥接发送通道；所有 HTTP 回应都必须成功才能继续。"""
    api = KernelApi(http, base, token)

    def send(item, text):
        wxid = str(item.get("wxid") or "").strip()
        if not wxid:
            raise ValueError("提醒缺少会话 ID，拒绝发送")
        name = str(item.get("name") or '').strip() or (display_name(wxid) if display_name else wxid)
        if item.get('kind') == 'plugin':
            def allowed():
                try:
                    return api.post('/api/reminders/permission', timeout=3,
                                    require_ok=False, json={'id': item.get('id')}).get('ok') is True
                except Exception:
                    return False
            if not allowed():
                return False
            if item.get('delivery') == 'voice':
                if send_voice is None:
                    raise RuntimeError('提醒语音通道未装配')
                return _owned_reminder_send(send_voice, (text, name, wxid), wxid, text,
                                            cancelled=lambda: not allowed())
        member = str(item.get("atName") or "").strip()
        if item.get("chatType") == "group" and member:
            return _owned_reminder_send(send_at, (member, text, name, wxid), wxid, text)
        return _owned_reminder_send(send_text, (text, name, wxid), wxid, text)

    def ack(item, ok, error, *, uncertain=False):
        payload = {'id': item.get('id'), 'ok': bool(ok), 'error': str(error or '')}
        if uncertain:
            payload['uncertain'] = True
        return api.post('/api/reminders/ack', json=payload)

    runner = ReminderRunner(
        fetch=lambda: api.get('/api/reminders/due'),
        send=send,
        ack=ack,
        log=log,
    )
    threading.Thread(target=runner.run, daemon=True, name="reminder-watch").start()
    return runner


class ReminderRunner:
    def __init__(self, *, fetch, send, ack, now_ms=None, log=None, idle_wait=30.0,
                 max_sleep=60.0, wake=None):
        """依赖全部注入，方便单测（不见网络、不见微信）。"""
        import time as _time
        self.fetch = fetch
        self.send = send
        self.ack = ack
        self.now_ms = now_ms or (lambda: int(_time.time() * 1000))
        self.log = log or (lambda *args: None)
        self.idle_wait = float(idle_wait)
        self.max_sleep = float(max_sleep)
        self.wake = wake or threading.Event()
        self.stopped = False
        self.sent = 0
        self.failed = 0
        self.uncertain = 0
        self._pending_acks = {}
        self._fenced_ids = set()
        try:
            inspect.signature(ack).bind(None, False, '', uncertain=True)
            self._ack_accepts_uncertain = True
        except (TypeError, ValueError):
            self._ack_accepts_uncertain = False

    def kick(self):
        """有新提醒时提前唤醒（engine 的 config_watch 或其它线程可以调）。"""
        self.wake.set()

    def step(self):
        """问一次，把到点的都发掉。返回 (发了几个, 下一条的时间戳)。"""
        # 只补回执，不补正文；未解决的同 ID 始终受本进程围栏保护。
        for record in list(self._pending_acks.values()):
            self._try_ack(record)
        data = self.fetch() or {}
        items = data.get("items") or []
        next_at = int(data.get("nextDueAt") or 0)
        sent = failed = 0
        seen = set()
        for item in items:
            if self.stopped:
                break
            key = str(item.get('id') or '')
            if not key:
                self.log('提醒缺少 ID，拒绝发送')
                continue
            if key in seen or key in self._fenced_ids or key in self._pending_acks:
                continue
            seen.add(key)
            text = str(item.get("text") or "").strip()
            if not text:
                self._ack_safe(item, False, "提醒内容为空")
                failed += 1
                continue
            try:
                outcome = self.send(item, text)
                rich = SendResult is not None and isinstance(outcome, SendResult)
                uncertain = rich and outcome.handled
                ok = False if rich else bool(outcome)
                err = '微信发送结果不确定，禁止自动重发' if uncertain else ("" if ok else "微信发送失败")
            except Exception as exc:                      # noqa: BLE001
                ok = False
                uncertain = False
                err = repr(exc)
            if uncertain:
                self.uncertain += 1
                self._fenced_ids.add(key)
            elif ok:
                sent += 1
                self.sent += 1
                self._fenced_ids.add(key)
            else:
                failed += 1
                self.failed += 1
            self._ack_safe(item, ok, err, uncertain=uncertain)
            if uncertain:
                self.log('提醒发送结果不确定（本进程禁止重发正文，等待核对）：', safe_text(text))
            elif not ok:
                self.log("提醒发送失败（服务端会在 5 分钟后重试一次）：", safe_text(text), err)
        return sent, next_at

    def _ack_safe(self, item, ok, err, *, uncertain=False):
        """回执也纳入异常保护（M15）：回执挂了只记日志、继续下一条。

        不保护的话一条回执异常会打断整批，同批剩余提醒全漏发。
        """
        key = str(item.get('id') or '')
        record = {'key': key, 'item': item, 'ok': ok, 'error': err,
                  'uncertain': uncertain, 'attempts': 0}
        self._pending_acks[key] = record
        self._try_ack(record)

    def _try_ack(self, record):
        """最多三次本进程簿记尝试；退出/崩溃会丢失围栏，不宣称重启 exactly-once。"""
        if record['attempts'] >= 3:
            return
        record['attempts'] += 1
        try:
            args = (record['item'], record['ok'], record['error'])
            if record['uncertain'] and self._ack_accepts_uncertain:
                response = self.ack(*args, uncertain=True)
            else:
                response = self.ack(*args)
            if response is False or (isinstance(response, dict) and response.get('ok') is False):
                raise RuntimeError('提醒回执尚未确认')
        except TypeError as exc:
            # 回调内部 TypeError 不能当签名探测再调用一次，也不做重复副作用重试。
            record['attempts'] = 3
            self.log('提醒回执回调异常（保留同 ID 围栏）：', repr(exc))
        except Exception as exc:                          # noqa: BLE001
            self.log('提醒回执失败（仅有界重试簿记，不重发正文）：', repr(exc))
        else:
            self._pending_acks.pop(record['key'], None)

    def run(self):
        while not self.stopped:
            # 先清唤醒位、再 fetch（M14）：fetch 之后到来的 kick 会把位重新置上，
            # 下一轮 wait 立即返回 —— 不会像旧写法（wait 返回与 clear 之间）那样丢唤醒。
            self.wake.clear()
            try:
                _, next_at = self.step()
            except Exception as exc:                      # noqa: BLE001
                self.log("提醒调度出错（不影响其它功能）：", repr(exc))
                next_at = 0
            # 睡到下一个提醒时刻（最多 60 秒醒一次，好让「新提醒 / 退出」能及时生效）
            delay = self.idle_wait
            if next_at:
                delay = max(0.2, min(self.max_sleep, (next_at - self.now_ms()) / 1000.0))
            self.wake.wait(delay)

    def stop(self):
        self.stopped = True
        self.wake.set()
