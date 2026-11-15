# -*- coding: utf-8 -*-
"""Pure normalized bridge settings shared by startup, reload and the watcher."""
import math
import os
from urllib.parse import urlsplit

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
    chat = _section(config, 'chat')
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
    message_settle_ms = max(0, min(10000, as_int(chat.get('messageSettleMs', 1500), 1500)))
    group_max_wait_ms = max(message_settle_ms, min(60000, as_int(chat.get('groupMaxBatchWaitMs', 5000), 5000)))
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
    voice_provider = str(voice.get('provider') or 'auto').strip().lower()
    voice_base = str(voice.get('baseUrl') or 'https://api.deepseek.com/v1/tools/asr').strip()
    try:
        _voice_parts = urlsplit(voice_base)
        voice_host = (_voice_parts.hostname or '').lower()
        voice_path = (_voice_parts.path or '').rstrip('/').lower()
    except ValueError:
        voice_host, voice_path = '', ''
    voice_model = str(voice.get('model') or '').strip()
    if not voice_model and (voice_provider == 'dashscope' or (
            voice_provider == 'auto' and (voice_host == 'dashscope.aliyuncs.com' or voice_host.startswith('dashscope-')))):
        # 老配置可能只填了百炼地址、没填模型名。
        voice_model = 'qwen3-asr-flash'
    if voice_provider == 'deepseek' or (voice_provider == 'auto' and (
            voice_host == 'api.deepseek.com' or voice_host.endswith('.deepseek.com') or voice_path.endswith('/v1/tools/asr'))):
        # DeepSeek ASR 单次最长 120 秒；配置填更大也按 120 截断。
        VOICE_MAX_SECONDS = min(VOICE_MAX_SECONDS, 120.0)
    values = {
        'STALE_AFTER': stale, 'LOG_LEVEL': level if level in ('debug', 'info', 'error') else 'info',
        'MESSAGE_SETTLE_MS': message_settle_ms, 'GROUP_MAX_BATCH_WAIT_MS': group_max_wait_ms,
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
        'VOICE_PROVIDER': voice_provider,
        'VOICE_BASE_URL': str(voice.get('baseUrl') or 'https://api.deepseek.com/v1/tools/asr'),
        'VOICE_MODEL': voice_model,
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
