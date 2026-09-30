// 描画に使うブラウザのオブジェクト(Path2D・画像)。ページのモデル・選択の同一性をキーに作り置きする
// (モデル・選択は作成後に書き換えないため、同じオブジェクトなら同じ内容)
import type { StrokeType } from "../domain/constants";
import { at } from "../domain/geometry";
import { type Item, isArea, isFill, isImage } from "../domain/items";
import type { PageModel } from "../domain/page-model";
import type { Selection } from "../domain/selection";

export interface StrokeBatch {
  readonly path: Path2D;
  readonly type: StrokeType;
  readonly w: number;
}

export interface PageResources {
  /** 埋め込み画像の範囲(全画像の四隅を1つにまとめたもの。画像が無ければ null) */
  readonly imageRegions: Path2D | null;
  /** 線・塗りつぶしの要素ごとの Path2D(文字・画像は undefined) */
  readonly paths: readonly (Path2D | undefined)[];
  /** ベクター描画用バッチ(種類×描画太さごとに1つのPath2D、最初に現れた順) */
  readonly strokeBatches: readonly StrokeBatch[];
}

export interface GroupBatches {
  readonly areas: readonly Item[];
  readonly strokes: readonly StrokeBatch[];
}

const batchStrokes = (
  items: Iterable<Item>,
  paths: readonly (Path2D | undefined)[]
): { areas: Item[]; strokes: StrokeBatch[] } => {
  const batches = new Map<string, StrokeBatch>();
  const areas: Item[] = [];
  for (const it of items) {
    const path = paths[it.id];
    if (isArea(it) || !path) {
      areas.push(it);
      continue;
    }
    const key = `${it.type}|${it.w}`;
    let b = batches.get(key);
    if (!b) {
      b = { path: new Path2D(), type: it.type, w: it.w };
      batches.set(key, b);
    }
    b.path.addPath(path);
  }
  return { areas, strokes: [...batches.values()] };
};

const pageResources = new WeakMap<PageModel, PageResources>();

/** 画像の四隅(左下・右下・右上・左上)をつないだ閉じた範囲を path に足す */
export const addQuad = (path: Path2D, quad: readonly number[]): void => {
  path.moveTo(at(quad, 0), at(quad, 1));
  for (let i = 2; i < 8; i += 2) {
    path.lineTo(at(quad, i), at(quad, i + 1));
  }
  path.closePath();
};

/** 埋め込み画像の範囲を1つの Path2D にまとめる(画像が無ければ null) */
export const imageRegionsOf = (items: Iterable<Item>): Path2D | null => {
  let path: Path2D | null = null;
  for (const it of items) {
    if (isImage(it)) {
      path ??= new Path2D();
      addQuad(path, it.quad);
    }
  }
  return path;
};

/**
 * ページの描画資源を作る。埋め込み画像は画素を取得せず、範囲(枠)だけを描く(ADR 0039)
 */
export const preparePageResources = (model: PageModel): PageResources => {
  const existing = pageResources.get(model);
  if (existing) {
    return existing;
  }
  const paths = model.items.map((it) =>
    isArea(it) && !isFill(it) ? undefined : new Path2D(it.d)
  );
  const resources = {
    imageRegions: imageRegionsOf(model.items),
    paths,
    strokeBatches: batchStrokes(model.items, paths).strokes,
  };
  pageResources.set(model, resources);
  return resources;
};

const EMPTY_RESOURCES: PageResources = {
  imageRegions: null,
  paths: [],
  strokeBatches: [],
};

export const resourcesOf = (model: PageModel): PageResources =>
  pageResources.get(model) ?? EMPTY_RESOURCES;

// グループ選択は描画太さごとにPath2Dをまとめて描く(数千本でもズーム毎に再構築しない)
const groupBatches = new WeakMap<Selection, GroupBatches>();

export const groupBatchesOf = (
  model: PageModel,
  selection: Selection
): GroupBatches => {
  const existing = groupBatches.get(selection);
  if (existing) {
    return existing;
  }
  const members = selection.members.map((id) => model.items[id] as Item);
  const batches = batchStrokes(members, resourcesOf(model).paths);
  groupBatches.set(selection, batches);
  return batches;
};
