import type { ChangeEvent } from "react";
import { opacityTip } from "../domain/messages";

interface Props {
  readonly onChange: (value: number) => void;
  readonly value: number;
}

/** 原本画像(下敷き)の濃さ */
export const OpacityControl = ({ onChange, value }: Props) => {
  const onInput = (e: ChangeEvent<HTMLInputElement>) =>
    onChange(Number(e.currentTarget.value));
  return (
    <label
      className="inline-flex items-center gap-2"
      data-tip={opacityTip(value)}
    >
      原本
      <input
        className="range range-primary range-xs w-20 [--range-bg:rgb(255_255_255/0.22)]"
        max={100}
        min={0}
        onChange={onInput}
        type="range"
        value={value}
      />
    </label>
  );
};
