import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from moments_ocr import MomentsOCR, MomentsOCRError


class MomentsOCRTest(unittest.TestCase):
    def setUp(self):
        self.stream = Mock()
        self.writer = Mock(store_async=AsyncMock())
        self.bitmap = Mock()
        words = [SimpleNamespace(bounding_rect=SimpleNamespace(x=x, y=10, width=12, height=20))
                 for x in (5, 20, 35, 50, 65, 80)]
        self.engine = SimpleNamespace(recognize_async=AsyncMock(return_value=SimpleNamespace(
            lines=[SimpleNamespace(text='选 照 片 或 视 频', words=words)])))
        self.factory = Mock(return_value=self.engine)
        self.writer_factory = Mock(return_value=self.writer)
        self.modules = {
            'wechatauto.param': SimpleNamespace(WxParam=SimpleNamespace(ENABLE_OCR=True)),
            'winsdk.windows.storage.streams': SimpleNamespace(
                DataWriter=self.writer_factory, InMemoryRandomAccessStream=lambda: self.stream),
            'winsdk.windows.graphics.imaging': SimpleNamespace(BitmapDecoder=SimpleNamespace(
                create_async=AsyncMock(return_value=SimpleNamespace(
                    get_software_bitmap_async=AsyncMock(return_value=self.bitmap))))),
            'winsdk.windows.media.ocr': SimpleNamespace(OcrEngine=SimpleNamespace(
                try_create_from_user_profile_languages=self.factory)),
            # 文件读取无论是否允许，都不应成为截图识别的依赖。
            'winsdk.windows.storage': SimpleNamespace(StorageFile=SimpleNamespace(
                get_file_from_path_async=Mock(side_effect=PermissionError('access denied')))),
        }
        self.image = SimpleNamespace(save=lambda output, format: output.write(b'png-image'))

    def test_uses_memory_even_when_storagefile_is_denied_and_unions_word_bounds(self):
        with patch.dict(sys.modules, self.modules):
            self.assertEqual(MomentsOCR.recognize(self.image), [('选照片或视频', 5, 10, 87, 20)])
        self.writer.write_bytes.assert_called_once_with(b'png-image')
        self.writer.store_async.assert_awaited_once()
        self.writer.detach_stream.assert_called_once()
        self.stream.seek.assert_called_once_with(0)
        self.bitmap.close.assert_called_once()
        self.writer.close.assert_called_once()
        self.stream.close.assert_called_once()
        self.modules['winsdk.windows.storage'].StorageFile.get_file_from_path_async.assert_not_called()

    def test_closes_resources_and_surfaces_stream_error(self):
        self.writer.store_async.side_effect = PermissionError('write failed')
        with patch.dict(sys.modules, self.modules):
            with self.assertRaises(MomentsOCRError):
                MomentsOCR.recognize(self.image)
        self.writer.close.assert_called_once()
        self.stream.close.assert_called_once()
        self.engine.recognize_async.assert_not_awaited()

    def test_timeout_and_missing_language_are_errors_not_empty_menu(self):
        self.engine.recognize_async.side_effect = TimeoutError()
        with patch.dict(sys.modules, self.modules):
            with self.assertRaises(MomentsOCRError):
                MomentsOCR.recognize(self.image)
        self.bitmap.close.assert_called_once()
        self.stream.close.assert_called_once()
        self.factory.return_value = None
        with patch.dict(sys.modules, self.modules):
            with self.assertRaises(MomentsOCRError):
                MomentsOCR.recognize(self.image)

    def test_respects_ocr_master_switch(self):
        self.modules['wechatauto.param'].WxParam.ENABLE_OCR = False
        with patch.dict(sys.modules, self.modules):
            self.assertEqual(MomentsOCR.recognize(self.image), [])
        self.writer_factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
