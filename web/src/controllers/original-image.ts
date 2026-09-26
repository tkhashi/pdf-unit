// 原本画像(元PDFを描画した下敷き)。表示倍率に応じた解像度段階で読み込み、拡大したら取り直す
import { pngDataUrl } from "../domain/format";
import type { PageImageResponse } from "../domain/types";
import { neededResolution } from "../domain/view";
import { devicePixelRatio } from "../render/dom";
import { apiPost } from "../services/api";
import { perfMark } from "../services/perf";
import type { ControllerContext, DocumentSession } from "./context";

const syncImageSrc = (ctx: ControllerContext, src: string | null): void => {
  const img = ctx.dom.pageImage;
  if (!img) {
    return;
  }
  if (src === null) {
    img.removeAttribute("src");
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
  let r: PageImageResponse;
  try {
    r = await apiPost<PageImageResponse>(
      `/api/page/image?resolution=${res}`,
      await session.pageBody(page)
    );
  } catch {
    app.dispatch({ docId, page, res, type: "originalImageFailed" });
    return;
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
    if (s.originalImage.src !== p.originalImage.src) {
      syncImageSrc(ctx, ctx.app.getState().originalImage.src);
    }
    if (s.view !== p.view) {
      updateImage(ctx);
    }
  });
