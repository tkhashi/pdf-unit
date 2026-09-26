import { describe, expect, it } from "vitest";
import { sameShape, shapeDescriptor } from "./shape";

const circle = (r: number, cx: number, cy: number, n = 48): number[] => {
  const pts: number[] = [];
  for (let k = 0; k <= n; k += 1) {
    const t = (2 * Math.PI * k) / n;
    pts.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
  }
  return pts;
};

const withShape = (polylines: number[][]) => ({
  shape: shapeDescriptor(polylines),
});

describe("形状の比較", () => {
  it("大きさ・位置の違う円は同じ形状", () => {
    const a = withShape([circle(10, 0, 0)]);
    const b = withShape([circle(35, 100, 50)]);
    expect(a.shape?.closed).toBe(true);
    expect(sameShape(a, b)).toBe(true);
  });

  it("逆向き・鏡像の開曲線も同じ形状、別の形は違う", () => {
    const s = [[0, 0, 10, 10, 20, 0, 30, -10, 40, 0]];
    const reversed = [[40, 0, 30, -10, 20, 0, 10, 10, 0, 0]];
    const mirrored = [[0, 0, 10, -10, 20, 0, 30, 10, 40, 0]];
    const other = [[0, 0, 10, 30, 20, 0, 30, 0, 40, 0]];
    expect(sameShape(withShape(s), withShape(reversed))).toBe(true);
    expect(sameShape(withShape(s), withShape(mirrored))).toBe(true);
    expect(sameShape(withShape(s), withShape(other))).toBe(false);
  });

  it("点が足りない・長さが0なら形状なし", () => {
    expect(shapeDescriptor([[1, 1]])).toBeNull();
    expect(shapeDescriptor([[1, 1, 1, 1]])).toBeNull();
    expect(sameShape({ shape: null }, { shape: null })).toBe(false);
  });

  it("閉曲線と開曲線は比べない", () => {
    const closed = withShape([circle(10, 0, 0)]);
    const open = withShape([circle(10, 0, 0).slice(0, 40)]);
    expect(sameShape(closed, open)).toBe(false);
  });
});
