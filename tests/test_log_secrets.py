import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'bridge'))
import bridge_log


class LogSecretTests(unittest.TestCase):
    def test_config_and_provider_keys_are_removed_from_console_and_file(self):
        with tempfile.TemporaryDirectory() as root:
            data = os.path.join(root, 'data')
            os.mkdir(data)
            key = 'fixture-opaque-python-value'
            with open(os.path.join(root, 'config.json'), 'w', encoding='utf-8') as f:
                json.dump({'keys': {'provider': key}}, f)
            bridge_log._secret_refresh = 0
            log = os.path.join(data, 'bridge.log')
            bridge_log.configure(log_file=log)
            console = io.StringIO()
            with contextlib.redirect_stdout(console):
                bridge_log.log_error('HTTP 401', key, 'api_key=other-fixture-value')
            with open(log, encoding='utf-8') as f:
                saved = f.read()
            for text in [console.getvalue(), saved]:
                self.assertNotIn(key, text)
                self.assertNotIn('other-fixture-value', text)
                self.assertIn('401', text)
                self.assertIn('***', text)
