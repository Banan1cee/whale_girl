# -*- coding: utf-8 -*-
"""One logical send owns preparation/recovery tickets and an elapsed deadline.

Legacy booleans mean handled, never confirmed delivery. An opaque call which
returns false or raises is uncertain once entered, and consumes the operation.
"""
from contextlib import contextmanager
import math
import threading
import time

_LOCAL = threading.local()
_WATCH_LOCK = threading.RLock()
_WATCH = None


class _Watch:
    def __init__(self, state, operation, previous):
        self.state, self.operation, self.previous = state, operation, previous
        self.epoch_start = state.get('start', 0.0)
        self.closed = False


class SendResult:
    __slots__ = ('status', 'reason', 'may_have_sent')

    def __init__(self, status='not_sent', reason='not_started', may_have_sent=False):
        self.status, self.reason = status, reason
        self.may_have_sent = bool(may_have_sent)

    @property
    def handled(self):
        return self.status in ('submitted', 'confirmed', 'uncertain')

    @property
    def terminal(self):
        return self.status in ('submitted', 'confirmed', 'uncertain', 'identity_mismatch', 'draft_dirty', 'cancelled')


def elapsed_budget(text_len=0, budget=0):
    values = (40.0, float(text_len or 0) * 0.16 + 8.0, float(budget or 0))
    return max(value for value in values if math.isfinite(value))


class SendOperation:
    def __init__(self, text_len=0, *, budget=0, max_steps=6, clock=None, cancelled=None):
        self.clock = clock or time.monotonic
        self.started = self.clock()
        self.budget = elapsed_budget(text_len, budget)
        self.max_steps = max(0, int(max_steps))
        self.steps = 0
        self.effect_started = False
        self._ticket = False
        self._exhausted = False
        self.cancelled = cancelled
        self.result = SendResult()
        self._completion_lock = threading.RLock()
        self._inflight = False
        self._scope_cleanup = []
        self.target_username = ''
        self.account_identity = ()
        self.known_chats = None

    def bind_identity(self, username='', account=(), known_chats=None):
        with self._completion_lock:
            username = str(username or '')
            account = tuple(account) if all(account) else ()
            if ((self.target_username and username and self.target_username != username)
                    or (self.account_identity and self.account_identity != account)):
                self.record('identity_mismatch', 'operation_identity_changed')
                return False
            self.target_username = username or self.target_username
            self.account_identity = account or self.account_identity
            self.known_chats = known_chats
            return True

    def expired(self):
        return self.clock() - self.started >= self.budget

    def record(self, status, reason):
        with self._completion_lock:
            if self.result.terminal and status in ('not_sent', 'input_started', 'submitted'):
                return self.result
            if self.effect_started and status in ('not_sent', 'cancelled'):
                status = 'uncertain'
            self.result = SendResult(status, reason, self.effect_started)
            _LOCAL.last_result = self.result
            return self.result

    def can_continue(self):
        if self.result.terminal or self.effect_started or self._exhausted:
            return False
        if self.cancelled is not None:
            try:
                cancelled = self.cancelled()
            except Exception:
                self.record('cancelled', 'cancellation_check_failed')
                return False
            if cancelled:
                self.record('cancelled', 'cancelled_before_effect')
                return False
        if self.expired():
            self.record('not_sent', 'elapsed_deadline')
            return False
        return True

    def reserve(self, stage):
        with self._completion_lock:
            if not self.can_continue():
                return False
            if self.steps >= self.max_steps:
                self._exhausted = True
                self._ticket = False
                self.record('not_sent', 'preparation_budget_exhausted')
                return False
            self.steps += 1
            self._ticket = True
            self.record('not_sent', 'prepared:' + stage)
            return True

    def begin_effect(self, stage):
        with self._completion_lock:
            if not self.can_continue() or not self._ticket:
                return False
            self._ticket = False
            self.effect_started = True
            self.record('input_started', stage)
            return True

    def opaque(self, stage, callback, *, true_status='submitted'):
        if not self.begin_effect(stage):
            return self.result.handled
        try:
            ok = bool(callback())
        except Exception as exc:
            self.record('uncertain', stage + ':' + type(exc).__name__)
        else:
            self.record(true_status if ok else 'uncertain', stage)
        return self.result.handled
    def begin_inflight(self):
        with self._completion_lock:
            self._inflight = True

    def when_idle(self, cleanup):
        with self._completion_lock:
            if self._inflight:
                self._scope_cleanup.append(cleanup)
                return
        cleanup()

    def finish_inflight(self):
        with self._completion_lock:
            self._inflight = False
            cleanup, self._scope_cleanup = self._scope_cleanup, []
        for callback in cleanup:
            callback()


