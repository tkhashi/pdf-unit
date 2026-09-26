"""API の抽出結果とエラー応答(ADR 0038)。合成PDFは tests/fixtures.py。"""

from __future__ import annotations

import base64
import codecs
import io

import pytest
from fastapi.testclient import TestClient
from fixtures import BASIC, build_cmap_pdf, build_pdf, fixture
from PIL import Image

from pdf_unit.extract import UNREADABLE_CHAR, _mark_unreadable
from pdf_unit.server import app

client = TestClient(app)


def post(path: str, pdf: bytes, **params) -> dict:
    r = client.post(path, content=pdf, params=params, headers={"content-type": "application/pdf"})
    assert r.status_code == 200, r.text
    return r.json()


def lines_of(name: str) -> dict:
    return post("/api/page/lines", fixture(name))


def by_type(body: dict, kind: str) -> list[dict]:
    return [ln for ln in body["lines"] if ln["type"] == kind]


# ---- 座標(表示範囲の左上原点、回転を反映) ----

@pytest.mark.parametrize("name", ["basic", "mediabox_offset", "cropbox", "cropbox_inherited", "cropbox_outside"])
def test_coordinates_are_relative_to_visible_area(name):
    body = lines_of(name)
    assert body["page"] == {"width": 200, "height": 200}
    assert [ln["bbox"] for ln in by_type(body, "rect")] == [[30, 40, 90, 80]]
    assert by_type(body, "line")[0]["bbox"] == [10, 10, 190, 190]
    assert by_type(body, "curve")[0]["d"] == "M20.00,180.00 C60.00,180.00 90.00,110.00 150.00,110.00"
    assert [w["text"] for w in body["texts"]] == ["Sample", "Text", "ABC"]
    assert body["texts"][0]["chars"][0] | {} == {"text": "S", "x": 20.0, "y": 50.0, "size": 18.0, "rotation": -0.0, "sx": 1.0}


@pytest.mark.parametrize(("name", "rect"), [("rotate90", [120, 30, 160, 90]), ("rotate270", [40, 210, 80, 270])])
def test_rotated_page(name, rect):
    body = lines_of(name)
    assert body["page"] == {"width": 200, "height": 300}
    assert by_type(body, "rect")[0]["bbox"] == rect


@pytest.mark.parametrize("name", ["basic", "rotate90", "rotate270", "mediabox_offset", "cropbox", "cropbox_inherited"])
def test_lines_align_with_page_image(name):
    """線の座標と原本画像の描画位置が一致する(CropBox や原点のずれたページを含む)。"""
    pdf = fixture(name)
    rect = by_type(post("/api/page/lines", pdf), "rect")[0]["bbox"]
    body = post("/api/page/image", pdf, resolution=72)
    image = Image.open(io.BytesIO(base64.b64decode(body["png_base64"]))).convert("RGB")
    px = image.load()
    blue = [(x, y) for x in range(image.width) for y in range(image.height)
            if px[x, y][2] > 200 and px[x, y][0] < 80 and px[x, y][1] < 80]
    found = [min(x for x, _ in blue), min(y for _, y in blue), max(x for x, _ in blue) + 1, max(y for _, y in blue) + 1]
    # 線幅 2pt の矩形なので、描画は path の外側に 1pt はみ出す
    assert all(abs(a - b) <= 1.5 for a, b in zip(found, rect)), (found, rect)


# ---- 図形 ----

def test_subpaths_are_split_and_classified():
    body = lines_of("multipath")
    assert [ln["type"] for ln in body["lines"]] == ["rect", "rect", "curve", "line", "line"]


def test_v_and_y_curves_are_expanded():
    curves = by_type(lines_of("vy"), "curve")
    assert [c["d"].count("C") for c in curves] == [1, 1]
    assert all(len(c["polylines"][0]) == 18 for c in curves)  # 始点 + ベジェの分割8点


def test_linewidth_is_drawn_width():
    widths = [ln["linewidth"] for ln in lines_of("linewidth")["lines"]]
    # cm の後に w / w の後に cm / 0 w / w の指定なし(既定値 1)
    assert widths == [3.0, 3.0, 0, 1.0]


def test_colors():
    body = lines_of("colors")
    colors = [ln["color"] for ln in body["lines"]]
    assert colors[:2] == ["rgb(77,153,230)", "rgb(128,128,128)"]
    # Separation(濃度 1 の墨)は黒に近い色になる(以前は濃度の値をグレーとみなし白になっていた)
    for color in (colors[2], body["texts"][0]["color"]):
        assert all(int(v) < 64 for v in color[4:-1].split(","))


