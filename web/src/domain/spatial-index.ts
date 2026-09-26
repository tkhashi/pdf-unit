// ヒット判定用: 線分 + 空間インデックス(値 >=0: 線分index, <0: -(面要素のid+1))
import { AREA_PENALTY, CELL, HIT_PX, type ItemType } from "./constants";
import { at, distPointSeg, distToBox, distToQuad } from "./geometry";
import { type Item, isArea, isImage } from "./items";

export interface SpatialIndex {
  readonly grid: ReadonlyMap<number, readonly number[]>;
  readonly maxHalfWidth: number;
  readonly segOwner: Int32Array;
  readonly segs: Float64Array;
}

const cellKey = (cx: number, cy: number): number => cx * 100_000 + cy;

const addToGrid = (
  grid: Map<number, number[]>,
  [x0, y0, x1, y1]: readonly [number, number, number, number],
  value: number
): void => {
  const cx0 = Math.floor(Math.min(x0, x1) / CELL);
  const cx1 = Math.floor(Math.max(x0, x1) / CELL);
  const cy0 = Math.floor(Math.min(y0, y1) / CELL);
  const cy1 = Math.floor(Math.max(y0, y1) / CELL);
  for (let cx = cx0; cx <= cx1; cx += 1) {
    for (let cy = cy0; cy <= cy1; cy += 1) {
      const key = cellKey(cx, cy);
      const cell = grid.get(key);
      if (cell) {
        cell.push(value);
      } else {
        grid.set(key, [value]);
      }
    }
  }
};

const countSegments = (items: readonly Item[]): number => {
  let n = 0;
  for (const it of items) {
    if (!isArea(it)) {
      for (const pl of it.polylines) {
        n += pl.length / 2 - 1;
      }
    }
  }
  return n;
};

/** インデックスを作る(作成中だけ内部の配列・Map を書き換え、以後は読み取り専用として扱う) */
export const buildIndex = (items: readonly Item[]): SpatialIndex => {
  const n = countSegments(items);
  const segs = new Float64Array(n * 4);
  const segOwner = new Int32Array(n);
  const grid = new Map<number, number[]>();
  let maxHalfWidth = 0;
  let k = 0;
  for (const it of items) {
    if (isArea(it)) {
      addToGrid(grid, it.bbox, -(it.id + 1));
      continue;
    }
    maxHalfWidth = Math.max(maxHalfWidth, it.w / 2);
    for (const pl of it.polylines) {
      for (let i = 0; i + 3 < pl.length; i += 2, k += 1) {
        const seg = [
          at(pl, i),
          at(pl, i + 1),
          at(pl, i + 2),
          at(pl, i + 3),
        ] as const;
        segs.set(seg, k * 4);
        segOwner[k] = it.id;
        addToGrid(grid, seg, k);
      }
    }
  }
  return { grid, maxHalfWidth, segOwner, segs };
};

export const EMPTY_INDEX: SpatialIndex = buildIndex([]);

/** 候補のスコア(小さいほど優先)。許容距離外・非表示なら Infinity */
const scoreOf = (
  it: Item,
  index: SpatialIndex,
  v: number,
  px: number,
  py: number,
  tol: number,
  isHidden: (type: ItemType) => boolean
): number => {
  if (isHidden(it.type)) {
    return Number.POSITIVE_INFINITY;
  }
  if (isArea(it)) {
    const d = isImage(it)
      ? distToQuad(px, py, it.quad)
      : distToBox(px, py, it.bbox);
    return d > tol ? Number.POSITIVE_INFINITY : d + tol * AREA_PENALTY[it.type];
  }
  const s = index.segs;
  const c = distPointSeg(
    px,
    py,
    at(s, v * 4),
    at(s, v * 4 + 1),
    at(s, v * 4 + 2),
    at(s, v * 4 + 3)
  );
  return c - it.w / 2 > tol ? Number.POSITIVE_INFINITY : c;
};

/**
 * 候補: 線の縁(描画太さ込み)まで許容距離以内。その中で中心線に最も近いものを選ぶ
 * (描画上重なって見える極細の密集線でも、中心線の近さで1本に決まる)。
 * 文字・画像は枠内でもペナルティを付け、重なる線を優先する(画像は四隅の多角形で判定)。
 * 見つからなければ -1。
 */
export const pick = (
  items: readonly Item[],
  index: SpatialIndex,
  px: number,
  py: number,
  scale: number,
  isHidden: (type: ItemType) => boolean
): number => {
  const tol = HIT_PX / scale;
  const r = tol + index.maxHalfWidth;
  const cx0 = Math.floor((px - r) / CELL);
  const cx1 = Math.floor((px + r) / CELL);
  const cy0 = Math.floor((py - r) / CELL);
  const cy1 = Math.floor((py + r) / CELL);
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let cx = cx0; cx <= cx1; cx += 1) {
    for (let cy = cy0; cy <= cy1; cy += 1) {
      for (const v of index.grid.get(cellKey(cx, cy)) ?? []) {
        const id = v < 0 ? -v - 1 : at(index.segOwner, v);
        const score = scoreOf(
          items[id] as Item,
          index,
          v,
          px,
          py,
          tol,
          isHidden
        );
        if (score < bestScore) {
          bestScore = score;
          best = id;
        }
      }
    }
  }
  return best;
};
