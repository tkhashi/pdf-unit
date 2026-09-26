"""テスト用の1ページの合成PDF(標準ライブラリだけで作る)。

実PDFはリポジトリに置けないため、抽出結果が変わりうる条件(ページ回転・MediaBox の原点・CropBox・複数サブパス・
v/y 演算子・色空間・Form XObject・拡大したテキスト・埋め込み画像)をそれぞれ1ページにする。

    uv run python tests/fixtures.py <出力ディレクトリ>   # 目視や計測スクリプト用に書き出す
"""

from __future__ import annotations

import sys
from pathlib import Path

BASIC = (
    b"1 w 10 10 m 190 190 l S "
    b"2 w 0 0 1 RG 30 120 60 40 re S "
    b"0 1 0 RG 20 20 m 60 20 90 90 150 90 c S "
    b"BT /F1 18 Tf 0 0 0 rg 20 150 Td (Sample Text ABC) Tj ET"
)
_FORM_BODY = b"1 w 10 10 40 30 re S 0 0 m 50 50 l S BT /F1 10 Tf 5 60 Td (InForm) Tj ET"
_SEPARATION = (b"[/Separation /Black /DeviceCMYK << /FunctionType 2 /Domain [0 1] "
               b"/C0 [0 0 0 0] /C1 [0 0 0 1] /N 1 >>]")


def _box(values: tuple[float, ...]) -> bytes:
    return b"[" + b" ".join(f"{v:g}".encode() for v in values) + b"]"


def _stream(dictionary: bytes, body: bytes) -> bytes:
    return b"<< " + dictionary + b" /Length %d >>\nstream\n" % len(body) + body + b"\nendstream"


def build_pdf(content: bytes, *, mediabox=(0, 0, 200, 200), cropbox=None, rotate=0, pages_cropbox=None,
              form: tuple[bytes, tuple[float, ...]] | None = None, image: bool = False,
              colorspace: bytes | None = None) -> bytes:
    """1ページのPDF。form は (Form XObject の内容, /Matrix) で /Fx、image は 2×2 の RGB 画像で /Im0、
    colorspace は /CS0 として参照できる。pages_cropbox は /Pages に置く(ページへ継承される)CropBox。"""
    pages = b"<< /Type /Pages /Kids [3 0 R] /Count 1"
    if pages_cropbox:
        pages += b" /CropBox " + _box(pages_cropbox)
    pages += b" >>"
    page = b"<< /Type /Page /Parent 2 0 R /MediaBox " + _box(mediabox)
    if cropbox:
        page += b" /CropBox " + _box(cropbox)
    if rotate:
        page += b" /Rotate %d" % rotate
    page += b" /Contents 4 0 R /Resources << /Font << /F1 5 0 R >>"
    xobjects = b""
    if form:
        xobjects += b" /Fx 6 0 R"
    if image:
        xobjects += b" /Im0 7 0 R"
    if xobjects:
        page += b" /XObject <<" + xobjects + b" >>"
    if colorspace:
        page += b" /ColorSpace << /CS0 " + colorspace + b" >>"
    page += b" >> >>"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        pages,
        page,
        _stream(b"", content),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        _stream(b"/Type /XObject /Subtype /Form /BBox [-1000 -1000 1000 1000] /Matrix "
                + _box(form[1] if form else (1, 0, 0, 1, 0, 0)) + b" /Resources << /Font << /F1 5 0 R >> >>",
                form[0] if form else b""),
        _stream(b"/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8",
                bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])),
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


FIXTURES: dict[str, dict] = {
    "basic": dict(content=BASIC),
    "rotate90": dict(content=BASIC, mediabox=(0, 0, 300, 200), rotate=90),
    "rotate270": dict(content=BASIC, mediabox=(0, 0, 300, 200), rotate=270),
    "mediabox_offset": dict(content=b"1 0 0 1 50 50 cm " + BASIC, mediabox=(50, 50, 250, 250)),
    "cropbox": dict(content=b"1 0 0 1 50 50 cm " + BASIC, mediabox=(0, 0, 300, 300), cropbox=(50, 50, 250, 250)),
    "cropbox_inherited": dict(content=b"1 0 0 1 50 50 cm " + BASIC, mediabox=(0, 0, 300, 300),
                              pages_cropbox=(50, 50, 250, 250)),
    "cropbox_outside": dict(content=BASIC, cropbox=(-50, -50, 250, 250)),
    "multipath": dict(content=(
        b"1 w 10 10 m 50 10 l 60 60 m 90 60 l S "
        b"20 100 m 40 100 l 40 120 l h 60 100 m 80 100 l 80 130 l 60 130 l h S "
        b"100 100 m 150 100 l 150 150 l 100 150 l 100 100 l S"
    )),
    "vy": dict(content=b"1 w 10 10 m 40 60 90 60 v S 10 100 m 40 150 90 150 y S"),
    "colors": dict(content=(
        b"1 w 0.3 0.6 0.9 RG 10 30 m 190 30 l S "
        b"0.5 G 10 20 m 190 20 l S "
        b"/CS0 CS 1 SCN 10 10 m 190 10 l S "
        b"BT /F1 12 Tf /CS0 cs 1 scn 20 150 Td (Sep) Tj ET"
    ), colorspace=_SEPARATION),
    "linewidth": dict(content=(
        b"q 2 0 0 2 0 0 cm 1.5 w 10 10 m 50 10 l S Q "  # cm の後に w
        b"q 1.5 w 2 0 0 2 0 0 cm 10 20 m 50 20 l S Q "  # w の後に cm(描画時の太さは 3)
        b"q 0 w 10 150 m 190 150 l S Q "
        b"10 160 m 190 160 l S"  # w を指定しない(既定値 1)
    )),
    "form_q": dict(content=b"q 2 0 0 2 10 10 cm /Fx Do Q 1 w 5 5 m 20 5 l S",
                   form=(_FORM_BODY, (0.5, 0, 0, 0.5, 20, 20))),
    "text_matrix": dict(content=(
        b"BT /F1 1 Tf 18 0 0 18 20 150 Tm (Scaled) Tj ET "
        b"BT /F1 12 Tf 0 1 -1 0 100 30 Tm (Vert) Tj ET "
        b"BT /F1 10 Tf 150 Tz 20 100 Td (Wide) Tj 100 Tz ET"
    )),
    "image": dict(content=b"q 50 0 0 50 20 20 cm /Im0 Do Q", image=True),
}


def _pdf_name(raw: bytes) -> bytes:
    return b"/" + b"".join(bytes([c]) if 0x21 <= c <= 0x7E and c not in b"#/()<>[]{}%" else b"#%02X" % c for c in raw)


def build_cmap_pdf(encoding: bytes, text: bytes, fontname: bytes) -> bytes:
    """埋め込まない日本語 CID フォント(Adobe-Japan1)で、CMap(/Encoding)に従って符号化した本文を1行書く(ADR 0021)。"""
    content = b"BT /F1 20 Tf 20 100 Td <" + text.hex().encode() + b"> Tj ET"
    name = _pdf_name(fontname)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        _stream(b"", content),
        b"<< /Type /Font /Subtype /Type0 /BaseFont " + name + b" /Encoding /" + encoding + b" /DescendantFonts [6 0 R] >>",
        b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont " + name
        + b" /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R /DW 1000 >>",
        b"<< /Type /FontDescriptor /FontName " + name + b" /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 "
        b"/Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def fixture(name: str) -> bytes:
    return build_pdf(**FIXTURES[name])


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for name in FIXTURES:
        (out / f"{name}.pdf").write_bytes(fixture(name))
        print(out / f"{name}.pdf")
