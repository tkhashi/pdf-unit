"""ページ切替時の同時リクエスト(線データ+原本画像2解像度)を、ローカルの1プロセスで再現して計る(ADR 0037)。

    uv run python scripts/poc_pypdfium2/concurrency.py <1ページのPDF> [--repeat 3]

本番(pdfplumber)は pdfminer の解析を `_pdfium_lock` の外で行う。移行後は線データの処理がすべて PDFium に
なりロックの中に入るため、原本画像の描画と直列になる。両方の構成で、3リクエストをスレッドで同時に投げ、
線データの応答までの時間と全体の時間を比べる。Lambda は1つの実行環境で同時に1リクエストしか処理しない
ため、この直列化が影響するのはローカルの開発サーバーだけ。
"""

from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _plumber(data: bytes):
    from fastapi import Response

    from pdf_unit import server

    return (
        lambda: server.page_lines(response=Response(), data=data),
        lambda res: server.page_image(response=Response(), resolution=res, data=data),
    )


def _pdfium(data: bytes):
    import pypdfium2 as pdfium

    from pdf_unit import server
    from poc_compare import body_pdfium

    def lines():
        with server._pdfium_lock:
            return body_pdfium(data)

    def image(res: int):
        with server._pdfium_lock:
            pdf = pdfium.PdfDocument(data)
            try:
                bitmap = pdf[0].render(scale=res / 72, no_smoothtext=True, no_smoothpath=True,
                                       no_smoothimage=True, prefer_bgrx=True)
                image = bitmap.to_pil().convert("RGB")
            finally:
                pdf.close()
        return server._b64(server._png_bytes(image))

    return lines, image


def run(data: bytes, variant: str) -> tuple[float, float]:
    lines, image = (_plumber if variant == "plumber" else _pdfium)(data)
    start = time.perf_counter()
    done: dict[str, float] = {}

    def timed(name, fn):
        fn()
        done[name] = (time.perf_counter() - start) * 1000

    with ThreadPoolExecutor(3) as pool:
        for f in [pool.submit(timed, "lines", lines), pool.submit(timed, "img100", lambda: image(100)),
                  pool.submit(timed, "img200", lambda: image(200))]:
            f.result()
    return done["lines"], max(done.values())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--repeat", type=int, default=3)
    args = parser.parse_args()
    data = args.pdf.read_bytes()
    for variant in ("plumber", "pdfium"):
        run(data, variant)  # 初回の import・キャッシュを除く
        results = [run(data, variant) for _ in range(args.repeat)]
        best = min(results, key=lambda r: r[1])
        print(f"{variant:<8} 線データの応答まで {best[0]:7.0f}ms  3リクエスト全体 {best[1]:7.0f}ms")


if __name__ == "__main__":
    main()
