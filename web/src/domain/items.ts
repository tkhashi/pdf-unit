// 表示・判定に使う要素(線・文字・画像)。サーバーの応答に通し番号と計算済みの値を加えたもの
import type { AreaType, ItemType, StrokeType } from "./constants";
import type { ShapeDescriptor } from "./shape";
import type { ImageRecord, LineRecord, TextRecord } from "./types";

export interface StrokeItem extends LineRecord {
  /** line の長さ(pt)。折れ線群の線分の長さの合計 */
  readonly length: number;
  readonly shape: ShapeDescriptor | null;
  readonly type: StrokeType;
  /** 描画太さ(pt) = 線幅 × 補正係数(下限あり) */
  readonly w: number;
}

export interface TextItem extends TextRecord {
  readonly id: number;
}

export interface ImageItem extends ImageRecord {
  readonly id: number;
}

export type Item = StrokeItem | TextItem | ImageItem;
export type AreaItem = TextItem | ImageItem;
export type Family = "stroke" | AreaType;

export const isText = (it: Item): it is TextItem => it.type === "text";
export const isImage = (it: Item): it is ImageItem => it.type === "image";
export const isArea = (it: Item): it is AreaItem => isText(it) || isImage(it);
export const isStroke = (it: Item): it is StrokeItem => !isArea(it);
export const family = (it: Item): Family => (isArea(it) ? it.type : "stroke");

export type TypeCounts = Readonly<Partial<Record<ItemType, number>>>;