def test_form_xobject():
    body = lines_of("form_q")
    assert [ln["bbox"] for ln in body["lines"]] == [[60, 110, 100, 140], [50, 100, 100, 150], [5, 195, 20, 195]]
    assert body["texts"][0]["text"] == "InForm"


def test_horizontal_scaling_is_reflected():
    wide = next(w for w in lines_of("text_matrix")["texts"] if w["text"] == "Wide")
    assert wide["chars"][0]["sx"] == 1.5


# ---- 文字 ----

def test_unreadable_fonts_are_marked():
    def char(text, font):
        return {"text": text, "fontname": font}

    chars = [char("ᮾ", "A"), char("஦", "A"), char("x", "A"), char("図", "B"), char("面", "B")]
    marked = _mark_unreadable(chars)
    assert [c["text"] for c in marked] == [UNREADABLE_CHAR] * 3 + ["図", "面"]
    assert [c.get("unreadable", False) for c in marked] == [True] * 3 + [False] * 2


@pytest.mark.parametrize(("encoding", "codec"), [
    (b"90ms-RKSJ-H", "cp932"), (b"90pv-RKSJ-H", "cp932"), (b"EUC-H", "euc_jp"),
    (b"UniJIS-UCS2-H", "utf-16-be"), (b"UniJIS-UTF16-H", "utf-16-be"),
])
def test_cmap_encoded_text(encoding, codec):
    words = post("/api/page/lines", build_cmap_pdf(encoding, "設計図ABC".encode(codec), b"MS-Gothic"))["texts"]
    assert [(w["text"], w["unreadable"]) for w in words] == [("設計図ABC", 0)]


def test_utf8_cmap_text_is_unreadable():
    """PDFium は UTF-8 の CMap に対応していない(既知の制約)。誤った文字ではなく「□」として示す。"""
    words = post("/api/page/lines", build_cmap_pdf(b"UniJIS-UTF8-H", "設計図ABC".encode(), b"MS-Gothic"))["texts"]
    assert [(w["text"], w["unreadable"]) for w in words] == [(UNREADABLE_CHAR * 6, 6)]


@pytest.mark.parametrize("fontname", [
    "ＭＳゴシック".encode("cp932"),
    codecs.BOM_UTF16_BE + "ＭＳゴシック".encode("utf-16-be"),
    "ＭＳゴシック".encode(),
    codecs.BOM_UTF8 + "ＭＳゴシック".encode(),
])
def test_font_name_encodings(fontname):
    words = post("/api/page/lines", build_cmap_pdf(b"90ms-RKSJ-H", "設計図".encode("cp932"), fontname))["texts"]
    assert [w["fontname"] for w in words] == ["ＭＳゴシック"]


# ---- 埋め込み画像 ----

def test_embedded_images():
    pdf = fixture("image")
    assert [im["bbox"] for im in post("/api/page/lines", pdf)["images"]] == [[20, 130, 70, 180]]
    single = post("/api/page/images/0", pdf)["png_base64"]
    batch = post("/api/page/images", pdf)
    assert batch["total"] == 1 and batch["next"] is None
    assert batch["images"] == [{"index": 0, "png_base64": single}]


# ---- エラー応答 ----

@pytest.mark.parametrize("path", ["/api/page/lines", "/api/page/image", "/api/page/images/0", "/api/page/images"])
@pytest.mark.parametrize("pdf", [
    BASIC,  # PDF ではない
    fixture("basic")[:300],  # 途中で切れている
    build_pdf(BASIC).replace(b"/Kids [3 0 R] /Count 1", b"/Kids [] /Count 0"),  # ページツリーが壊れている
])
def test_invalid_pdf_is_400(path, pdf):
    r = client.post(path, content=pdf, headers={"content-type": "application/pdf"})
    assert r.status_code == 400


def test_missing_image_is_404():
    pdf = fixture("basic")
    assert client.post("/api/page/images/0", content=pdf).status_code == 404
    assert client.post("/api/page/images", content=fixture("image"), params={"start": 5}).status_code == 404


def test_page_image():
    body = post("/api/page/image", fixture("rotate90"), resolution=144)
    image = Image.open(io.BytesIO(base64.b64decode(body["png_base64"])))
    assert body["resolution"] == 144
    assert image.size == (400, 600)
