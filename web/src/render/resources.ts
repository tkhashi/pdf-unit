// 描画に使うブラウザのオブジェクト(Path2D・画像)。ページのモデル・選択の同一性をキーに作り置きする
// (モデル・選択は作成後に書き換えないため、同じオブジェクトなら同じ内容)
import type { StrokeType } from "../domain/constants";
import { type Item, isArea, isImage } from "../domain/items";
import type { PageModel } from "../domain/page-model";
import type { Selection } from "../domain/selection";

export interface StrokeBatch {
  readonly path: Path2D;
  readonly type: StrokeType;
  readonly w: number;
}

export interface PageResources {
  /** 埋め込み画像の画像データ(ページ内の画像番号 → 画像) */
  readonly images: ReadonlyMap<number, HTMLImageElement>;
  /** 線の要素ごとの Path2D(文字・画像は undefined) */
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

/**
 * ページの描画資源を作る。埋め込み画像は要素だけ作り、画像データは loadImage で取得する
 * (読み込み完了時に onImageLoad を呼ぶ)
 */
export const preparePageResources = (
  model: PageModel,
  loadImage: (index: number, el: HTMLImageElement) => void,
  onImageLoad: () => void
): PageResources => {
  const existing = pageResources.get(model);
  if (existing) {
    return existing;
  }
  const paths = model.items.map((it) =>
    isArea(it) ? undefined : new Path2D(it.d)
  );
  const images = new Map<number, HTMLImageElement>();
  for (const it of model.items) {
    if (isImage(it)) {
      const el = new Image();
      el.onload = onImageLoad;
      loadImage(it.index, el);
      images.set(it.index, el);
    }
  }
  const resources = {
    images,
    paths,
    strokeBatches: batchStrokes(model.items, paths).strokes,
  };
  pageResources.set(model, resources);
  return resources;
};

const EMPTY_RESOURCES: PageResources = {
  images: new Map(),
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
