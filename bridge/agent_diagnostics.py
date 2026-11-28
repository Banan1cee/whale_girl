"""Emit only diagnostic metadata. The shareable report validates its own allowlist."""
from datetime import datetime, timezone
import json
import uuid


class Flow:
    def __init__(self, log):
        self.id = uuid.uuid4().hex
        self.log = log

    def record(self, subject, stage, status, code, *, caused_by=None, duration_ms=None):
        event = {
            'eventId': uuid.uuid4().hex, 'flowId': self.id,
            'at': datetime.now(timezone.utc).isoformat(), 'component': 'bridge',
            'subject': subject, 'stage': stage, 'status': status, 'code': code,
        }
        if caused_by is not None:
            event['causedBy'] = caused_by
        if duration_ms is not None:
            event['durationMs'] = max(0, int(duration_ms))
        # 诊断记录不能影响实际发送。
        try:
            self.log('[agent_diag] ' + json.dumps(event, separators=(',', ':')))
        except Exception:
            pass
        return event['eventId']

    def sticker(self, outcome):
        if not isinstance(outcome, dict):
            return
        status = outcome.get('status')
        if status not in ('failed', 'cancelled', 'unconfirmed', 'confirmed'):
            return
        code = {
            'target account window could not be verified': 'STICKER_ACCOUNT_NOT_VERIFIED',
            'could not bring the WeChat window to the foreground': 'WECHAT_NOT_FOREGROUND',
            'exact target is not open in the pinned window': 'STICKER_TARGET_NOT_VERIFIED',
            'UIA target proof is unavailable; no OCR fallback': 'UIA_TARGET_UNAVAILABLE',
        }.get(outcome.get('error'), 'STICKER_RESULT')
        self.record('sticker', 'dispatch', status, code)
