"""ページ画像・線データ・サムネイルを返すステートレスなFastAPIサーバー。

サーバーはPDFを保存しない。クライアントは開いたPDFから必要なページだけを切り出したPDF
(1ページ、またはサムネイル用の数ページ)をリクエストボディで送り、サーバーはメモリ上で処理して
結果を返す(AWS Lambda での実行を想定。ADR 0019, 0020)。
"""

from __future__ import annotations

import base64
import io
import json
import math
import resource
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from .calibration import calibrate_linewidth
from .extract import extract_page_lines, extract_page_texts
from .raster import PageImages, extract_page_images
from .timing import Timings, add_metric, collect, metric, server_timing_header, stage

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
# 応答を gzip で圧縮する(ADR 0024)。線数の多いページの抽出結果は JSON で6MB(Lambda の応答上限)を超えるが、
# 圧縮すれば1/6〜1/9になる。ブラウザが展開するので受け取る内容は変わらない。圧縮レベルは既定の9だと時間が
# かかる割に縮まないため4にする(実測: 12.8MBの応答が level 4 で 2.14MB・87ms、level 9 で 1.95MB・760ms)。
# 後で登録する計測ログのミドルウェアより内側になるので、ログの resp_bytes は圧縮後の大きさになる
app.add_middleware(GZipMiddleware, compresslevel=4)
# UI は web/ でビルドし static/ に出力する(index.html・assets/・licenses.md。ADR 0029)。index.html は
# 相対パス assets/ で参照するので、静的ファイルとして並べて配置すればそのまま動く(AWS では S3 が配信する)。
# ビルド前でもサーバー(API)は起動できるよう、ディレクトリの存在は起動時に確かめない
app.mount("/assets", StaticFiles(directory=_STATIC_DIR / "assets", check_dir=False), name="assets")

# PDFium(pypdfium2)はスレッドセーフではなく、同時に呼ぶとプロセスごとクラッシュする(SIGSEGV)。
# FastAPIの同期エンドポイントはスレッドプールで並行実行されるため、PDFiumを使う処理
# (page.to_image / 線幅キャリブレーション / cid文字補完 / 埋め込み画像抽出 / サムネイル)は
# このロックで直列化する。page_lines内から_imagesを呼ぶため再入可能なRLockにする。
_pdfium_lock = threading.RLock()


@contextmanager
def _pdfium_locked() -> Iterator[None]:
    """_pdfium_lock を保持する。ロックの待ち時間を計測区間 lock_wait として記録する(ADR 0023)。"""
    with stage("lock_wait"):
        _pdfium_lock.acquire()
    try:
        yield
    finally:
        _pdfium_lock.release()


# ---- 計測ログ(ADR 0023) ----
# APIリクエストごとに、所要時間の内訳(Server-Timing)・サイズ・メモリを1行のJSONで標準出力へ書く。
# Lambda では CloudWatch Logs に入り、Logs Insights で集計できる
_cold = True  # プロセスが最初に受けるリクエストか(Lambda のコールドスタートの判定)


def _maxrss_mb() -> float:
    # ru_maxrss は macOS ではバイト、Linux では KB
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)


def _rss_mb() -> float | None:
    try:
        with open("/proc/self/statm") as f:  # Linux(Lambda)のみ
            return round(int(f.read().split()[1]) * resource.getpagesize() / (1024 * 1024), 1)
    except OSError:
        return None


def _parse_server_timing(value: str) -> dict[str, float]:
    stages = {}
    for entry in filter(None, (e.strip() for e in value.split(","))):
        name, _, dur = entry.partition(";dur=")
        stages[name] = float(dur)
    return stages


