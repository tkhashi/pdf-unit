"""線・矩形・曲線抽出(`src/pdf_unit/extract.py:extract_page_lines`相当)のpypdfium2直接実装(PoC)。

pdfplumberの`page.rects`/`page.curves`/`page.lines`は`pdfminer.six`のPDF解析結果を高レベルに
分類したもの。pypdfium2には同等の高レベルAPIが無いため、`page.get_objects()`で取得した
FPDF_PAGEOBJ_PATHオブジェクトを、`FPDFPath_*`の生APIでセグメント単位に分解し、同じ分類
(rect/curve/line)を試みる。

これは効果測定PoCであり、本番の`extract_page_lines`と完全な出力互換を目指すものではない。
座標変換は埋め込み画像抽出(`src/pdf_unit/raster.py`)と同じ`PageToDisplay`を再利用し、
pdfplumberと同じ表示座標系(top原点、回転反映後)に合わせる。
"""

from __future__ import annotations

import ctypes
from typing import Any, TypedDict

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from pdf_unit.raster import PageToDisplay


class LineRecordPoc(TypedDict):
    id: int
    type: str  # "line" | "rect" | "curve"
    d: str
    linewidth: float | None
    color: str | None
    bbox: tuple[float, float, float, float]


def _to_page(point: tuple[float, float], forms: list[pdfium.PdfMatrix]) -> tuple[float, float]:
    for m in reversed(forms):
        point = m.on_point(*point)
    return point


def _fmt(p: tuple[float, float]) -> str:
    return f"{p[0]:.2f},{p[1]:.2f}"


def _segments(obj: pdfium.PdfObject) -> list[tuple[int, tuple[float, float], bool]]:
    """(セグメント種別, 点, close有無)のリストを返す。点はオブジェクト空間の座標(未変換)。"""
    count = pdfium_c.FPDFPath_CountSegments(obj.raw)
    x, y = ctypes.c_float(), ctypes.c_float()
    result = []
    for i in range(count):
        seg = pdfium_c.FPDFPath_GetPathSegment(obj.raw, i)
        seg_type = pdfium_c.FPDFPathSegment_GetType(seg)
        pdfium_c.FPDFPathSegment_GetPoint(seg, x, y)
        closed = bool(pdfium_c.FPDFPathSegment_GetClose(seg))
        result.append((seg_type, (x.value, y.value), closed))
    return result


def _stroke_width(obj: pdfium.PdfObject) -> float | None:
    w = ctypes.c_float()
    if pdfium_c.FPDFPageObj_GetStrokeWidth(obj.raw, w):
        return round(w.value, 3)
    return None


def _stroke_color(obj: pdfium.PdfObject) -> str | None:
    r, g, b, a = (ctypes.c_uint() for _ in range(4))
    if not pdfium_c.FPDFPageObj_GetStrokeColor(obj.raw, r, g, b, a):
        return None
    if a.value == 0:
        return None
    return f"rgb({r.value},{g.value},{b.value})"


def _build_d(
    segs: list[tuple[int, tuple[float, float], bool]], points: list[tuple[float, float]], closed: bool
) -> str:
    """セグメント種別に沿ってSVG path dを組み立てる(m/l/c(3点1組)/close)。"""
    parts: list[str] = []
    i = 0
    while i < len(segs):
        seg_type, _, _ = segs[i]
        if seg_type == pdfium_c.FPDF_SEGMENT_MOVETO:
            parts.append(f"M{_fmt(points[i])}")
            i += 1
        elif seg_type == pdfium_c.FPDF_SEGMENT_BEZIERTO and i + 2 < len(segs):
            parts.append("C" + " ".join(_fmt(points[j]) for j in (i, i + 1, i + 2)))
            i += 3
        else:
            parts.append(f"L{_fmt(points[i])}")
            i += 1
    if closed:
        parts.append("Z")
    return " ".join(parts)


def _classify(points: list[tuple[float, float]], has_bezier: bool, closed: bool) -> str:
    """pdfplumberの分類に寄せる: 直線2点=line、軸並行な閉矩形4点=rect、それ以外=curve。

    `closed`(FPDFPathSegment_GetClose)が立つパスは終点が始点と同座標で戻ってくるため、
    矩形判定の前に重複する終点を取り除く。
    """
    if has_bezier:
        return "curve"
    corners = points[:-1] if closed and len(points) >= 2 and points[0] == points[-1] else points
    if len(corners) == 2 and not closed:
        return "line"
    if len(corners) == 4 and closed:
        xs = sorted({round(p[0], 2) for p in corners})
        ys = sorted({round(p[1], 2) for p in corners})
        if len(xs) == 2 and len(ys) == 2:
            return "rect"
    return "curve"


def _iter_paths(page: pdfium.PdfPage, form=None, forms: list[pdfium.PdfMatrix] | None = None, level: int = 0):
    forms = forms or []
    for obj in page.get_objects(max_depth=0, form=form, level=level):
        if obj.type == pdfium_c.FPDF_PAGEOBJ_PATH:
            yield obj, forms
        elif obj.type == pdfium_c.FPDF_PAGEOBJ_FORM:
            yield from _iter_paths(page, obj, [*forms, obj.get_matrix()], level + 1)


def extract_page_lines_pdfium(pdf_data: bytes, page_no: int) -> list[LineRecordPoc]:
    records: list[LineRecordPoc] = []
    pdf = pdfium.PdfDocument(pdf_data)
    try:
        page = pdf[page_no]
        to_display = PageToDisplay(page)
        for obj, forms in _iter_paths(page):
            obj_matrix = obj.get_matrix()
            segs = _segments(obj)
            if not segs:
                continue
            points_disp = [to_display(_to_page(obj_matrix.on_point(*p), forms)) for _, p, _ in segs]
            has_bezier = any(t == pdfium_c.FPDF_SEGMENT_BEZIERTO for t, _, _ in segs)
            closed = segs[-1][2] or any(c for _, _, c in segs)
            object_type = _classify(points_disp, has_bezier, closed)
            d = _build_d(segs, points_disp, closed)
            xs = [p[0] for p in points_disp]
            ys = [p[1] for p in points_disp]
            records.append(
                {
                    "id": len(records),
                    "type": object_type,
                    "d": d,
                    "linewidth": _stroke_width(obj),
                    "color": _stroke_color(obj),
                    "bbox": (min(xs), min(ys), max(xs), max(ys)),
                }
            )
    finally:
        pdf.close()
    return records
