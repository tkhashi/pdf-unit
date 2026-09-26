import type { ChangeEvent } from "react";

interface Props {
  readonly onOpen: (file: File) => void;
}

export const FileOpenButton = ({ onOpen }: Props) => {
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    if (file) {
      onOpen(file);
    }
  };
  return (
    <label
      className="btn btn-xs h-6 border-white/15 bg-white/10 px-2.5 font-normal text-[13px] text-neutral-content shadow-none hover:bg-white/20"
      data-tip={
        "PDFファイルを選択して開きます。\n図面の領域へドラッグ&ドロップしても開けます"
      }
    >
      開く
      <input
        accept="application/pdf"
        className="hidden"
        onChange={onChange}
        type="file"
      />
    </label>
  );
};
