// 幾何計算(ヒット判定・ハイライト)。座標は pt、左上原点
import type { Bbox } from "./types";

/** 配列の要素(範囲は呼び出し側で保証する。noUncheckedIndexedAccess の undefined を数値計算に持ち込まない) */
export const at = (a: ArrayLike<number>, i: number): number => a[i] as number;

/** 四隅 [x, y] * 4 の多角形の内側か(偶奇規則) */
export const inQuad = (
  px: number,
  py: number,
  q: readonly number[]
): boolean => {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i, i += 1) {
    const xi = at(q, i * 2);
    const yi = at(q, i * 2 + 1);
    const xj = at(q, j * 2);
    const yj = at(q, j * 2 + 1);
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

export const distPointSeg = (
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 > 0
      ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
      : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

/** 四隅の多角形までの距離(内側なら0)。回転画像ではbboxの角が画像外になるため */
export const distToQuad = (
  px: number,
  py: number,
  q: readonly number[]
): number => {
  if (inQuad(px, py, q)) {
    return 0;
  }
  let d = Number.POSITIVE_INFINITY;
  for (let i = 0, j = 3; i < 4; j = i, i += 1) {
    d = Math.min(
      d,
      distPointSeg(
        px,
        py,
        at(q, j * 2),
        at(q, j * 2 + 1),
        at(q, i * 2),
        at(q, i * 2 + 1)
      )
    );
  }
  return d;
};

export const distToBox = (
  px: number,
  py: number,
  [x0, top, x1, bottom]: Bbox
): number => {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dy = Math.max(top - py, 0, py - bottom);
  return Math.hypot(dx, dy);
};

/** 四隅(左下・右下・右上・左上)を各辺から d だけ内側へ寄せる(長方形・回転した長方形を想定) */
export const insetQuad = (q: readonly number[], d: number): number[] => {
  const ux = at(q, 2) - at(q, 0);
  const uy = at(q, 3) - at(q, 1);
  const vx = at(q, 6) - at(q, 0);
  const vy = at(q, 7) - at(q, 1);
  const ul = Math.hypot(ux, uy) || 1;
  const vl = Math.hypot(vx, vy) || 1;
  const ax = (ux / ul) * d;
  const ay = (uy / ul) * d;
  const bx = (vx / vl) * d;
  const by = (vy / vl) * d;
  return [
    at(q, 0) + ax + bx,
    at(q, 1) + ay + by, // 左下
    at(q, 2) - ax + bx,
    at(q, 3) - ay + by, // 右下
    at(q, 4) - ax - bx,
    at(q, 5) - ay - by, // 右上
    at(q, 6) + ax - bx,
    at(q, 7) + ay - by, // 左上
  ];
};

export const quadMinSide = (q: readonly number[]): number =>
  Math.min(
    Math.hypot(at(q, 2) - at(q, 0), at(q, 3) - at(q, 1)),
    Math.hypot(at(q, 6) - at(q, 0), at(q, 7) - at(q, 1))
  );
