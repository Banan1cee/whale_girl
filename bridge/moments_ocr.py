"""In-memory Windows OCR for the Moments publishing adapter."""
import asyncio
import io


class MomentsOCRError(RuntimeError):
    pass


class MomentsOCR:
    @staticmethod
    def recognize(image):
        from wechatauto.param import WxParam
        if not getattr(WxParam, 'ENABLE_OCR', True):
            return []

        from winsdk.windows.media.ocr import OcrEngine
        from winsdk.windows.graphics.imaging import BitmapDecoder
        from winsdk.windows.storage.streams import DataWriter, InMemoryRandomAccessStream

        async def run():
            # StorageFile 无权读临时截图时会上报空结果。内存流不经过文件权限，
            # 每次单独创建，也不会把朋友圈截图留在临时目录。
            png = io.BytesIO()
            image.save(png, format='PNG')
            stream = InMemoryRandomAccessStream()
            try:
                writer = DataWriter(stream)
                try:
                    writer.write_bytes(png.getvalue())
                    await writer.store_async()
                    writer.detach_stream()
                finally:
                    writer.close()
                stream.seek(0)
                decoder = await BitmapDecoder.create_async(stream)
                bitmap = await decoder.get_software_bitmap_async()
                try:
                    engine = OcrEngine.try_create_from_user_profile_languages()
                    if engine is None:
                        raise RuntimeError('Windows OCR language unavailable')
                    result = await engine.recognize_async(bitmap)
                    lines = []
                    for line in result.lines:
                        text = ''.join(line.text.split())
                        if not text or not line.words:
                            continue
                        # 用整行边界，避免中文被分成单字后只取到第一个字。
                        boxes = [word.bounding_rect for word in line.words]
                        x, y = min(r.x for r in boxes), min(r.y for r in boxes)
                        right = max(r.x + r.width for r in boxes)
                        bottom = max(r.y + r.height for r in boxes)
                        lines.append((text, int(x), int(y), int(right - x), int(bottom - y)))
                    return lines
                finally:
                    bitmap.close()
            finally:
                stream.close()

        # 失败交给发表流程显示具体错误，不能伪装成菜单没有文字。
        try:
            return asyncio.run(asyncio.wait_for(run(), timeout=8))
        except Exception as exc:
            raise MomentsOCRError('Moments OCR failed') from exc
