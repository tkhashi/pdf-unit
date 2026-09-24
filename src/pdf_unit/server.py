"""ページ画像・線データ・サムネイルを返すステートレスなFastAPIサーバー。

サーバーはPDFを保存しない。クライアントは開いたPDFから必要なページだけを切り出したPDF
(1ページ、またはサムネイル用の数ページ)をリクエストボディで送り、サーバーはメモリ上で処理して
結果を返す(AWS Lambda での実行を想定。ADR 0019, 0020)。
"""

from __future__ import annotations

import base64
import io
import math
import threading
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .calibration import calibrate_linewidth
from .extract import extract_page_lines, extract_page_texts
from .raster import PageImages, extract_page_images

_STATIC_DIR = Path(__file__).parent / "static"

# Lambda の同期呼び出しはリクエスト・レスポンスとも6MBが上限。関数URLはバイナリのボディを
# base64化して渡すため(4/3倍)、1回に送るPDF(切り出したページ)の生バイト列は4MBまでに制限する
# (base64後約5.3MB、ヘッダー等の余裕を残す)。PDF全体の大きさには制限が無い。フロントエンドと同じ値。
MAX_PDF_BYTES = 4 * 1024 * 1024
# レスポンスJSON中のbase64文字列の上限。6MBの上限に対してJSONの他の部分の余裕を残す。
MAX_PNG_BASE64_CHARS = int(5.5 * 1024 * 1024)
_MIN_RESOLUTION = 36
_MAX_RESOLUTION = 600
_MAX_THUMBS_PER_REQUEST = 10

app = FastAPI(title="PDF Unit")
# UIが使う同梱ライブラリ(static/vendor/pdf-lib.min.js 等)。index.html は相対パス vendor/ で参照するので、
# 静的ファイルとして index.html と vendor/ を並べて配置すればそのまま動く
app.mount("/vendor", StaticFiles(directory=_STATIC_DIR / "vendor"), name="vendor")

# PDFium(pypdfium2)はスレッドセーフではなく、同時に呼ぶとプロセスごとクラッシュする(SIGSEGV)。
# FastAPIの同期エンドポイントはスレッドプールで並行実行されるため、PDFiumを使う処理
# (page.to_image / 線幅キャリブレーション / cid文字補完 / 埋め込み画像抽出 / サムネイル)は
# このロックで直列化する。page_lines内から_imagesを呼ぶため再入可能なRLockにする。
_pdfium_lock = threading.RLock()


async def pdf_body(request: Request) -> bytes:
    """リクエストボディ(PDFの生バイト列)を検証して返す共通の依存関係。"""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF too large")
    data = await request.body()
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF too large")
    if not data.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="request body is not a PDF")
    return data


def _open_pdf(data: bytes) -> pdfplumber.PDF:
    try:
        return pdfplumber.open(io.BytesIO(data))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid PDF: {e}") from e


def _check_page(pdf: pdfplumber.PDF, page_no: int) -> pdfplumber.page.Page:
    if not 0 <= page_no < len(pdf.pages):
        raise HTTPException(status_code=404, detail="page not found")
    return pdf.pages[page_no]


def _png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _b64(png: bytes) -> str:
    return base64.b64encode(png).decode("ascii")


def _shrink_factor(b64_len: int) -> float:
    # PNGのサイズは画素数(辺の2乗)にほぼ比例するので、辺は比の平方根で縮める。圧縮率の揺れに備えて1割余裕を取る
    return math.sqrt(MAX_PNG_BASE64_CHARS / b64_len) * 0.9


def _render_page(data: bytes, page_no: int, resolution: int) -> tuple[int, str]:
    """ページ画像をレンダリングする。base64が上限を超える場合は解像度を下げて描き直し、実際の解像度を返す。"""
    with _open_pdf(data) as pdf:
        page = _check_page(pdf, page_no)
        while True:
            with _pdfium_lock:
                image = page.to_image(resolution=resolution).original
            encoded = _b64(_png_bytes(image))
            if len(encoded) <= MAX_PNG_BASE64_CHARS or resolution <= _MIN_RESOLUTION:
                return resolution, encoded
            shrunk = int(resolution * _shrink_factor(len(encoded)))
            resolution = max(_MIN_RESOLUTION, min(resolution - 1, shrunk))