@app.middleware("http")
async def perf_log(request: Request, call_next):
    if not request.url.path.startswith("/api/"):
        return await call_next(request)
    global _cold
    cold, _cold = _cold, False
    start = time.perf_counter()
    response = await call_next(request)
    record = {
        "perf": request.url.path,
        "query": str(request.url.query),
        "status": response.status_code,
        "cold": cold,
        "total_ms": round((time.perf_counter() - start) * 1000, 1),
        "req_bytes": int(request.headers.get("content-length") or 0),
        "resp_bytes": int(response.headers.get("content-length") or 0),
        "stages_ms": _parse_server_timing(response.headers.get("server-timing", "")),
        "metrics": json.loads(response.headers.get("x-perf-metrics", "{}")),
        "maxrss_mb": _maxrss_mb(),
        "rss_mb": _rss_mb(),
    }
    print(json.dumps(record, ensure_ascii=False), flush=True)
    return response


def _set_timing_headers(response: Response, timings: Timings) -> None:
    response.headers["Server-Timing"] = server_timing_header(timings)
    response.headers["X-Perf-Metrics"] = json.dumps(timings.metrics, separators=(",", ":"))


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


@contextmanager
def _open_page(data: bytes, page_no: int) -> Iterator[pdfplumber.page.Page]:
    """PDFを開いてページを返す(閉じるのは with を抜けるとき)。開く処理を計測区間 open として記録する。"""
    with stage("open"):
        pdf = _open_pdf(data)
    with pdf:
        with stage("open"):
            page = _check_page(pdf, page_no)
        yield page


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
    with _open_page(data, page_no) as page:
        while True:
            add_metric("render_attempts", 1)
            with _pdfium_locked(), stage("render"):
                image = page.to_image(resolution=resolution).original
            metric("render_px", image.width * image.height)
            with stage("png"):
                png = _png_bytes(image)
            with stage("b64"):
                encoded = _b64(png)
            metric("resolution", resolution)
            if len(encoded) <= MAX_PNG_BASE64_CHARS or resolution <= _MIN_RESOLUTION:
                return resolution, encoded
            shrunk = int(resolution * _shrink_factor(len(encoded)))
            resolution = max(_MIN_RESOLUTION, min(resolution - 1, shrunk))


def _render_thumbnails(data: bytes, width: int) -> list[dict]:
    """ボディのPDFの各ページ(最大 _MAX_THUMBS_PER_REQUEST)の縮小画像(線検出なし)。大判図面では数dpi相当になるため、
    dpi指定ではなく出力幅から倍率を決める。"""
    thumbs = []
    with _pdfium_locked():
        try:
            with stage("open"):
                pdf = pdfium.PdfDocument(data)
        except pdfium.PdfiumError as e:
            raise HTTPException(status_code=400, detail=f"invalid PDF: {e}") from e
        try:
            for page_no in range(min(len(pdf), _MAX_THUMBS_PER_REQUEST)):
                with stage("render"):
                    page = pdf[page_no]
                    # get_widthは回転(/Rotate)反映後の表示幅。renderも回転を反映する
                    image = page.render(scale=width / page.get_width()).to_pil()
                with stage("png"):
                    png = _png_bytes(image)
                with stage("b64"):
                    thumbs.append({"page": page_no, "png_base64": _b64(png)})
        finally:
            pdf.close()
    metric("thumbs", len(thumbs))
    return thumbs


def _images(data: bytes, page_no: int, png_indices: tuple[int, ...] = ()) -> PageImages:
    """埋め込み画像の配置情報と、png_indices で指定した画像の PNG(既定は PNG 化しない)。"""
    with _pdfium_locked(), stage("images"):
        return extract_page_images(data, page_no, png_indices)


def _downscale_png(png: bytes) -> str:
    """埋め込み画像のbase64が上限を超える場合、Pillowで縮小してから返す。"""
    encoded = _b64(png)
    if len(encoded) <= MAX_PNG_BASE64_CHARS:
        return encoded
    with stage("downscale"):
        image = Image.open(io.BytesIO(png))
        image.load()
        while len(encoded) > MAX_PNG_BASE64_CHARS and min(image.size) > 1:
            add_metric("downscale_attempts", 1)
            factor = _shrink_factor(len(encoded))
            size = (max(1, int(image.width * factor)), max(1, int(image.height * factor)))
            image = image.resize(size, Image.Resampling.LANCZOS)
            encoded = _b64(_png_bytes(image))
    return encoded


