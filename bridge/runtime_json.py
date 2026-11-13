# -*- coding: utf-8 -*-
"""Atomic JSON snapshots; callers retain their own required/best-effort policy."""
import json
import os
import tempfile
import threading

_REPLACE_LOCK = threading.Lock()


def atomic_write_json(path, payload, *, indent=None):
    path = os.path.abspath(os.fspath(path))
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                dir=directory, prefix='.' + os.path.basename(path) + '.',
                suffix='.tmp', delete=False) as output:
            temporary = output.name
            json.dump(payload, output, ensure_ascii=False, indent=indent)
            output.flush()
            os.fsync(output.fileno())
        # Concurrent replaces of one Windows target can fail with sharing
        # violations even though each writer owns a distinct closed temp file.
        # Only serialize the short replace operation, not JSON serialization.
        with _REPLACE_LOCK:
            os.replace(temporary, path)
        temporary = None
    finally:
        # This exact unique file was created above; never clean by glob or
        # remove the previous snapshot when serialization/replace fails.
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass
