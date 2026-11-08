"""按需读取当前桥接账号的朋友圈缓存；没有 UI 操作，也不下载媒体。"""
import threading


def _error_code(exc, action):
    """把异常收敛成固定错误码，正文只留在本机日志里。

    内核只根据错误码给用户提示，原始异常可能带 XML、昵称或本机路径，
    不能原样过接口。
    """
    if isinstance(exc, ImportError):
        return 'unsupported'
    if isinstance(exc, PermissionError):
        return 'permission'
    if isinstance(exc, ValueError) and 'missing account' in str(exc):
        return 'missing_account'
    if isinstance(exc, RuntimeError) and 'sns.db' in str(exc):
        return 'no_sns_db'
    return 'interaction_failed' if action != 'read' else 'read_failed'


def collect(db, query, factory=None):
    if factory is None:
        from wechatauto import MomentDB
        factory = MomentDB
    limit = query.get('limit', 20)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
        raise ValueError('invalid limit')
    username = str(getattr(db, 'wxid', '') or '') if query.get('own') else str(query.get('username') or '')
    if query.get('own') and not username:
        raise ValueError('missing account')
    self_wxid = str(getattr(db, 'wxid', '') or '')
    rows = factory(db).get_moments(limit=limit, keyword=str(query.get('keyword') or '')[:100] or None,
                                  username=username[:120] or None)
    # 仅返回展示所需字段：不把媒体 URL、路径、定位或评论者信息一并送到内核。
    return [{
        'id': str(row.get('id') or row.get('tid') or '')[:120],
        'nickname': str(row.get('nickname') or '')[:120],
        'text': str(row.get('text') or '')[:6000],
        'create_time': row.get('create_time') or 0,
        'imageCount': len(row.get('images') or []),
        'videoCount': len(row.get('videos') or []),
        # 自动点赞要跳过自己的动态和已经点过赞的动态；只回布尔值，不回点赞名单。
        'own': bool(self_wxid and str(row.get('username') or '') == self_wxid),
        'likedByMe': any(str((like or {}).get('username') or '') == self_wxid
                         for like in (row.get('likes') or []) if isinstance(like, dict)),
    } for row in rows[:limit]]


class MomentsReader:
    def __init__(self, db, http, base, headers, log, factory=None, interact=None):
        self.db, self.http, self.base = db, http, base
        self.headers, self.log, self.factory = headers, log, factory
        self.interact = interact
        self.stop_event = threading.Event()
        # 同一个错误只记一次，恢复后才允许记录下一轮；避免内核没启动时刷屏。
        self._claim_error = None
        self._complete_error = None

    def _account(self):
        # 启动器 /api/status 里的 bridge.account 是账号目录（wechat.account），
        # 不是 wxid；两边用同一个标识做任务绑定。缺目录时退回 wxid。
        return str(getattr(self.db, 'account', '') or getattr(self.db, 'wxid', '') or '')

    def _note(self, field, message):
        if getattr(self, field) != message:
            setattr(self, field, message)
            self.log(message)

    def tick(self):
        account = self._account()
        response = self.http.post(self.base + '/api/moments/claim',
                                  json={'account': account}, headers=self.headers, timeout=8)
        if response.status_code != 200:
            self._note('_claim_error', '朋友圈任务领取失败 status=%s（请检查桥接 token 与内核地址）'
                       % response.status_code)
            return
        self._claim_error = None
        try:
            job = response.json().get('job')
        except Exception as exc:
            self._note('_claim_error', '朋友圈领取响应无法解析 type=%s' % type(exc).__name__)
            return
        if not job:
            return
        action = job.get('action', 'read')
        result = {'id': job['id'], 'account': account}
        try:
            if action == 'read':
                result['items'] = collect(self.db, job['query'], self.factory)
            elif self.interact:
                outcome = self.interact(action, job['query'])
                # perform() 成功返回 True；失败返回固定错误码，便于内核给出准确提示。
                if outcome is True:
                    result['performed'] = True
                else:
                    result['error'] = outcome if isinstance(outcome, str) else 'interaction_failed'
            else:
                result['error'] = 'unsupported'
        except ImportError:
            result['error'] = 'unsupported'
        except Exception as exc:
            result['error'] = _error_code(exc, action)
            # 异常正文可能含 XML/本机路径：日志只留异常类型，不输出朋友圈内容。
            self.log(('朋友圈互动失败' if action != 'read' else '朋友圈读取失败')
                     + ' type=%s' % type(exc).__name__)
        complete = self.http.post(self.base + '/api/moments/complete', json=result,
                                  headers=self.headers, timeout=8)
        if complete.status_code != 200:
            self._note('_complete_error', '朋友圈结果回传失败 status=%s' % complete.status_code)
        else:
            self._complete_error = None

    def run(self):
        failed = False
        while not self.stop_event.is_set():
            try:
                self.tick()
                failed = False
            except Exception as exc:
                # 内核未启动时不能每五秒刷屏；恢复后才允许记录下一轮失败。
                if not failed:
                    self.log('朋友圈通道异常 type=%s' % type(exc).__name__)
                failed = True
            self.stop_event.wait(5)

    def start(self):
        thread = threading.Thread(target=self.run, name='moments-read', daemon=True)
        thread.start()
        return self

    def stop(self):
        self.stop_event.set()
