import { describe, expect, it } from "vitest";
import {
  computeProgress,
  DEFAULT_ESTIMATE_MS,
  estimateDurationMs,
  NETWORK_OVERHEAD_MS,
  PROGRESS_STAGES,
} from "./progress";

describe("擬似プログレスバーの見積もり", () => {
  it("実測が無ければ既定値+通信オーバーヘッドを使う", () => {
    expect(estimateDurationMs(null)).toBe(
      DEFAULT_ESTIMATE_MS + NETWORK_OVERHEAD_MS
    );
  });

  it("直近の実測に通信オーバーヘッドを加える", () => {
    expect(estimateDurationMs(2000)).toBe(2000 + NETWORK_OVERHEAD_MS);
  });
});

describe("擬似プログレスバーの段階計算", () => {
  it("開始直後は最初の段階(raster)", () => {
    expect(computeProgress(0, 1000)).toEqual({ ratio: 0, stageIndex: 0 });
  });

  it("最初の5段階を均等に進む", () => {
    // 5段階分(0.9)を均等割り: 各0.18
    expect(computeProgress(179, 1000).stageIndex).toBe(0);
    expect(computeProgress(181, 1000).stageIndex).toBe(1);
    expect(computeProgress(361, 1000).stageIndex).toBe(2);
    expect(computeProgress(541, 1000).stageIndex).toBe(3);
    expect(computeProgress(721, 1000).stageIndex).toBe(4);
  });

  it("見積もり時間を超えたら最後の段階(解析結果まとめ)で99%まで足踏みする", () => {
    const last = PROGRESS_STAGES.length - 1;
    expect(computeProgress(900, 1000).stageIndex).toBe(last);
    expect(computeProgress(900, 1000).ratio).toBeCloseTo(0.9, 5);
    const atEstimate = computeProgress(1000, 1000);
    expect(atEstimate.stageIndex).toBe(last);
    expect(atEstimate.ratio).toBeCloseTo(0.99, 5);
    const wayOver = computeProgress(10_000, 1000);
    expect(wayOver.stageIndex).toBe(last);
    expect(wayOver.ratio).toBeCloseTo(0.99, 5);
    expect(wayOver.ratio).toBeLessThanOrEqual(0.99);
  });

  it("見積もり0以下でも最後の段階で足踏みする値を返す", () => {
    expect(computeProgress(0, 0)).toEqual({ ratio: 0.99, stageIndex: 5 });
  });
});
