import { memo, type Ref } from "react";
import { THUMB_WIDTH } from "../domain/constants";
import type { PageSize } from "../domain/types";

interface Props {
  readonly current: boolean;
  readonly onSelect: (page: number) => void;
  readonly page: number;
  readonly ref: Ref<HTMLButtonElement>;
  readonly size: PageSize;
  readonly src: string | null;
  /** 大きすぎて表示できない場合の補足 */
  readonly unavailableTip: string | null;
}

export const ThumbnailButton = memo(
  ({ current, onSelect, page, ref, size, src, unavailableTip }: Props) => {
    const onClick = () => onSelect(page);
    return (
      <button
        className={`flex cursor-pointer scroll-m-2 flex-col items-center gap-0.5 rounded-md border-2 p-1 text-[11px] text-base-content/80 ${
          current
            ? "border-primary bg-primary/20"
            : "border-transparent hover:bg-base-200"
        }`}
        data-page={page}
        data-tip={unavailableTip ?? `${page + 1}ページ`}
        onClick={onClick}
        ref={ref}
        type="button"
      >
        <span className="relative block">
          <img
            alt={`${page + 1}ページ`}
            className={`block h-auto w-[140px] shadow-sm ${unavailableTip ? "thumb-unavailable" : "bg-white"}`}
            height={Math.round((THUMB_WIDTH * size.height) / size.width)}
            src={src ?? undefined}
            style={{ aspectRatio: `${size.width} / ${size.height}` }}
            width={THUMB_WIDTH}
          />
          {src === null && !unavailableTip ? (
            <span className="loading loading-spinner loading-sm absolute inset-0 m-auto text-primary" />
          ) : null}
        </span>
        <span>{page + 1}</span>
      </button>
    );
  }
);
