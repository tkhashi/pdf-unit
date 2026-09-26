"""pdfplumber の Page と同じ形のデータを pypdfium2 だけで作る互換クラス(技術調査、ADR 0037)。

`extract_page_lines`・`calibrate_linewidth`・`extract_page_texts` は pdfplumber の Page から
`width`・`height`・`rects`・`curves`・`lines`・`chars`・`to_image()` だけを読む。これらを PDFium から
pdfminer/pdfplumber と同じ規則で組み立てれば、既存の関数を改造せずに移行できるかを確かめられる。

再現している規則(pdfminer.six 20260107 / pdfplumber 0.11.10):
- 座標: MediaBox と /Rotate から作るページ行列(PDFPageInterpreter.process_page)を掛け、
  point2coord / top・bottom の式で上原点に直す(CropBox は使わない)
- 図形: サブパスごとに分け、`ml`/`mlh` は line、軸に平行な閉じた4辺は rect、それ以外は curve
  (PDFLayoutAnalyzer.paint_path)。bbox は端点だけから取る
- 線幅: `w` の値に CTM の拡大率を掛ける(do_w)。PDFium は描画時の CTM しか持たないため、
  `w` の後に `cm` があるPDFでは一致しない
- 文字: 外接矩形は (0, descent)〜(adv, descent + フォントサイズ) を文字行列で写したもの(LTChar)

PDFium の公開 API では再現できないもの(出力が変わる):
- 色: PDFium は RGB に変換済みの整数しか返さない。CMYK や、`round()` の偶数丸めにかかる値は変わる
- descent: pdfminer はフォント記述子/AFM、PDFium はフォント実体のメトリクスを使う
- cid 文字: pdfminer の `(cid:N)` に当たる情報(ToUnicode が無いこと・CID の値)が取れない
- 座標の精度: PDFium の API は float32。`decimal=True` で「float32 として同じ値になる最短の10進数」に戻して
  PDF に書かれた数値の復元を試みる
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
    """pdfminer.utils.mult_matrix と同じ式(m1 を先に適用)。"""
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
    """pdfminer.utils.apply_matrix_rect と同じ(4隅を写した外接矩形)。"""
    x0, y0, x1, y1 = rect
    pts = [_apply(m, p) for p in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


class _PageImage:
    def __init__(self, original: Image.Image) -> None:
        self.original = original


class PdfiumPage:
    """pdfplumber.page.Page の代わりに既存の抽出関数へ渡す読み取り専用のページ。"""

    def __init__(self, pdf: pdfium.PdfDocument, page_no: int, *, decimal: bool = True, cid_heuristic: bool = True) -> None:
        self._pdf = pdf
        self._page = pdf[page_no]
        self._num = _decimal if decimal else (lambda v: v)
        self._cid_heuristic = cid_heuristic
        self.rotation = self._page.get_rotation()
        raw = tuple(self._num(v) for v in self._page.get_mediabox())
        x0, y0, x1, y1 = raw
        # pdfminer のページ行列(PDFPageInterpreter.process_page)
        self._page_ctm: Matrix = {
            90: (0, -1, 1, 0, -y0, x1),
            180: (-1, 0, 0, -1, x1, y1),
            270: (0, 1, -1, 0, y1, -x0),
        }.get(self.rotation, (1, 0, 0, 1, -x0, -y0))
        # pdfplumber の mediabox(_normalize_box → _invert_box)
        nx0, nx1 = sorted((x0, x1))
        ny0, ny1 = sorted((y0, y1))
        box = (ny0, nx0, ny1, nx1) if self.rotation in (90, 270) else (nx0, ny0, nx1, ny1)
        mb_height = box[3] - box[1]
        self.mediabox = (box[0], mb_height - box[3], box[2], mb_height - box[1])
        self.width = self.mediabox[2] - self.mediabox[0]
        self.height = self.mediabox[3] - self.mediabox[1]
        self._objects: dict[str, list[dict[str, Any]]] | None = None
        self._chars: list[dict[str, Any]] | None = None
        self.stats: dict[str, int] = {}

    # ---- 座標 ----

    def _matrix(self, m: pdfium.PdfMatrix) -> Matrix:
        n = self._num
        return (n(m.a), n(m.b), n(m.c), n(m.d), n(m.e), n(m.f))

    def _coord(self, p: tuple[float, float]) -> tuple[float, float]:
        """pdfplumber Page.point2coord。"""
        return (self.mediabox[0] + p[0], self.mediabox[1] + self.height - p[1])

    def _bbox_attrs(self, x0: float, y0: float, x1: float, y1: float) -> dict[str, float]:
        """pdfplumber Page.process_object の x0/x1/top/bottom。"""
        mb_x0, mb_top = self.mediabox[:2]
        attrs = {"x0": x0, "y0": y0, "x1": x1, "y1": y1,
                 "top": (self.height - y1) + mb_top, "bottom": (self.height - y0) + mb_top}
        attrs["doctop"] = attrs["top"]
        if mb_x0 != 0:
            attrs["x0"] += mb_x0
            attrs["x1"] += mb_x0
        return attrs

    # ---- 図形 ----

    def _iter_paths(self, form=None, forms: tuple[Matrix, ...] = (), level: int = 0):
        for obj in self._page.get_objects(max_depth=0, form=form, level=level):
            if obj.type == pdfium_c.FPDF_PAGEOBJ_PATH:
                yield obj, forms
            elif obj.type == pdfium_c.FPDF_PAGEOBJ_FORM:
                yield from self._iter_paths(obj, (*forms, self._matrix(obj.get_matrix())), level + 1)

    def _path_ops(self, obj) -> list[list[tuple]]:
        """PDFium のセグメントを pdfminer の path(サブパスごと、未変換の座標)に直す。"""
        x, y = ctypes.c_float(), ctypes.c_float()
        subpaths: list[list[tuple]] = []
        bezier: list[tuple[float, float]] = []
        n = self._num
        for i in range(pdfium_c.FPDFPath_CountSegments(obj.raw)):
            seg = pdfium_c.FPDFPath_GetPathSegment(obj.raw, i)
            kind = pdfium_c.FPDFPathSegment_GetType(seg)
            pdfium_c.FPDFPathSegment_GetPoint(seg, x, y)
            p = (n(x.value), n(y.value))
            if kind == pdfium_c.FPDF_SEGMENT_MOVETO or not subpaths:
                subpaths.append([("m", p)])
            elif kind == pdfium_c.FPDF_SEGMENT_BEZIERTO:
                bezier.append(p)
                if len(bezier) == 3:
                    subpaths[-1].append(("c", *bezier))
                    bezier = []
            else:
                subpaths[-1].append(("l", p))
            if pdfium_c.FPDFPathSegment_GetClose(seg):
                path = subpaths[-1]
                # PDFium は閉じるときに始点へ戻る点を足す(`re` も `h` も)。pdfminer の表現(... h)に戻す
                if len(path) > 2 and path[-1][0] == "l" and path[-1][1] == path[0][1]:
                    path.pop()
                path.append(("h",))
        return subpaths

    def _stroke(self, obj, ctm: Matrix) -> tuple[float, tuple[float, ...]]:
        w = ctypes.c_float()
        pdfium_c.FPDFPageObj_GetStrokeWidth(obj.raw, w)
        # pdfminer は `w` の値に CTM(ページ行列込み)の拡大率を掛ける
        linewidth = self._num(w.value) * (ctm[0] ** 2 + ctm[1] ** 2) ** 0.5
        r, g, b, a = (ctypes.c_uint() for _ in range(4))
        pdfium_c.FPDFPageObj_GetStrokeColor(obj.raw, r, g, b, a)
        return linewidth, (r.value / 255, g.value / 255, b.value / 255)

    def _paint(self, path: list[tuple], ctm: Matrix, linewidth: float, color, out) -> None:
        """pdfminer PDFLayoutAnalyzer.paint_path(1サブパス分)。"""
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
                # LTRect は bbox (pts[0], pts[2]) の4隅を pts にする
                (rx0, ry0), (rx1, ry1) = pts[0], pts[2]
                pts = [(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)]
            else:
                kind = "curve"
        else:
            kind = "curve"
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        obj = {
            "object_type": kind,
            **self._bbox_attrs(min(xs), min(ys), max(xs), max(ys)),
            "linewidth": linewidth,
            "stroking_color": color,
            "pts": [self._coord(p) for p in pts],
            "path": [(op[0], *(self._coord(p) for p in op[1:])) for op in transformed],
        }
        out[kind].append(obj)

    def _load_objects(self) -> dict[str, list[dict[str, Any]]]:
        if self._objects is None:
            out: dict[str, list[dict[str, Any]]] = {"rect": [], "curve": [], "line": []}
            for obj, forms in self._iter_paths():
                ctm = self._matrix(obj.get_matrix())
                for fm in reversed(forms):
                    ctm = _mult(ctm, fm)
                ctm = _mult(ctm, self._page_ctm)
                linewidth, color = self._stroke(obj, ctm)
                for path in self._path_ops(obj):
                    if path and path[0][0] == "m":
                        self._paint(path, ctm, linewidth, color, out)
            self._objects = out
        return self._objects

    @property
    def rects(self) -> list[dict[str, Any]]:
        return self._load_objects()["rect"]

    @property
    def curves(self) -> list[dict[str, Any]]:
        return self._load_objects()["curve"]

    @property
    def lines(self) -> list[dict[str, Any]]:
        return self._load_objects()["line"]

    # ---- 文字 ----

    @property
    def chars(self) -> list[dict[str, Any]]:
        if self._chars is None:
            self._chars = self._load_chars()
        return self._chars

    def _load_chars(self) -> list[dict[str, Any]]:
        tp = self._page.get_textpage()
        chars: list[dict[str, Any]] = []
        m = pdfium_c.FS_MATRIX()
        ox, oy = ctypes.c_double(), ctypes.c_double()
        rect = pdfium_c.FS_RECTF()
        desc, asc = ctypes.c_float(), ctypes.c_float()
        r, g, b, a = (ctypes.c_uint() for _ in range(4))
        buf = ctypes.create_string_buffer(512)
        flags = ctypes.c_int()
        fonts: dict[int, tuple[float, float]] = {}
        names: dict[bytes, Any] = {}
        n = self._num
        for i in range(tp.count_chars()):
            if pdfium_c.FPDFText_IsGenerated(tp.raw, i) == 1:
                continue
            code = pdfium_c.FPDFText_GetUnicode(tp.raw, i)
            if code == 0:
                continue
            pdfium_c.FPDFText_GetMatrix(tp.raw, i, m)
            pdfium_c.FPDFText_GetCharOrigin(tp.raw, i, ox, oy)
            fontsize = n(pdfium_c.FPDFText_GetFontSize(tp.raw, i))
            textobj = pdfium_c.FPDFText_GetTextObject(tp.raw, i)
            font = pdfium_c.FPDFTextObj_GetFont(textobj)
            key = (ctypes.cast(font, ctypes.c_void_p).value, fontsize)
            if key not in fonts:
                pdfium_c.FPDFFont_GetDescent(font, ctypes.c_float(fontsize), desc)
                pdfium_c.FPDFFont_GetAscent(font, ctypes.c_float(fontsize), asc)
                fonts[key] = (desc.value, asc.value)
            descent, ascent = fonts[key]
            # 文字行列(ページ行列込み)。PDFium の行列の平行移動はテキストオブジェクトの原点なので、文字の原点に置き換える
            ex, fy = _apply(self._page_ctm, (n(ox.value), n(oy.value)))
            mat = _mult((n(m.a), n(m.b), n(m.c), n(m.d), 0, 0), self._page_ctm)
            mat = (mat[0], mat[1], mat[2], mat[3], ex, fy)
            # 送り幅: ゆるい外接矩形(PDFium の ascent/descent × 送り幅を行列で写したもの)から逆算する
            pdfium_c.FPDFText_GetLooseCharBox(tp.raw, i, rect)
            box_w, box_h, height = rect.right - rect.left, rect.top - rect.bottom, ascent - descent
            if abs(m.a) >= abs(m.b) and abs(m.a) > 1e-9:
                adv = (box_w - abs(m.c) * height) / abs(m.a)
            elif abs(m.b) > 1e-9:
                adv = (box_h - abs(m.d) * height) / abs(m.b)
            else:
                adv = 0.0
            if fontsize > 0:
                # 外接矩形は float32 の絶対座標なので、送り幅に 1e-5 程度の誤差が乗る(回転した文字では size に
                # なるため、extract_words の size による分割が位置ごとに揺れる)。フォントの幅(1/1000 em)を
                # 0.1 単位に戻し、pdfminer と同じ式(char_width × フォントサイズ)で作り直す
                adv = round(adv / fontsize * 1000, 1) * 0.001 * fontsize
            x0, y0, x1, y1 = _apply_rect(mat, (0, descent, adv, descent + fontsize))
            a_, b_, c_, d_ = mat[:4]
            pdfium_c.FPDFText_GetFillColor(tp.raw, i, r, g, b, a)
            nlen = pdfium_c.FPDFText_GetFontInfo(tp.raw, i, buf, len(buf), flags)
            raw_name = buf.raw[: max(nlen - 1, 0)]
            if raw_name not in names:
                # pdfminer の literal_name と同じ: UTF-8 で読めれば str、読めなければ str(bytes)
                try:
                    names[raw_name] = raw_name.decode("utf-8")
                except UnicodeDecodeError:
                    names[raw_name] = str(raw_name)
            chars.append({
                "object_type": "char",
                "text": chr(code),
                **self._bbox_attrs(x0, y0, x1, y1),
                "matrix": mat,
                "adv": adv,
                "size": y1 - y0,
                "upright": a_ * d_ > 0 and b_ * c_ <= 0,
                "fontname": names[raw_name],
                "non_stroking_color": (r.value / 255, g.value / 255, b.value / 255),
            })
        tp.close()
        if self._cid_heuristic:
            self._mark_unmapped(chars)
        return chars

    def _mark_unmapped(self, chars: list[dict[str, Any]]) -> None:
        """ToUnicode の無いフォントの文字を `(cid:N)` にして、既存の cid 補完(_restore_cid_chars)に「□」を付けさせる。

        pdfminer は ToUnicode で引けない文字を `(cid:N)` にするが、PDFium の公開 API にはその区別も CID の値も無い
        (引けない文字は文字コードをそのまま Unicode とみなした値になる)。本番の判定の後半(フォント内の文字が
        「よく使われる文字」に _PLAUSIBLE_RATIO 以上収まらなければ読めないフォントとみなす)を、フォント内の
        全文字に当てはめる近似。ToUnicode があっても珍しい文字ばかりのフォントは誤って「□」になりうる。
        """
        from pdf_unit.extract import _PLAUSIBLE_RATIO, _is_common

        by_font: dict[Any, list[int]] = {}
        for i, c in enumerate(chars):
            by_font.setdefault(c["fontname"], []).append(i)
        marked = 0
        for indices in by_font.values():
            codes = [ord(chars[i]["text"]) for i in indices]
            if sum(_is_common(code) for code in codes) < _PLAUSIBLE_RATIO * len(codes):
                for i, code in zip(indices, codes):
                    chars[i] = {**chars[i], "text": f"(cid:{code})"}
                    marked += 1
        self.stats["unmapped_marked"] = marked

    # ---- 描画 ----

    def to_image(self, resolution: float) -> _PageImage:
        """pdfplumber.display.get_page_image と同じ設定で描画する(ロックは呼び出し側で取る)。"""
        bitmap = self._page.render(
            scale=resolution / 72, no_smoothtext=True, no_smoothpath=True, no_smoothimage=True, prefer_bgrx=True,
        )
        return _PageImage(bitmap.to_pil().convert("RGB"))
