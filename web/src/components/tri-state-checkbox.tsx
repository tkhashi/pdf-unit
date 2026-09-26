import type { Ref } from "react";

interface Props {
  readonly checked: boolean;
  readonly indeterminate: boolean;
  readonly onChange: () => void;
}

/** 一部だけ選ばれている状態(−)を表せるチェックボックス。indeterminate は DOM のプロパティにだけあるため ref で反映する */
export const TriStateCheckbox = ({
  checked,
  indeterminate,
  onChange,
}: Props) => {
  const ref: Ref<HTMLInputElement> = (el) => {
    if (el) {
      el.indeterminate = indeterminate;
    }
  };
  return (
    <input
      checked={checked}
      className="checkbox checkbox-xs checkbox-primary border-white/40"
      onChange={onChange}
      ref={ref}
      type="checkbox"
    />
  );
};
