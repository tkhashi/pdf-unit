"""`/api/page/lines` の応答を、本番(pdfplumber)と PdfiumPage(pypdfium2)で作って突き合わせる(ADR 0037)。

    uv run python scripts/poc_compare.py <PDF> [--pages 1-3] [--f32] [--dump DIR] [--repeat 3]

- 本番側は `server.page_lines` をそのまま呼ぶ。PoC 側は同じ関数群(`extract_page_lines`・
  `calibrate_linewidth`・`extract_page_texts`・`extract_page_images`)に PdfiumPage を渡す。
  既存コードは変更しない
- 比較は応答ボディ全体。lines/texts は同じ順序の要素ごとに、キーごとの不一致件数と
  数値の最大差を数える(件数が違う場合は先頭から対応づけるため、以降は参考値)
- 時間は子プロセスで各 `--repeat` 回計り、最小値を採る(起動・キャッシュのばらつきを除く)
- `--f32`: float32 の値をそのまま使う(既定は最短の10進数に戻す)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import profile_pages as pp  # noqa: E402


def body_plumber(data: bytes) -> tuple[dict, dict[str, float]]:
    from fastapi import Response

    from pdf_unit import server

    response = Response()
    body = server.page_lines(response=response, data=data)
    return body, server._parse_server_timing(response.headers["server-timing"])


def body_pdfium(data: bytes, decimal: bool = True) -> tuple[dict, dict[str, float]]:
    """本番の page_lines と同じ区間名で計る(parse=図形の読み取り、texts.chars=文字の読み取り)。"""
    import pypdfium2 as pdfium

    from pdf_unit.calibration import calibrate_linewidth
    from pdf_unit.extract import extract_page_lines, extract_page_texts
    from pdf_unit.raster import extract_page_images
    from pdf_unit.timing import collect, stage
    from poc_pypdfium2.pdfium_page import PdfiumPage

    with collect() as timings:
        with stage("open"):
            pdf = pdfium.PdfDocument(data)
            page = PdfiumPage(pdf, 0, decimal=decimal)
        try:
            with stage("parse"):
                page.rects
            with stage("vectors"):
                lines = extract_page_lines(page)
            with stage("calib"):
                calib = calibrate_linewidth(page, page.lines + page.rects + page.curves)
            with stage("texts"):
                with stage("texts.chars"):
                    page.chars
                texts = extract_page_texts(page, data, 0)
        finally:
            pdf.close()
        with stage("images"):
            images = extract_page_images(data, 0, ()).records  # 本番の _images と同じく PNG 化しない
    stages = {name: round(sec * 1000, 1) for name, sec in timings.stages.items()}
    return {
        "page": {"width": page.width, "height": page.height},
        "linewidth_scale": calib.scale,
        "calibration": calib.method,
        "lines": lines,
        "texts": texts,
        "images": images,
    }, stages


def _normalize(body: dict) -> dict:
    return json.loads(json.dumps(body, default=list))


def _num_diff(a, b) -> float:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(a - b)
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return max((_num_diff(x, y) for x, y in zip(a, b)), default=0.0)
    return float("inf") if a != b else 0.0


def _glyphs(texts: list[dict]) -> dict[tuple[float, float], list[dict]]:
    """単語の文字(原点)を、原点の位置(0.1pt単位)で引けるようにする。単語の属性も付ける。"""
    table: dict[tuple[float, float], list[dict]] = {}
    for w in texts:
        for g in w["chars"]:
            key = (round(g["x"], 1), round(g["y"], 1))
            table.setdefault(key, []).append({**g, "fontname": w["fontname"], "color": w["color"], "word": w["text"]})
    return table


def compare_texts(xs: list[dict], ys: list[dict]) -> dict:
    """文字は原点の位置で、単語は文字列の多重集合で対応づける(並び順・分割の違いに影響されない)。"""
    from collections import Counter

    ga, gb = _glyphs(xs), _glyphs(ys)
    common = ga.keys() & gb.keys()
    diff: Counter = Counter()
    examples: dict[str, list] = {}
    for key in common:
        a, b = ga[key][0], gb[key][0]
        for k in ("text", "size", "rotation", "sx", "fontname", "color", "word"):
            if a[k] != b[k]:
                diff[k] += 1
                examples.setdefault(k, [a[k], b[k]])
    wa, wb = Counter(w["text"] for w in xs), Counter(w["text"] for w in ys)
    return {
        "glyphs": [sum(map(len, ga.values())), sum(map(len, gb.values()))],
        "glyph_positions_common": len(common),
        "glyph_only_plumber": len(ga.keys() - gb.keys()),
        "glyph_only_pdfium": len(gb.keys() - ga.keys()),
        "glyph_attr_diff": dict(diff),
        "glyph_attr_examples": examples,
        "words_same_text": sum((wa & wb).values()),
        "unreadable": [sum(w["unreadable"] for w in xs), sum(w["unreadable"] for w in ys)],
    }


def compare(a: dict, b: dict) -> dict:
    """a=本番, b=PoC。要素ごと・キーごとの不一致件数と数値の最大差。"""
    a, b = _normalize(a), _normalize(b)
    report: dict = {"identical": a == b}
    for key in ("page", "linewidth_scale", "calibration"):
        report[key] = {"plumber": a[key], "pdfium": b[key], "same": a[key] == b[key]}
    for key in ("lines", "texts", "images"):
        xs, ys = a[key], b[key]
        per_key: dict[str, dict] = {}
        for x, y in zip(xs, ys):
            for k in x.keys() | y.keys():
                if x.get(k) != y.get(k):
                    s = per_key.setdefault(k, {"diff": 0, "max_num_diff": 0.0, "example": None})
                    s["diff"] += 1
                    d = _num_diff(x.get(k), y.get(k))
                    if d > s["max_num_diff"] or s["example"] is None:
                        s["max_num_diff"] = max(s["max_num_diff"], d)
                        s["example"] = [x.get(k), y.get(k)]
        report[key] = {
            "count": [len(xs), len(ys)],
            "identical_items": sum(1 for x, y in zip(xs, ys) if x == y),
            "keys": per_key,
        }
    report["texts_by_position"] = compare_texts(a["texts"], b["texts"])
    return report


def _child(job: dict) -> None:
    data = Path(job["pdf"]).read_bytes()
    fn = body_plumber if job["variant"] == "plumber" else (lambda d: body_pdfium(d, job["decimal"]))
    runs = []
    body = None
    for _ in range(job["repeat"]):
        start = time.perf_counter()
        body, stages = fn(data)
        runs.append({"ms": (time.perf_counter() - start) * 1000, "stages": stages})
    Path(job["out"]).write_text(json.dumps(_normalize(body), ensure_ascii=False))
    print(json.dumps({"ms": [r["ms"] for r in runs], "stages": min(runs, key=lambda r: r["ms"])["stages"]}))


def run_page(pdf_path: str, repeat: int, decimal: bool, tmp: str) -> tuple[dict, dict[str, list[float]]]:
    outs, times = {}, {}
    for variant in ("plumber", "pdfium"):
        out = f"{tmp}/{variant}.json"
        job = {"pdf": pdf_path, "variant": variant, "repeat": repeat, "decimal": decimal, "out": out}
        proc = subprocess.run([sys.executable, __file__, "--child", json.dumps(job)], capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip().splitlines()[-1])
        result = json.loads(proc.stdout.strip().splitlines()[-1])
        times[variant] = result["ms"]
        times[variant + "_stages"] = result["stages"]
        outs[variant] = json.loads(Path(out).read_text())
    return compare(outs["plumber"], outs["pdfium"]), times


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == "--child":
        _child(json.loads(sys.argv[2]))
        return
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--pages")
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--f32", action="store_true")
    parser.add_argument("--splitter", choices=["auto", "pdflib", "pdfium"], default="auto")
    parser.add_argument("--label", help="表示用の名前(実PDFのファイル名を出さないため)")
    parser.add_argument("--json", type=Path, help="比較結果の保存先(JSONL)")
    args = parser.parse_args()

    import pypdfium2 as pdfium

    with pdfium.PdfDocument(str(args.pdf)) as doc:
        count = len(doc)
    pages = pp._parse_pages(args.pages, count)
    label = args.label or args.pdf.name
    out = args.json.open("a") if args.json else None
    with tempfile.TemporaryDirectory() as tmp:
        pp._split(args.pdf, [{"out": f"{tmp}/p{p}.pdf", "indices": [p]} for p in pages], args.splitter)
        for p in pages:
            report, times = run_page(f"{tmp}/p{p}.pdf", args.repeat, not args.f32, tmp)
            t_pl, t_fx = min(times["plumber"]), min(times["pdfium"])
            print(f"\n== {label} p{p + 1}: plumber {t_pl:.0f}ms / pdfium {t_fx:.0f}ms (比 {t_fx / t_pl:.2f})"
                  f"  応答が完全一致: {report['identical']}")
            top = lambda st: {k: v for k, v in st.items() if "." not in k or k == "texts.chars"}  # noqa: E731
            print(f"  区間(ms) plumber {top(times['plumber_stages'])}")
            print(f"  区間(ms) pdfium  {top(times['pdfium_stages'])}")
            for key in ("page", "linewidth_scale", "calibration"):
                r = report[key]
                if not r["same"]:
                    print(f"  {key}: plumber={r['plumber']} pdfium={r['pdfium']}")
            for key in ("lines", "images"):
                r = report[key]
                print(f"  {key}: 件数 {r['count'][0]} / {r['count'][1]}、完全一致 {r['identical_items']}")
                for k, s in sorted(r["keys"].items(), key=lambda kv: -kv[1]["diff"]):
                    ex = json.dumps(s["example"], ensure_ascii=False)
                    print(f"    {k:<11} 不一致 {s['diff']:>6}  数値の最大差 {s['max_num_diff']:.3g}  例 {ex[:160]}")
            t = report["texts_by_position"]
            print(f"  texts: 単語 {report['texts']['count'][0]} / {report['texts']['count'][1]}"
                  f"(文字列が一致する単語 {t['words_same_text']})、文字 {t['glyphs'][0]} / {t['glyphs'][1]}"
                  f"(同じ原点 {t['glyph_positions_common']}、片方だけ {t['glyph_only_plumber']} / {t['glyph_only_pdfium']})"
                  f"、□ {t['unreadable'][0]} / {t['unreadable'][1]}")
            for k, n in sorted(t["glyph_attr_diff"].items(), key=lambda kv: -kv[1]):
                ex = json.dumps(t["glyph_attr_examples"][k], ensure_ascii=False)
                print(f"    文字の{k:<9} 不一致 {n:>6}  例 {ex[:120]}")
            if out:
                out.write(json.dumps({"label": label, "page": p + 1, "times": times, "report": report},
                                     ensure_ascii=False) + "\n")
    if out:
        out.close()


if __name__ == "__main__":
    main()
