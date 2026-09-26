import { describe, expect, it } from "vitest";
import { fitView, neededResolution, toPage, zoomAt } from "./view";

describe("表示変換", () => {
  it("余白24pxを残して中央に収める", () => {
    expect(
      fitView({ height: 100, width: 200 }, { height: 348, width: 448 })
    ).toEqual({
      scale: 2,
      x: 24,
      y: 74,
    });
  });

  it("カーソル位置を中心にズームし、0.1〜400倍に収める", () => {
    const v = zoomAt({ scale: 1, x: 0, y: 0 }, { x: 100, y: 50 }, -1000);
    expect(toPage(v, { x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
    expect(zoomAt({ scale: 399, x: 0, y: 0 }, { x: 0, y: 0 }, -1e4).scale).toBe(
      400
    );
    expect(zoomAt({ scale: 0.11, x: 0, y: 0 }, { x: 0, y: 0 }, 1e4).scale).toBe(
      0.1
    );
  });

  it("原本画像の解像度段階", () => {
    expect(neededResolution(1, 1)).toBe(100);
    expect(neededResolution(1.5, 1)).toBe(200);
    expect(neededResolution(2, 2)).toBe(400);
    expect(neededResolution(20, 2)).toBe(400);
  });
});
