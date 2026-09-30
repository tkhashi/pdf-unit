import { describe, expect, it } from "vitest";
import { sampleLines } from "../test/sample";
import { buildPageModel, effWidth } from "./page-model";
import { pick } from "./spatial-index";

const none = () => false;

describe("ページのモデル", () => {
  it("線・文字・画像・塗りつぶしの順に通し番号を振り、長さと描画太さを求める", () => {
    const m = buildPageModel(sampleLines());
    expect(m.items.map((item) => `${item.id}:${item.type}`)).toEqual([
      "0:line",
      "1:line",
      "2:line",
      "3:rect",
      "4:text",
      "5:image",
      "6:fill",
    ]);
    expect(m.counts).toEqual({ fill: 1, image: 1, line: 3, rect: 1, text: 1 });
    const [first] = m.items;
    expect(first && "length" in first ? first.length : null).toBe(100);
    expect(first && "w" in first ? first.w : null).toBe(0.5);
  });

  it("描画太さは線幅×係数(線幅なしは0.5、下限0.15)", () => {
    expect(effWidth(null, 1)).toBe(0.5);
    expect(effWidth(0, 1)).toBe(0.15);
    expect(effWidth(2, 0.5)).toBe(1);
  });
});

describe("ヒット判定", () => {
  const m = buildPageModel(sampleLines());

  it("許容距離内で中心線に最も近い線を選ぶ", () => {
    expect(pick(m.items, m.index, 50, 12, 1, none)).toBe(0);
    expect(pick(m.items, m.index, 50, 28, 1, none)).toBe(1);
    expect(pick(m.items, m.index, 50, 20, 1, none)).toBe(-1);
  });

  it("文字・画像は枠内でも重なる線より後回し", () => {
    expect(pick(m.items, m.index, 120, 46, 1, none)).toBe(4);
    expect(pick(m.items, m.index, 230, 220, 1, none)).toBe(5);
  });

  it("塗りつぶしは塗りの範囲(穴は除く)と縁の近くで選ぶ", () => {
    expect(pick(m.items, m.index, 310, 30, 1, none)).toBe(6);
    expect(pick(m.items, m.index, 365, 50, 1, none)).toBe(6);
    // 偶奇規則の穴の中央(縁から10pt)は範囲外
    expect(pick(m.items, m.index, 330, 50, 1, none)).toBe(-1);
    expect(pick(m.items, m.index, 310, 30, 1, (t) => t === "fill")).toBe(-1);
  });

  it("非表示の種類は選ばない。倍率で許容距離が変わる", () => {
    expect(pick(m.items, m.index, 50, 12, 1, (t) => t === "line")).toBe(-1);
    expect(pick(m.items, m.index, 50, 17, 1, none)).toBe(0);
    expect(pick(m.items, m.index, 50, 17, 4, none)).toBe(-1);
  });
});
