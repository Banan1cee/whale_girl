# -*- coding: utf-8 -*-
"""Pure normalized bridge settings shared by startup, reload and the watcher."""
import math
import os

try:
    from config_values import as_bool, as_int, as_float, parse_bg_send
except ImportError:
    from .config_values import as_bool, as_int, as_float, parse_bg_send


def _section(config, name):
    value = config.get(name)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError('配置节必须是对象：' + name)
    return value


def _finite(value, default, positive=False):
    number = as_float(value, default)
    if not math.isfinite(number) or (positive and number <= 0):
        return float(default)
    return number


def inbound_token(config):
    gateway = _section(_section(config, 'gateway'), 'wechat')
    return str(gateway.get('inboundToken', 'change-me-wechat') or '')


def runtime_snapshot(config, environ=None):
    if not isinstance(config, dict):
        raise ValueError('配置必须是对象')
    env = os.environ if environ is None else environ
    w = _section(config, 'wechat')
    care = _section(config, 'care')
    voice = _section(config, 'voice')
    persona = _section(config, 'persona')
    _section(config, 'server')
    if not isinstance(persona.get('aliases') or [], list):
        raise ValueError('persona.aliases 必须是数组')
    master = _section(persona, 'master')
    features = _section(config, 'features')
    sticker = _section(config, 'sticker')
    level = str(_section(config, 'log').get('level') or 'info').strip().lower()
    workers = max(1, min(16, as_int(w.get('pipelineWorkers', 4) or 4, 4)))
    if env.get('WHALE_PIPELINE_WORKERS'):
        workers = max(1, min(16, as_int(env['WHALE_PIPELINE_WORKERS'], workers)))
    stale_default = _finite(env.get('WHALE_STALE_AFTER', 120), 120, positive=True)
    stale = _finite(w.get('staleAfterSec', stale_default), stale_default, positive=True)
    wxids = master.get('wxids') or []
    if not isinstance(wxids, list):
        raise ValueError('persona.master.wxids 必须是数组')
    ignored = w.get('ignoreSenders') or []
    if not isinstance(ignored, list):
        raise ValueError('wechat.ignoreSenders 必须是数组')
    vo = {'timeoutMs': _finite(voice.get('timeoutMs', 90000), 90000, positive=True),
          'maxSeconds': _finite(voice.get('maxSeconds', 120), 120, positive=True)}
    VOICE_TIMEOUT = float(vo.get('timeoutMs')) / 1000.0
    VOICE_MAX_SECONDS = float(vo.get('maxSeconds'))
    values = {
        'STALE_AFTER': stale, 'LOG_LEVEL': level if level in ('debug', 'info', 'error') else 'info',
        'QUOTE_REPLY': as_bool(w.get('quoteReply', False), False),
        'KEYBOARD_FALLBACK': as_bool(w.get('keyboardFallback', True), True),
        'BACKGROUND_SEND': as_bool(w.get('backgroundSend', True), True),
        'BG_SEND': parse_bg_send(w), 'PIPELINE_WORKERS': workers,
        'PIPELINE_QUEUE_LIMIT': max(1, min(32, as_int(w.get('pipelineQueueLimit', 8) or 8, 8))),
        'ACCOUNT_GUARD': as_bool(w.get('accountGuard', True), True),
        'WINDOW_HWND': as_int(w.get('windowHwnd'), 0),
        'ACCOUNT_WANTED': str(w.get('account') or '').strip(),
        'LOW_BATTERY_PCT': _finite(w.get('lowBatteryPercent', 5), 5),
        'GOODNIGHT_TEXT': str(w.get('goodnightText', '晚安，电量快没了，我先睡啦，明天见～')),
        'CARE_ENABLED': as_bool(care.get('enabled', True), True),
        'CARE_ALLOW_GROUPS': as_bool(care.get('allowGroups', False), False),
        'CARE_ONLY_MASTER': as_bool(care.get('onlyMaster', True), True),
        'CARE_ALLOW_OTHERS': as_bool(care.get('allowOthers', False), False),
        'CARE_QUIET_MIN': _finite(care.get('quietAfterMinutes', 20) or 0, 20),
        'STICKER_TEST_ON': as_bool(features.get('stickers', False), False),
        'STICKER_COLLECT': as_bool(sticker.get('collectReceived', False), False),
        'MASTER_WXID': wxids[0] if wxids else '',
        'VOICE_ENABLED': as_bool(voice.get('enabled', True), True),
        'VOICE_BASE_URL': str(voice.get('baseUrl') or 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'),
        'VOICE_MODEL': str(voice.get('model') or 'qwen3-asr-flash'),
        'VOICE_TIMEOUT': VOICE_TIMEOUT, 'VOICE_MAX_SECONDS': VOICE_MAX_SECONDS,
    }
    return {'token': inbound_token(config),
            'dbDir': str(w.get('dbDir') or ''),
            'ignoreSenders': tuple(str(x).strip() for x in ignored if str(x).strip()),
            'values': values}


def restart_fields(before, after):
    changed = [name for name in ('token', 'dbDir') if before[name] != after[name]]
    changed.extend(name for name in ('ACCOUNT_WANTED', 'PIPELINE_WORKERS', 'PIPELINE_QUEUE_LIMIT')
                   if before['values'][name] != after['values'][name])
    return tuple(changed)
