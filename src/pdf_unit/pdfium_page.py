"""PDFium(pypdfium2)のページから、抽出処理が読む図形・文字・画像を組み立てる(ADR 0038)。

抽出処理(extract.py・calibration.py)は pdfplumber の Page と同じ形のデータ(`rects`・`curves`・`lines`・`chars`
の dict と `width`・`height`・`to_image()`)を読む。以前は pdfplumber(pdfminer.six)で作っていたものを、同じ規則で
PDFium から作る。

座標: ページの表示範囲(CropBox と MediaBox の交わり。PDFium の描画・埋め込み画像の配置と同じ)の左上を原点とし、
/Rotate を反映した pt。行列の掛け方と上原点への直し方は pdfminer/pdfplumber と同じ式にする。

数値: PDFium の API は float32 を返すため、「float32 として同じ値になる最短の10進数」に戻してから計算する。
PDF に書かれた数値(有効数字7桁まで)がそのまま復元され、行列の計算は float64 で行える。

PDFium はスレッドセーフではないため、PdfiumPage はロック(server._pdfium_lock)の中で作り、to_image() もロックの
中で呼ぶ。図形と文字はコンストラクタで組み立て終えるので、ロックの外で PDFium を呼ぶことはない。
"""

from __future__ import annotations

import ctypes
import math
import struct
from functools import lru_cache
from typing import Any

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image

from .timing import metric, stage

Matrix = tuple[float, float, float, float, float, float]

_F32 = struct.Struct("f")


@lru_cache(maxsize=1 << 16)
def _decimal(v: float) -> float:
    """float32 の値を、float32 として同じ値になる最短の10進表記の float64 に戻す。"""
    if v == 0 or not math.isfinite(v):
        return v + 0.0
    for digits in range(1, 10):
        d = float(f"{v:.{digits}g}")
        if _F32.unpack(_F32.pack(d))[0] == v:
            return d
    return v


def _mult(m1: Matrix, m0: Matrix) -> Matrix:
    """m1 を先に適用する行列の積(pdfminer.utils.mult_matrix と同じ式)。"""
    a1, b1, c1, d1, e1, f1 = m1
    a0, b0, c0, d0, e0, f0 = m0
    return (
        a0 * a1 + c0 * b1,
        b0 * a1 + d0 * b1,
        a0 * c1 + c0 * d1,
        b0 * c1 + d0 * d1,
        a0 * e1 + c0 * f1 + e0,
        b0 * e1 + d0 * f1 + f0,
    )


def _apply(m: Matrix, p: tuple[float, float]) -> tuple[float, float]:
    a, b, c, d, e, f = m
    x, y = p
    return a * x + c * y + e, b * x + d * y + f