@app.get("/", response_model=None)
def index() -> FileResponse | PlainTextResponse:
    page = _STATIC_DIR / "index.html"
    if not page.is_file():
        return PlainTextResponse(
            "UI がビルドされていません。pnpm --dir web install && pnpm --dir web build を実行してください",
            status_code=503,
        )
    return FileResponse(page)


@app.get("/licenses.md")
def licenses() -> FileResponse:
    """UI に同梱したライブラリのライセンス(ビルド時に生成)。"""
    path = _STATIC_DIR / "licenses.md"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not built")
    return FileResponse(path, media_type="text/markdown; charset=utf-8")


# 以下のAPIのボディは、UIが対象ページだけを切り出したPDF。ページ番号は常に先頭(0)になる
_PAGE = 0


# 各APIは所要時間の内訳を Server-Timing、件数などを X-Perf-Metrics ヘッダーで返す(ADR 0023)
@app.post("/api/thumbs")
def page_thumbnails(response: Response, width: int = 160, data: bytes = Depends(pdf_body)) -> dict:
    """ボディのPDFの全ページ(最大10)のサムネイル。page はボディ内でのページ番号。"""
    width = max(60, min(width, 400))
    with collect() as timings:
        thumbs = _render_thumbnails(data, width)
    _set_timing_headers(response, timings)
    return {"thumbs": thumbs}


@app.post("/api/page/lines")
def page_lines(response: Response, data: bytes = Depends(pdf_body)) -> dict:
    with collect() as timings, _open_page(data, _PAGE) as page:
        with stage("parse"):
            page.objects  # pdfminerによるページの解析(結果はpdfplumberが保持し、以降の抽出で使い回す)
        with stage("vectors"):
            lines = extract_page_lines(page)  # pdfplumberのみ(PDFium不使用)なのでロック外
        with _pdfium_locked():
            with stage("calib"):
                # 報告linewidthと実描画太さの比(ハイライト幅を実際の線の太さに合わせるため)
                calib = calibrate_linewidth(page, page.lines + page.rects + page.curves)
            with stage("texts"):
                texts = extract_page_texts(page, data, _PAGE)
            images = _images(data, _PAGE).records
        # UIがpdf-libで求めたページ寸法と食い違った場合に合わせられるよう、座標系の基準となる寸法も返す
        size = {"width": page.width, "height": page.height}
        metric("page_pt", f"{page.width:g}x{page.height:g}")
        metric("lines", len(lines))
        metric("texts", len(texts))
        metric("images", len(images))
    _set_timing_headers(response, timings)
    return {
        "page": size,
        "linewidth_scale": calib.scale,
        "calibration": calib.method,
        "lines": lines,
        "texts": texts,
        "images": images,
    }


@app.post("/api/page/image")
def page_image(response: Response, resolution: int = 150, data: bytes = Depends(pdf_body)) -> dict:
    resolution = max(_MIN_RESOLUTION, min(resolution, _MAX_RESOLUTION))
    with collect() as timings:
        actual, encoded = _render_page(data, _PAGE, resolution)
    _set_timing_headers(response, timings)
    return {"resolution": actual, "png_base64": encoded}


@app.post("/api/page/images/{index}")
def embedded_image(response: Response, index: int, data: bytes = Depends(pdf_body)) -> dict:
    with collect() as timings:
        with _open_page(data, _PAGE):
            pass
        pngs = _images(data, _PAGE, png_indices=(index,)).pngs
        if index not in pngs:
            raise HTTPException(status_code=404, detail="image not found")
        encoded = _downscale_png(pngs[index])
    _set_timing_headers(response, timings)
    return {"png_base64": encoded}


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=8000)
