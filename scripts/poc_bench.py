"""pdfplumber実装とpypdfium2実装(PoC、ADR 0032)を同一PDFに対して比較計測する。

    uv run python scripts/poc_bench.py <PDF> [--pages 1-5] [--kinds lines,texts,image]
        [--resolutions 100,200,400] [--out DIR] [--splitter auto]

- ページの切り出しは `scripts/profile_pages.py` と同じロジック(`_split`)を再利用する
  (pdf-lib優先、無ければpypdfium2)。
- 対象は3種: lines(`extract_page_lines` vs `poc_pypdfium2.poc_lines`)、
  texts(`extract_page_texts` vs `poc_pypdfium2.poc_texts`)、
  image(`_render_page`が使う`page.to_image()` vs `poc_pypdfium2.poc_render`)。
- 1回の呼び出しごとに子プロセスを起動し、`resource.getrusage().ru_maxrss`をその呼び出しの
  ピークメモリとみなす(`profile_pages.py`と同じ考え方。ADR 0023)。
- `--out DIR` を指定すると、各呼び出しの出力(lines/textsはJSON、imageはPNG)を保存する。
  厳密な出力互換は目指していない(PoCの実装は簡略化しているため)ので、自動診断はせず
  目視・別途の差分確認に使う。lines/textsは件数、imageは画素差分(既存 vs PoC)を要約に出す。
"""

from __future__ import annotations

import argparse
import io
import json
import resource
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import profile_pages as pp  # noqa: E402  (scripts/ 内の既存モジュールを再利用)


def _maxrss_mb() -> float:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)


def _run_lines(data: bytes, variant: str) -> list[dict]:
    if variant == "pdfplumber":
        import pdfplumber

        from pdf_unit.extract import extract_page_lines

        with pdfplumber.open(io.BytesIO(data)) as pdf:
            page = pdf.pages[0]
            page.objects
            return extract_page_lines(page)
    from poc_pypdfium2.poc_lines import extract_page_lines_pdfium

    return extract_page_lines_pdfium(data, 0)


def _run_texts(data: bytes, variant: str) -> list[dict]:
    if variant == "pdfplumber":
        import pdfplumber

        from pdf_unit.extract import extract_page_texts

        with pdfplumber.open(io.BytesIO(data)) as pdf:
            page = pdf.pages[0]
            return extract_page_texts(page, data, 0)
    from poc_pypdfium2.poc_texts import extract_page_texts_pdfium

    return extract_page_texts_pdfium(data, 0)


def _run_image(data: bytes, variant: str, resolution: int):
    if variant == "pdfplumber":
        import pdfplumber

        with pdfplumber.open(io.BytesIO(data)) as pdf:
            return pdf.pages[0].to_image(resolution=resolution).original
    from poc_pypdfium2.poc_render import render_page_pdfium

    return render_page_pdfium(data, 0, resolution)


def _jsonable(records: list[dict]) -> list[dict]:
    return json.loads(json.dumps(records, default=lambda v: list(v) if isinstance(v, tuple) else str(v)))


def _run_child(job: dict) -> dict:
    data = Path(job["pdf"]).read_bytes()
    kind, variant = job["kind"], job["variant"]
    import time

    start = time.perf_counter()
    if kind == "lines":
        out = _run_lines(data, variant)
    elif kind == "texts":
        out = _run_texts(data, variant)
    else:
        out = _run_image(data, variant, job["resolution"])
    elapsed_ms = round((time.perf_counter() - start) * 1000, 1)
    result = {"kind": kind, "variant": variant, "page": job["page"], "resolution": job.get("resolution"),
              "total_ms": elapsed_ms, "maxrss_mb": _maxrss_mb()}
    if kind == "image":
        result["size"] = list(out.size)
        if job.get("dump"):
            out.save(job["dump"])
    else:
        result["count"] = len(out)
        if job.get("dump"):
            Path(job["dump"]).write_text(json.dumps(_jsonable(out), ensure_ascii=False, indent=2))
    return result


def _spawn(job: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, __file__, "--child", json.dumps(job)], capture_output=True, text=True
    )
    if proc.returncode != 0:
        return {"kind": job["kind"], "variant": job["variant"], "page": job["page"],
                "error": proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else f"exit {proc.returncode}"}
    return json.loads(proc.stdout.strip().splitlines()[-1])


def _image_diff(a_path: Path, b_path: Path) -> dict | None:
    if not (a_path.is_file() and b_path.is_file()):
        return None
    from PIL import Image, ImageChops

    a, b = Image.open(a_path).convert("RGB"), Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return {"same_size": False, "a_size": a.size, "b_size": b.size}
    diff = ImageChops.difference(a, b)
    hist = diff.convert("L").histogram()
    nonzero = sum(hist[1:])
    return {"same_size": True, "diff_px": nonzero, "total_px": a.size[0] * a.size[1], "max_diff": diff.getextrema()}


