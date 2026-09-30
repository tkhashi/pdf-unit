import { describe, expect, it } from "vitest";
import { sampleLines } from "../test/sample";
import { describe as describeItem } from "./describe";
import type { Item } from "./items";
import { buildPageModel } from "./page-model";
import { filterSelection, type Selection, selectNext } from "./selection";

const m = buildPageModel(sampleLines());
const none = () => false;
const item = (id: number) => m.items[id] as Item;

const cycle = (id: number) => {
  const seen: string[] = [];
  let s: Selection | null = null;
  for (let k = 0; k < 10; k += 1) {
    s = selectNext(m.items, s, id, none);
    if (!s) {
      break;
    }
    seen.push(`${s.label}=${s.value}:${s.members.join(",")}`);
  }
  return seen;
};

describe("クリックでの属性の巡回", () => {
  it("線は種類→線幅→長さ→…と進み、同じ集合になる属性は飛ばす", () => {
    // 描画太さ(0.50pt)は線幅と、濃淡は色と同じ集合になるため飛ばす
    expect(cycle(0)).toEqual([
      "種類=line:0,1,2",
      "線幅=1:0,1,3",
      "長さ=100.00pt:0,1",
      "色=rgb(0,0,0):0,2,3",
    ]);
  });

  it("別の要素をクリックすると最初の属性からやり直す", () => {
    const a = selectNext(m.items, null, 0, none);
    const b = selectNext(m.items, a, 1, none);
    expect(b?.level).toBe(0);
    expect(b?.anchor).toBe(1);
  });

  it("表示対象から外れた要素を選択から外し、起点が外れたら解除する", () => {
    const s = selectNext(m.items, null, 3, none);
    const lw = selectNext(m.items, s, 3, none);
    expect(lw?.members).toEqual([0, 1, 3]);
    const filtered = filterSelection(m.items, lw, (t) => t === "line");
    expect(filtered?.members).toEqual([3]);
    expect(filtered?.level).toBe(lw?.level);
    expect(filterSelection(m.items, lw, (t) => t === "rect")).toBeNull();
  });
});

describe("属性パネル", () => {
  it("選択中の属性の行に件数を付ける", () => {
    const s = selectNext(m.items, null, 0, none);
    const rows = describeItem(m.items, item(1), s, m.lwScale);
    expect(rows.map((r) => [r.label, r.count])).toEqual([
      ["種類", 3],
      ["線幅", null],
      ["長さ", null],
      ["描画太さ", null],
      ["色", null],
      ["濃淡", null],
      ["bbox", null],
    ]);
    expect(rows[3]?.value).toEqual({
      kind: "plain",
      text: "0.50pt (補正×0.5)",
    });
    expect(rows[6]?.value).toEqual({
      kind: "plain",
      text: "(10.00, 30.00) - (110.00, 30.00)",
    });
  });

  it("塗りつぶしは線幅を示し、描画太さは示さない", () => {
    const fill = describeItem(m.items, item(6), null, m.lwScale);
    expect(fill.map((r) => r.label)).toEqual([
      "種類",
      "線幅",
      "色",
      "濃淡",
      "bbox",
    ]);
    expect(fill[1]?.value).toEqual({ kind: "plain", text: "2.5" });
    // 線とは別の種類として巡回する(同じ線幅の線を含めない)
    expect(cycle(6)).toEqual(["種類=fill:6"]);
  });

  it("文字・画像の行", () => {
    const text = describeItem(m.items, item(4), null, m.lwScale);
    expect(text.map((r) => r.label)).toEqual([
      "text",
      "種類",
      "フォント",
      "サイズ",
      "色",
      "濃淡",
      "bbox",
    ]);
    const image = describeItem(m.items, item(5), null, m.lwScale);
    expect(image.map((r) => r.label)).toEqual([
      "種類",
      "画素数",
      "解像度",
      "圧縮形式",
      "配置",
      "bbox",
    ]);
    expect(image[1]?.value).toEqual({ kind: "plain", text: "60×40px" });
  });
});
