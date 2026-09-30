import { describe, expect, it } from "vitest";
import {
  computeProgress,
  DEFAULT_ESTIMATE_MS,
  estimatePlan,
  NETWORK_OVERHEAD_MS,
  PROGRESS_STAGES,
} from "./progress";

describe("擬似プログレスバーの見積もり計画", () => {
  it("実測が無ければ既定値を基準にする", () => {
    const { primaryMs, tailMs } = estimatePlan(null);
    expect(primaryMs).toBeCloseTo(DEFAULT_ESTIMATE_MS * 0.9, 5);
    expect(tailMs).toBeCloseTo(
      DEFAULT_ESTIMATE_MS * 0.1 + NETWORK_OVERHEAD_MS,
      5
    );
  });

  it("直近の実測を基準にし、通信オーバーヘッドは最後の段階だけに乗せる", () => {
    const { primaryMs, tailMs } = estimatePlan(2000);
    expect(primaryMs).toBeCloseTo(1800, 5);
    expect(tailMs).toBeCloseTo(200 + NETWORK_OVERHEAD_MS, 5);
  });
});

describe("擬似プログレスバーの段階計算", () => {
  it("開始直後は最初の段階(raster)", () => {
    expect(computeProgress(0, 900, 100)).toEqual({ ratio: 0, stageIndex: 0 });
  });

  it("最初の5段階を均等に進む", () => {
    // 5段階分(primaryMs=900)を均等割り: 各180ms
    expect(computeProgress(179, 900, 100).stageIndex).toBe(0);
    expect(computeProgress(181, 900, 100).stageIndex).toBe(1);
    expect(computeProgress(361, 900, 100).stageIndex).toBe(2);
    expect(computeProgress(541, 900, 100).stageIndex).toBe(3);
    expect(computeProgress(721, 900, 100).stageIndex).toBe(4);
  });

  it("primaryMsを超えたら最後の段階(解析結果まとめ)に入る", () => {
    const last = PROGRESS_STAGES.length - 1;
    const atPrimary = computeProgress(900, 900, 100);
    expect(atPrimary.stageIndex).toBe(last);
    expect(atPrimary.ratio).toBeCloseTo(0.9, 5);
  });

  it("見積もり時間を超えたら99%まで足踏みする", () => {
    const last = PROGRESS_STAGES.length - 1;
    const atEstimate = computeProgress(1000, 900, 100);
    expect(atEstimate.stageIndex).toBe(last);
    expect(atEstimate.ratio).toBeCloseTo(0.99, 5);
    const wayOver = computeProgress(10_000, 900, 100);
    expect(wayOver.stageIndex).toBe(last);
    expect(wayOver.ratio).toBeCloseTo(0.99, 5);
    expect(wayOver.ratio).toBeLessThanOrEqual(0.99);
  });

  it("見積もり0以下でも最後の段階で足踏みする値を返す", () => {
    expect(computeProgress(0, 0, 0)).toEqual({ ratio: 0.99, stageIndex: 5 });
  });
});
