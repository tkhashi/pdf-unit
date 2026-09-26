"""ページ画像化(`src/pdf_unit/server.py:_render_page`相当)のpypdfium2直接実装(PoC)。

`pdfplumber.Page.to_image()` は内部で `pypdfium2.PdfDocument(...)` を新たに開いて
`page.render()` を呼んでいる(pdfplumber.display.get_page_image)。つまり `_render_page` は
`pdfplumber.open()` で開いたPDFを、画像化のたびにPDFium側でもう一度開き直している。
この関数はPDFを一度(pypdfium2で)だけ開いて描画し、その二重オープンを避けられるかを確かめる。

出力は既存の `_render_page` と同じPIL.Imageの"original"相当(解像度に応じた等倍描画、RGB)。
応答サイズが上限を超えた場合の解像度縮小・PNG化・base64化は比較対象外なのでここでは行わない。
"""

from __future__ import annotations

import pypdfium2 as pdfium
from PIL import Image


def render_page_pdfium(pdf_data: bytes, page_no: int, resolution: int) -> Image.Image:
    """`page.to_image(resolution=resolution).original` に相当する画像をpypdfium2直接で描画する。

    `pdfplumber.display.get_page_image` は `antialias=False`(既定)のとき
    `no_smoothtext=no_smoothpath=no_smoothimage=True` で描画する。同じ条件を指定しないと
    アンチエイリアスの有無だけで画素差分が大きくなり比較にならないため、ここでも揃える。
    """
    pdf = pdfium.PdfDocument(pdf_data)
    try:
        page = pdf[page_no]
        bitmap = page.render(
            scale=resolution / 72,
            no_smoothtext=True,
            no_smoothpath=True,
            no_smoothimage=True,
            prefer_bgrx=True,
        )
        return bitmap.to_pil().convert("RGB")
    finally:
        pdf.close()
