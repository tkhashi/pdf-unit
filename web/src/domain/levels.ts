// クリックで辿る属性(種類ごと)
import { shade } from "./color";
import {
  type ImageItem,
  type Item,
  isImage,
  isText,
  type StrokeItem,
  type TextItem,
} from "./items";
import { sameShape } from "./shape";

export interface Level<T extends Item = Item> {
  /** 値(該当しなければ null) */
  readonly key: (it: T) => string | null;
  readonly label: string;
  /** 一致判定(省略時は値の一致) */
  readonly same?: (a: T, b: T) => boolean;
}

// 同じ種類(family)の要素どうしでだけ比べるため、各表の関数はその種類の要素だけを受け取る
const strokeLevels: readonly Level<StrokeItem>[] = [
  { key: (it) => it.type, label: "種類" },
  {
    key: (it) => (it.linewidth === null ? null : String(it.linewidth)),
    label: "線幅",
  },
  {
    key: (it) => (it.type === "line" ? `${it.length.toFixed(2)}pt` : null),
    label: "長さ",
  },
  {
    key: (it) => {
      if (it.type !== "curve" || !it.shape) {
        return null;
      }
      return it.shape.closed ? "閉曲線" : "開曲線";
    },
    label: "形状",
    same: sameShape,
  },
  { key: (it) => `${it.w.toFixed(2)}pt`, label: "描画太さ" },
  { key: (it) => it.color, label: "色" },
  { key: (it) => shade(it.color), label: "濃淡" },
];

const textLevels: readonly Level<TextItem>[] = [
  { key: (it) => it.type, label: "種類" },
  { key: (it) => it.fontname, label: "フォント" },
  { key: (it) => (it.size === null ? null : `${it.size}pt`), label: "サイズ" },
  { key: (it) => it.color, label: "色" },
  { key: (it) => shade(it.color), label: "濃淡" },
];

const imageLevels: readonly Level<ImageItem>[] = [
  { key: (it) => it.type, label: "種類" },
  { key: (it) => `${it.px_width}×${it.px_height}px`, label: "画素数" },
  { key: (it) => `${Math.round(it.dpi)}dpi`, label: "解像度" },
  { key: (it) => it.filters.join("+") || "なし", label: "圧縮形式" },
];

// 表の同一性(===)で要素の種類が同じかを判定するため、表は定数のまま使う
export const STROKE_LEVELS = strokeLevels as readonly Level[];
export const TEXT_LEVELS = textLevels as readonly Level[];
export const IMAGE_LEVELS = imageLevels as readonly Level[];

export const levelsOf = (it: Item): readonly Level[] => {
  if (isImage(it)) {
    return IMAGE_LEVELS;
  }
  if (isText(it)) {
    return TEXT_LEVELS;
  }
  return STROKE_LEVELS;
};
