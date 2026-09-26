"""PDFに埋め込まれたラスター画像を抽出し、ページ上の配置と画像データを返す。

pdfplumberは画像の配置は取れるが画像データのデコード(フィルタ・マスク処理)を
持たないため、PDFium(pypdfium2)で画像オブジェクトを走査・レンダリングする。
"""

from __future__ import annotations

import ctypes
import io
from collections.abc import Container
from dataclasses import dataclass
from typing import TypedDict

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image

from .timing import add_metric, stage


class ImageRecord(TypedDict):
    type: str  # "image"
    index: int  # ページ内の画像番号(画像データ取得APIのキー)
    bbox: tuple[float, float, float, float]  # x0, top, x1, bottom(top原点、pt)
    quad: list[float]  # 四隅 [x, y] * 4(左下・右下・右上・左上の順、top原点)
    placement: str  # "bbox": 画像データをbboxに描く / "affine": 画像データの左上→quad[3]等に合わせて変形
    px_width: int  # 埋め込み画像の元の画素数
    px_height: int
    dpi: float  # ページ上での実効解像度(横方向)
    filters: list[str]


@dataclass(frozen=True)
class PageImages:
    records: list[ImageRecord]
    pngs: dict[int, bytes]  # 画像番号(ImageRecord.index) -> PNG。png_indices で指定した画像だけ


def _to_page(point: tuple[float, float], forms: list[pdfium.PdfMatrix]) -> tuple[float, float]:
    # Form XObject内の座標はフォーム空間なので、内側のフォームから順にページ空間へ変換する
    for m in reversed(forms):
        point = m.on_point(*point)
    return point


# FPDF_PageToDeviceは整数座標を返すので、ページを100倍の解像度に写像して0.01pt精度を得る
_DEVICE_SCALE = 100

# ページの/Rotate(時計回り)に合わせてPDF座標の向きの画像を回すための転置
_ROTATE_TRANSPOSE = {
    90: Image.Transpose.ROTATE_270,
    180: Image.Transpose.ROTATE_180,
    270: Image.Transpose.ROTATE_90,
}


class PageToDisplay:
    """PDF座標 → pdfplumberと同じ表示座標(top原点、ページ回転・MediaBox原点を反映)への写像。"""

    def __init__(self, page: pdfium.PdfPage) -> None:
        self._page = page
        # get_width/heightは回転後(表示上)の寸法
        self._size = (round(page.get_width() * _DEVICE_SCALE), round(page.get_height() * _DEVICE_SCALE))
        self._x, self._y = ctypes.c_int(), ctypes.c_int()

    def __call__(self, point: tuple[float, float]) -> tuple[float, float]:
        pdfium_c.FPDF_PageToDevice(
            self._page.raw, 0, 0, *self._size, 0, point[0], point[1], self._x, self._y
        )
        return self._x.value / _DEVICE_SCALE, self._y.value / _DEVICE_SCALE


def _iter_images(page: pdfium.PdfPage, form=None, forms: list[pdfium.PdfMatrix] | None = None, level: int = 0):
    forms = forms or []
    for obj in page.get_objects(max_depth=0, form=form, level=level):
        if obj.type == pdfium_c.FPDF_PAGEOBJ_IMAGE:
            yield obj, forms
        elif obj.type == pdfium_c.FPDF_PAGEOBJ_FORM:
            yield from _iter_images(page, obj, [*forms, obj.get_matrix()], level + 1)


def extract_page_images(pdf_data: bytes, page_no: int, png_indices: Container[int] | None = None) -> PageImages:
    """ページ内の埋め込み画像の配置情報と、png_indices で指定した画像番号の PNG を返す(None なら全画像)。

    画像データの取り出し(get_bitmap)は、PNG が不要な画像でも行う。取り出せない画像は飛ばして番号を
    詰めるため、取り出しを省くと画像番号が変わりうるから。PNG 化(時間の大半)だけを指定した画像に絞る(ADR 0026)。
    """
    records: list[ImageRecord] = []
    pngs: dict[int, bytes] = {}
    pdf = pdfium.PdfDocument(pdf_data)
    try:
        page = pdf[page_no]
        to_display = PageToDisplay(page)
        rotation = page.get_rotation()
        for obj, forms in _iter_images(page):
            pdf_corners = [_to_page(p, forms) for p in obj.get_quad_points()]
            # 四隅は左下・右下・右上・左上の順。PDF座標で上辺が水平かつ左辺が垂直なら回転・せん断なし
            (x0, _), _, (_, y2), (x3, y3) = pdf_corners
            axis_aligned = abs(y2 - y3) < 1e-3 and abs(x0 - x3) < 1e-3
            corners = [to_display(p) for p in pdf_corners]
            xs = [x for x, _ in corners]
            ys = [y for _, y in corners]
            try:
                with stage("images.decode"):
                    # 回転なし: render=Trueでアルファマスク・反転を適用した見た目を外接矩形に描く。
                    # 回転あり: PDFiumのレンダリングは端が欠けるため、生の画素を返し
                    # UI側で四隅に合わせたアフィン変換で描く(アルファマスクは未適用)。
                    bitmap = obj.get_bitmap(render=axis_aligned)
            except pdfium.PdfiumError:
                continue
            index = len(records)
            if png_indices is None or index in png_indices:
                with stage("images.png"):
                    pil = bitmap.to_pil()
                    if axis_aligned and rotation in _ROTATE_TRANSPOSE:
                        # render=Trueの結果はPDF座標での向きなので、表示時のページ回転に合わせる
                        pil = pil.transpose(_ROTATE_TRANSPOSE[rotation])
                    buf = io.BytesIO()
                    pil.save(buf, format="PNG")
                pngs[index] = buf.getvalue()
                add_metric("images_png_px", pil.width * pil.height)
            px_w, px_h = obj.get_px_size()
            # 画像の横辺(左下→右下)の長さ。回転していても実寸になる
            width_pt = ((xs[1] - xs[0]) ** 2 + (ys[1] - ys[0]) ** 2) ** 0.5
            records.append(
                {
                    "type": "image",
                    "index": index,
                    "bbox": (min(xs), min(ys), max(xs), max(ys)),
                    "quad": [round(v, 2) for x, y in zip(xs, ys) for v in (x, y)],
                    "placement": "bbox" if axis_aligned else "affine",
                    "px_width": px_w,
                    "px_height": px_h,
                    "dpi": round(px_w / width_pt * 72, 1) if width_pt > 0 else 0.0,
                    "filters": list(obj.get_filters()),
                }
            )
    finally:
        pdf.close()
    return PageImages(records, pngs)
