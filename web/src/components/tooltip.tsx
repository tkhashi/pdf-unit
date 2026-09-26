import { useLayoutEffect, useRef } from "react";

interface Props {
  readonly anchor: DOMRectReadOnly | null;
  readonly text: string | null;
}

const MARGIN = 8;
const GAP = 6;

/** 自前のツールチップ。対象の下(収まらなければ上)の中央に、画面からはみ出さないよう置く */
export const Tooltip = ({ anchor, text }: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  // 自身の大きさが決まってから位置を書く(DOM の操作だけで、状態は持たない)
  useLayoutEffect(() => {
    const tip = ref.current;
    if (!(tip && anchor && text !== null)) {
      return;
    }
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const x = Math.max(
      MARGIN,
      Math.min(anchor.left + anchor.width / 2 - w / 2, innerWidth - w - MARGIN)
    );
    const below = anchor.bottom + GAP;
    tip.style.left = `${x}px`;
    tip.style.top = `${
      below + h <= innerHeight - MARGIN
        ? below
        : Math.max(MARGIN, anchor.top - h - GAP)
    }px`;
  }, [anchor, text]);
  return (
    <div
      className="pointer-events-none fixed z-[1000] max-w-80 whitespace-pre-line rounded bg-neutral px-2 py-1.5 text-neutral-content text-xs leading-normal shadow-lg"
      hidden={text === null}
      ref={ref}
      role="tooltip"
    >
      {text}
    </div>
  );
};