def _apply_rect(m: Matrix, rect: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """4隅を写した外接矩形(pdfminer.utils.apply_matrix_rect と同じ)。"""
    x0, y0, x1, y1 = rect
    pts = [_apply(m, p) for p in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def render_page(page: pdfium.PdfPage, resolution: float) -> Image.Image:
    """ページ画像(RGB)。以前の pdfplumber の page.to_image() と同じ描画設定(バイト単位で同じ結果になる)。"""
    bitmap = page.render(
        scale=resolution / 72, no_smoothtext=True, no_smoothpath=True, no_smoothimage=True, prefer_bgrx=True,
    )
    return bitmap.to_pil().convert("RGB")


class _PageImage:
    def __init__(self, original: Image.Image) -> None:
        self.original = original


class PdfiumPage:
    """抽出処理に渡すページ。図形(rects・curves・lines)と文字(chars)をコンストラクタで組み立てる。"""

    def __init__(self, page: pdfium.PdfPage) -> None:
        self._page = page
        self.rotation = page.get_rotation()
        x0, y0, x1, y1 = (_decimal(v) for v in page.get_bbox())
        # 表示範囲の左下を原点にし、/Rotate を反映するページ行列(pdfminer の PDFPageInterpreter.process_page と
        # 同じ形。pdfminer は MediaBox を使うが、ここでは描画と同じ表示範囲を使う)
        self._page_ctm: Matrix = {
            90: (0, -1, 1, 0, -y0, x1),
            180: (-1, 0, 0, -1, x1, y1),
            270: (0, 1, -1, 0, y1, -x0),
        }.get(self.rotation, (1, 0, 0, 1, -x0, -y0))
        w, h = abs(x1 - x0), abs(y1 - y0)
        self.width, self.height = (h, w) if self.rotation in (90, 270) else (w, h)
        objects: dict[str, list[dict[str, Any]]] = {"rect": [], "curve": [], "line": []}
        with stage("parse.paths"):
            for obj, forms in self._iter_paths():
                self._add_path(obj, forms, objects)
        self.rects, self.curves, self.lines = objects["rect"], objects["curve"], objects["line"]
        with stage("parse.chars"):
            self.chars = self._load_chars()
        metric("chars", len(self.chars))

    # ---- 座標 ----

    def _coord(self, p: tuple[float, float]) -> tuple[float, float]:
        """ページ行列を掛けた座標(左下原点)を上原点に直す(pdfplumber の point2coord)。"""
        return (p[0], self.height - p[1])

    def _bbox_attrs(self, x0: float, y0: float, x1: float, y1: float) -> dict[str, float]:
        return {"x0": x0, "y0": y0, "x1": x1, "y1": y1,
                "top": self.height - y1, "bottom": self.height - y0, "doctop": self.height - y1}

    @staticmethod
    def _matrix(m: pdfium.PdfMatrix) -> Matrix:
        return (_decimal(m.a), _decimal(m.b), _decimal(m.c), _decimal(m.d), _decimal(m.e), _decimal(m.f))

    # ---- 図形 ----

    def _iter_paths(self, form=None, forms: tuple[Matrix, ...] = (), level: int = 0):
        for obj in self._page.get_objects(max_depth=0, form=form, level=level):
            if obj.type == pdfium_c.FPDF_PAGEOBJ_PATH:
                yield obj, forms
            elif obj.type == pdfium_c.FPDF_PAGEOBJ_FORM:
                # Form XObject 内の図形の行列はフォーム空間なので、外側のフォームの行列も掛ける
                yield from self._iter_paths(obj, (*forms, self._matrix(obj.get_matrix())), level + 1)

    @staticmethod
    def _subpaths(obj) -> list[list[tuple]]:
        """PDFium のセグメントを、サブパスごとの pdfminer 形式の path(m/l/c/h、未変換の座標)に直す。"""
        x, y = ctypes.c_float(), ctypes.c_float()
        subpaths: list[list[tuple]] = []
        bezier: list[tuple[float, float]] = []
        for i in range(pdfium_c.FPDFPath_CountSegments(obj.raw)):
            seg = pdfium_c.FPDFPath_GetPathSegment(obj.raw, i)
            kind = pdfium_c.FPDFPathSegment_GetType(seg)
            pdfium_c.FPDFPathSegment_GetPoint(seg, x, y)
            p = (_decimal(x.value), _decimal(y.value))
            if kind == pdfium_c.FPDF_SEGMENT_MOVETO or not subpaths:
                subpaths.append([("m", p)])
            elif kind == pdfium_c.FPDF_SEGMENT_BEZIERTO:
                # PDFium は `v`/`y` も制御点を補った3点のベジェにする
                bezier.append(p)
                if len(bezier) == 3:
                    subpaths[-1].append(("c", *bezier))
                    bezier = []
            else:
                subpaths[-1].append(("l", p))
            if pdfium_c.FPDFPathSegment_GetClose(seg):
                path = subpaths[-1]
                # PDFium は閉じるとき(`h` も `re` も)始点へ戻る点を足すので、`... h` の形に戻す
                if len(path) > 2 and path[-1][0] == "l" and path[-1][1] == path[0][1]:
                    path.pop()
                path.append(("h",))
        return subpaths

    def _add_path(self, obj, forms: tuple[Matrix, ...], out: dict[str, list[dict[str, Any]]]) -> None:
        ctm = self._matrix(obj.get_matrix())
        for fm in reversed(forms):
            ctm = _mult(ctm, fm)
        ctm = _mult(ctm, self._page_ctm)
        w = ctypes.c_float()
        pdfium_c.FPDFPageObj_GetStrokeWidth(obj.raw, w)
        # 描画時の CTM の拡大率を掛けた、実際に描かれる太さ
        linewidth = _decimal(w.value) * (ctm[0] ** 2 + ctm[1] ** 2) ** 0.5
        r, g, b, a = (ctypes.c_uint() for _ in range(4))
        pdfium_c.FPDFPageObj_GetStrokeColor(obj.raw, r, g, b, a)
        color = (r.value / 255, g.value / 255, b.value / 255)
        for path in self._subpaths(obj):
            if path[0][0] == "m":
                self._paint(path, ctm, linewidth, color, out)

    def _paint(self, path: list[tuple], ctm: Matrix, linewidth: float, color, out) -> None:
        """1サブパスを line/rect/curve に分ける(pdfminer の PDFLayoutAnalyzer.paint_path と同じ規則)。"""
        shape = "".join(op[0] for op in path)
        raw_pts = [op[-1] if op[0] != "h" else path[0][-1] for op in path]
        pts = [_apply(ctm, p) for p in raw_pts]
        transformed = [(op[0], *(_apply(ctm, p) for p in op[1:])) for op in path]
        if len(shape) > 3 and shape[-2:] == "lh" and pts[-2] == pts[0]:
            shape = shape[:-2] + "h"
            pts.pop()
        if shape in {"mlh", "ml"}:
            kind, pts = "line", pts[:2]
        elif shape in {"mlllh", "mllll"}:
            (x0, y0), (x1, y1), (x2, y2), (x3, y3), _ = pts
            square = (x0 == x1 and y1 == y2 and x2 == x3 and y3 == y0) or (
                y0 == y1 and x1 == x2 and y2 == y3 and x3 == x0)
            if pts[0] == pts[4] and square:
                kind = "rect"
                (rx0, ry0), (rx1, ry1) = pts[0], pts[2]
                pts = [(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)]
            else:
                kind = "curve"
        else:
            kind = "curve"
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        out[kind].append({
            "object_type": kind,
            **self._bbox_attrs(min(xs), min(ys), max(xs), max(ys)),
            "linewidth": linewidth,
            "stroking_color": color,
            "pts": [self._coord(p) for p in pts],
            "path": [(op[0], *(self._coord(p) for p in op[1:])) for op in transformed],
        })

    # ---- 文字 ----

    def _load_chars(self) -> list[dict[str, Any]]:
        tp = self._page.get_textpage()
        try:
            return self._read_chars(tp)
        finally:
            tp.close()

    def _read_chars(self, tp: pdfium.PdfTextPage) -> list[dict[str, Any]]:
        chars: list[dict[str, Any]] = []
        m = pdfium_c.FS_MATRIX()
        ox, oy = ctypes.c_double(), ctypes.c_double()
        rect = pdfium_c.FS_RECTF()
        desc, asc = ctypes.c_float(), ctypes.c_float()
        r, g, b, a = (ctypes.c_uint() for _ in range(4))
        buf = ctypes.create_string_buffer(512)
        flags = ctypes.c_int()
        fonts: dict[tuple, tuple[float, float]] = {}
        names: dict[bytes, str | bytes] = {}
        for i in range(tp.count_chars()):
            if pdfium_c.FPDFText_IsGenerated(tp.raw, i) == 1:
                continue  # PDFium が補った空白・改行(PDF 上に実体が無い)
            code = pdfium_c.FPDFText_GetUnicode(tp.raw, i)
            if code == 0:
                continue
            pdfium_c.FPDFText_GetMatrix(tp.raw, i, m)
            pdfium_c.FPDFText_GetCharOrigin(tp.raw, i, ox, oy)
            fontsize = _decimal(pdfium_c.FPDFText_GetFontSize(tp.raw, i))
            font = pdfium_c.FPDFTextObj_GetFont(pdfium_c.FPDFText_GetTextObject(tp.raw, i))
            key = (ctypes.cast(font, ctypes.c_void_p).value, fontsize)
            if key not in fonts:
                pdfium_c.FPDFFont_GetDescent(font, ctypes.c_float(fontsize), desc)
                pdfium_c.FPDFFont_GetAscent(font, ctypes.c_float(fontsize), asc)
                fonts[key] = (desc.value, asc.value)
            descent, ascent = fonts[key]
            # 文字行列: PDFium の行列(テキスト空間→ページ、フォントサイズを含まない)にページ行列を掛け、
            # 平行移動を文字の原点にする(PDFium の行列の平行移動はテキストオブジェクトの原点)
            ex, fy = _apply(self._page_ctm, (_decimal(ox.value), _decimal(oy.value)))
            mat = _mult((_decimal(m.a), _decimal(m.b), _decimal(m.c), _decimal(m.d), 0, 0), self._page_ctm)
            mat = (*mat[:4], ex, fy)
            adv = self._advance(tp, i, rect, m, fontsize, ascent - descent)
            x0, y0, x1, y1 = _apply_rect(mat, (0, descent, adv, descent + fontsize))
            pdfium_c.FPDFText_GetFillColor(tp.raw, i, r, g, b, a)
            n = pdfium_c.FPDFText_GetFontInfo(tp.raw, i, buf, len(buf), flags)
            raw_name = buf.raw[: max(n - 1, 0)]
            if raw_name not in names:
                # UTF-8 で読めない名前はバイト列のまま渡し、decode_font_names で文字コードを判定する
                try:
                    names[raw_name] = raw_name.decode("utf-8")
                except UnicodeDecodeError:
                    names[raw_name] = raw_name
            chars.append({
                "object_type": "char",
                "text": chr(code),
                **self._bbox_attrs(x0, y0, x1, y1),
                "matrix": mat,
                "adv": adv,
                "size": y1 - y0,
                "upright": mat[0] * mat[3] > 0 and mat[1] * mat[2] <= 0,
                "fontname": names[raw_name],
                "non_stroking_color": (r.value / 255, g.value / 255, b.value / 255),
            })
        return chars

    @staticmethod
    def _advance(tp, i: int, rect, m, fontsize: float, height: float) -> float:
        """送り幅(テキスト空間)。PDFium のゆるい外接矩形(送り幅 × ascent〜descent を行列で写したもの)から逆算する。

        外接矩形は float32 の絶対座標なので 1e-5 程度の誤差が乗る。回転した文字では送り幅が extract_words の size
        (完全一致で単語を分ける)になるため、フォントの幅(1/1000 em。PDF の /Widths の値)を 0.1 単位に戻し、
        幅 × 0.001 × フォントサイズで作り直す。
        """
        pdfium_c.FPDFText_GetLooseCharBox(tp.raw, i, rect)
        box_w, box_h = rect.right - rect.left, rect.top - rect.bottom
        if abs(m.a) >= abs(m.b) and abs(m.a) > 1e-9:
            adv = (box_w - abs(m.c) * height) / abs(m.a)
        elif abs(m.b) > 1e-9:
            adv = (box_h - abs(m.d) * height) / abs(m.b)
        else:
            return 0.0
        if fontsize > 0:
            adv = round(adv / fontsize * 1000, 1) * 0.001 * fontsize
        return adv

    # ---- 描画 ----

    def to_image(self, resolution: float) -> _PageImage:
        return _PageImage(render_page(self._page, resolution))
