// ページの表示: 線データを取得してモデルを作り、描画資源(Path2D・埋め込み画像の範囲)を用意する
import { flushSync } from "react-dom";
import { PROGRESS_HOLD_MS } from "../domain/constants";
import { buildPageModel } from "../domain/page-model";
import { computeProgress } from "../domain/progress";
import type { LinesResponse } from "../domain/types";
import { viewportSize } from "../render/dom";
import { preparePageResources } from "../render/resources";
import { apiPost } from "../services/api";
import { perfMark, perfStart } from "../services/perf";
import { sleep } from "../services/timing";
import type { ControllerContext } from "./context";

// 表示中のページの線データの要求。次のページを要求したら取り消す
const linesRequests = new WeakMap<ControllerContext, AbortController>();

/** 擬似プログレスバーを更新する間隔(ms) */
const PROGRESS_TICK_MS = 100;

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export const showPage = async (
  ctx: ControllerContext,
  n: number
): Promise<void> => {
  const { app, dom } = ctx;
  const session = ctx.session();
  if (!session) {
    return;
  }
  perfStart(n);
  // 表示領域の大きさを正しく測るため、直前の変更(ツールバー・一覧の表示)を先に DOM へ反映しておく
  flushSync(() =>
    app.dispatch({
      index: n,
      type: "pageRequested",
      viewport: viewportSize(dom),
    })
  );
  const {
    page: { progress, request },
  } = app.getState();
  const primaryMs = progress?.primaryMs ?? 0;
  const tailMs = progress?.tailMs ?? 0;
  const t0 = performance.now();
  const tick = window.setInterval(() => {
    const { ratio, stageIndex } = computeProgress(
      performance.now() - t0,
      primaryMs,
      tailMs
    );
    app.dispatch({ ratio, request, stageIndex, type: "pageProgressTicked" });
  }, PROGRESS_TICK_MS);
  linesRequests.get(ctx)?.abort();
  const abort = new AbortController();
  linesRequests.set(ctx, abort);
  let data: LinesResponse;
  try {
    data = await apiPost<LinesResponse>(
      "/api/page/lines",
      await session.pageBody(n),
      abort.signal
    );
  } catch (e) {
    if (!abort.signal.aborted) {
      app.dispatch({ message: errorMessage(e), request, type: "pageFailed" });
    }
    return;
  } finally {
    window.clearInterval(tick);
    app.dispatch({
      durationMs: performance.now() - t0,
      request,
      type: "pageLoadSettled",
    });
  }
  if (request !== app.getState().page.request) {
    return;
  }
  perfMark(n, "線データ受信");
  app.dispatch({
    pageSize: data.page,
    request,
    type: "pageSizeReported",
    viewport: viewportSize(dom),
  });
  const model = buildPageModel(data);
  preparePageResources(model);
  perfMark(n, "描画準備完了", `${model.items.length}要素`);
  app.dispatch({ model, request, type: "pageLoaded" });
  // store の変更で予約された描画と同じフレームの後に呼ばれる
  requestAnimationFrame(() => perfMark(n, "初回描画完了"));
  // 100%表示を一瞬見せてから消す。ページが切り替わっていれば request 不一致で無視される
  await sleep(PROGRESS_HOLD_MS);
  app.dispatch({ request, type: "pageProgressCleared" });
};
