import { thumbToggleLabel } from "../domain/messages";

interface Props {
  readonly onToggle: () => void;
  readonly visible: boolean;
}

/** サムネイル一覧の開閉ボタン: 一覧の右(図面との境目)に隣接する細長い縦ボタン。閉じても残る */
export const ThumbToggle = ({ onToggle, visible }: Props) => {
  const label = thumbToggleLabel(visible);
  return (
    <button
      aria-label={label}
      className="w-3.5 flex-none cursor-pointer border-base-content/20 border-r bg-base-300/70 p-0 text-[10px] text-base-content/70 hover:bg-base-content/20 hover:text-base-content"
      data-tip={label}
      onClick={onToggle}
      type="button"
    >
      {visible ? "◀" : "▶"}
    </button>
  );
};
