import { PROGRESS_STAGES } from "../domain/progress";

interface Props {
  readonly ratio: number;
  readonly stageIndex: number;
}

/** PDF解析中の擬似プログレスバー。表示中のページの線データ取得中だけ現れる */
export const PageProgressBar = ({ ratio, stageIndex }: Props) => (
  <div
    className="pointer-events-none absolute top-3 left-1/2 w-64 -translate-x-1/2 rounded-md bg-neutral/90 px-3 py-2 text-neutral-content text-xs shadow-lg"
    data-testid="page-progress"
  >
    <div className="mb-1">{PROGRESS_STAGES[stageIndex]}</div>
    <progress
      className="progress progress-primary w-full"
      max={1}
      value={ratio}
    />
  </div>
);
