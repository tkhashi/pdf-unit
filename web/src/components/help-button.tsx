import type { MouseEvent } from "react";
import { HELP_ATTR } from "../controllers/tooltip";

const HELP_TIP = [
  "操作説明(クリックで表示を固定)",
  "ホイール: ズーム",
  "ドラッグ: 移動",
  "ホバー: 最も近い線・文字・画像を赤で示し、属性を右下に表示",
  "クリック: 同じ属性の要素をすべて選択(同じ要素を再クリックで比べる属性を切替)",
  "Esc / 何もない所をクリック: 選択解除",
  "ページ移動: 左のサムネイル一覧",
].join("\n");

interface Props {
  readonly expanded: boolean;
  readonly onToggle: (el: HTMLElement) => void;
}

export const HelpButton = ({ expanded, onToggle }: Props) => {
  const onClick = (e: MouseEvent<HTMLButtonElement>) =>
    onToggle(e.currentTarget);
  return (
    <button
      aria-expanded={expanded}
      aria-label="操作説明"
      className={`btn btn-circle btn-xs size-[22px] min-h-0 font-bold shadow-none ${
        expanded
          ? "btn-primary"
          : "border-white/15 bg-white/10 text-neutral-content hover:bg-white/20"
      }`}
      data-tip={HELP_TIP}
      onClick={onClick}
      type="button"
      {...{ [HELP_ATTR]: "" }}
    >
      ?
    </button>
  );
};
