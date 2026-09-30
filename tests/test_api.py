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


def test_fills_are_separated_from_strokes():
    """塗るだけのパスは線にしない。塗りの規則はパス全体に掛かるので、サブパスをまとめて1件にする(ADR 0044)。"""
    body = lines_of("fills")
    assert [(ln["type"], ln["linewidth"], ln["color"]) for ln in body["lines"]] == [
        ("rect", 1.0, "rgb(0,255,0)"), ("line", 2.0, "rgb(0,0,0)"),
    ]
    fills = [(f["type"], f["fill_rule"], f["linewidth"], f["color"], f["bbox"], len(f["polylines"]))
             for f in body["fills"]]
    assert fills == [
        ("fill", "nonzero", 20.0, "rgb(255,0,0)", [10, 140, 40, 180], 1),
        ("fill", "evenodd", 1.0, "rgb(0,0,255)", [100, 50, 150, 100], 2),
        ("fill", "nonzero", 1.0, "rgb(0,255,0)", [60, 60, 80, 80], 1),
    ]
    assert body["fills"][1]["d"] == ("M100.00,100.00 L150.00,100.00 L150.00,50.00 L100.00,50.00 Z "
                                     "M110.00,90.00 L140.00,90.00 L140.00,60.00 L110.00,60.00 Z")
    assert body["fills"][0]["polylines"][0] == [10, 180, 40, 180, 40, 140, 10, 140, 10, 180]


def test_fill_clips():
    """クリップは表示座標で返し、フォームに掛かるクリップも中の塗りに重ねる。同じクリップは1つにまとめる(ADR 0046)。"""
    body = lines_of("fill_clips")
    assert [f["clip"] for f in body["fills"]] == [[0], [1, 2], []]
    boxes = [(min(p[0::2]), min(p[1::2]), max(p[0::2]), max(p[1::2])) for c in body["clip_paths"] for p in c["polylines"]]
    # ページ: 5..15 を 2 倍 / フォームに掛かるクリップ: 0..60 × 0..100 / フォーム内: 5..15 を 0.5 倍 + 20 してから 2 倍 + 10。
    # PDFium は図形を完全に含む矩形のクリップを省く(効果が無いため)ので、フォームの中身を実際に切る範囲にしている
    assert boxes == [(10, 170, 30, 190), (0, 100, 60, 200), (55, 135, 65, 145)]
    assert body["clip_paths"][0]["d"] == "M10.00,190.00 L30.00,190.00 L30.00,170.00 L10.00,170.00 Z"


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
    images = post("/api/page/lines", fixture("image"))["images"]
    assert [(im["bbox"], im["quad"], im["px_width"], im["px_height"]) for im in images] == [
        ([20, 130, 70, 180], [20, 180, 70, 180, 70, 130, 20, 130], 2, 2)
    ]


@pytest.mark.parametrize("path", ["/api/page/images/0", "/api/page/images"])
def test_embedded_image_data_api_is_removed(path):
    """UI は画像データを使わない(ADR 0039)ため、画像データの API は削除した(ADR 0040)。"""
    assert client.post(path, content=fixture("image")).status_code == 404


# ---- エラー応答 ----

@pytest.mark.parametrize("path", ["/api/page/lines", "/api/page/image"])
@pytest.mark.parametrize("pdf", [
    BASIC,  # PDF ではない
    fixture("basic")[:300],  # 途中で切れている
    build_pdf(BASIC).replace(b"/Kids [3 0 R] /Count 1", b"/Kids [] /Count 0"),  # ページツリーが壊れている
])
def test_invalid_pdf_is_400(path, pdf):
    r = client.post(path, content=pdf, headers={"content-type": "application/pdf"})
    assert r.status_code == 400


def test_page_image():
    body = post("/api/page/image", fixture("rotate90"), resolution=144)
    image = Image.open(io.BytesIO(base64.b64decode(body["png_base64"])))
    assert body["resolution"] == 144
    assert image.size == (400, 600)
