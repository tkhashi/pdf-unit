// 実時間の経過を待つだけの小さなユーティリティ
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));