class SendPreparationStopped(RuntimeError):
    """The owned adapter stopped before submission; retain error:<Type> format."""


def operation_for_call(text_len=0):
    return getattr(_LOCAL, 'operation', None) or SendOperation(text_len)


def last_result():
    return getattr(_LOCAL, 'last_result', None)


def bind_runtime_identity(operation, runtime, username=''):
    db = getattr(runtime, 'db', None)
    account = (str(getattr(db, 'account', '') or ''), str(getattr(db, 'wxid', '') or ''))
    return operation.bind_identity(username, account, getattr(runtime, 'sessions', None))


def prepared_adapter(operation, stage, callback):
    """Only an adapter's fresh phase evidence may authorize a safe fallback."""
    if not operation.can_continue():
        return operation.result.handled
    try:
        from send_state import ChatIdentityError, DraftDirtyError
    except ImportError:
        from .send_state import ChatIdentityError, DraftDirtyError
    before = operation.result
    try:
        returned = bool(callback())
    except (ChatIdentityError, DraftDirtyError):
        raise
    except Exception:
        if operation.result is not before:
            raise
        operation.effect_started = True
        operation.record('uncertain', stage + ':unclassified_exception')
        return True
    if operation.result is before:
        operation.effect_started = True
        operation.record('uncertain', stage + ':unclassified_result')
        return True
    return returned or operation.result.handled


@contextmanager
def logical_operation(text_len=0, *, budget=0):
    previous = getattr(_LOCAL, 'operation', None)
    if previous is not None:
        if not previous.effect_started and previous.steps == 0:
            previous.budget = max(previous.budget, elapsed_budget(text_len, budget))
        yield previous
        return
    operation = SendOperation(text_len, budget=budget)
    _LOCAL.operation = operation
    _LOCAL.last_result = operation.result
    try:
        yield operation
    finally:
        _LOCAL.last_result = operation.result
        _LOCAL.operation = previous


def begin_watch(state, operation, epoch_start=None):
    global _WATCH
    with _WATCH_LOCK:
        if epoch_start is not None:
            same_operation = (_WATCH is not None and not _WATCH.closed
                              and _WATCH.state is state and _WATCH.operation is operation)
            state['active'] = True
            if not same_operation:
                state['start'] = epoch_start
            state['budget'] = operation.budget
        token = _Watch(state, operation, _WATCH)
        _WATCH = token
        return token


def end_watch(token, previous_state=None):
    global _WATCH
    with _WATCH_LOCK:
        token.closed = True
        if _WATCH is token:
            previous = token.previous
            while previous is not None and previous.closed:
                previous = previous.previous
            _WATCH = previous
            if previous_state is not None:
                if previous is not None and previous.state is token.state:
                    if previous is token.previous:
                        token.state.update(previous_state)
                    else:
                        token.state.update(active=True, start=previous.epoch_start)
                    token.state['budget'] = previous.operation.budget
                else:
                    token.state['active'] = False


def watchdog_expired(state):
    # Never subtract legacy epoch start from monotonic time. All real owners
    # enter _SendStateScope, which publishes this private clock binding.
    if not state.get('active'):
        return False
    with _WATCH_LOCK:
        watch = _WATCH
    return bool(watch is not None and watch.state is state and not watch.closed and watch.operation.expired())
