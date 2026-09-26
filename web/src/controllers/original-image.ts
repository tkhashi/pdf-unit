// 原本画像(元PDFを描画した下敷き)。表示倍率に応じた解像度段階で読み込み、拡大したら取り直す
import { pngDataUrl } from "../domain/format";
import type { PageImageResponse } from "../domain/types";
import { neededResolution } from "../domain/view";
import { devicePixelRatio } from "../render/dom";
import { apiPost } from "../services/api";
import { perfMark } from "../services/perf";
import type { ControllerContext, DocumentSession } from "./context";

// 表示中のページの原本画像の要求。ページ・文書を切り替えたら取り消す
const imageRequests = new WeakMap<ControllerContext, Set<AbortController>>();

const abortImageRequests = (ctx: ControllerContext): void => {
  for (const abort of imageRequests.get(ctx) ?? []) {
    abort.abort();
  }
  imageRequests.delete(ctx);
};

const syncImageSrc = (ctx: ControllerContext, src: string | null): void => {
  const img = ctx.dom.pageImage;
  if (!img) {
    return;
  }
  // 埋め込み画像の範囲は原本画像を描き写すので、読み込み終わったら描き直す(ADR 0039)
  img.onload = () => ctx.renderer.invalidate(true);
  if (src === null) {
    img.removeAttribute("src");
    ctx.renderer.invalidate(true);
  } else {
    img.src = src;
  }
};

const updateImage = (ctx: ControllerContext): void => {
  const { app } = ctx;
  const s = app.getState();
  const session = ctx.session();
  if (!(s.doc && session)) {
    return;
  }
  const res = neededResolution(s.view.scale, devicePixelRatio());
  if (res <= s.originalImage.requestedRes) {
    return;
  }
  // 要求した段階を記録する。サーバーが応答サイズ上限のため解像度を下げて返しても、同じ段階を再要求しない
  const docId = s.doc.id;
  const page = s.page.index;
  app.dispatch({ docId, page, res, type: "originalImageRequested" });
  requestImage(ctx, session, docId, page, res);
};

const markDecoded = async (
  img: HTMLImageElement,
  page: number,
  resolution: number
): Promise<void> => {
  try {
    await img.decode();
    perfMark(page, `原本画像表示 ${resolution}dpi`);
  } catch {
    // 表示できなかった場合は計測を記録しないだけ
  }
};

const requestImage = async (
  ctx: ControllerContext,
  session: DocumentSession,
  docId: number,
  page: number,
  res: number
): Promise<void> => {
  const { app } = ctx;
  const abort = new AbortController();
  const requests = imageRequests.get(ctx) ?? new Set();
  requests.add(abort);
  imageRequests.set(ctx, requests);
  let r: PageImageResponse;
  try {
    r = await apiPost<PageImageResponse>(
      `/api/page/image?resolution=${res}`,
      await session.pageBody(page),
      abort.signal
    );
  } catch {
    if (!abort.signal.aborted) {
      app.dispatch({ docId, page, res, type: "originalImageFailed" });
    }
    return;
  } finally {
    requests.delete(abort);
  }
  const before = app.getState();
  app.dispatch({
    docId,
    page,
    resolution: r.resolution,
    src: pngDataUrl(r.png_base64),
    type: "originalImageLoaded",
  });
  const img = ctx.dom.pageImage;
  if (img && app.getState() !== before) {
    markDecoded(img, page, r.resolution);
  }
};

/** 表示変換が変わるたびに解像度段階を確かめる。画像要素の src は store の値に合わせる */
export const watchOriginalImage = (ctx: ControllerContext): (() => void) =>
  ctx.app.subscribe((s, p) => {
    if (s.page.index !== p.page.index || s.doc?.id !== p.doc?.id) {
      abortImageRequests(ctx);
    }
    if (s.originalImage.src !== p.originalImage.src) {
      syncImageSrc(ctx, ctx.app.getState().originalImage.src);
    }
    if (s.view !== p.view) {
      updateImage(ctx);
    }
  });
