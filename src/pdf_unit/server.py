"""PDFアップロード・ページ画像・線データを返すローカル用FastAPIサーバー。"""

from __future__ import annotations

import io
import shutil
import tempfile
import threading
import uuid
from functools import lru_cache
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from .calibration import calibrate_linewidth
from .extract import extract_page_lines, extract_page_texts
from .raster import PageImages, extract_page_images

_STATIC_DIR = Path(__file__).parent / "static"
_UPLOAD_DIR = Path(tempfile.mkdtemp(prefix="pdf-unit-"))

app = FastAPI(title="PDF Unit")

# doc_id -> 保存先PDFパス(ローカル用途なのでメモリ保持のみ)
_documents: dict[str, Path] = {}

# PDFium(pypdfium2)はスレッドセーフではなく、同時に呼ぶとプロセスごとクラッシュする(SIGSEGV)。
# FastAPIの同期エンドポイントはスレッドプールで並行実行されるため、PDFiumを使う処理
# (page.to_image / 線幅キャリブレーション / cid文字補完 / 埋め込み画像抽出)はこのロックで直列化する。
# _lines内から_imagesを呼ぶため再入可能なRLockにする。
_pdfium_lock = threading.RLock()


def _pdf_path(doc_id: str) -> Path:
    path = _documents.get(doc_id)
    if path is None:
        raise HTTPException(status_code=404, detail="document not found")
    return path


def _check_page(pdf: pdfplumber.PDF, page_no: int) -> pdfplumber.page.Page:
    if not 0 <= page_no < len(pdf.pages):
        raise HTTPException(status_code=404, detail="page not found")
    return pdf.pages[page_no]


@lru_cache(maxsize=32)
def _render_png(path: Path, page_no: int, resolution: int) -> bytes:
    with pdfplumber.open(path) as pdf:
        page = _check_page(pdf, page_no)
        with _pdfium_lock:
            image = page.to_image(resolution=resolution).original
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


@lru_cache(maxsize=512)
def _render_thumbnail(path: Path, page_no: int, width: int) -> bytes:
    """ページ一覧用の縮小画像(線検出なし)。大判図面では数dpi相当になるため、
    dpi指定の_render_pngではなく出力幅から倍率を決める。"""
    with _pdfium_lock:
        pdf = pdfium.PdfDocument(path)
        try:
            if not 0 <= page_no < len(pdf):
                raise HTTPException(status_code=404, detail="page not found")
            page = pdf[page_no]
            # get_widthは回転(/Rotate)反映後の表示幅。renderも回転を反映する
            image = page.render(scale=width / page.get_width()).to_pil()
        finally:
            pdf.close()
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


@lru_cache(maxsize=32)
def _lines(path: Path, page_no: int) -> dict:
    with pdfplumber.open(path) as pdf:
        page = _check_page(pdf, page_no)
        lines = extract_page_lines(page)  # pdfplumberのみ(PDFium不使用)なのでロック外
        with _pdfium_lock:
            # 報告linewidthと実描画太さの比(ハイライト幅を実際の線の太さに合わせるため)
            calib = calibrate_linewidth(page, page.lines + page.rects + page.curves)
            texts = extract_page_texts(page, path, page_no)
            images = _images(path, page_no).records
        return {
            "linewidth_scale": calib.scale,
            "calibration": calib.method,
            "lines": lines,
            "texts": texts,
            "images": images,
        }


@lru_cache(maxsize=32)
def _images(path: Path, page_no: int) -> PageImages:
    with _pdfium_lock:
        return extract_page_images(path, page_no)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(_STATIC_DIR / "index.html")


@app.post("/api/documents")
def upload(file: UploadFile) -> dict:
    doc_id = uuid.uuid4().hex
    path = _UPLOAD_DIR / f"{doc_id}.pdf"
    with path.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        with pdfplumber.open(path) as pdf:
            pages = [{"width": p.width, "height": p.height} for p in pdf.pages]
    except Exception as e:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"invalid PDF: {e}") from e
    _documents[doc_id] = path
    return {"doc_id": doc_id, "filename": file.filename, "pages": pages}


@app.get("/api/documents/{doc_id}/pages/{page_no}/image.png")
def page_image(doc_id: str, page_no: int, resolution: int = 150) -> Response:
    resolution = max(36, min(resolution, 600))
    png = _render_png(_pdf_path(doc_id), page_no, resolution)
    return Response(content=png, media_type="image/png")


@app.get("/api/documents/{doc_id}/pages/{page_no}/thumb.png")
def page_thumbnail(doc_id: str, page_no: int, width: int = 160) -> Response:
    width = max(60, min(width, 400))
    png = _render_thumbnail(_pdf_path(doc_id), page_no, width)
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/documents/{doc_id}/pages/{page_no}/lines")
def page_lines(doc_id: str, page_no: int) -> dict:
    return _lines(_pdf_path(doc_id), page_no)


@app.get("/api/documents/{doc_id}/pages/{page_no}/images/{index}.png")
def embedded_image(doc_id: str, page_no: int, index: int) -> Response:
    pngs = _images(_pdf_path(doc_id), page_no).pngs
    if not 0 <= index < len(pngs):
        raise HTTPException(status_code=404, detail="image not found")
    return Response(content=pngs[index], media_type="image/png")


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=8000)