def _summarize(results: list[dict], out_dir: Path | None) -> None:
    print("\n== 呼び出しごと(処理時間・メモリ) ==")
    print(f"{'page':>5} {'kind':<8} {'variant':<10} {'total_ms':>9} {'maxrss_MB':>9}  詳細")
    for r in results:
        if "error" in r:
            print(f"{r['page'] + 1:>5} {r['kind']:<8} {r['variant']:<10}  エラー: {r['error']}")
            continue
        detail = f"count={r['count']}" if "count" in r else f"size={r.get('size')}"
        print(f"{r['page'] + 1:>5} {r['kind']:<8} {r['variant']:<10} {r['total_ms']:>9.1f} {r['maxrss_mb']:>9.1f}  {detail}")

    print("\n== pdfplumber比のpypdfium2処理時間(小さいほど高速) ==")
    by_key: dict[tuple, dict[str, dict]] = {}
    for r in results:
        if "error" in r:
            continue
        key = (r["page"], r["kind"], r.get("resolution"))
        by_key.setdefault(key, {})[r["variant"]] = r
    for key, variants in sorted(by_key.items()):
        if "pdfplumber" in variants and "pypdfium2" in variants:
            base, poc = variants["pdfplumber"], variants["pypdfium2"]
            ratio = poc["total_ms"] / base["total_ms"] if base["total_ms"] else float("nan")
            print(f"p{key[0] + 1} {key[1]}"
                  + (f"@{key[2]}" if key[2] else "")
                  + f": pdfplumber={base['total_ms']:.1f}ms pypdfium2={poc['total_ms']:.1f}ms 比={ratio:.2f}")

    if out_dir:
        print("\n== 画像化の画素差分(既存 vs PoC) ==")
        for key, variants in sorted(by_key.items()):
            if key[1] != "image" or "pdfplumber" not in variants or "pypdfium2" not in variants:
                continue
            page, _, res = key
            a = out_dir / f"p{page + 1}_image_{res}_pdfplumber.png"
            b = out_dir / f"p{page + 1}_image_{res}_pypdfium2.png"
            diff = _image_diff(a, b)
            if diff:
                print(f"p{page + 1}@{res}: {diff}")


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == "--child":
        print(json.dumps(_run_child(json.loads(sys.argv[2])), ensure_ascii=False))
        return

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--pages", help="1始まりのページ番号(例: 1-5,10)。省略時は全ページ")
    parser.add_argument("--kinds", default="lines,texts,image")
    parser.add_argument("--resolutions", default=pp.DEFAULT_RESOLUTIONS)
    parser.add_argument("--splitter", choices=["auto", "pdflib", "pdfium"], default="auto")
    parser.add_argument("--out", type=Path, help="出力(JSON/PNG)の保存先ディレクトリ")
    args = parser.parse_args()

    import pypdfium2 as pdfium

    with pdfium.PdfDocument(str(args.pdf)) as doc:
        count = len(doc)
    pages = pp._parse_pages(args.pages, count)
    kinds = args.kinds.split(",")
    resolutions = [int(r) for r in args.resolutions.split(",")]
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        split_jobs = [{"out": f"{tmp}/p{p}.pdf", "indices": [p]} for p in pages]
        splitter = pp._split(args.pdf, split_jobs, args.splitter)
        print(f"{args.pdf.name}: {count}ページ中 {len(pages)}ページを計測(切り出し: {splitter})", file=sys.stderr)

        results = []
        for p in pages:
            pdf_path = f"{tmp}/p{p}.pdf"
            for kind in kinds:
                variant_resolutions = resolutions if kind == "image" else [None]
                for res in variant_resolutions:
                    for variant in ("pdfplumber", "pypdfium2"):
                        job = {"kind": kind, "variant": variant, "page": p, "pdf": pdf_path, "resolution": res}
                        if args.out:
                            ext = "png" if kind == "image" else "json"
                            name = f"p{p + 1}_{kind}" + (f"_{res}" if res else "") + f"_{variant}.{ext}"
                            job["dump"] = str(args.out / name)
                        r = _spawn(job)
                        results.append(r)
                        status = r["error"] if "error" in r else f"{r['total_ms']:.0f}ms"
                        print(f"  p{p + 1} {kind}{f'@{res}' if res else ''} {variant}: {status}", file=sys.stderr)

    _summarize(results, args.out)


if __name__ == "__main__":
    main()
