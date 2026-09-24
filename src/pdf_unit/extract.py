"""PDFページから線(line/rect/curve)と文字(単語単位)を抽出し、UI描画用の最小レコードにする。

参考: ClassifierArchDrawingByJev の extract.py / render.py。
座標はpdfplumberのtop原点(pt)で、そのままSVGのviewBox座標として使える。
"""

from __future__ import annotations

import ctypes
import math
import re
from pathlib import Path
from typing import Any, TypedDict

import pdfplumber
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from pdfplumber.utils import extract_words

from .raster import PageToDisplay


class LineRecord(TypedDict):
    id: int
    type: str  # "line" | "rect" | "curve"
    d: str  # SVG path data(ハイライト描画用)
    polylines: list[list[float]]  # ヒット判定用の折れ線群 [x0, y0, x1, y1, ...](ベジェは分割済み)
    linewidth: float | None
    color: str | None
    bbox: tuple[float, float, float, float]  # x0, top, x1, bottom


def _clamp255(v: float) -> int:
    return max(0, min(255, round(v * 255)))


def _color_to_css(color: Any) -> str | None:
    """pdfplumberの色表現(グレースケール/RGB/CMYK)をCSS色文字列に変換する。"""
    if color is None:
        return None
    if isinstance(color, (int, float)):
        g = _clamp255(color)
        return f"rgb({g},{g},{g})"
    if isinstance(color, (tuple, list)):
        if len(color) == 1:
            g = _clamp255(color[0])
            return f"rgb({g},{g},{g})"
        if len(color) == 3:
            r, g, b = color
            return f"rgb({_clamp255(r)},{_clamp255(g)},{_clamp255(b)})"
        if len(color) == 4:
            c, m, y, k = color
            return (
                f"rgb({_clamp255(1 - min(1, c + k))},"
                f"{_clamp255(1 - min(1, m + k))},"
                f"{_clamp255(1 - min(1, y + k))})"
            )
    return None


def _fmt(p: tuple[float, float]) -> str:
    return f"{p[0]:.2f},{p[1]:.2f}"


def _path_from_commands(path: list[Any]) -> str | None:
    """pdfplumberの`path`(m/l/c/h)をSVG path dに変換する。ベジェを保持できる。"""
    parts: list[str] = []
    for cmd in path:
        op, pts = cmd[0], cmd[1:]
        if op == "m":
            parts.append(f"M{_fmt(pts[0])}")
        elif op == "l":
            parts.append(f"L{_fmt(pts[0])}")
        elif op == "c":
            parts.append("C" + " ".join(_fmt(p) for p in pts))
        elif op == "h":
            parts.append("Z")
    return " ".join(parts) if len(parts) >= 2 else None


_BEZIER_STEPS = 8


def _cubic(p0, p1, p2, p3, t: float) -> tuple[float, float]:
    u = 1 - t
    return (
        u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
        u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
    )


def _flatten_commands(path: list[Any]) -> list[list[tuple[float, float]]]:
    """`path`(m/l/c/h)をサブパスごとの折れ線に変換する。"""
    polys: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    for cmd in path:
        op, pts = cmd[0], cmd[1:]
        if op == "m":
            if len(cur) >= 2:
                polys.append(cur)
            cur = [pts[0]]
        elif op == "l" and cur:
            cur.append(pts[0])
        elif op == "c" and cur:
            p0 = cur[-1]
            cur.extend(_cubic(p0, *pts, i / _BEZIER_STEPS) for i in range(1, _BEZIER_STEPS + 1))
        elif op == "h" and cur:
            cur.append(cur[0])
    if len(cur) >= 2:
        polys.append(cur)
    return polys


def _to_polylines(obj: dict[str, Any], object_type: str) -> list[list[float]]:
    if object_type == "rect":
        x0, top, x1, bottom = obj["x0"], obj["top"], obj["x1"], obj["bottom"]
        polys = [[(x0, top), (x1, top), (x1, bottom), (x0, bottom), (x0, top)]]
    elif object_type == "curve" and obj.get("path"):
        polys = _flatten_commands(obj["path"])
    else:
        polys = [list(obj.get("pts") or [])]
    return [[round(v, 2) for pt in poly for v in pt] for poly in polys if len(poly) >= 2]


def _path_from_points(pts: list[tuple[float, float]], closed: bool) -> str | None:
    if len(pts) < 2:
        return None
    d = f"M{_fmt(pts[0])} " + " ".join(f"L{_fmt(p)}" for p in pts[1:])
    return d + " Z" if closed else d


def _to_d(obj: dict[str, Any], object_type: str) -> str | None:
    if object_type == "rect":
        x0, top, x1, bottom = obj["x0"], obj["top"], obj["x1"], obj["bottom"]
        return _path_from_points([(x0, top), (x1, top), (x1, bottom), (x0, bottom)], True)
    if object_type == "curve" and obj.get("path"):
        d = _path_from_commands(obj["path"])
        if d:
            return d
    return _path_from_points(obj.get("pts") or [], False)


