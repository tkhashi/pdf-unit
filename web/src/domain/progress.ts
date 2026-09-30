// PDF解析中の擬似プログレスバー。サーバー側の実際の処理段階とは連動しておらず、
// 直近の実測解析時間をもとに見積もった時間で段階を進めるだけの表示上の演出

/** 表示するステージ名。この順に進む */
export const PROGRESS_STAGES = [
  "raster",
  "text",
  "line",
  "curve",
  "rect",
  "解析結果まとめ",
] as const;

export type ProgressStage = (typeof PROGRESS_STAGES)[number];

const LAST_STAGE_INDEX = PROGRESS_STAGES.length - 1;
/** 最初の5段階(raster〜rect)に使う、見積もり時間に対する割合。残りは最後の段階(解析結果まとめ)に使う */
const PRIMARY_SHARE = 0.9;
/** 見積もりを超えても、最後の段階でここまでは進めて実際の完了を待つ(足踏み) */
const MAX_RATIO_WHILE_WAITING = 0.99;

/** 応答が無い場合に使う既定の見積もり(初回・実測が無いとき) */
export const DEFAULT_ESTIMATE_MS = 1500;
/** インターネット越しの通信を見込んだ固定の加算時間 */
export const NETWORK_OVERHEAD_MS = 800;

/** 直近の実測解析時間から、今回の見積もり時間(段階の配分に使う)を求める */
export const estimateDurationMs = (lastDurationMs: number | null): number =>
  (lastDurationMs ?? DEFAULT_ESTIMATE_MS) + NETWORK_OVERHEAD_MS;

export interface ProgressPoint {
  /** 全体に対する進み具合(0〜1) */
  readonly ratio: number;
  /** 現在のステージの添字(PROGRESS_STAGES のindex) */
  readonly stageIndex: number;
}

/** 経過時間と見積もり時間から、現在のステージと全体比率を求める(純粋関数) */
export const computeProgress = (
  elapsedMs: number,
  estimateMs: number
): ProgressPoint => {
  if (estimateMs <= 0) {
    return { ratio: MAX_RATIO_WHILE_WAITING, stageIndex: LAST_STAGE_INDEX };
  }
  const primaryMs = estimateMs * PRIMARY_SHARE;
  if (elapsedMs < primaryMs) {
    const primaryStageCount = LAST_STAGE_INDEX;
    const perStageMs = primaryMs / primaryStageCount;
    const stageIndex = Math.min(
      Math.floor(elapsedMs / perStageMs),
      primaryStageCount - 1
    );
    return { ratio: elapsedMs / estimateMs, stageIndex };
  }
  const tailMs = estimateMs - primaryMs;
  const tailRatio =
    tailMs > 0 ? Math.min((elapsedMs - primaryMs) / tailMs, 1) : 1;
  return {
    ratio: Math.min(
      PRIMARY_SHARE + (MAX_RATIO_WHILE_WAITING - PRIMARY_SHARE) * tailRatio,
      MAX_RATIO_WHILE_WAITING
    ),
    stageIndex: LAST_STAGE_INDEX,
  };
};
