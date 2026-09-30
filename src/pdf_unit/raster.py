"""PDFに埋め込まれたラスター画像を抽出し、ページ上の配置を返す。

PDFium(pypdfium2)で画像オブジェクトを走査する。UI は画像データを使わず、配置範囲に枠を描く(ADR 0039, 0040)。
"""

from __future__ import annotations

import ctypes
from typing import TypedDict

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from .timing import stage


class ImageRecord(TypedDict):
    type: str  # "image"
    index: int  # ページ内の画像番号
    bbox: tuple[float, float, float, float]  # x0, top, x1, bottom(top原点、pt)
    quad: list[float]  # 四隅 [x, y] * 4(左下・右下・右上・左上の順、top原点)
    placement: str  # "bbox": PDF座標で回転・せん断なし / "affine": 回転・せん断あり
    px_width: int  # 埋め込み画像の元の画素数
    px_height: int
    dpi: float  # ページ上での実効解像度(横方向)
    filters: list[str]


def _to_page(point: tuple[float, float], forms: list[pdfium.PdfMatrix]) -> tuple[float, float]:
    # Form XObject内の座標はフォーム空間なので、内側のフォームから順にページ空間へ変換する
    for m in reversed(forms):
        point = m.on_point(*point)
    return point


# FPDF_PageToDeviceは整数座標を返すので、ページを100倍の解像度に写像して0.01pt精度を得る
_DEVICE_SCALE = 100


class PageToDisplay:
    """PDF座標 → 表示座標(表示範囲=CropBoxとMediaBoxの交わりの左上原点、ページ回転を反映)への写像。
    PdfiumPage の線・文字と同じ座標系(ADR 0038)。"""

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


def extract_images(page: pdfium.PdfPage) -> list[ImageRecord]:
    """ページ内の埋め込み画像の配置情報。

    画像データの取り出し(get_bitmap)は、画素を使わなくても行う。取り出せない画像は飛ばして番号を詰めており、
    取り出しを省くと返す画像と番号が変わるため(ADR 0026)。取り出した bitmap は PDFium が確保したメモリで、
    文書を閉じても解放されないので、ロックの中にいるうちにここで閉じる(ADR 0038)。
    """
    records: list[ImageRecord] = []
    to_display = PageToDisplay(page)
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
                obj.get_bitmap(render=axis_aligned).close()
        except pdfium.PdfiumError:
            continue
        px_w, px_h = obj.get_px_size()
        # 画像の横辺(左下→右下)の長さ。回転していても実寸になる
        width_pt = ((xs[1] - xs[0]) ** 2 + (ys[1] - ys[0]) ** 2) ** 0.5
        records.append(
            {
                "type": "image",
                "index": len(records),
                "bbox": (min(xs), min(ys), max(xs), max(ys)),
                "quad": [round(v, 2) for x, y in zip(xs, ys) for v in (x, y)],
                "placement": "bbox" if axis_aligned else "affine",
                "px_width": px_w,
                "px_height": px_h,
                "dpi": round(px_w / width_pt * 72, 1) if width_pt > 0 else 0.0,
                "filters": list(obj.get_filters()),
            }
        )
    return records
