import { useShallow } from "zustand/react/shallow";
import { useAppState } from "../app/app-context";
import { PageProgressBar } from "../components/page-progress-bar";

/** PDF解析中(線データ取得中)だけ表示する擬似プログレスバー */
export const PageProgressContainer = () => {
  const progress = useAppState(useShallow((s) => s.page.progress));
  return progress ? (
    <PageProgressBar ratio={progress.ratio} stageIndex={progress.stageIndex} />
  ) : null;
};
