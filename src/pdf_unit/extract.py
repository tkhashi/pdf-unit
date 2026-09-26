"""PDFページから線(line/rect/curve)と文字(単語単位)を抽出し、UI描画用の最小レコードにする。

参考: ClassifierArchDrawingByJev の extract.py / render.py。
入力は PdfiumPage(pdfium_page.py。pdfplumber の Page と同じ形のデータ)。座標は表示範囲の左上原点(pt)で、
そのままSVGのviewBox座標として使える。
"""

from __future__ import annotations

import codecs
import math
import unicodedata
from typing import Any, TypedDict

from ._vendor.pdfplumber.utils import extract_words
from .pdfium_page import PdfiumPage
from .timing import metric, stage


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
    """色(0〜1の成分。グレースケール/RGB/CMYK)をCSS色文字列に変換する。PdfiumPage の色は PDFium が色空間を
    変換済みの RGB なので、実際に通るのは RGB の分岐。"""
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
    """`path`(m/l/c/h)をSVG path dに変換する。ベジェを保持できる(`v`/`y` は PdfiumPage が `c` に直している)。"""
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


def extract_page_lines(page: PdfiumPage) -> list[LineRecord]:
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

    文字の`matrix`はフォントサイズを含まない(テキスト行列×CTMのみ)。
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


# 復元できなかった文字の表示。本物の「□」と区別するため、文字には unreadable フラグも付ける
UNREADABLE_CHAR = "□"
# 読めるフォントとみなす割合: フォント内の文字がこの割合以上「よく使われる文字」なら読める
_PLAUSIBLE_RATIO = 0.9
# よく使われる文字の範囲(ASCII・ラテン・ギリシャ・キリル・記号・かな・CJK統合漢字・ハングル・全角)
_COMMON_RANGES = (
    (0x0020, 0x024F), (0x0370, 0x04FF), (0x2000, 0x27BF), (0x3000, 0x30FF),
    (0x3200, 0x33FF), (0x4E00, 0x9FFF), (0xAC00, 0xD7AF), (0xF900, 0xFAFF), (0xFF00, 0xFFEF),
)


def _is_common(code: int) -> bool:
    return any(lo <= code <= hi for lo, hi in _COMMON_RANGES)


