import { PROGRESS_STAGES, STAGE_DISPLAY_WEIGHTS } from "../domain/progress";

interface Props {
  readonly ratio: number;
  readonly stageIndex: number;
}

const segmentClassName = (i: number, current: number): string => {
  if (i < current) {
    return "bg-primary/70 text-primary-content";
  }
  if (i === current) {
    return "bg-primary text-primary-content";
  }
  return "bg-neutral-content/20 text-neutral-content/60";
};

/**
 * PDF解析中の擬似プログレスバー。表示中のページの線データ取得中だけ現れる。
 * 段階ごとのセグメント幅(STAGE_DISPLAY_WEIGHTS)は見た目だけの重みで、実際の
 * 時間配分(見積もり計画)とは独立している
 */
export const PageProgressBar = ({ ratio, stageIndex }: Props) => (
  <div
    className="pointer-events-none absolute top-3 left-1/2 w-[80%] -translate-x-1/2 rounded-md bg-neutral/90 px-3 py-2 text-neutral-content text-xs shadow-lg"
    data-testid="page-progress"
  >
    <div className="mb-1.5 flex gap-0.5" data-testid="page-progress-stages">
      {PROGRESS_STAGES.map((stage, i) => (
        <span
          className={`truncate rounded px-1 py-0.5 text-center ${segmentClassName(i, stageIndex)}`}
          key={stage}
          style={{ flexBasis: 0, flexGrow: STAGE_DISPLAY_WEIGHTS[i] }}
        >
          {stage}
        </span>
      ))}
    </div>
    <progress
      className="progress progress-primary w-full"
      max={1}
      value={ratio}
    />
  </div>
);
