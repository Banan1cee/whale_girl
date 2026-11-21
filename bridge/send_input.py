# -*- coding: utf-8 -*-
"""Only the identical input-blank primitive; no identity/policy coercion."""


def is_blank(value):
    return isinstance(value, str) and value.strip() == ''


def input_value(uia):
    """None is unavailable evidence, never an empty composer."""
    try:
        control = uia._chat_input()
        if control is None:
            return None
        try:
            # wechatauto 返回的是 uiautomation 控件，正文由 ValuePattern 提供。
            value = control.GetValuePattern().Value
            if isinstance(value, str):
                return value
        except Exception:
            pass
        for name in ('get_value', 'value'):
            try:
                value = getattr(control, name)
                value = value() if callable(value) else value
                if isinstance(value, str):
                    return value
            except Exception:
                pass
        try:
            value = control.iface_value.Value
            if isinstance(value, str):
                return value
        except Exception:
            pass
    except Exception:
        pass
    return None
