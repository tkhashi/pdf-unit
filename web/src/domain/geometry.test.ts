import { describe, expect, it } from "vitest";
import {
  distPointSeg,
  distToBox,
  distToPolylines,
  distToQuad,
  inPolylines,
  inQuad,
  insetQuad,
  quadMinSide,
} from "./geometry";

const square = [0, 10, 10, 10, 10, 0, 0, 0];

describe("幾何", () => {
  it("線分までの距離は端点で打ち切る", () => {
    expect(distPointSeg(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(distPointSeg(13, 4, 0, 0, 10, 0)).toBe(5);
    expect(distPointSeg(3, 4, 0, 0, 0, 0)).toBe(5);
  });

  it("四隅の多角形の内側は距離0、外側は辺までの距離", () => {
    expect(inQuad(5, 5, square)).toBe(true);
    expect(inQuad(11, 5, square)).toBe(false);
    expect(distToQuad(5, 5, square)).toBe(0);
    expect(distToQuad(13, 5, square)).toBe(3);
  });

  it("塗りの規則で、同じ向きに重ねた内側の範囲の扱いが変わる", () => {
    const outer = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0];
    const inner = [3, 3, 7, 3, 7, 7, 3, 7, 3, 3];
    expect(inPolylines(5, 5, [outer, inner], "nonzero")).toBe(true);
    expect(inPolylines(5, 5, [outer, inner], "evenodd")).toBe(false);
    expect(inPolylines(1, 5, [outer, inner], "evenodd")).toBe(true);
    expect(inPolylines(11, 5, [outer, inner], "nonzero")).toBe(false);
    expect(distToPolylines(5, 5, [outer, inner])).toBe(2);
  });

  it("枠までの距離", () => {
    expect(distToBox(5, 5, [0, 0, 10, 10])).toBe(0);
    expect(distToBox(13, 14, [0, 0, 10, 10])).toBe(5);
  });

  it("四隅を内側へ寄せる", () => {
    expect(insetQuad(square, 1)).toEqual([1, 9, 9, 9, 9, 1, 1, 1]);
    expect(quadMinSide([0, 4, 10, 4, 10, 0, 0, 0])).toBe(4);
  });
});
