import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import wechat_db


class CustomDirectoryDiscoveryTests(unittest.TestCase):
    def test_custom_folder_recovers_when_process_file_scan_is_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            drive = Path(tmp) / 'drive'
            root = drive / 'custom-files' / 'xwechat_files'
            (root / 'test-account' / 'db_storage').mkdir(parents=True)
            config = Path(tmp) / 'config.json'
            config.write_text(json.dumps({'wechat': {'dbDir': ''}}), encoding='utf-8')
            process = SimpleNamespace(info={'name': 'Weixin.exe'}, open_files=lambda: (_ for _ in ()).throw(PermissionError()))
            with patch.dict(sys.modules, {'psutil': SimpleNamespace(process_iter=lambda *_: [process])}), \
                    patch.object(wechat_db, 'iter_drive_roots', return_value=[str(drive)]):
                actual = wechat_db.resolve_db_dir(config_path=str(config))
            self.assertEqual(actual, str(root))
            self.assertEqual(wechat_db.find_account_dirs(actual), ['test-account'])

    def test_manual_directory_keeps_priority(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'manual'
            (root / 'test-account' / 'db_storage').mkdir(parents=True)
            config = Path(tmp) / 'config.json'
            config.write_text(json.dumps({'wechat': {'dbDir': str(root)}}), encoding='utf-8')
            self.assertEqual(wechat_db.resolve_db_dir(config_path=str(config), roots=[]), str(root))
