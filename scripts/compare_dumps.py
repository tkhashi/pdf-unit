"""`profile_pages.py --dump` で保存した2つの応答ボディのディレクトリを突き合わせる(ADR 0038)。

    uv run python scripts/compare_dumps.py <変更前のDIR> <変更後のDIR> [--jsonl 変更前.jsonl 変更後.jsonl]

- 原本画像(`*_image_*.json`)などの線データ以外はバイト単位で比べる
- 線データ(`*_lines.json`)は、`page`・`linewidth_scale`・`calibration` と、`lines`/`images` の要素ごとの
  キー単位の不一致件数・数値の最大差を出す。`texts` は並び順や単語の分割の違いに影響されないよう、
  文字は原点の位置、単語は「文字列+先頭の文字の原点」で対応づけて比べる
- `--jsonl` を渡すと、`profile_pages.py --out` の所要時間(total_ms)を API ごとに比べる
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


def _num_diff(a, b) -> float:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(a - b)
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return max((_num_diff(x, y) for x, y in zip(a, b)), default=0.0)
    return float("inf") if a != b else 0.0


def _items(xs: list[dict], ys: list[dict]) -> dict:
    per_key: dict[str, dict] = {}
    for x, y in zip(xs, ys):
        for k in x.keys() | y.keys():
            if x.get(k) != y.get(k):
                s = per_key.setdefault(k, {"diff": 0, "max_num_diff": 0.0, "example": None})
                s["diff"] += 1
                d = _num_diff(x.get(k), y.get(k))
                if s["example"] is None or d > s["max_num_diff"]:
                    s["max_num_diff"] = max(s["max_num_diff"], d)
                    s["example"] = [x.get(k), y.get(k)]
    return {"count": [len(xs), len(ys)], "identical": sum(1 for x, y in zip(xs, ys) if x == y), "keys": per_key}


def _glyphs(texts: list[dict]) -> dict[tuple[float, float], dict]:
    table: dict[tuple[float, float], dict] = {}
    for w in texts:
        for g in w["chars"]:
            table.setdefault((round(g["x"], 1), round(g["y"], 1)),
                             {**g, "fontname": w["fontname"], "color": w["color"], "word": w["text"]})
    return table


def _texts(xs: list[dict], ys: list[dict]) -> dict:
    ga, gb = _glyphs(xs), _glyphs(ys)
    common = ga.keys() & gb.keys()
    glyph_diff: Counter = Counter()
    examples: dict[str, list] = {}
    for key in common:
        for k in ("text", "size", "rotation", "sx", "fontname", "color", "word"):
            if ga[key][k] != gb[key][k]:
                glyph_diff[k] += 1
                examples.setdefault(k, [ga[key][k], gb[key][k]])

    def word_key(w):
        return (w["text"], round(w["chars"][0]["x"], 1), round(w["chars"][0]["y"], 1)) if w["chars"] else None

    bm = {word_key(w): w for w in ys}
    matched = [(w, bm[word_key(w)]) for w in xs if word_key(w) in bm]
    word_diff = Counter(k for x, y in matched for k in x if x[k] != y[k])
    bbox = max((abs(p - q) for x, y in matched for p, q in zip(x["bbox"], y["bbox"])), default=0.0)
    return {
        "words": [len(xs), len(ys)],
        "words_matched": len(matched),
        "words_identical": sum(1 for x, y in matched if x == y),
        "word_attr_diff": dict(word_diff),
        "word_bbox_max_diff": bbox,
        "glyphs": [len(ga), len(gb)],
        "glyphs_common": len(common),
        "glyph_attr_diff": dict(glyph_diff),
        "glyph_attr_examples": examples,
        "unreadable": [sum(w["unreadable"] for w in xs), sum(w["unreadable"] for w in ys)],
    }


def compare_lines(a: dict, b: dict) -> dict:
    report = {k: {"before": a.get(k), "after": b.get(k)} for k in ("page", "linewidth_scale", "calibration")
              if a.get(k) != b.get(k)}
    report["lines"] = _items(a["lines"], b["lines"])
    report["fills"] = _items(a.get("fills", []), b.get("fills", []))  # 塗りつぶしは ADR 0044 で追加
    report["clip_paths"] = _items(a.get("clip_paths", []), b.get("clip_paths", []))  # ADR 0046 で追加
    report["images"] = _items(a["images"], b["images"])
    report["texts"] = _texts(a["texts"], b["texts"])
    return report


def _print_lines(name: str, r: dict) -> None:
    print(f"\n== {name}")
    for k in ("page", "linewidth_scale", "calibration"):
        if k in r:
            print(f"  {k}: {r[k]['before']} → {r[k]['after']}")
    for k in ("lines", "fills", "clip_paths", "images"):
        s = r[k]
        print(f"  {k}: 件数 {s['count'][0]} → {s['count'][1]}、完全一致 {s['identical']}")
        for key, v in sorted(s["keys"].items(), key=lambda kv: -kv[1]["diff"]):
            ex = json.dumps(v["example"], ensure_ascii=False)
            print(f"    {key:<10} 不一致 {v['diff']:>6}  数値の最大差 {v['max_num_diff']:.3g}  例 {ex[:150]}")
    t = r["texts"]
    print(f"  texts: 単語 {t['words'][0]} → {t['words'][1]}(対応 {t['words_matched']}、完全一致 {t['words_identical']}、"
          f"bbox の最大差 {t['word_bbox_max_diff']:.4g}pt)、文字 {t['glyphs'][0]} → {t['glyphs'][1]}"
          f"(同じ原点 {t['glyphs_common']})、□ {t['unreadable'][0]} → {t['unreadable'][1]}")
    if t["word_attr_diff"]:
        print(f"    対応した単語で異なる項目: {t['word_attr_diff']}")
    for k, n in sorted(t["glyph_attr_diff"].items(), key=lambda kv: -kv[1]):
        print(f"    文字の{k:<9} 不一致 {n:>6}  例 {json.dumps(t['glyph_attr_examples'][k], ensure_ascii=False)[:120]}")


def _timings(before: Path, after: Path) -> None:
    def load(p: Path) -> dict[str, float]:
        out = {}
        for line in p.read_text().splitlines():
            r = json.loads(line)
            if "total_ms" in r:
                label = f"p{r['page'] + 1} {r['kind']}" + (f"@{r['resolution']}" if r.get("resolution") else "") + \
                        (f"#{r['index']}" if r.get("index") is not None else "")
                out[label] = r["total_ms"]
        return out

    a, b = load(before), load(after)
    print("\n== 所要時間(ms)")
    for k in a.keys() & b.keys():
        print(f"  {k:<18} {a[k]:>9.1f} → {b[k]:>9.1f}  (比 {b[k] / a[k]:.2f})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--jsonl", type=Path, nargs=2)
    args = parser.parse_args()

    names = sorted(p.name for p in args.before.glob("*.json"))
    missing = sorted({p.name for p in args.after.glob("*.json")} ^ set(names))
    if missing:
        print(f"片方にしか無いファイル: {missing}")
    same_bytes = []
    for name in names:
        a, b = args.before / name, args.after / name
        if not b.exists():
            continue
        if name.endswith("_lines.json"):
            _print_lines(name, compare_lines(json.loads(a.read_text()), json.loads(b.read_text())))
        else:
            same_bytes.append((name, a.read_bytes() == b.read_bytes()))
    if same_bytes:
        print("\n== 画像(バイト単位)")
        for name, same in same_bytes:
            print(f"  {name}: {'一致' if same else '不一致'}")
    if args.jsonl:
        _timings(*args.jsonl)


if __name__ == "__main__":
    main()
