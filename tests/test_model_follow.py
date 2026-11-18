"""Model-follow regressions; no UI, user settings, audio uploads or live services."""
import ast
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import sys

ROOT = Path(__file__).resolve().parents[1]


def pure(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


voice = pure('fixture_follow_voice', 'bridge/voice.py')


class FollowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='whale-follow-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'data').mkdir()
        self.cfg = {'voice': {'enabled': True, 'provider': 'follow', 'apiKey': 'unit-stale'}}

    def save(self, **settings):
        (self.root / 'data/settings.json').write_text(json.dumps(settings), encoding='utf-8')

    def resolve(self):
        return voice.resolve_voice_config(self.cfg, self.root, environ={})

    def test_chat_switch_is_live_and_does_not_reuse_manual_key(self):
        self.save(provider='deepseek', apiKey='unit-ds', baseUrl='https://api.deepseek.com', model='deepseek-v4-pro')
        ds = self.resolve()
        self.assertEqual(ds['apiKey'], 'unit-ds')
        self.assertEqual(ds['baseUrl'], 'https://api.deepseek.com/v1/tools/asr')
        self.save(provider='qwen', apiKey='unit-qw', baseUrl='https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
        qw = self.resolve()
        self.assertEqual(qw['apiKey'], 'unit-qw')
        self.assertEqual(qw['model'], 'qwen3-asr-flash')
        self.assertTrue(qw['baseUrl'].startswith('https://dashscope-intl.aliyuncs.com/'))
        self.assertEqual(self.cfg['voice']['apiKey'], 'unit-stale')

    def test_proxy_unknown_provider_and_insecure_url_fail_closed(self):
        for provider, url in [('deepseek', 'https://proxy.example/v1'), ('qwen', 'http://dashscope.aliyuncs.com/compatible-mode/v1'),
                              ('qwen', 'https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1'),
                              ('deepseek', 'https://api.deepseek.com:444'), ('zhipu', 'https://open.bigmodel.cn/api/paas/v4'),
                              ('custom', 'https://api.deepseek.com')]:
            with self.subTest(url=url):
                self.save(provider=provider, apiKey='unit-private', baseUrl=url)
                out = self.resolve()
                self.assertFalse(out['supported'])
                self.assertEqual(out['apiKey'], '')

    def test_workspace_keeps_region_and_key_clear_is_respected(self):
        self.save(provider='qwen', apiKey='unit-workspace', baseUrl='https://demo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
        self.assertEqual(self.resolve()['baseUrl'], 'https://demo.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
        self.save(provider='deepseek', apiKey='', baseUrl='https://api.deepseek.com', keys={'deepseek': 'unit-stale'})
        self.cfg['deepseek'] = {'apiKey': 'unit-legacy'}
        self.assertEqual(self.resolve()['apiKey'], '')

    def test_manual_service_and_explicit_off_are_preserved(self):
        self.cfg['voice'] = {'enabled': False, 'provider': 'custom', 'apiKey': 'unit-manual', 'baseUrl': 'https://asr.example/x', 'model': 'manual'}
        self.save(provider='deepseek', apiKey='unit-main')
        self.assertEqual(self.resolve(), self.cfg['voice'])

    def test_malformed_settings_does_not_reuse_legacy_key(self):
        (self.root / 'data/settings.json').write_text('{broken', encoding='utf-8')
        self.cfg['deepseek'] = {'apiKey': 'unit-legacy'}
        self.assertEqual(self.resolve()['apiKey'], '')

    def test_receiver_uses_one_snapshot_per_message_and_closed_means_no_download(self):
        # Extract the real receiver body while excluding all process/window imports.
        tree = ast.parse((ROOT / 'bridge/receiver_mixin.py').read_text(encoding='utf-8-sig'))
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'transcribe_voice')
        sample = self.root / 'sample.silk'
        sample.write_bytes(b'fixture-not-user-audio')
        media = SimpleNamespace(download_voice=Mock(return_value=str(sample)))
        current = dict(VOICE_ENABLED=True, VOICE_API_KEY='unit-first', VOICE_MODEL='',
                       VOICE_PROVIDER='deepseek', VOICE_BASE_URL='https://api.deepseek.com/v1/tools/asr',
                       VOICE_TIMEOUT=30, VOICE_MAX_SECONDS=120, VOICE_SUPPORTED=True)
        g = SimpleNamespace(voice_runtime=lambda: dict(current), VOICE_SAMPLE_RATE=16000, VOICE_PROVIDER='unused',
                            os=__import__('os'), asr_transcribe=Mock(return_value='你好'), clean_transcript=voice.clean_transcript,
                            safe_text=lambda text: 'len=' + str(len(text)), log=Mock(), log_throttled=Mock())
        scope = {'G': g}
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'fixture_receiver', 'exec'), scope)
        runtime = SimpleNamespace(_get_media=lambda: media)
        codec = SimpleNamespace(decode=lambda src, dst, rate: dst.write(bytes(32000)))
        with patch.dict(sys.modules, {'pysilk': codec}):
            self.assertEqual(scope['transcribe_voice'](runtime, {'username': 'fixture-chat', 'local_id': 1}), '你好')
            self.assertEqual(g.asr_transcribe.call_args.args[1], 'unit-first')
            current['VOICE_API_KEY'] = 'unit-second'
            self.assertEqual(scope['transcribe_voice'](runtime, {'username': 'fixture-chat', 'local_id': 2}), '你好')
            self.assertEqual(g.asr_transcribe.call_args.args[1], 'unit-second')
            self.assertFalse(sample.with_suffix('.wav').exists())
            current['VOICE_ENABLED'] = False
            self.assertEqual(scope['transcribe_voice'](runtime, {}), '')
            self.assertEqual(media.download_voice.call_count, 2)


class DecoderBuildTests(unittest.TestCase):
    def test_both_build_entry_points_install_and_check_decoder(self):
        requirements = (ROOT / 'bridge/requirements.txt').read_text(encoding='utf-8')
        builder = (ROOT / 'scripts/build-runtime.ps1').read_text(encoding='utf-8-sig')
        self.assertIn('silk-python==0.2.9', requirements)
        self.assertIn("'silk-python==0.2.9'", builder)
        self.assertGreaterEqual(builder.count('uiautomation, pysilk'), 1)
        prepare = pure('fixture_decoder_prepare', 'scripts/prepare-voice-runtime.py')
        self.assertEqual(len(prepare.WHEEL_SHA256), 64)
        with tempfile.TemporaryDirectory() as tmp:
            wrong = Path(tmp) / prepare.WHEEL_NAME
            wrong.write_bytes(b'wrong-wheel')
            with self.assertRaises(ValueError):
                prepare.prepare(tmp, wrong)


if __name__ == '__main__':
    unittest.main()
