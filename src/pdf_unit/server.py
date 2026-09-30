"""ページ画像・線データを返すステートレスなFastAPIサーバー。

サーバーはPDFを保存しない。クライアントは開いたPDFから必要な1ページだけを切り出したPDFを
リクエストボディで送り、サーバーはメモリ上で処理して結果を返す(AWS Lambda での実行を想定。
ADR 0019, 0020)。サムネイルはブラウザ側(pdf.js)でラスタライズする(ADR 0041)。
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
import zlib
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pypdfium2 as pdfium
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from starlette.concurrency import run_in_threadpool

from .calibration import calibrate_linewidth
from .extract import extract_page_fills, extract_page_lines, extract_page_texts
from .pdfium_page import PdfiumPage, render_page
from .raster import extract_images
from .timing import Timings, add_metric, collect, metric, server_timing_header, stage

_STATIC_DIR = Path(__file__).parent / "static"

# Lambda の同期呼び出しはリクエスト・レスポンスとも6MBが上限。関数URLはバイナリのボディを
# base64化して渡すため(4/3倍)、1回に送るPDF(切り出したページ)の生バイト列は4MBまでに制限する
# (base64後約5.3MB、ヘッダー等の余裕を残す)。PDF全体の大きさには制限が無い。フロントエンドと同じ値。
MAX_PDF_BYTES = 4 * 1024 * 1024
# gzip で圧縮して送られたボディ(Content-Encoding: gzip)を展開した後の上限(ADR 0034)。圧縮すれば 4MB に収まる
# ページを送れるようにするためのもので、展開後は 4MB を超えてよい。圧縮爆弾に備え、展開はこの大きさで打ち切る
MAX_DECOMPRESSED_PDF_BYTES = 64 * 1024 * 1024
# レスポンスJSON中のbase64文字列の上限。6MBの上限に対してJSONの他の部分の余裕を残す。
MAX_PNG_BASE64_CHARS = int(5.5 * 1024 * 1024)
_MIN_RESOLUTION = 36
_MAX_RESOLUTION = 600

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
# FastAPIの同期エンドポイントはスレッドプールで並行実行されるため、PDFiumを使う処理(PDFを開く・図形と文字の
# 読み取り・ページの描画・埋め込み画像の抽出)は、開いてから閉じるまでをこのロックで直列化する
# (ADR 0011, 0038)。Lambda は1つの実行環境で同時に1リクエストしか処理しないので、取り合うのはローカルだけ。
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


def _gunzip(data: bytes) -> bytes:
    """gzip で圧縮されたボディを展開する。展開後が MAX_DECOMPRESSED_PDF_BYTES を超えたら打ち切って 413 にする。"""
    decompressor = zlib.decompressobj(wbits=31)  # gzip 形式(ヘッダー・CRC を検証する)
    try:
        out = decompressor.decompress(data, MAX_DECOMPRESSED_PDF_BYTES + 1)
    except zlib.error as e:
        raise HTTPException(status_code=400, detail=f"invalid gzip body: {e}") from e
    if len(out) > MAX_DECOMPRESSED_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF too large")
    if not decompressor.eof or decompressor.unused_data:
        # 途中で切れている、または複数の gzip を連結したボディ(ブラウザの CompressionStream は1つだけ作る)
        raise HTTPException(status_code=400, detail="invalid gzip body")
    return out


async def pdf_body(request: Request) -> bytes:
    """リクエストボディ(PDFの生バイト列)を検証して返す共通の依存関係。

    Content-Encoding: gzip のボディは展開してから返す(ADR 0034)。上限 MAX_PDF_BYTES は送られてきた
    (圧縮後の)大きさにかける。Lambda のリクエスト上限は転送される大きさにかかるため。
    """
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF too large")
    data = await request.body()
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF too large")
    encoding = request.headers.get("content-encoding", "identity").strip().lower()
    if encoding == "gzip":
        data = await run_in_threadpool(_gunzip, data)  # 最大数十MBの展開でイベントループを止めない
    elif encoding != "identity":
        raise HTTPException(status_code=415, detail=f"unsupported Content-Encoding: {encoding}")
    if not data.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="request body is not a PDF")
    return data


@contextmanager
def _open_page(data: bytes, page_no: int) -> Iterator[pdfium.PdfPage]:
    """PDFを開いてページを返し、with を抜けるときに閉じる。_pdfium_lock を保持して呼ぶ。
    開く処理を計測区間 open として記録する。"""
    with stage("open"):
        try:
            pdf = pdfium.PdfDocument(data)
        except pdfium.PdfiumError as e:
            raise HTTPException(status_code=400, detail=f"invalid PDF: {e}") from e
    try:
        if not 0 <= page_no < len(pdf):
            raise HTTPException(status_code=404, detail="page not found")
        yield pdf[page_no]
    finally:
        # 開いたページ・テキストページも一緒に閉じる(ロックの外で GC に後片付けさせない)
        pdf.close()


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
    while True:
        add_metric("render_attempts", 1)
        # 描き直すときも開き直す(文書を開いたままロックを外さない)
        with _pdfium_locked(), _open_page(data, page_no) as page, stage("render"):
            image = render_page(page, resolution)
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
@app.post("/api/page/lines")
def page_lines(response: Response, data: bytes = Depends(pdf_body)) -> dict:
    # 1つの文書で図形・文字・埋め込み画像を読み、線幅補正の描画も行う。すべて PDFium を使うのでロック内
    with collect() as timings, _pdfium_locked(), _open_page(data, _PAGE) as pdf_page:
        with stage("parse"):
            page = PdfiumPage(pdf_page)  # 図形と文字の読み取り(内訳 parse.paths・parse.chars)
        with stage("vectors"):
            lines = extract_page_lines(page)
            fills = extract_page_fills(page)
        with stage("calib"):
            # 報告linewidthと実描画太さの比(ハイライト幅を実際の線の太さに合わせるため)
            calib = calibrate_linewidth(page, page.lines + page.rects + page.curves)
        with stage("texts"):
            texts = extract_page_texts(page)
        with stage("images"):
            images = extract_images(pdf_page)
        # UIがpdf-libで求めたページ寸法と食い違った場合に合わせられるよう、座標系の基準となる寸法も返す
        size = {"width": page.width, "height": page.height}
        metric("page_pt", f"{page.width:g}x{page.height:g}")
        metric("lines", len(lines))
        metric("fills", len(fills))
        metric("texts", len(texts))
        metric("images", len(images))
    _set_timing_headers(response, timings)
    return {
        "page": size,
        "linewidth_scale": calib.scale,
        "calibration": calib.method,
        "lines": lines,
        "fills": fills,
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


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=8000)