def extract_page_lines(page: pdfplumber.page.Page) -> list[LineRecord]:
    """rect/curveを先、lineを後に並べる(SVGで後ろの要素が前面=細かい直線を優先ホバー)。"""
    records: list[LineRecord] = []
    sources = (("rect", page.rects), ("curve", page.curves), ("line", page.lines))
    for object_type, objs in sources:
        for obj in objs:
            d = _to_d(obj, object_type)
            if d is None:
                continue
            records.append(
                {
                    "id": len(records),
                    "type": object_type,
                    "d": d,
                    "polylines": _to_polylines(obj, object_type),
                    "linewidth": obj.get("linewidth"),
                    "color": _color_to_css(obj.get("stroking_color")),
                    "bbox": (obj["x0"], obj["top"], obj["x1"], obj["bottom"]),
                }
            )
    return records


class CharGlyph(TypedDict):
    text: str
    x: float  # ベースライン原点(top原点座標)
    y: float
    size: float  # 文字の高さ(pt)
    rotation: float  # 度(時計回り)
    sx: float  # 横方向の伸縮率(長体・平体。1で等倍)


class TextRecord(TypedDict):
    type: str  # "text"
    text: str
    bbox: tuple[float, float, float, float]
    fontname: str | None
    size: float | None
    color: str | None
    chars: list[CharGlyph]
    unreadable: int  # 復元できず「□」で表示している文字の数


def _font_size(char: dict[str, Any]) -> float | None:
    """フォントサイズ(Tf)を文字の外接矩形・送り幅・行列から逆算する。

    pdfminerの`matrix`はフォントサイズを含まない(テキスト行列×CTMのみ)。
    Tf=1で行列側に拡大を持つPDFでは hypot(a,b) が文字サイズになるが、
    Tf=12・行列=単位行列のようなPDFでは1になってしまうため、
    文字空間での矩形(幅=adv, 高さ=フォントサイズ)を行列で写した外接矩形
      幅 = |a|·adv + |c|·F,  高さ = |b|·adv + |d|·F
    からフォントサイズFを解く。
    """
    a, b, c, d = char["matrix"][:4]
    adv = char.get("adv") or 0.0
    width, height = char["x1"] - char["x0"], char["bottom"] - char["top"]
    if abs(d) >= abs(c) and abs(d) > 1e-9:
        size = (height - abs(b) * adv) / abs(d)
    elif abs(c) > 1e-9:
        size = (width - abs(a) * adv) / abs(c)
    else:
        return None
    return size if size > 0 and math.isfinite(size) else None


def _glyph(char: dict[str, Any], page_height: float) -> CharGlyph | None:
    """charの`matrix`から描画位置・回転を、フォントサイズと合わせて文字の大きさを導出する。"""
    matrix = char.get("matrix")
    if not matrix:
        return None
    a, b, c, d, e, f = matrix
    x_scale, y_scale = math.hypot(a, b), math.hypot(c, d)
    if x_scale <= 0 or y_scale <= 0:
        return None
    font_size = _font_size(char) or (char.get("size") or 0) / y_scale
    size = font_size * y_scale
    if size <= 0:
        return None
    return {
        "text": char["text"],
        "x": round(e, 2),
        "y": round(page_height - f, 2),
        "size": round(size, 3),
        "rotation": round(-math.degrees(math.atan2(b, a)), 2),
        "sx": round(x_scale / y_scale, 3),
    }


_CID_RE = re.compile(r"\(cid:(\d+)\)")
_ORIGIN_DECIMALS = 1
# 復元できなかった文字の表示。本物の「□」と区別するため、文字には unreadable フラグも付ける
UNREADABLE_CHAR = "□"
# CID を Unicode とみなしてよいかの判定: フォント内の文字がこの割合以上「よく使われる文字」なら採用
_PLAUSIBLE_RATIO = 0.9
# よく使われる文字の範囲(ASCII・ラテン・ギリシャ・キリル・記号・かな・CJK統合漢字・ハングル・全角)
_COMMON_RANGES = (
    (0x0020, 0x024F), (0x0370, 0x04FF), (0x2000, 0x27BF), (0x3000, 0x30FF),
    (0x3200, 0x33FF), (0x4E00, 0x9FFF), (0xAC00, 0xD7AF), (0xF900, 0xFAFF), (0xFF00, 0xFFEF),
)


def _is_common(code: int) -> bool:
    return any(lo <= code <= hi for lo, hi in _COMMON_RANGES)


def _origin_key(x: float, y: float) -> tuple[float, float]:
    return (round(x, _ORIGIN_DECIMALS), round(y, _ORIGIN_DECIMALS))


