import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from ffmpeg_runtime import configure_ffmpeg


class FfmpegRuntimeTests(unittest.TestCase):
    def test_configures_versioned_installer_binary_without_global_path(self):
        with tempfile.TemporaryDirectory(prefix='Whale runtime ') as root:
            exe = (Path(root) / 'runtime/python/Lib/site-packages/imageio_ffmpeg/binaries'
                   / 'ffmpeg-win-x86_64-v9.0.2.exe')
            exe.parent.mkdir(parents=True)
            exe.touch()
            with patch.dict(os.environ, {'PATH': '', 'IMAGEIO_FFMPEG_EXE': str(Path(root) / 'missing.exe')}):
                self.assertEqual(configure_ffmpeg(root), str(exe))
                self.assertEqual(os.environ['IMAGEIO_FFMPEG_EXE'], str(exe))
                self.assertEqual(os.environ['PATH'], '')

    def test_legacy_binary_is_available_to_both_command_and_imageio(self):
        with tempfile.TemporaryDirectory() as root:
            exe = Path(root) / 'runtime/ffmpeg/bin/ffmpeg.exe'
            exe.parent.mkdir(parents=True)
            exe.touch()
            with patch.dict(os.environ, {'PATH': ''}):
                self.assertEqual(configure_ffmpeg(root), str(exe))
                self.assertEqual(os.environ['IMAGEIO_FFMPEG_EXE'], str(exe))
                self.assertEqual(os.environ['PATH'].split(os.pathsep)[0], str(exe.parent))


if __name__ == '__main__':
    unittest.main()
