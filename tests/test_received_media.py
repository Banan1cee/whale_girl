import ast
import base64
import hashlib
import io
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
import uuid
from unittest.mock import Mock, call, patch

try:
    from PIL import Image
except ImportError:  # 干净的 Python / 没装 Pillow：整组跳过，别让一堆无关用例跟着红
    raise unittest.SkipTest('表情包解码要 Pillow（随包 runtime 自带；源码环境 pip install pillow）')

try:  # AES 回源解密那条用例才需要它
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes  # noqa: F401
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'bridge'))
import emoji_vision
from image_cache import bind_target_probe, V2_MAGIC
from media_key_compat import install_key_scan_guard
from receiver_mixin import image_dir_note, image_key_note, run_media_with_timeout


from bridge_ast import load_function  # noqa: E402


def nested(name, env):
    return load_function(name, env)


class ReceivedMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = self.root / 'image.png'
        Image.new('RGB', (40, 30), 'blue').save(self.image)

    def env(self, download):
        post = Mock(return_value=types.SimpleNamespace(json=lambda: {'ok': True, 'text': '蓝色图片'}))
        sleeps = []
        env = dict(os=os, time=types.SimpleNamespace(sleep=sleeps.append),
                   bot_url='http://localhost/webhook/wechat', log=Mock(), log_throttled=Mock(),
                   _get_media=lambda: types.SimpleNamespace(download_image=download),
                   LOCAL_HTTP=types.SimpleNamespace(post=post))
        return env, post, sleeps

    def test_image_waits_for_cache_and_keeps_message_shard(self):
        download = Mock(side_effect=[None, str(self.image)])
        env, post, sleeps = self.env(download)
        result = nested('describe_image', env)({'username': 'peer', 'local_id': 4, 'shard': 'shard2'})
        self.assertEqual(result, '蓝色图片')
        self.assertEqual(sleeps, [0.5])
        self.assertEqual(len(post.call_args_list), 1)
        self.assertTrue(all(call.kwargs['shard'] == 'shard2' for call in download.call_args_list))

    def test_image_retries_full_before_using_thumbnail(self):
        full = self.root / 'full.png'
        Image.new('RGB', (640, 360), 'blue').save(full)
        attempts = []

        def download(_user, _local_id, *, tier, shard):
            attempts.append((tier, shard))
            if tier == 'best':
                return str(self.image)
            return str(full) if attempts.count(('full', 'shard2')) > 1 else None

        env, post, sleeps = self.env(download)
        msg = {'username': 'peer', 'local_id': 4, 'shard': 'shard2'}
        self.assertEqual(nested('describe_image', env)(msg), '蓝色图片')
        payload = base64.b64decode(post.call_args.kwargs['json']['image'])
        with Image.open(io.BytesIO(payload)) as decoded:
            self.assertEqual(decoded.size, (640, 360))
        self.assertEqual(attempts, [('full', 'shard2'), ('full', 'shard2')])
        self.assertEqual(sleeps, [0.5])

    def test_image_falls_back_to_thumbnail_after_full_retry_budget(self):
        download = Mock(side_effect=lambda *args, tier, **kwargs: str(self.image) if tier == 'best' else None)
        env, post, sleeps = self.env(download)
        self.assertEqual(nested('describe_image', env)({'username': 'peer', 'local_id': 4}), '蓝色图片')
        self.assertEqual([request.kwargs['tier'] for request in download.call_args_list],
                         ['full', 'full', 'full', 'full', 'best'])
        self.assertEqual(sleeps, [0.5, 1, 2])
        post.assert_called_once()

    def test_image_unavailable_stops_without_vision_request(self):
        download = Mock(return_value=None)
        env, post, sleeps = self.env(download)
        self.assertEqual(nested('describe_image', env)({'username': 'peer', 'local_id': 4}), '')
        self.assertEqual(download.call_count, 5)
        self.assertEqual(sleeps, [0.5, 1, 2])
        post.assert_not_called()

    def test_image_falls_back_to_ui_capture_when_local_file_is_missing(self):
        buf = io.BytesIO()
        Image.new('RGB', (40, 30), 'red').save(buf, format='JPEG')
        shot = buf.getvalue()
        env, post, _sleeps = self.env(Mock(return_value=None))
        ui = Mock(return_value=shot)
        env['image_ui_fallback'] = ui
        msg = {'username': 'peer', 'local_id': 4}
        self.assertEqual(nested('describe_image', env)(msg), '蓝色图片')
        ui.assert_called_once_with(msg)
        self.assertEqual(len(post.call_args_list), 1, '截图也要送去识图')

    def test_image_fallback_failure_is_explained_and_not_sent(self):
        env, post, _sleeps = self.env(Mock(return_value=None))
        env['image_ui_fallback'] = Mock(return_value=b'')
        msg = {'username': 'peer', 'local_id': 4}
        self.assertEqual(nested('describe_image', env)(msg), '')
        self.assertIn('界面兜底', msg.get('_media_fail') or '')
        post.assert_not_called()

    def test_missing_image_key_skips_pointless_retries_and_uses_ui_fallback(self):
        # 密钥取不到时再等 3.5 秒也不会变；聊天不会等，直接转界面兜底。
        download = Mock(side_effect=RuntimeError('无法获取图片 AES 密钥：请保持微信登录'))
        env, post, sleeps = self.env(download)
        env['image_ui_fallback'] = Mock(return_value=b'')
        self.assertEqual(nested('describe_image', env)({'username': 'peer', 'local_id': 4}), '')
        self.assertEqual(download.call_count, 2, '只试 full/best 各一次，不再空转三轮')
        self.assertEqual(sleeps, [], '密钥问题不需要等待重试')
        env['image_ui_fallback'].assert_called_once()
        post.assert_not_called()

    def test_unverified_account_cannot_start_image_ui_fallback(self):
        import threading

        env = {
            'ACCOUNT': {'verified': False, 'hwnd': 100, 'pid': 42},
            'display_name': Mock(return_value='测试会话'),
            '_get_media': Mock(return_value=types.SimpleNamespace(save_dir=str(self.root))),
            'send_lock': threading.Lock(),
            'gui_lock': threading.Lock(),
            'log': Mock(),
        }
        with patch('image_ui_fallback.read_image_via_ui', return_value=b'wrong-account') as capture:
            self.assertEqual(nested('image_ui_fallback', env)({'username': 'peer', 'local_id': 4}), b'')
        capture.assert_not_called()

    def test_image_preview_timeout_releases_send_and_gui_locks(self):
        import subprocess
        import threading

        send_lock, gui_lock = threading.Lock(), threading.Lock()
        win = types.SimpleNamespace(IsWindow=lambda hwnd: True, GetForegroundWindow=lambda: 100)
        process = types.SimpleNamespace(GetWindowThreadProcessId=lambda hwnd: (1, 42))
        db = types.SimpleNamespace(account='fixture', get_messages=lambda *a, **k: [
            {'type': '图片', 'local_id': 4, 'shard': 'test-shard'},
        ])
        env = {'ACCOUNT': {'verified': True, 'hwnd': 100, 'pid': 42}, 'db': db,
               'display_name': lambda username: '测试会话', 'configured_account_dir': lambda: 'fixture',
               'send_lock': send_lock, 'gui_lock': gui_lock, 'log': Mock()}

        def timeout(command, **kwargs):
            self.assertTrue(send_lock.locked() and gui_lock.locked())
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])

        msg = {'username': 'peer', 'local_id': 4, 'shard': 'test-shard'}
        with patch.dict(sys.modules, {'win32gui': win, 'win32process': process}), \
                patch('image_ui_fallback.subprocess.run', side_effect=timeout) as worker:
            self.assertEqual(nested('image_ui_fallback', env)(msg), b'')
        worker.assert_called_once()
        self.assertFalse(send_lock.locked() or gui_lock.locked())
        self.assertTrue(any('子进程超时' in str(line) for line in env['log'].call_args_list))

    def test_decryption_validates_current_image_instead_of_old_probe(self):
        target = self.root / 'target.dat'
        probe = b'current-probe-16'
        probe = probe.ljust(16, b'!')
        target.write_bytes(V2_MAGIC + b'\0' * 9 + probe + b'\0')
        downloader = types.SimpleNamespace(_key_probe=b'old', _xor_key=123)
        observed = []
        downloader.decrypt_image = lambda path, **kw: observed.append((downloader._key_probe, downloader._xor_key, kw)) or b'decoded'
        bind_target_probe(downloader)
        bind_target_probe(downloader)
        self.assertEqual(downloader.decrypt_image(target, aes_key='example'), b'decoded')
        self.assertEqual(observed, [(probe, None, {'aes_key': 'example'})])

    def test_cdn_sticker_verifies_hash_and_samples_gif(self):
        frames = [Image.new('RGB', (12, 10), color) for color in ('red', 'green', 'blue')]
        buf = io.BytesIO()
        frames[0].save(buf, format='GIF', save_all=True, append_images=frames[1:], duration=100)
        raw = buf.getvalue()
        digest = hashlib.md5(raw).hexdigest()
        content = '<msg><emoji md5 = "' + digest + '" cdnurl="https://wxapp.tc.qq.com/a?a=1&amp;b=2"/></msg>'
        fetch = Mock(return_value=raw)
        preview, count = emoji_vision.load_preview(self.root, content, allow_network=True, fetch=fetch)
        self.assertEqual(count, 3)
        self.assertEqual(Image.open(io.BytesIO(preview)).format, 'PNG')
        fetch.assert_called_once_with('https://wxapp.tc.qq.com/a?a=1&b=2')
        self.assertIsNone(emoji_vision.load_preview(self.root, content, allow_network=True, fetch=lambda u: b'wrong asset'))

    def test_sticker_network_is_explicit_and_rejects_untrusted_hosts(self):
        for url in ('http://127.0.0.1/a', 'https://wxapp.tc.qq.com.evil.example/a'):
            fetch = Mock()
            content = '<emoji md5="' + 'a' * 32 + '" cdnurl="' + url + '"/>'
            self.assertIsNone(emoji_vision.load_preview(self.root, content, allow_network=True, fetch=fetch))
            fetch.assert_not_called()
        fetch = Mock()
        content = '<emoji md5="' + 'a' * 32 + '" cdnurl="https://wxapp.tc.qq.com/a"/>'
        self.assertIsNone(emoji_vision.load_preview(self.root, content, fetch=fetch))
        fetch.assert_not_called()

    def test_local_sticker_without_extension(self):
        digest = hashlib.md5(self.image.read_bytes()).hexdigest()
        path = self.root / 'cache/2026-11/Emoticon' / digest[:2] / digest
        path.parent.mkdir(parents=True)
        path.write_bytes(self.image.read_bytes())
        preview, count = emoji_vision.load_preview(self.root, '<emoji md5="' + digest + '"/>')
        self.assertEqual(count, 1)
        self.assertEqual(Image.open(io.BytesIO(preview)).size, (40, 30))

    def test_collection_keeps_original_gif_animation_and_deduplicates(self):
        frames = [Image.new('RGB', (12, 10), color) for color in ('red', 'green', 'blue')]
        buf = io.BytesIO()
        frames[0].save(buf, format='GIF', save_all=True, append_images=frames[1:], duration=[100, 200, 300], loop=0)
        raw = buf.getvalue()
        digest = hashlib.md5(raw).hexdigest()
        content = '<emoji md5="' + digest + '" cdnurl="https://wxapp.tc.qq.com/a"/>'
        directory = self.root / '收集的表情包'
        callback = lambda data, fmt: emoji_vision.save_original(directory, data, fmt)
        for _ in range(2):
            preview, _ = emoji_vision.load_preview(self.root, content, True, lambda _: raw, callback)
        files = list(directory.iterdir())
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].suffix, '.gif')
        self.assertEqual(files[0].read_bytes(), raw)
        with Image.open(files[0]) as image:
            self.assertEqual(image.n_frames, 3)
            self.assertEqual(image.info['loop'], 0)
            image.seek(1)
            self.assertEqual(image.info['duration'], 200)
        self.assertNotEqual(preview, raw)

    def test_collection_is_independent_of_vision_success_and_send_switch(self):
        raw = self.image.read_bytes()
        digest = hashlib.md5(raw).hexdigest()
        cache = self.root / 'cache/month/Emoticon' / digest[:2] / digest
        cache.parent.mkdir(parents=True)
        cache.write_bytes(raw)
        env, post, _ = self.env(None)
        env.update(ROOT=str(self.root), STICKER_COLLECT=True, STICKER_TEST_ON=False,
                   db=types.SimpleNamespace(account_dir=str(self.root)))
        post.return_value.json = lambda: {'ok': False, 'error': '识别不可用'}
        describe = nested('describe_emoji', env)
        self.assertEqual(describe({'content': '<emoji md5="' + digest + '"/>'}), '')
        files = list((self.root / 'data/收集的表情包').iterdir())
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].read_bytes(), raw)
        files[0].unlink()
        env['STICKER_COLLECT'] = False
        describe({'content': '<emoji md5="' + digest + '"/>'})
        self.assertEqual(list((self.root / 'data/收集的表情包').iterdir()), [])

    def test_collection_write_failure_does_not_break_vision(self):
        raw = self.image.read_bytes()
        digest = hashlib.md5(raw).hexdigest()
        cache = self.root / 'cache/month/Emoticon' / digest[:2] / digest
        cache.parent.mkdir(parents=True)
        cache.write_bytes(raw)
        (self.root / 'data').write_text('阻止创建目录')
        env, _, _ = self.env(None)
        env.update(ROOT=str(self.root), STICKER_COLLECT=True, db=types.SimpleNamespace(account_dir=str(self.root)))
        self.assertEqual(nested('describe_emoji', env)({'content': '<emoji md5="' + digest + '"/>'}), '蓝色图片')
        self.assertTrue(any('表情包收集失败 type=' in str(call) for call in env['log'].call_args_list))

    def test_collection_rejects_wrong_local_hash(self):
        digest = 'a' * 32
        cache = self.root / 'cache/month/Emoticon' / digest[:2] / digest
        cache.parent.mkdir(parents=True)
        cache.write_bytes(self.image.read_bytes())
        callback = Mock()
        self.assertIsNone(emoji_vision.load_preview(self.root, '<emoji md5="' + digest + '"/>', on_original=callback))
        callback.assert_not_called()

    @unittest.skipUnless(HAS_CRYPTO, '需要 cryptography 才能校验 AES 回源解密')
    def test_encrypted_cdn_sticker_is_verified_after_decryption(self):
        raw = self.image.read_bytes()
        key = bytes(range(16))
        padding = 16 - len(raw) % 16
        cipher = Cipher(algorithms.AES(key), modes.CBC(bytes(16))).encryptor()
        encrypted = cipher.update(raw + bytes([padding]) * padding) + cipher.finalize()
        content = '<emoji md5="' + hashlib.md5(raw).hexdigest() + '" aeskey="' + key.hex() + '" encrypturl="https://wxapp.tc.qq.com/a"/>'
        saved = []
        self.assertIsNotNone(emoji_vision.load_preview(self.root, content, allow_network=True,
                                                     fetch=lambda u: encrypted,
                                                     on_original=lambda data, fmt: saved.append(data)))
        self.assertEqual(saved, [raw])