def _pdfium_chars_by_origin(pdf_path: Path, page_no: int) -> dict[tuple[float, float], str]:
    """PDFiumが解釈した各文字のUnicodeを、文字原点の表示座標(pdfplumberと同じ左上原点・回転反映後)で引けるようにする。

    PDFiumの文字原点は回転前のPDF座標なので、/Rotate のあるページでは pdfplumber と一致しない。
    埋め込み画像と同じ PageToDisplay で表示座標へ変換してから登録する。
    """
    result: dict[tuple[float, float], str] = {}
    pdf = pdfium.PdfDocument(pdf_path)
    try:
        page = pdf[page_no]
        to_display = PageToDisplay(page)
        textpage = page.get_textpage()
        x, y = ctypes.c_double(), ctypes.c_double()
        for i in range(textpage.count_chars()):
            if pdfium_c.FPDFText_IsGenerated(textpage.raw, i) == 1:
                continue  # PDFiumが補った空白・改行(PDF上に実体が無い)
            code = pdfium_c.FPDFText_GetUnicode(textpage.raw, i)
            if code in (0, 0xFFFE, 0xFFFF) or not pdfium_c.FPDFText_GetCharOrigin(textpage.raw, i, x, y):
                continue
            result.setdefault(_origin_key(*to_display((x.value, y.value))), chr(code))
    finally:
        pdf.close()
    return result


def _lookup(table: dict[tuple[float, float], str], x: float, y: float) -> str | None:
    step = 10**-_ORIGIN_DECIMALS
    for dx in (0, -step, step):
        for dy in (0, -step, step):
            if (u := table.get(_origin_key(x + dx, y + dy))) is not None:
                return u
    return None


def _restore_cid_chars(
    chars: list[dict[str, Any]], pdf_path: Path, page_no: int, page_height: float
) -> list[dict[str, Any]]:
    """pdfminerが`(cid:N)`としか出せなかった文字(ToUnicode CMapの無いフォント)を補完する。

    1. PDFiumの文字解釈を文字原点で突き合わせ、PDFiumが chr(CID) 以外の文字を返したものはそれを採用する
       (PDFiumがフォント内部のcmap等から実際に対応を見つけた場合)
    2. PDFiumが chr(CID) を返した文字や突き合わせられない文字は根拠が無い(PDFium自身もCIDをそのまま
       Unicodeとみなしているだけ)。フォント単位で、chr(CID) の大半がよく使われる文字に収まる場合だけ
       CID=Unicode のフォントとみなして chr(CID) を使う
    3. それ以外は復元できない文字として「□」にし、unreadable フラグを付ける
    """
    cids = [(i, int(m.group(1))) for i, c in enumerate(chars) if (m := _CID_RE.fullmatch(c["text"]))]
    if not cids:
        return chars
    table = _pdfium_chars_by_origin(pdf_path, page_no)
    fixed = list(chars)
    pending: dict[str, list[tuple[int, int]]] = {}  # フォント名 -> PDFiumで決まらなかった (index, cid)
    for i, cid in cids:
        c = chars[i]
        matrix = c.get("matrix")
        # pdfplumberの matrix(e, f) は回転反映後の下原点座標なので、上原点へ直して突き合わせる
        u = _lookup(table, matrix[4], page_height - matrix[5]) if matrix else None
        if u is not None and u != chr(cid):
            fixed[i] = {**c, "text": u}
        else:
            pending.setdefault(c["fontname"], []).append((i, cid))
    for font_chars in pending.values():
        codes = [cid for _, cid in font_chars]
        plausible = sum(_is_common(cid) for cid in codes) >= _PLAUSIBLE_RATIO * len(codes)
        for i, cid in font_chars:
            if plausible and _is_common(cid):
                fixed[i] = {**chars[i], "text": chr(cid)}
            else:
                fixed[i] = {**chars[i], "text": UNREADABLE_CHAR, "unreadable": True}
    return fixed


def extract_page_texts(page: pdfplumber.page.Page, pdf_path: Path, page_no: int) -> list[TextRecord]:
    """文字を単語単位にまとめる。フォント・サイズ・色が変わる箇所では別単語に分ける。"""
    chars = _restore_cid_chars(page.chars, pdf_path, page_no, page.height)
    words = extract_words(
        chars, extra_attrs=["fontname", "size", "non_stroking_color"], return_chars=True
    )
    records: list[TextRecord] = []
    for w in words:
        if not w["text"].strip():
            continue
        glyphs = [g for c in w["chars"] if (g := _glyph(c, page.height)) is not None]
        records.append(
            {
                "type": "text",
                "text": w["text"],
                "bbox": (w["x0"], w["top"], w["x1"], w["bottom"]),
                "fontname": w.get("fontname"),
                "size": round(w["size"], 2) if w.get("size") else None,
                "color": _color_to_css(w.get("non_stroking_color")),
                "chars": glyphs,
                "unreadable": sum(1 for c in w["chars"] if c.get("unreadable")),
            }
        )
    return records
