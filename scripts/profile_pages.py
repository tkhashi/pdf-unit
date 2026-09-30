"""PDFのページごとにAPIの所要時間・内訳・応答サイズ・ピークメモリを計測する(ADR 0023)。

    uv run python scripts/profile_pages.py <PDF> [--pages 1-5,10] [--endpoints lines,image]
        [--resolutions 100,200,400] [--out result.jsonl] [--dump DIR] [--cprofile DIR]

- ページの切り出しは UI と同じく pdf-lib(web/ の依存。Node.js)で行う(copyPages、useObjectStreams: false)。
  Node.js か pdf-lib(pnpm --dir web install)が無い場合は pypdfium2 で切り出す(バイト列が UI と異なるため、計測値の比較には注意)。
- 1回のAPI呼び出しごとに子プロセスを起動し、ASGI アプリを直接呼ぶ(Depends・JSON 直列化・ミドルウェアを含む
  実際の処理経路)。子プロセスの ru_maxrss を、その呼び出しのピークメモリとみなす。
- ブラウザと同じく Accept-Encoding: gzip を付けて送る。resp_bytes は展開後、wire_bytes は転送される大きさ、
  lambda_bytes は Lambda の応答上限(6MB)と比べる大きさの推定(圧縮した応答は Lambda Web Adapter が base64 化
  するので4/3倍)。--dump には展開後のボディを保存する。
- 所要時間の内訳はサーバーが返す Server-Timing / X-Perf-Metrics ヘッダーから取る。
  other_ms = 全体 - 内訳の上位区間の合計(リクエストの受信・検証、JSON 直列化など)。
- --dump DIR: 各応答のボディを保存する(変更前後で出力が同一かを cmp で確かめる用)。
- --cprofile DIR: エンドポイント関数を(スレッドプールを介さず)直接呼んで cProfile を保存する。
  プロファイラのオーバーヘッドで時間は増えるので、所要時間の計測とは別に実行する。
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import gzip
import io
import json
import os
import resource
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# UI と同じ pdf-lib(web/ の依存。pnpm --dir web install で入る)
PDF_LIB = ROOT / "web" / "node_modules" / "pdf-lib" / "dist" / "pdf-lib.min.js"
# UI と同じ値(web/src/domain/constants.ts の RESOLUTIONS)
DEFAULT_RESOLUTIONS = "100,200,400"
MAX_SEND_BYTES = 4 * 1024 * 1024

# UI の extractPages と同じ処理で、指定ページだけを含むPDFを書き出す
_SPLIT_JS = r"""
const [lib, src, jobsJson] = process.argv.slice(1);
const PDFLib = require(lib);
const fs = require("fs");
(async () => {
  const pdf = await PDFLib.PDFDocument.load(fs.readFileSync(src), { updateMetadata: false });
  for (const { out, indices } of JSON.parse(fs.readFileSync(jobsJson, "utf8"))) {
    const doc = await PDFLib.PDFDocument.create();
    for (const page of await doc.copyPages(pdf, indices)) doc.addPage(page);
    fs.writeFileSync(out, await doc.save({ useObjectStreams: false }));
  }
})().catch((e) => { console.error(e); process.exit(1); });
"""


def _maxrss_mb() -> float:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(rss / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)


# ---- 子プロセス ----

async def _asgi_post(app, path: str, query: str, body: bytes) -> tuple[int, dict[str, str], bytes]:
    """ASGI アプリに POST を1回送り、ステータス・ヘッダー・ボディを返す(httpx を使わない最小の呼び出し)。"""
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": query.encode(),
        "root_path": "", "server": ("127.0.0.1", 8000), "client": ("127.0.0.1", 50000),
        "headers": [
            (b"content-type", b"application/pdf"),
            (b"content-length", str(len(body)).encode()),
            (b"accept-encoding", b"gzip"),  # ブラウザと同じ
        ],
    }
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            await asyncio.Event().wait()  # 切断待ち(呼ばれても応答完了まで返さない)
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    status, headers, chunks = 0, {}, []

    async def send(message):
        nonlocal status, headers
        if message["type"] == "http.response.start":
            status = message["status"]
            headers = {k.decode().lower(): v.decode() for k, v in message["headers"]}
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    await app(scope, receive, send)
    return status, headers, b"".join(chunks)


def _parse_server_timing(value: str) -> dict[str, float]:
    stages = {}
    for entry in filter(None, (e.strip() for e in value.split(","))):
        name, _, dur = entry.partition(";dur=")
        stages[name] = float(dur)
    return stages


def _run_child(job: dict) -> dict:
    from pdf_unit import server

    data = Path(job["pdf"]).read_bytes()
    result = {k: job[k] for k in ("kind", "page", "resolution") if k in job}
    result["req_bytes"] = len(data)
    result["over_limit"] = len(data) > MAX_SEND_BYTES  # UI では送信しない大きさ(計測はする)
    result["maxrss_base_mb"] = _maxrss_mb()

    if job.get("cprofile"):
        import cProfile

        from fastapi import Response

        call = {
            "lines": lambda: server.page_lines(response=Response(), data=data),
            "image": lambda: server.page_image(response=Response(), resolution=job["resolution"], data=data),
        }[job["kind"]]
        profiler = cProfile.Profile()
        start = time.perf_counter()
        profiler.runcall(call)
        result["total_ms"] = round((time.perf_counter() - start) * 1000, 1)
        profiler.dump_stats(job["cprofile"])
        result["maxrss_mb"] = _maxrss_mb()
        return result

    path, query = {
        "lines": ("/api/page/lines", ""),
        "image": ("/api/page/image", f"resolution={job.get('resolution')}"),
    }[job["kind"]]
    log = io.StringIO()  # ミドルウェアの計測ログは捨てる(同じ値をヘッダーから取る)
    start = time.perf_counter()
    with contextlib.redirect_stdout(log):
        status, headers, body = asyncio.run(_asgi_post(server.app, path, query, data))
    total = (time.perf_counter() - start) * 1000
    wire = len(body)
    compressed = headers.get("content-encoding") == "gzip"
    if compressed:
        body = gzip.decompress(body)
    stages = _parse_server_timing(headers.get("server-timing", ""))
    top = sum(v for k, v in stages.items() if "." not in k and k != "lock_wait")
    result.update(
        status=status,
        total_ms=round(total, 1),
        other_ms=round(total - top, 1),
        resp_bytes=len(body),
        wire_bytes=wire,
        lambda_bytes=wire * 4 // 3 if compressed else wire,
        stages_ms=stages,
        metrics=json.loads(headers.get("x-perf-metrics", "{}")),
        maxrss_mb=_maxrss_mb(),
    )
    if job.get("dump"):
        Path(job["dump"]).write_bytes(body)
    return result


# ---- 親プロセス ----

def _parse_pages(spec: str | None, count: int) -> list[int]:
    if not spec:
        return list(range(count))
    pages: list[int] = []
    for part in spec.split(","):
        lo, _, hi = part.partition("-")
        pages.extend(range(int(lo) - 1, int(hi or lo)))
    return sorted({p for p in pages if 0 <= p < count})


def _split(pdf: Path, jobs: list[dict], splitter: str) -> str:
    """jobs の各 {out, indices} について、指定ページだけのPDFを書き出す。使った方式を返す。"""
    if splitter == "auto":
        splitter = "pdflib" if shutil.which("node") and PDF_LIB.is_file() else "pdfium"
    if splitter == "pdflib":
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(jobs, f)
        try:
            subprocess.run(["node", "-e", _SPLIT_JS, str(PDF_LIB), str(pdf), f.name], check=True)
        finally:
            os.unlink(f.name)
    else:
        import pypdfium2 as pdfium

        src = pdfium.PdfDocument(str(pdf))
        for job in jobs:
            dst = pdfium.PdfDocument.new()
            dst.import_pages(src, job["indices"])
            dst.save(job["out"])
            dst.close()
        src.close()
    return splitter


def _spawn(job: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, __file__, "--child", json.dumps(job)], capture_output=True, text=True
    )
    if proc.returncode != 0:
        return {**{k: job.get(k) for k in ("kind", "page", "resolution")},
                "error": proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else f"exit {proc.returncode}"}
    return json.loads(proc.stdout.strip().splitlines()[-1])


def _label(r: dict) -> str:
    label = r["kind"]
    if r.get("resolution"):
        label += f"@{r['resolution']}"
    return label


def _summarize(results: list[dict]) -> None:
    ok = [r for r in results if "error" not in r and r.get("status") == 200]
    failed = [r for r in results if "error" not in r and r.get("status") != 200]
    errors = [r for r in results if "error" in r]
    print("\n== 呼び出しごと(所要時間の大きい順、上位20件) ==")
    print(f"{'page':>5} {'api':<14} {'total_ms':>9} {'other_ms':>9} {'req_KB':>8} {'resp_KB':>8} {'wire_KB':>8} {'maxrss_MB':>9}  主な区間")
    for r in sorted(ok, key=lambda r: -r["total_ms"])[:20]:
        stages = sorted(((k, v) for k, v in r.get("stages_ms", {}).items()), key=lambda kv: -kv[1])[:4]
        print(f"{r['page'] + 1:>5} {_label(r):<14} {r['total_ms']:>9.1f} {r.get('other_ms', 0):>9.1f} "
              f"{r['req_bytes'] / 1024:>8.0f} {r.get('resp_bytes', 0) / 1024:>8.0f} "
              f"{r.get('wire_bytes', r.get('resp_bytes', 0)) / 1024:>8.0f} {r['maxrss_mb']:>9.1f}  "
              + ", ".join(f"{k}={v:.0f}" for k, v in stages))

    print("\n== API・区間ごとの合計と最大(ms) ==")
    groups: dict[str, dict[str, list[float]]] = {}
    for r in ok:
        g = groups.setdefault(_label(r).split("#")[0], {})
        g.setdefault("total", []).append(r["total_ms"])
        g.setdefault("other", []).append(r.get("other_ms", 0.0))
        for k, v in r.get("stages_ms", {}).items():
            g.setdefault(k, []).append(v)
    for api, stages in groups.items():
        print(f"[{api}] 呼び出し {len(stages['total'])} 回")
        for k, vs in sorted(stages.items(), key=lambda kv: -sum(kv[1])):
            print(f"  {k:<16} 合計 {sum(vs):>10.1f}  最大 {max(vs):>9.1f}  平均 {sum(vs) / len(vs):>9.1f}")

    print("\n== 上限・メモリ ==")
    if ok:
        size = lambda r: r.get("lambda_bytes", r.get("resp_bytes", 0))  # noqa: E731
        big = max(ok, key=size)
        print(f"応答の最大(Lambda での推定): {size(big) / 1024 / 1024:.2f}MB (p{big['page'] + 1} {_label(big)}、"
              f"展開後 {big.get('resp_bytes', 0) / 1024 / 1024:.2f}MB、Lambda の上限は6MB)")
        over = [f"p{r['page'] + 1} {_label(r)}" for r in ok if size(r) > 6 * 1024 * 1024]
        if over:
            print(f"Lambda の応答上限を超える呼び出し: {over}")
        peak = max(ok, key=lambda r: r["maxrss_mb"])
        print(f"ピークメモリの最大: {peak['maxrss_mb']:.0f}MB (p{peak['page'] + 1} {_label(peak)}、"
              f"起動直後 {peak['maxrss_base_mb']:.0f}MB、Lambda は2048MB)")
    over = sorted({r["page"] + 1 for r in results if r.get("over_limit")})
    if over:
        # 1ページ分がこの大きさを超えると UI では処理できない
        print("送信上限(4MB)を超える切り出し: " + ", ".join(f"p{p}" for p in over))
    for r in failed:
        print(f"HTTP {r['status']}: p{r['page'] + 1} {_label(r)}(集計から除外)")
    for r in errors:
        print(f"エラー: p{r['page'] + 1} {_label(r)}: {r['error']}")


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == "--child":
        print(json.dumps(_run_child(json.loads(sys.argv[2])), ensure_ascii=False))
        return

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--pages", help="1始まりのページ番号(例: 1-5,10)。省略時は全ページ")
    parser.add_argument("--endpoints", default="lines,image")
    parser.add_argument("--resolutions", default=DEFAULT_RESOLUTIONS, help="原本画像の解像度(dpi)")
    parser.add_argument("--splitter", choices=["auto", "pdflib", "pdfium"], default="auto")
    parser.add_argument("--out", type=Path, help="結果の JSONL")
    parser.add_argument("--dump", type=Path, help="応答ボディの保存先ディレクトリ")
    parser.add_argument("--cprofile", type=Path, help="cProfile の保存先ディレクトリ")
    args = parser.parse_args()

    import pypdfium2 as pdfium

    with pdfium.PdfDocument(str(args.pdf)) as doc:
        count = len(doc)
    pages = _parse_pages(args.pages, count)
    endpoints = args.endpoints.split(",")
    resolutions = [int(r) for r in args.resolutions.split(",")]
    for d in (args.dump, args.cprofile):
        if d:
            d.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        split_jobs = [{"out": f"{tmp}/p{p}.pdf", "indices": [p]} for p in pages]
        splitter = _split(args.pdf, split_jobs, args.splitter)
        print(f"{args.pdf.name}: {count}ページ中 {len(pages)}ページを計測(切り出し: {splitter})", file=sys.stderr)

        def job(kind: str, page: int, pdf: str, **extra) -> dict:
            j = {"kind": kind, "page": page, "pdf": pdf, **extra}
            name = f"p{page + 1}_{kind}" + "".join(f"_{v}" for v in extra.values())
            if args.dump:
                j["dump"] = str(args.dump / f"{name}.json")
            if args.cprofile:
                j["cprofile"] = str(args.cprofile / f"{name}.prof")
            return j

        results = []
        out = args.out.open("w") if args.out else None
        try:
            def run(j: dict) -> dict:
                r = _spawn(j)
                results.append(r)
                if out:
                    out.write(json.dumps(r, ensure_ascii=False) + "\n")
                    out.flush()
                status = r["error"] if "error" in r else "" if r.get("status", 200) == 200 else f" HTTP {r['status']}"
                print(f"  p{j['page'] + 1} {_label(j)}: "
                      + (status if "error" in r else f"{r['total_ms']:.0f}ms{status}"), file=sys.stderr)
                return r

            for p in pages:
                pdf = f"{tmp}/p{p}.pdf"
                if "lines" in endpoints:
                    run(job("lines", p, pdf))
                if "image" in endpoints:
                    for res in resolutions:
                        run(job("image", p, pdf, resolution=res))
        finally:
            if out:
                out.close()

    if not args.cprofile:
        _summarize(results)
    else:
        print(f"\ncProfile を {args.cprofile} に保存しました(例: python -m pstats {args.cprofile}/<file>.prof)")


if __name__ == "__main__":
    main()
