import type { ItemType } from "./constants";

/** 再描画する対象。ラスター = PDFに埋め込まれた画像 */
export type DisplayMode = "both" | "vector" | "raster";

export interface Visibility {
  readonly displayMode: DisplayMode;
  readonly hiddenTypes: ReadonlySet<ItemType>;
}

export const isHiddenType = (v: Visibility, type: ItemType): boolean =>
  v.hiddenTypes.has(type) ||
  (v.displayMode === "vector" && type === "image") ||
  (v.displayMode === "raster" && type !== "image");

export const hiddenPredicate =
  (v: Visibility) =>
  (type: ItemType): boolean =>
    isHiddenType(v, type);