def _render_thumbnails(data: bytes, width: int) -> list[dict]:
    """ボディのPDFの各ページ(最大 _MAX_THUMBS_PER_REQUEST)の縮小画像(線検出なし)。大判図面では数dpi相当になるため、
    dpi指定ではなく出力幅から倍率を決める。"""
    thumbs = []
    with _pdfium_lock:
        try:
            pdf = pdfium.PdfDocument(data)
        except pdfium.PdfiumError as e:
            raise HTTPException(status_code=400, detail=f"invalid PDF: {e}") from e
        try:
            for page_no in range(min(len(pdf), _MAX_THUMBS_PER_REQUEST)):
                page = pdf[page_no]
                # get_widthは回転(/Rotate)反映後の表示幅。renderも回転を反映する
                image = page.render(scale=width / page.get_width()).to_pil()
                thumbs.append({"page": page_no, "png_base64": _b64(_png_bytes(image))})
        finally:
            pdf.close()
    return thumbs


def _images(data: bytes, page_no: int) -> PageImages:
    with _pdfium_lock:
        return extract_page_images(data, page_no)


def _downscale_png(png: bytes) -> str:
    """埋め込み画像のbase64が上限を超える場合、Pillowで縮小してから返す。"""
    encoded = _b64(png)
    if len(encoded) <= MAX_PNG_BASE64_CHARS:
        return encoded
    image = Image.open(io.BytesIO(png))
    image.load()
    while len(encoded) > MAX_PNG_BASE64_CHARS and min(image.size) > 1:
        factor = _shrink_factor(len(encoded))
        size = (max(1, int(image.width * factor)), max(1, int(image.height * factor)))
        image = image.resize(size, Image.Resampling.LANCZOS)
        encoded = _b64(_png_bytes(image))
    return encoded


@app.get("/")
def index() -> FileResponse:
    return FileResponse(_STATIC_DIR / "index.html")


# 以下のAPIのボディは、UIが対象ページだけを切り出したPDF。ページ番号は常に先頭(0)になる
_PAGE = 0


@app.post("/api/thumbs")
def page_thumbnails(width: int = 160, data: bytes = Depends(pdf_body)) -> dict:
    """ボディのPDFの全ページ(最大10)のサムネイル。page はボディ内でのページ番号。"""
    width = max(60, min(width, 400))
    return {"thumbs": _render_thumbnails(data, width)}


@app.post("/api/page/lines")
def page_lines(data: bytes = Depends(pdf_body)) -> dict:
    with _open_pdf(data) as pdf:
        page = _check_page(pdf, _PAGE)
        lines = extract_page_lines(page)  # pdfplumberのみ(PDFium不使用)なのでロック外
        with _pdfium_lock:
            # 報告linewidthと実描画太さの比(ハイライト幅を実際の線の太さに合わせるため)
            calib = calibrate_linewidth(page, page.lines + page.rects + page.curves)
            texts = extract_page_texts(page, data, _PAGE)
            images = _images(data, _PAGE).records
        # UIがpdf-libで求めたページ寸法と食い違った場合に合わせられるよう、座標系の基準となる寸法も返す
        size = {"width": page.width, "height": page.height}
    return {
        "page": size,
        "linewidth_scale": calib.scale,
        "calibration": calib.method,
        "lines": lines,
        "texts": texts,
        "images": images,
    }


@app.post("/api/page/image")
def page_image(resolution: int = 150, data: bytes = Depends(pdf_body)) -> dict:
    resolution = max(_MIN_RESOLUTION, min(resolution, _MAX_RESOLUTION))
    actual, encoded = _render_page(data, _PAGE, resolution)
    return {"resolution": actual, "png_base64": encoded}


@app.post("/api/page/images/{index}")
def embedded_image(index: int, data: bytes = Depends(pdf_body)) -> dict:
    with _open_pdf(data) as pdf:
        _check_page(pdf, _PAGE)
    pngs = _images(data, _PAGE).pngs
    if not 0 <= index < len(pngs):
        raise HTTPException(status_code=404, detail="image not found")
    return {"png_base64": _downscale_png(pngs[index])}


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=8000)
