// 形状(相似形)比較
import { SHAPE_N, SHAPE_TOL } from "./constants";
import { at } from "./geometry";

export interface ShapeDescriptor {
  readonly closed: boolean;
  readonly im: Float64Array;
  readonly re: Float64Array;
}

/** 連続する同一点を除いて折れ線群の頂点を1列に並べる */
const collectPoints = (polylines: readonly (readonly number[])[]) => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const pl of polylines) {
    for (let i = 0; i < pl.length; i += 2) {
      const n = xs.length;
      if (n && xs[n - 1] === pl[i] && ys[n - 1] === pl[i + 1]) {
        continue;
      }
      xs.push(at(pl, i));
      ys.push(at(pl, i + 1));
    }
  }
  return { xs, ys };
};

/** 重心を原点・ノルム1に正規化する(ノルムが0に近ければ false) */
const normalize = (re: Float64Array, im: Float64Array): boolean => {
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < SHAPE_N; k += 1) {
    cx += at(re, k);
    cy += at(im, k);
  }
  cx /= SHAPE_N;
  cy /= SHAPE_N;
  let norm = 0;
  for (let k = 0; k < SHAPE_N; k += 1) {
    re[k] = at(re, k) - cx;
    im[k] = at(im, k) - cy;
    norm += at(re, k) * at(re, k) + at(im, k) * at(im, k);
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-9) {
    return false;
  }
  for (let k = 0; k < SHAPE_N; k += 1) {
    re[k] = at(re, k) / norm;
    im[k] = at(im, k) / norm;
  }
  return true;
};

/**
 * 折れ線を弧長で等間隔に再標本化し、重心を原点・ノルム1に正規化した複素数列にする。
 */
export const shapeDescriptor = (
  polylines: readonly (readonly number[])[]
): ShapeDescriptor | null => {
  const { xs, ys } = collectPoints(polylines);
  if (xs.length < 2) {
    return null;
  }
  const cum = [0];
  for (let i = 1; i < xs.length; i += 1) {
    cum.push(
      at(cum, i - 1) +
        Math.hypot(at(xs, i) - at(xs, i - 1), at(ys, i) - at(ys, i - 1))
    );
  }
  const total = at(cum, cum.length - 1);
  if (total < 1e-6) {
    return null;
  }
  const closed =
    Math.hypot(
      at(xs, xs.length - 1) - at(xs, 0),
      at(ys, ys.length - 1) - at(ys, 0)
    ) <
    total * 0.01;
  const re = new Float64Array(SHAPE_N);
  const im = new Float64Array(SHAPE_N);
  let j = 0;
  for (let k = 0; k < SHAPE_N; k += 1) {
    // 閉曲線は終点=始点なので周長をN等分、開曲線は両端を含めてN-1等分
    const t = (total * k) / (closed ? SHAPE_N : SHAPE_N - 1);
    while (j < cum.length - 2 && at(cum, j + 1) < t) {
      j += 1;
    }
    const seg = at(cum, j + 1) - at(cum, j);
    const u = seg > 0 ? Math.min(1, (t - at(cum, j)) / seg) : 0;
    re[k] = at(xs, j) + (at(xs, j + 1) - at(xs, j)) * u;
    im[k] = at(ys, j) + (at(ys, j + 1) - at(ys, j)) * u;
  }
  if (!normalize(re, im)) {
    return null;
  }
  return { closed, im, re };
};

/** 比較する側の点の添字(逆向き・閉曲線の巡回シフトを考慮) */
const pairIndex = (
  k: number,
  s: number,
  reversed: boolean,
  closed: boolean
): number => {
  const n = SHAPE_N;
  if (closed) {
    return reversed ? (s - k + n) % n : (s + k) % n;
  }
  return reversed ? n - 1 - k : k;
};

/**
 * 回転+一様拡大の最適当てはめ後の一致度 |<a,b>| (直交プロクラステス, 1で完全一致)。
 * 反転は conj(b)、逆向きは逆順、閉曲線は始点の巡回シフトも試して最大値を返す。
 */
export const shapeScore = (a: ShapeDescriptor, b: ShapeDescriptor): number => {
  const shifts = a.closed ? SHAPE_N : 1;
  let best = 0;
  for (const reversed of [false, true]) {
    for (let s = 0; s < shifts; s += 1) {
      // Σ a·conj(b), Σ a·b(反転)
      let r1 = 0;
      let i1 = 0;
      let r2 = 0;
      let i2 = 0;
      for (let k = 0; k < SHAPE_N; k += 1) {
        const j = pairIndex(k, s, reversed, a.closed);
        const ar = at(a.re, k);
        const ai = at(a.im, k);
        const br = at(b.re, j);
        const bi = at(b.im, j);
        r1 += ar * br + ai * bi;
        i1 += ai * br - ar * bi;
        r2 += ar * br - ai * bi;
        i2 += ar * bi + ai * br;
      }
      best = Math.max(best, Math.hypot(r1, i1), Math.hypot(r2, i2));
    }
  }
  return best;
};

interface HasShape {
  readonly shape: ShapeDescriptor | null;
}

export const sameShape = (a: HasShape, b: HasShape): boolean => {
  if (!(a.shape && b.shape) || a.shape.closed !== b.shape.closed) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const score = Math.min(1, shapeScore(a.shape, b.shape));
  return Math.sqrt(1 - score * score) < SHAPE_TOL;
};
