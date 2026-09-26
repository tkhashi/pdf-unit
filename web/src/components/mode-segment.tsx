import type { DisplayMode } from "../domain/visibility";

const MODES: readonly {
  readonly label: string;
  readonly mode: DisplayMode;
  readonly tip: string;
}[] = [
  { label: "両方", mode: "both", tip: "線・文字と埋め込み画像の両方を表示" },
  {
    label: "ベクター",
    mode: "vector",
    tip: "線・文字だけを表示(埋め込み画像は隠す)",
  },
  {
    label: "ラスター",
    mode: "raster",
    tip: "PDFに埋め込まれた画像だけを表示(線・文字は隠す)",
  },
];

interface ButtonProps {
  readonly checked: boolean;
  readonly label: string;
  readonly mode: DisplayMode;
  readonly onChange: (mode: DisplayMode) => void;
  readonly tip: string;
}

const ModeButton = ({ checked, label, mode, onChange, tip }: ButtonProps) => {
  const onClick = () => onChange(mode);
  return (
    // 旧UIと同じく、各ボタンを Tab で選べる radio として扱う(矢印キーでの移動は持たない)
    // biome-ignore lint/a11y/useSemanticElements: input[type=radio] にすると Tab・矢印キーの操作が変わるため
    <button
      aria-checked={checked}
      className={`btn join-item btn-xs h-6 px-2 font-normal text-[13px] shadow-none ${
        checked
          ? "btn-primary"
          : "border-white/15 bg-white/10 text-neutral-content/85 hover:bg-white/20"
      }`}
      data-tip={tip}
      onClick={onClick}
      role="radio"
      type="button"
    >
      {label}
    </button>
  );
};

interface Props {
  readonly mode: DisplayMode;
  readonly onChange: (mode: DisplayMode) => void;
}

/** セグメントボタン(3つのうち1つを選ぶ) */
export const ModeSegment = ({ mode, onChange }: Props) => (
  <div aria-label="再描画する対象" className="join" role="radiogroup">
    {MODES.map((m) => (
      <ModeButton
        checked={m.mode === mode}
        key={m.mode}
        label={m.label}
        mode={m.mode}
        onChange={onChange}
        tip={m.tip}
      />
    ))}
  </div>
);