class MediaFailureLogTests(unittest.TestCase):
    """识别失败照旧不回话，但日志要能回答「这条消息她为什么没回」。

    以前的失败路径只有一个 return：内部日志没有消息 id，事后只能猜。
    """

    def env(self, stubs):
        # log_throttled 用真身跑：节流行为本身就是这次要验证的东西
        clock = types.SimpleNamespace(now=1_700_000_000.0)
        clock.time = lambda: clock.now
        env = dict(
            me='self',
            time=clock,
            _THROTTLE_LOG={},
            log=Mock(),
            log_error=Mock(),
            display_name=lambda chat: '好友',
            db=types.SimpleNamespace(get_nickname=lambda sender: '张三'),
            LOCAL_HTTP=types.SimpleNamespace(post=Mock()),   # 真连微信/服务端的替身
            token='',
            bot_url='http://localhost/webhook/wechat',
            CONN_STATE={'ok': True},
            ONLY_CHATS=[],
        )
        env.update(stubs)
        env['log_throttled'] = nested('log_throttled', env)
        # on_message_inner 会调用模块级 fix_garbled（0eba2cb 的乱码还原），单函数抽取要一起带上
        env['fix_garbled'] = nested('fix_garbled', env)
        env['on_message_inner'] = nested('on_message_inner', env)
        return env

    def message(self, mtype, **changes):
        msg = dict(username='peer', sender_username='friend', type=mtype, content='',
                   local_id=7, shard='shard1', create_time=200.)
        msg.update(changes)
        return msg

    def error_line(self, env):
        env['log_error'].assert_called_once()
        return env['log_error'].call_args.args[0]

    def test_image_failure_logs_error_and_lets_her_reply(self):
        env = self.env({'describe_image': Mock(return_value=''),
                        'describe_emoji': Mock(), 'STICKER_COLLECT': True})
        msg = self.message('图片')
        env['on_message_inner'](msg, None)
        env['describe_image'].assert_called_once_with(msg)
        env['describe_emoji'].assert_not_called()
        line = self.error_line(env)
        # 日志已脱敏：会话/发送者只留稳定 hash，不再写真实昵称。
        for piece in ('会话=#', '发送者=#', '类型=图片', '消息id=peer:shard1:7', '空描述'):
            self.assertIn(piece, line)
        # 取不到图不再装没看见：把「没取到」交给模型，让它自然回一句。
        payload = env['LOCAL_HTTP'].post.call_args.kwargs['json']
        self.assertIn('没取到', payload['text'])
        self.assertIn('不要编造', payload['text'])
        self.assertTrue(payload['text'].startswith('（对方发了一张图片，但这边没取到'))

    def test_two_failed_images_both_reach_the_kernel(self):
        # 占位文本对同一会话是固定的，不能因此把第二张图当「重复消息」丢掉。
        env = self.env({'describe_image': Mock(return_value='')})
        env['LOCAL_HTTP'].post.return_value = types.SimpleNamespace(
            status_code=400, json=lambda: {})
        env['on_message_inner'](self.message('图片', local_id=9101), None)
        env['on_message_inner'](self.message('图片', local_id=9102), None)
        self.assertEqual(env['LOCAL_HTTP'].post.call_count, 2)

    def test_skipped_messages_are_logged_with_reason(self):
        # 每条没处理的消息都要能在日志里找到原因，不能只剩一个 return。
        env = self.env({'describe_image': Mock(return_value='')})
        env['on_message_inner'](self.message('文本', content=''), None)
        env['on_message_inner'](self.message('文件', content='<msg><appmsg></appmsg></msg>'), None)
        env['on_message_inner'](self.message('文本', content='在吗', sender_username='self'), None)
        lines = ' '.join(str(call.args) for call in env['log'].call_args_list)
        self.assertIn('消息未处理', lines)
        self.assertIn('正文为空', lines)
        self.assertIn('没有可读正文', lines)
        self.assertIn('自己发出的消息', lines)
        self.assertIn('消息id=', lines, '每条跳过日志都要带消息 id')

    def test_separate_text_reply_sends_two_messages_even_with_auto_voice(self):
        data = {'ok': True, 'action': 'reply', 'reply': '先保存。再重启。',
                'bubbles': ['先保存', '再重启'], 'separateText': True}
        env = self.env({
            'ONLY_CHATS': [], 'is_system_notice': lambda *_: False, 'duplicate_guard': lambda *_: False,
            'aliases': [], 'token': '', 'bot_url': 'http://localhost/webhook/wechat',
            'CONN_STATE': {'ok': True}, 'rate_guard': lambda *_: True,
            'STICKER_TEST_ON': False,
            'voice_reply': types.SimpleNamespace(settings=Mock(), choose=Mock(return_value=True)),
            'send_text': Mock(return_value=True), 'send_voice_reply': Mock(return_value=True),
        })
        env['time'].sleep = Mock()
        env['LOCAL_HTTP'].post.return_value = types.SimpleNamespace(status_code=200, json=lambda: data)
        env['on_message_inner'](self.message('文本', content='请分条发'), None)
        env['send_voice_reply'].assert_not_called()
        self.assertEqual(env['send_text'].call_args_list, [
            call('先保存', '好友', 'peer'),
            call('再重启', '好友', 'peer'),
        ])

    def test_emoji_failure_logs_error_and_sends_nothing(self):
        env = self.env({'describe_emoji': Mock(return_value='')})
        msg = self.message('表情', content='<emoji md5="deadbeef"/>')
        env['on_message_inner'](msg, None)
        env['describe_emoji'].assert_called_once_with(msg)
        line = self.error_line(env)
        self.assertIn('类型=表情', line)
        self.assertIn('消息id=peer:shard1:7', line)
        env['LOCAL_HTTP'].post.assert_not_called()

    def test_voice_failure_logs_error_and_sends_nothing(self):
        env = self.env({'transcribe_voice': Mock(return_value='')})
        msg = self.message('语音')
        env['on_message_inner'](msg, None)
        line = self.error_line(env)
        self.assertIn('类型=语音', line)
        self.assertIn('消息id=peer:shard1:7', line)
        env['LOCAL_HTTP'].post.assert_not_called()

    def test_success_keeps_error_log_silent(self):
        env = self.env({'describe_image': Mock(return_value='一张蓝色图片')})
        # 名单不匹配让函数在「识别成功之后」提前返回，不碰真正的发送链路
        env['ONLY_CHATS'] = ['不在名单里的会话']
        env['on_message_inner'](self.message('图片'), None)
        env['log_error'].assert_not_called()
        self.assertFalse([k for k in env['_THROTTLE_LOG'] if k.startswith('media-fail')])

    def test_same_message_is_throttled_to_one_error_line(self):
        env = self.env({'describe_image': Mock(return_value='')})
        msg = self.message('图片')
        env['on_message_inner'](msg, None)
        env['on_message_inner'](msg, None)
        env['log_error'].assert_called_once()
        keys = [k for k in env['_THROTTLE_LOG'] if k.startswith('media-fail')]
        self.assertEqual(len(keys), 1)
        self.assertIn('peer:shard1:7', keys[0], '节流 key 要带消息 id，别把别的消息一起吞掉')

    def test_exception_type_is_carried_into_the_error_line(self):
        # 落盘路径不存在 → getsize 抛 FileNotFoundError，异常类型要能带回消息上
        missing = str(ROOT / ('missing-image-%s.png' % uuid.uuid4().hex))
        env = dict(os=os, time=types.SimpleNamespace(sleep=lambda *_: None),
                   bot_url='http://localhost/webhook/wechat', log=Mock(), log_throttled=Mock(),
                   _get_media=lambda: types.SimpleNamespace(download_image=lambda *a, **k: missing),
                   LOCAL_HTTP=types.SimpleNamespace(post=Mock()))
        msg = {'username': 'peer', 'local_id': 7, 'shard': 'shard1'}
        self.assertEqual(nested('describe_image', env)(msg), '')
        self.assertEqual(msg.get('_media_fail'), 'FileNotFoundError')
        env['LOCAL_HTTP'].post.assert_not_called()


