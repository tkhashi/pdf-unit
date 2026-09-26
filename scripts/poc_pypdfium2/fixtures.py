"""座標系・分類・色の差異を確かめる合成PDF(ADR 0037)。標準ライブラリだけで書き出す。

    uv run python scripts/poc_pypdfium2/fixtures.py <出力ディレクトリ>

実PDFはリポジトリに置けないため、移行で差が出うる条件(ページ回転・MediaBox の原点・CropBox・
複数サブパス・v/y 演算子・色空間・Form XObject・拡大したテキスト)をそれぞれ1ページのPDFにする。
"""

from __future__ import annotations

import sys
from pathlib import Path

_FONT = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
_BASIC = (
    b"1 w 10 10 m 190 190 l S "
    b"2 w 0 0 1 RG 30 120 60 40 re S "
    b"0 1 0 RG 20 20 m 60 20 90 90 150 90 c S "
    b"BT /F1 18 Tf 0 0 0 rg 20 150 Td (Sample Text ABC) Tj ET"
)


def _box(values: tuple[float, ...]) -> bytes:
    return b"[" + b" ".join(f"{v:g}".encode() for v in values) + b"]"


def write_pdf(path: Path, content: bytes, *, mediabox=(0, 0, 200, 200), cropbox=None, rotate=0,
              form: tuple[bytes, tuple[float, ...]] | None = None) -> None:
    """1ページのPDFを書き出す。form は (Form XObject の内容, /Matrix) で、/Fx として参照できる。"""
    page = b"<< /Type /Page /Parent 2 0 R /MediaBox " + _box(mediabox)
    if cropbox:
        page += b" /CropBox " + _box(cropbox)
    if rotate:
        page += b" /Rotate %d" % rotate
    page += b" /Contents 4 0 R /Resources << /Font << /F1 5 0 R >>"
    if form:
        page += b" /XObject << /Fx 6 0 R >>"
    page += b" >> >>"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        page,
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        _FONT,
    ]
    if form:
        body, matrix = form
        objs.append(
            b"<< /Type /XObject /Subtype /Form /BBox [-1000 -1000 1000 1000] /Matrix " + _box(matrix)
            + b" /Resources << /Font << /F1 5 0 R >> >> /Length %d >>\nstream\n" % len(body) + body + b"\nendstream"
        )
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    path.write_bytes(bytes(out))


FIXTURES = {
    "basic": dict(content=_BASIC),
    "rotate90": dict(content=_BASIC, rotate=90),
    "rotate270": dict(content=_BASIC, rotate=270),
    "mediabox_offset": dict(content=b"1 0 0 1 50 50 cm " + _BASIC, mediabox=(50, 50, 250, 250)),
    "cropbox": dict(content=b"1 0 0 1 50 50 cm " + _BASIC, mediabox=(0, 0, 300, 300), cropbox=(50, 50, 250, 250)),
    "multipath": dict(content=(
        b"1 w 10 10 m 50 10 l 60 60 m 90 60 l S "
        b"20 100 m 40 100 l 40 120 l h 60 100 m 80 100 l 80 130 l 60 130 l h S "
        b"100 100 m 150 100 l 150 150 l 100 150 l 100 100 l S"
    )),
    "vy": dict(content=b"1 w 10 10 m 40 60 90 60 v S 10 100 m 40 150 90 150 y S"),
    "colors": dict(content=(
        b"0.1 0.2 0.3 0.4 K 10 10 m 190 10 l S "
        b"0.5 G 10 20 m 190 20 l S "
        b"0.3 0.6 0.9 RG 10 30 m 190 30 l S "
        b"0.137 G 10 40 m 190 40 l S "
        b"BT /F1 12 Tf 0.2 0.3 0.4 0.1 k 20 150 Td (Cmyk) Tj 0.5 g 60 0 Td (Gray) Tj ET"
    )),
    "form": dict(
        content=b"2 0 0 2 10 10 cm /Fx Do 1 w 5 5 m 20 5 l S",
        form=(b"1 w 10 10 40 30 re S 0 0 m 50 50 l S BT /F1 10 Tf 5 60 Td (InForm) Tj ET", (0.5, 0, 0, 0.5, 20, 20)),
    ),
    "form_q": dict(
        content=b"q 2 0 0 2 10 10 cm /Fx Do Q 1 w 5 5 m 20 5 l S",
        form=(b"1 w 10 10 40 30 re S 0 0 m 50 50 l S BT /F1 10 Tf 5 60 Td (InForm) Tj ET", (0.5, 0, 0, 0.5, 20, 20)),
    ),
    "text_matrix": dict(content=(
        b"BT /F1 1 Tf 18 0 0 18 20 150 Tm (Scaled) Tj ET "
        b"BT /F1 12 Tf 0 1 -1 0 100 30 Tm (Vert) Tj ET "
        b"BT /F1 10 Tf 150 Tz 2 Tc 20 100 Td (Wide Spaced) Tj ET "
        b"BT /F1 10 Tf 20 60 Td 3 Ts (Rise) Tj ET"
    )),
    "cm_linewidth": dict(content=b"2 0 0 2 0 0 cm 1.5 w 10 10 m 50 10 l S 0.3 0 0 0.3 0 0 cm 0 w 20 200 m 200 200 l S"),
}


def write_all(out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, spec in FIXTURES.items():
        path = out_dir / f"{name}.pdf"
        write_pdf(path, **spec)
        paths.append(path)
    return paths


if __name__ == "__main__":
    for p in write_all(Path(sys.argv[1])):
        print(p)
