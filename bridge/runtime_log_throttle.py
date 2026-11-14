# -*- coding: utf-8 -*-
"""Bounded, synchronized log suppression; never used for message deduplication."""
import threading
import time

_LOCK = threading.RLock()


def log_throttled(state, key, *args, ttl=600, emit, folded=None,
                  capacity=1024, clock=time.monotonic):
    now = clock()
    ttl = max(0.0, float(ttl))
    capacity = max(1, int(capacity))
    with _LOCK:
        previous = state.get(key)
        # Keep the current key's folded count even when its TTL has elapsed.
        skipped = previous[2] if previous is not None else 0
        if previous is not None and now - previous[0] < ttl:
            state[key] = (previous[0], ttl, skipped + 1)
            return False
        for old_key, value in list(state.items()):
            if now - value[0] >= value[1]:
                state.pop(old_key, None)
        state.pop(key, None)
        while len(state) >= capacity:
            state.pop(next(iter(state)))
        state[key] = (now, ttl, 0)
    # Logger callbacks can reenter or block; never invoke them under the lock.
    if skipped and folded:
        folded('（上面这类日志还有 %d 条被折叠了）' % skipped)
    emit(*args)
    return True