class MediaHangGuardTests(unittest.TestCase):
    """发一张图把整个会话卡死：图片密钥扫描不能无限等，识别也不能无限跑。"""

    def test_slow_key_scan_is_abandoned_instead_of_blocking_the_chat(self):
        calls = []

        def slow_scan(monitor=False, monitor_timeout=120.0, probe=None):
            calls.append(monitor)
            time.sleep(2.0)          # 真实现是 120 秒的「每 2 秒重扫」循环
            return 'late-key'

        dl = types.SimpleNamespace(_scan_aes_key=slow_scan)
        logs = []
        self.assertTrue(install_key_scan_guard(dl, log=lambda *a: logs.append(a),
                                               timeout=0.2, cooldown=60.0))
        started = time.monotonic()
        self.assertIsNone(dl._scan_aes_key(monitor=True))
        self.assertLess(time.monotonic() - started, 1.5, '超时后必须马上返回，不能等原扫描跑完')
        self.assertEqual(calls, [False], '必须强制单次扫描，不再挂 120 秒 monitor')
        self.assertTrue(any('先跳过' in str(item) for item in logs), '要留下能看懂的日志')

        # 冷却期内不再扫内存，避免每条图片都再卡一次
        self.assertIsNone(dl._scan_aes_key(monitor=True))
        self.assertEqual(calls, [False])

    def test_fast_key_scan_result_still_passes_through(self):
        seen = []

        def quick(monitor=False, monitor_timeout=120.0, probe=None):
            seen.append((monitor, probe))
            return 'fast-key'

        dl = types.SimpleNamespace(_scan_aes_key=quick)
        self.assertTrue(install_key_scan_guard(dl, log=lambda *a: None, timeout=1.0, cooldown=0))
        self.assertEqual(dl._scan_aes_key(monitor=True, probe=b'p'), 'fast-key')
        self.assertEqual(seen, [(False, b'p')], '取到密钥时原样返回，只是不再 monitor')
        self.assertFalse(install_key_scan_guard(dl), '重复安装要幂等')

    def test_media_recognition_timeout_releases_the_chat(self):
        msg = {'username': 'peer', 'local_id': 9}
        started = time.monotonic()
        out = run_media_with_timeout(lambda: time.sleep(3.0) or '迟到的描述', '图片', msg,
                                     log=lambda *a: None, timeout=0.2)
        self.assertEqual(out, '')
        self.assertLess(time.monotonic() - started, 1.5, '识别超时必须立刻放弃这一条')
        self.assertIn('识别超时', msg.get('_media_fail') or '')

    def test_media_recognition_result_passes_through(self):
        msg = {'username': 'peer', 'local_id': 10}
        out = run_media_with_timeout(lambda: '图里是一碗面', '图片', msg, log=lambda *a: None)
        self.assertEqual(out, '图里是一碗面')
        self.assertNotIn('_media_fail', msg)

    def test_media_recognition_exception_is_reported_not_raised(self):
        msg = {'username': 'peer', 'local_id': 11}

        def boom():
            raise RuntimeError('下载失败')

        self.assertEqual(run_media_with_timeout(boom, '表情', msg, log=lambda *a: None), '')
        self.assertEqual(msg.get('_media_fail'), 'RuntimeError')


