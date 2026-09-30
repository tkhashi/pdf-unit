// 属性パネルの行。クリック巡回の属性定義から作る。選択中の属性で、表示中の要素がその集合に含まれれば行を強調する
import type { ItemType } from "./constants";
import { type Item, isFill, isImage, isText } from "./items";
import { levelsOf } from "./levels";
import type { Selection } from "./selection";

export type InfoValue =
  | { readonly kind: "plain"; readonly text: string }
  /** 種類: 種類名(種類の色・太字) + 通し番号 */
  | { readonly id: number; readonly kind: "type"; readonly type: ItemType }
  /** 色: 値 + 色見本 */
  | { readonly color: string; readonly kind: "color" };

export interface InfoRow {
  /** 強調中なら選択の件数、それ以外は null */
  readonly count: number | null;
  readonly label: string;
  readonly value: InfoValue;
}

const plain = (text: string): InfoValue => ({ kind: "plain", text });

const row = (label: string, value: InfoValue, count: number | null = null) => ({
  count,
  label,
  value,
});

const levelValue = (
  it: Item,
  label: string,
  value: string,
  lwScale: number
): InfoValue => {
  if (label === "種類") {
    return { id: it.id, kind: "type", type: it.type };
  }
  if (label === "色" && !isImage(it) && it.color) {
    return { color: value, kind: "color" };
  }
  if (label === "描画太さ") {
    return plain(`${value} (補正×${lwScale})`);
  }
  return plain(value);
};

export const describe = (
  items: readonly Item[],
  it: Item,
  selection: Selection | null,
  lwScale: number
): readonly InfoRow[] => {
  const [x0, top, x1, bottom] = it.bbox.map((v) => v.toFixed(2));
  const levels = levelsOf(it);
  const activeLevel =
    selection &&
    levelsOf(items[selection.anchor] as Item) === levels &&
    selection.memberSet.has(it.id)
      ? selection.level
      : -1;
  const rows: InfoRow[] = [];
  if (isText(it)) {
    rows.push(row("text", plain(it.text)));
    // フォントに文字の対応情報が無く、何の文字か分からないものは「□」で表示している
    if (it.unreadable) {
      rows.push(
        row(
          "読めない文字",
          plain(`${it.unreadable}字(□で表示。フォントに文字の対応情報が無い)`)
        )
      );
    }
  }
  for (const [i, { label, key }] of levels.entries()) {
    const value = key(it);
    if (value === null) {
      continue;
    }
    const count =
      i === activeLevel && selection ? selection.members.length : null;
    rows.push(row(label, levelValue(it, label, value, lwScale), count));
  }
  if (isFill(it) && it.clip.length > 0) {
    rows.push(row("クリップ", plain("あり(クリップの内側だけ塗られる)")));
  }
  if (isImage(it)) {
    rows.push(
      row(
        "配置",
        plain(it.placement === "bbox" ? "回転なし" : "回転・変形あり")
      )
    );
  }
  rows.push(row("bbox", plain(`(${x0}, ${top}) - (${x1}, ${bottom})`)));
  return rows;
};
