"""テキスト抽出(`src/pdf_unit/extract.py:extract_page_texts`相当)のpypdfium2直接実装(PoC)。

pdfplumberの`extract_words`はpdfminer.sixの文字単位の解析結果を単語にまとめる。pypdfium2には
単語分割APIは無いが、`FPDFText_CountRects`/`FPDFText_GetRect`がページ全体を「連続したテキスト
領域」の矩形群にまとめてくれる(改行・段組みで区切られる)ため、これを単語相当の単位として使う。
実際の分割粒度はpdfplumberの単語単位と一致しない(行単位・段落単位に近くなる場合がある)。

本番の`extract_page_texts`が行うcid補完(`_restore_cid_chars`)・フォント名デコード
(`decode_font_names`)・文字ごとの回転/伸縮(`CharGlyph`)は、効果測定PoCの対象外として省く。
座標は埋め込み画像抽出と同じ`PageToDisplay`でpdfplumberと同じ表示座標系に変換する。
"""

from __future__ import annotations

import ctypes
from typing import TypedDict

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from pdf_unit.raster import PageToDisplay


class TextRecordPoc(TypedDict):
    type: str  # "text"
    text: str
    bbox: tuple[float, float, float, float]
    size: float | None
    color: str | None


def _fill_color(textpage: pdfium.PdfTextPage, char_index: int) -> str | None:
    r, g, b, a = (ctypes.c_uint() for _ in range(4))
    if not pdfium_c.FPDFText_GetFillColor(textpage.raw, char_index, r, g, b, a) or a.value == 0:
        return None
    return f"rgb({r.value},{g.value},{b.value})"


def extract_page_texts_pdfium(pdf_data: bytes, page_no: int) -> list[TextRecordPoc]:
    records: list[TextRecordPoc] = []
    pdf = pdfium.PdfDocument(pdf_data)
    try:
        page = pdf[page_no]
        to_display = PageToDisplay(page)
        textpage = page.get_textpage()
        n_rects = textpage.count_rects()
        for i in range(n_rects):
            left, bottom, right, top = textpage.get_rect(i)
            text = textpage.get_text_bounded(left, bottom, right, top)
            if not text.strip():
                continue
            corners = [to_display((left, bottom)), to_display((right, top))]
            xs = [x for x, _ in corners]
            ys = [y for _, y in corners]
            char_index = textpage.get_index((left + right) / 2, (bottom + top) / 2, 1.0, 1.0)
            size = round(pdfium_c.FPDFText_GetFontSize(textpage.raw, char_index), 2) if char_index is not None else None
            color = _fill_color(textpage, char_index) if char_index is not None else None
            records.append(
                {
                    "type": "text",
                    "text": text,
                    "bbox": (min(xs), min(ys), max(xs), max(ys)),
                    "size": size,
                    "color": color,
                }
            )
    finally:
        pdf.close()
    return records
