# -*- coding: utf-8 -*-
"""Internal kernel JSON adapter over the existing thread-local get/post client."""


class KernelApiError(RuntimeError):
    """A failed request is distinct from a successful empty work queue."""


class KernelApi:
    def __init__(self, http, base, token):
        self.http = http
        self.base = str(base).rstrip('/')
        self.headers = {'x-whale-bridge': '1'}
        if token:
            self.headers['x-bot-token'] = token

    def request(self, method, endpoint, *, timeout=10, require_ok=True, **kwargs):
        # A redirect must not forward the bridge credential to a different host.
        transport = getattr(self.http, method.lower())
        try:
            response = transport(self.base + endpoint, headers=dict(self.headers),
                                 timeout=timeout, allow_redirects=False, **kwargs)
        except Exception as exc:
            raise KernelApiError('内核接口传输失败：' + type(exc).__name__) from exc
        status = getattr(response, 'status_code', 0)
        if not isinstance(status, int) or not 200 <= status < 300:
            raise KernelApiError('内核接口返回 HTTP %s' % status)
        try:
            data = response.json()
        except Exception as exc:
            raise KernelApiError('内核接口返回无效 JSON') from exc
        if not isinstance(data, dict):
            raise KernelApiError('内核接口返回非对象 JSON')
        if require_ok and data.get('ok') is not True:
            # Do not log the response body: it can contain message/config content.
            raise KernelApiError('内核接口返回业务失败')
        return data

    def get(self, endpoint, **kwargs):
        return self.request('get', endpoint, **kwargs)

    def post(self, endpoint, **kwargs):
        return self.request('post', endpoint, **kwargs)
