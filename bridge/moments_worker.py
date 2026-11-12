"""Run native WeChat publishing away from the long-lived bridge process."""
import json
import os
import queue
import subprocess
import sys
import threading
import time


STAGES = ('starting', 'timeline', 'camera', 'menu', 'image_dialog', 'file_field', 'file_path', 'file_open', 'image_selected',
          'editor', 'image_preview', 'draft', 'submit', 'submitted')


def bootstrap_paths():
    directory = os.path.dirname(os.path.abspath(__file__))
    for location in (directory, os.path.join(os.path.dirname(directory), 'examples')):
        if location not in sys.path:
            sys.path.insert(0, location)


def run_worker(payload, allowed, log, *, spawn=subprocess.Popen, timeout=90):
    events = queue.Queue()
    submitted = False
    stage = 'starting'
    try:
        process = spawn([sys.executable, '-X', 'utf8', '-u', os.path.abspath(__file__), '--publish'],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        text=True, encoding='utf-8', bufsize=1,
                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except Exception as exc:
        log('朋友圈发表子进程未启动 type=%s' % type(exc).__name__)
        return 'failed', 'publish_worker_exited'

    def read_events():
        try:
            for line in process.stdout:
                if len(line) > 4096:
                    continue
                try:
                    event = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if isinstance(event, dict):
                    events.put(event)
        finally:
            events.put(None)

    reader = threading.Thread(target=read_events, name='moments-publish-worker-output', daemon=True)

    def stop_result(error):
        nonlocal submitted, stage
        if process.poll() is None:
            process.kill()
        process.wait(timeout=3)
        if reader.ident is not None:
            reader.join(timeout=1)
        # 取消/超时可能刚好赶在提交阶段消息入队之前；先终止再排空消息，
        # 防止已点发表却按「未发送」归还额度并重复投递。
        while True:
            try:
                event = events.get_nowait()
            except queue.Empty:
                break
            if isinstance(event, dict) and event.get('event') == 'stage' and event.get('stage') in STAGES:
                stage = event['stage']
                submitted = submitted or stage in ('submit', 'submitted')
        return ('unconfirmed' if submitted else 'failed'), error

    try:
        process.stdin.write(json.dumps(payload, ensure_ascii=False) + '\n')
        process.stdin.flush()
        reader.start()
        deadline = time.monotonic() + timeout
        last_gate = time.monotonic()
        while time.monotonic() < deadline:
            if time.monotonic() - last_gate >= 1:
                last_gate = time.monotonic()
                if not allowed():
                    return stop_result('job_cancelled')
            try:
                event = events.get(timeout=min(0.25, max(0.001, deadline - time.monotonic())))
            except queue.Empty:
                continue
            if event is None:
                process.wait(timeout=3)
                log('朋友圈发表子进程退出 stage=%s code=%s' % (stage, process.returncode))
                return ('unconfirmed' if submitted else 'failed'), 'publish_worker_exited'
            if event.get('event') == 'gate':
                # 每次动作仍由主桥接检查当前账号和任务授权，不在子进程缓存授权。
                ok = bool(allowed())
                last_gate = time.monotonic()
                process.stdin.write(json.dumps({'allowed': ok}) + '\n')
                process.stdin.flush()
                if not ok:
                    return stop_result('job_cancelled')
            elif event.get('event') == 'stage' and event.get('stage') in STAGES:
                stage = event['stage']
                submitted = submitted or stage in ('submit', 'submitted')
                log('朋友圈发表进度 stage=%s' % stage)
            elif event.get('event') == 'result':
                status, error = event.get('status'), event.get('error', '')
                if status in ('failed', 'unconfirmed') and isinstance(error, str) and (
                        not error or (len(error) <= 36 and error.replace('_', '').isascii()
                                      and error.replace('_', '').isalpha() and error == error.lower())):
                    return status, error
            elif event.get('event') == 'diagnostic':
                import re
                fields = [str(event.get(name, '')) for name in ('type', 'module', 'file')]
                if all(re.fullmatch(r'[A-Za-z0-9_.]{0,100}', field) for field in fields):
                    line = event.get('line')
                    if isinstance(line, int) and 0 < line < 100000:
                        log('朋友圈发表启动诊断 type=%s module=%s file=%s line=%d' % (*fields, line))
            elif event.get('event') == 'picker_probe':
                import re
                fields, buttons = event.get('fields'), event.get('buttons')
                if (isinstance(fields, int) and isinstance(buttons, int)
                        and 0 <= fields <= 350 and 0 <= buttons <= 350):
                    controls = []
                    for item in event.get('controls', [])[:24]:
                        if not isinstance(item, dict):
                            continue
                        role, identifier = str(item.get('type', '')), str(item.get('id', ''))
                        if re.fullmatch(r'[A-Za-z]{1,30}', role) and re.fullmatch(r'[A-Za-z0-9_]{0,60}', identifier):
                            controls.append(role + ':' + identifier)
                    log('朋友圈选图控件 fields=%d buttons=%d controls=%s' % (fields, buttons, ','.join(controls)))
            elif event.get('event') == 'draft_probe':
                counts = [event.get(key) for key in ('length', 'expected', 'buttons')]
                flags = [event.get(key) for key in ('readable', 'matches', 'enabled')]
                if (all(isinstance(n, int) and 0 <= n <= 100000 for n in counts)
                        and all(isinstance(flag, bool) for flag in flags)):
                    log('朋友圈文案校验 length=%d expected=%d buttons=%d readable=%s matches=%s enabled=%s'
                        % (*counts, *flags))
            elif event.get('event') == 'submit_probe':
                x, y, width, height = [event.get(key) for key in ('x', 'y', 'width', 'height')]
                if (all(isinstance(n, int) for n in (x, y, width, height))
                        and 0 <= x < width <= 30000 and 0 <= y < height <= 30000):
                    log('朋友圈发表点击 method=mouse x=%d y=%d width=%d height=%d' % (x, y, width, height))
        log('朋友圈发表子进程超时 stage=%s' % stage)
        return stop_result('publish_worker_timeout')
    except Exception as exc:
        log('朋友圈发表子进程异常 stage=%s type=%s' % (stage, type(exc).__name__))
        return stop_result('publish_worker_exited')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        try:
            process.stdin.close()
        except OSError:
            pass
        if reader.ident is not None:
            reader.join(timeout=1)
        process.stdout.close()


def publish_isolated(runtime, query, allowed, log):
    import win32gui
    import win32process
    from moments import collect

    hwnd = int(runtime.ACCOUNT.get('hwnd') or 0)
    if not allowed() or not hwnd or not win32gui.IsWindow(hwnd):
        return 'failed', 'account_not_verified'
    pid = int(win32process.GetWindowThreadProcessId(hwnd)[1])
    bound_pid = int(runtime.ACCOUNT.get('pid') or 0)
    if not pid or (bound_pid and bound_pid != pid):
        return 'failed', 'account_not_verified'
    started = time.time()
    status, error = run_worker({'account': {'hwnd': hwnd, 'pid': pid, 'verified': True},
                                'query': query}, allowed, log)
    if status == 'unconfirmed' and error in ('', 'submit_not_observed'):
        for _ in range(3):
            time.sleep(1)
            try:
                rows = collect(runtime.db, {'own': True, 'limit': 8})
                if any(row['own'] and row['text'].strip() == query['text'].strip()
                       and float(row['create_time']) >= int(started)
                       and row['imageCount'] == int(bool(query.get('image'))) for row in rows):
                    return 'confirmed', ''
            except Exception:
                break
    return status, error


def worker_main(input_stream, protocol):
    from contextlib import redirect_stdout
    from types import SimpleNamespace

    def emit(event):
        protocol.write(json.dumps(event) + '\n')
        protocol.flush()

    def gate():
        emit({'event': 'gate'})
        line = input_stream.readline()
        return bool(line and json.loads(line).get('allowed') is True)

    # 第三方库日志不能混入协议，更不能将正文和路径回传到进度日志。
    with redirect_stdout(sys.stderr):
        payload = json.loads(input_stream.readline())
        emit({'event': 'stage', 'stage': 'starting'})
        if not gate():
            emit({'event': 'result', 'status': 'failed', 'error': 'job_cancelled'})
            return
        import uiautomation as auto
        auto.InitializeUIAutomationInCurrentThread()
        import uia_compat
        uia_compat.apply()
        from wechatauto import WeChat, WeChatGUI
        from moments_publish import publish
        from window_mixin import WindowMixin
        account = payload['account']
        if not gate():
            emit({'event': 'result', 'status': 'failed', 'error': 'job_cancelled'})
            return
        gui = WeChatGUI(hwnd=int(account['hwnd']))
        runtime = SimpleNamespace(ACCOUNT=account, gui=gui)
        runtime.force_foreground = lambda hwnd: WindowMixin.force_foreground(runtime, hwnd)
        report = lambda stage: emit({'event': 'stage', 'stage': stage})
        probe = lambda details: emit({'event': ('submit_probe' if details.get('submit') else
            'draft_probe' if details.get('draft') else 'picker_probe'), **details})
        # 子进程只操作已钉住的 UI；数据库读取和最终确认仍由主桥接负责。
        ui_only_db = SimpleNamespace(get_self_info=lambda: {})
        status, error = publish(runtime, WeChat(gui=gui, db=ui_only_db).Moment, payload['query'], gate,
                                report=report, probe=probe, confirm=False)
        emit({'event': 'result', 'status': status, 'error': error})


if __name__ == '__main__' and sys.argv[1:] == ['--publish']:
    # 便携 Python 的 ._pth 隔离模式不会自动加入脚本所在目录。
    # 与主桥接入口一致：兼容层位于 examples，不在 bridge 目录内。
    bootstrap_paths()
    try:
        worker_main(sys.stdin, sys.stdout)
    except Exception as exc:
        import traceback
        last = traceback.extract_tb(exc.__traceback__)[-1]
        event = {'event': 'diagnostic', 'type': type(exc).__name__,
                 'module': getattr(exc, 'name', '') or '',
                 'file': os.path.basename(last.filename), 'line': last.lineno}
        sys.stdout.write(json.dumps(event) + '\n')
        sys.stdout.flush()
        sys.exit(1)
