// /api/page/lines の応答から、描画・ヒット判定に使うページのモデルを作る
import { type ItemType, MIN_LINEWIDTH } from "./constants";
import { at } from "./geometry";
import type { Item, StrokeItem, TypeCounts } from "./items";
import { shapeDescriptor } from "./shape";
import { buildIndex, EMPTY_INDEX, type SpatialIndex } from "./spatial-index";
import type { CalibrationMethod, LineRecord, LinesResponse } from "./types";

/**
 * 1ページ分の要素。大きい(10万要素を超えることがある)ため、作成後は書き換えず参照で受け渡す
 * (型は readonly。実行時の凍結はしない)
 */
export interface PageModel {
  readonly calibration: CalibrationMethod | null;
  readonly counts: TypeCounts;
  readonly index: SpatialIndex;
  /** 線(line/rect/curve)・文字(text)・画像(image)の順の通し番号 = 配列の添字 */
  readonly items: readonly Item[];
  /** 報告linewidth→実描画太さの補正係数 */
  readonly lwScale: number;
}

export const EMPTY_PAGE_MODEL: PageModel = {
  calibration: null,
  counts: {},
  index: EMPTY_INDEX,
  items: [],
  lwScale: 1,
};

export const effWidth = (lw: number | null, lwScale: number): number =>
  Math.max((lw ?? 0.5) * lwScale, MIN_LINEWIDTH);

const polylineLength = (polylines: LineRecord["polylines"]): number => {
  let length = 0;
  for (const pl of polylines) {
    for (let i = 0; i + 3 < pl.length; i += 2) {
      length += Math.hypot(
        at(pl, i + 2) - at(pl, i),
        at(pl, i + 3) - at(pl, i + 1)
      );
    }
  }
  return length;
};

const toStroke = (ln: LineRecord, id: number, lwScale: number): StrokeItem => ({
  ...ln,
  id,
  length: polylineLength(ln.polylines),
  shape: ln.type === "curve" ? shapeDescriptor(ln.polylines) : null,
  w: effWidth(ln.linewidth, lwScale),
});

const countTypes = (items: readonly Item[]): TypeCounts => {
  const counts: Partial<Record<ItemType, number>> = {};
  for (const it of items) {
    counts[it.type] = (counts[it.type] ?? 0) + 1;
  }
  return counts;
};

export const buildPageModel = (data: LinesResponse): PageModel => {
  const lwScale = data.linewidth_scale;
  const strokes = data.lines.map((ln, i) => toStroke(ln, i, lwScale));
  const texts = data.texts.map((t, i) => ({ ...t, id: strokes.length + i }));
  const offset = strokes.length + texts.length;
  const images = data.images.map((im, i) => ({ ...im, id: offset + i }));
  const items: readonly Item[] = [...strokes, ...texts, ...images];
  return {
    calibration: data.calibration,
    counts: countTypes(items),
    index: buildIndex(items),
    items,
    lwScale,
  };
};