def _mark_unreadable(chars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """ToUnicode の無いフォントの文字を「□」にし、unreadable フラグを付ける(ADR 0038)。

    PDFium は Unicode に引けない文字を、文字コードをそのまま Unicode とみなした値で返す(区別する API も CID の値も
    無い)。そうしたフォントの文字は、よく使われる文字の範囲からほとんど外れる。フォント単位で、よく使われる文字が
    _PLAUSIBLE_RATIO に満たなければ読めないフォントとみなし、その全文字を「□」にする。ToUnicode があっても
    珍しい文字ばかりのフォントは、読めないフォントとみなされうる。
    """
    by_font: dict[Any, list[int]] = {}
    for i, c in enumerate(chars):
        by_font.setdefault(c["fontname"], []).append(i)
    fixed = list(chars)
    marked = 0
    for indices in by_font.values():
        if sum(_is_common(ord(chars[i]["text"])) for i in indices) < _PLAUSIBLE_RATIO * len(indices):
            for i in indices:
                fixed[i] = {**chars[i], "text": UNREADABLE_CHAR, "unreadable": True}
            marked += len(indices)
    metric("unreadable_chars", marked)
    return fixed


# BOMで文字コードが明示されている場合(長いBOMから順に照合する)
_BOMS = ((codecs.BOM_UTF8, "utf-8"), (codecs.BOM_UTF16_BE, "utf-16-be"), (codecs.BOM_UTF16_LE, "utf-16-le"))


def _strip_bom(raw: bytes) -> tuple[bytes, str | None]:
    for bom, encoding in _BOMS:
        if raw.startswith(bom):
            return raw[len(bom):], encoding
    return raw, None


def _utf16_without_bom(raws: list[bytes]) -> str | None:
    """BOMの無いUTF-16は、ASCII部分の上位(下位)バイトの0x00が偶数(奇数)位置に並ぶことで判定する。"""
    if not raws or any(len(r) % 2 or b"\x00" not in r for r in raws):
        return None
    even = sum(r[0::2].count(0) for r in raws)
    odd = sum(r[1::2].count(0) for r in raws)
    return "utf-16-be" if even > odd else "utf-16-le" if odd > even else None


def _decode_all(raws: list[bytes], encoding: str) -> list[str] | None:
    """全名前を読めた場合だけ結果を返す。制御文字・私用領域の文字が出る場合も読めなかったとみなす
    (cp932 は 0x80 や 0xFD〜0xFF をエラーにせず、これらの文字に割り当ててしまうため)。
    """
    try:
        decoded = [r.decode(encoding) for r in raws]
    except UnicodeDecodeError:
        return None
    if any(unicodedata.category(ch) in ("Cc", "Co", "Cs") for name in decoded for ch in name):
        return None
    return decoded


def _pdf_name_notation(raw: bytes) -> str:
    """文字コードを決められない名前は推測せず、PDFの名前表記(`#82`形式)で表示する。"""
    return "".join(chr(b) if 0x21 <= b <= 0x7E and b != 0x23 else f"#{b:02X}" for b in raw)


def decode_font_names(names: list[Any]) -> dict[Any, str]:
    """1ページ分のフォント名を表示用の文字列にする(ADR 0021)。

    1ページの中で文字コードは1種類と仮定し、BOMの無い非ASCIIの名前はページ内でまとめて判定する。
      1. ASCIIだけの名前はそのまま
      2. BOM(UTF-8 / UTF-16BE / UTF-16LE)があればそれに従う(名前ごと)
      3. 全名前が UTF-8 で読めれば UTF-8
      4. 0x00 を含む偶数長の名前ばかりなら BOM無し UTF-16
      5. 全名前が Shift_JIS(cp932)で読めれば cp932
      6. どれにも当てはまらなければ推測せず PDF の名前表記(`#82`形式)
    名前は PdfiumPage が渡す、UTF-8で読めたstrか、読めなかったbytes。
    UTF-8で読めた名前も判定に含める(Shift_JISのバイト列が偶然UTF-8として読める場合があるため)。
    """
    result: dict[Any, str] = {}
    undecided: dict[Any, bytes] = {}
    for name in dict.fromkeys(n for n in names if n is not None):
        raw = name
        if isinstance(raw, str):
            if raw.isascii():
                result[name] = raw
                continue
            raw = raw.encode("utf-8")
        body, encoding = _strip_bom(raw)
        if encoding is not None:
            try:
                result[name] = body.decode(encoding)
                continue
            except UnicodeDecodeError:
                pass
        undecided[name] = raw
    if undecided:
        raws = list(undecided.values())
        decoded = None
        for encoding in ("utf-8", _utf16_without_bom(raws), "cp932"):
            if encoding and (decoded := _decode_all(raws, encoding)) is not None:
                break
        for i, (name, raw) in enumerate(undecided.items()):
            result[name] = decoded[i] if decoded is not None else _pdf_name_notation(raw)
    return result


def extract_page_texts(page: PdfiumPage) -> list[TextRecord]:
    """文字を単語単位にまとめる。フォント・サイズ・色が変わる箇所では別単語に分ける。"""
    with stage("texts.unreadable"):
        chars = _mark_unreadable(page.chars)
    with stage("texts.words"):
        words = extract_words(
            chars, extra_attrs=["fontname", "size", "non_stroking_color"], return_chars=True
        )
    with stage("texts.fonts"):
        font_names = decode_font_names([w.get("fontname") for w in words])
    records: list[TextRecord] = []
    with stage("texts.records"):
        for w in words:
            if not w["text"].strip():
                continue
            glyphs = [g for c in w["chars"] if (g := _glyph(c, page.height)) is not None]
            records.append(
                {
                    "type": "text",
                    "text": w["text"],
                    "bbox": (w["x0"], w["top"], w["x1"], w["bottom"]),
                    "fontname": font_names.get(w.get("fontname")),
                    "size": round(w["size"], 2) if w.get("size") else None,
                    "color": _color_to_css(w.get("non_stroking_color")),
                    "chars": glyphs,
                    "unreadable": sum(1 for c in w["chars"] if c.get("unreadable")),
                }
            )
    return records
