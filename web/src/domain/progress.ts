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

export const LAST_STAGE_INDEX = PROGRESS_STAGES.length - 1;
/** 最初の5段階(raster〜rect)に使う、基準時間に対する割合。残りは最後の段階(解析結果まとめ)に使う */
const PRIMARY_SHARE = 0.9;
/** 見積もりを超えても、最後の段階でここまでは進めて実際の完了を待つ(足踏み) */
const MAX_RATIO_WHILE_WAITING = 0.99;

/** 応答が無い場合に使う既定の見積もり(初回・実測が無いとき) */
export const DEFAULT_ESTIMATE_MS = 1500;
/** インターネット越しの通信を見込んだ固定の加算時間。5段階の均等配分には含めず、
 *  最後の段階(解析結果まとめ、実際にはサーバーからの応答待ち)の見積もりにだけ乗せる */
export const NETWORK_OVERHEAD_MS = 800;

/**
 * ステージ一覧(セグメントバー)の表示上の幅の重み。実際の時間配分(見積もり時間)とは独立した、
 * 見た目だけの値。raster は短め、line/curve/rectは長め、解析結果まとめは最も短くする
 */
export const STAGE_DISPLAY_WEIGHTS: readonly number[] = [
  0.7, 1, 1.3, 1.3, 1.3, 0.4,
];

export interface ProgressPlan {
  /** 最初の5段階(raster〜rect)に均等配分する合計時間(ms)。通信オーバーヘッドは含まない */
  readonly primaryMs: number;
  /** 最後の段階(解析結果まとめ)の見積もり時間(ms)。通信オーバーヘッドを含む */
  readonly tailMs: number;
}

/** 直近の実測解析時間から、今回の見積もり計画(5段階分・最後の段階分)を求める */
export const estimatePlan = (lastDurationMs: number | null): ProgressPlan => {
  const baseMs = lastDurationMs ?? DEFAULT_ESTIMATE_MS;
  return {
    primaryMs: baseMs * PRIMARY_SHARE,
    tailMs: baseMs * (1 - PRIMARY_SHARE) + NETWORK_OVERHEAD_MS,
  };
};

export interface ProgressPoint {
  /** 全体に対する進み具合(0〜1) */
  readonly ratio: number;
  /** 現在のステージの添字(PROGRESS_STAGES のindex) */
  readonly stageIndex: number;
}

/** 経過時間と見積もり計画から、現在のステージと全体比率を求める(純粋関数) */
export const computeProgress = (
  elapsedMs: number,
  primaryMs: number,
  tailMs: number
): ProgressPoint => {
  const estimateMs = primaryMs + tailMs;
  if (estimateMs <= 0) {
    return { ratio: MAX_RATIO_WHILE_WAITING, stageIndex: LAST_STAGE_INDEX };
  }
  if (elapsedMs < primaryMs) {
    const primaryStageCount = LAST_STAGE_INDEX;
    const perStageMs = primaryMs / primaryStageCount;
    const stageIndex = Math.min(
      Math.floor(elapsedMs / perStageMs),
      primaryStageCount - 1
    );
    return { ratio: elapsedMs / estimateMs, stageIndex };
  }
  const tailRatio =
    tailMs > 0 ? Math.min((elapsedMs - primaryMs) / tailMs, 1) : 1;
  const primaryRatio = primaryMs / estimateMs;
  return {
    ratio: Math.min(
      primaryRatio + (MAX_RATIO_WHILE_WAITING - primaryRatio) * tailRatio,
      MAX_RATIO_WHILE_WAITING
    ),
    stageIndex: LAST_STAGE_INDEX,
  };
};
