import type { ChangeEvent } from "react";
import { ITEM_TYPES, type ItemType, TYPE_COLORS } from "../domain/constants";
import type { TypeCounts } from "../domain/items";
import { legendTypeTip } from "../domain/messages";
import { TriStateCheckbox } from "./tri-state-checkbox";

interface ItemProps {
  readonly count: number;
  readonly onToggle: (type: ItemType, visible: boolean) => void;
  readonly type: ItemType;
  readonly visible: boolean;
}

const LegendItem = ({ count, onToggle, type, visible }: ItemProps) => {
  const onChange = (e: ChangeEvent<HTMLInputElement>) =>
    onToggle(type, e.currentTarget.checked);
  return (
    <label
      className="inline-flex cursor-pointer items-center gap-1"
      data-tip={legendTypeTip(type, count)}
    >
      <input
        checked={visible}
        className="checkbox checkbox-xs checkbox-primary border-white/40"
        onChange={onChange}
        type="checkbox"
      />
      <span
        className="inline-block h-1 w-3"
        style={{ background: TYPE_COLORS[type] }}
      />
      {type} {count}
    </label>
  );
};

interface Props {
  readonly counts: TypeCounts;
  readonly hiddenTypes: ReadonlySet<ItemType>;
  readonly onToggleAll: () => void;
  readonly onToggleType: (type: ItemType, visible: boolean) => void;
}

/** 種類別の凡例(一括チェック、種類ごとの件数・表示切替) */
export const Legend = ({
  counts,
  hiddenTypes,
  onToggleAll,
  onToggleType,
}: Props) => {
  const shown = ITEM_TYPES.filter((t) => !hiddenTypes.has(t)).length;
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-normal"
      data-testid="legend"
    >
      {/* 一括チェック(よくある「すべて選択」と同じ): 全部表示=チェック、一部=不確定(−)、全部非表示=空 */}
      <label
        className="inline-flex cursor-pointer items-center border-white/20 border-r pr-2"
        data-tip="すべての種類の表示/非表示をまとめて切り替えます"
      >
        <TriStateCheckbox
          checked={shown === ITEM_TYPES.length}
          indeterminate={shown > 0 && shown < ITEM_TYPES.length}
          onChange={onToggleAll}
        />
      </label>
      {ITEM_TYPES.map((type) => (
        <LegendItem
          count={counts[type] ?? 0}
          key={type}
          onToggle={onToggleType}
          type={type}
          visible={!hiddenTypes.has(type)}
        />
      ))}
    </span>
  );
};
