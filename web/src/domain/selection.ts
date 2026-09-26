// 選択(クリックで属性を順に切替)
import type { ItemType } from "./constants";
import { family, type Item } from "./items";
import { levelsOf } from "./levels";

export interface Selection {
  readonly anchor: number;
  /** これまでに選んだ集合(同じ集合になる属性は飛ばす) */
  readonly history: readonly (readonly number[])[];
  readonly label: string;
  readonly level: number;
  readonly memberSet: ReadonlySet<number>;
  readonly members: readonly number[];
  readonly value: string;
}

const sameMembers = (a: readonly number[], b: readonly number[]): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const s = new Set(a);
  return b.every((id) => s.has(id));
};

/**
 * id の要素をクリックしたときの次の選択。同じ要素の再クリックなら次の属性へ進み、
 * 該当する属性が残っていなければ null(選択解除)
 */
export const selectNext = (
  items: readonly Item[],
  selection: Selection | null,
  id: number,
  isHidden: (type: ItemType) => boolean
): Selection | null => {
  const anchor = items[id] as Item;
  const levels = levelsOf(anchor);
  const cont = selection !== null && selection.anchor === id;
  const start = cont ? selection.level + 1 : 0;
  const history = cont ? selection.history : [];
  for (let lv = start; lv < levels.length; lv += 1) {
    const { label, key, same } = levels[lv] as (typeof levels)[number];
    const value = key(anchor);
    if (value === null) {
      continue; // この要素には該当しない属性(例: line以外の長さ)
    }
    const match = same
      ? (it: Item) => key(it) !== null && same(anchor, it)
      : (it: Item) => key(it) === value;
    const members = items
      .filter(
        (it) => family(it) === family(anchor) && !isHidden(it.type) && match(it)
      )
      .map((it) => it.id);
    if (history.some((h) => sameMembers(h, members))) {
      continue; // 既に選んだ集合と同じになる属性は飛ばす
    }
    return {
      anchor: id,
      history: [...history, members],
      label,
      level: lv,
      memberSet: new Set(members),
      members,
      value,
    };
  }
  return null;
};

/** 表示対象が変わったら、見えなくなった要素を選択から外す(起点が見えなくなれば解除) */
export const filterSelection = (
  items: readonly Item[],
  selection: Selection | null,
  isHidden: (type: ItemType) => boolean
): Selection | null => {
  if (!selection) {
    return null;
  }
  const members = selection.members.filter(
    (id) => !isHidden((items[id] as Item).type)
  );
  if (isHidden((items[selection.anchor] as Item).type)) {
    return null;
  }
  return { ...selection, memberSet: new Set(members), members };
};