class ImageDiagnosticsTests(unittest.TestCase):
    """密钥取不到时要能一眼看出：能不能离线派生、图来自哪个账号目录。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_image_key_note_reports_cfg_and_cache(self):
        workdir = self.root / 'keys'
        workdir.mkdir()
        db = types.SimpleNamespace(cfg_dword=0x1234, workdir=str(workdir))
        self.assertIn('cfgDword 可用', image_key_note(db))

        (workdir / 'image_keys.json').write_text('{}', encoding='utf-8')
        db2 = types.SimpleNamespace(cfg_dword=None, workdir=str(workdir))
        note = image_key_note(db2)
        self.assertIn('cfgDword 不可用', note)
        self.assertIn('密钥缓存有', note)

        self.assertIn('密钥缓存没有', image_key_note(types.SimpleNamespace(
            cfg_dword=None, workdir=str(self.root / 'missing'))))

    def test_image_dir_note_tells_current_account_from_elsewhere(self):
        current = self.root / 'wxid_a_1111'
        image = current / 'msg' / 'attach' / 'x' / '2026-11' / 'Img' / 'a.dat'
        image.parent.mkdir(parents=True)
        image.write_bytes(b'x')
        db = types.SimpleNamespace(account_dir=str(current))
        self.assertEqual(image_dir_note(db, str(image)), '当前账号目录')

        other = self.root / 'wxid_b_2222' / 'msg' / 'attach' / 'x' / 'Img' / 'a.dat'
        self.assertIn('非当前账号目录', image_dir_note(db, str(other)))
        self.assertEqual(image_dir_note(types.SimpleNamespace(account_dir=''), str(image)), '')


if __name__ == '__main__':
    unittest.main()
