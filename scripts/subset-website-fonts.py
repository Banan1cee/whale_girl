"""从官方 Noto Sans SC 可变字体补齐官网字集，不改动其他排版参数。"""

import argparse
from html.parser import HTMLParser
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


class TextCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.texts = []

    def handle_data(self, data):
        self.texts.append(data)

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ("alt", "title", "aria-label", "placeholder") and value:
                self.texts.append(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="官方 NotoSansSC[wght].ttf")
    parser.add_argument("site", type=Path, help="生成后的官网目录")
    args = parser.parse_args()
    output = Path(__file__).resolve().parent.parent / "website" / "fonts"
    collector = TextCollector()
    for file in args.site.rglob("*.html"):
        collector.feed(file.read_text(encoding="utf-8"))
    codepoints = set(range(32, 127)) | {ord(char) for char in "".join(collector.texts)}
    # 保留旧字集，避免历史首页文案的字形被这次增量更新移除。
    for file in output.glob("noto-sans-sc-*.ttf"):
        with TTFont(file) as existing:
            codepoints.update(existing.getBestCmap())
    for weight in (400, 500, 600):
        with TTFont(args.source, recalcTimestamp=False) as source:
            options = subset.Options()
            options.recalc_timestamp = False
            options.layout_features = ["*"]
            subsetter = subset.Subsetter(options=options)
            subsetter.populate(unicodes=codepoints)
            subsetter.subset(source)
            font = instantiateVariableFont(source, {"wght": weight}, inplace=True)
            font.recalcTimestamp = False
            target = output / f"noto-sans-sc-{weight}.ttf"
            font.save(target)
            print(f"{target.name}: {len(font.getBestCmap())} glyphs, {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
