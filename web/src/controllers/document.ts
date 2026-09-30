// 文書を開く: PDF本体はブラウザで保持し(pdf-lib)、表示するページだけをサーバーへ送る
import { flushSync } from "react-dom";
import { PAGE_PDF_CACHE } from "../domain/constants";
import { plainStatus } from "../domain/messages";
import { createPageBodyCache } from "../services/page-body-cache";
import {
  extractPages,
  isEncryptedPdfError,
  loadPdf,
  pageSizes,
} from "../services/pdf";
import { loadThumbsPref, saveThumbsPref } from "../services/prefs";
import {
  closeThumbnailSource,
  openThumbnailSource,
} from "../services/thumbnail-render";
import type { ControllerContext, DocumentSession } from "./context";
import { showPage } from "./page";
import type { ThumbnailScheduler } from "./thumbnails";

let nextDocId = 1;

const loadError = (e: unknown): string =>
  isEncryptedPdfError(e)
    ? "エラー: 暗号化されたPDFは開けません"
    : `エラー: PDFを読み込めません(${e instanceof Error ? e.message : String(e)})`;

export const openFile = async (
  ctx: ControllerContext,
  thumbs: ThumbnailScheduler,
  file: File
): Promise<void> => {
  const { app } = ctx;
  app.dispatch({ status: plainStatus("読み込み中..."), type: "statusChanged" });
  const previous = ctx.session();
  let session: DocumentSession;
  try {
    const raw = await file.arrayBuffer();
    const pdf = await loadPdf(raw);
    const id = nextDocId;
    nextDocId += 1;
    // 本体ページの表示を待たせないよう、サムネイル用 Worker の初期化は待たずに進める(ADR 0041)。
    // pdf-lib は読み込み時に必要なバイト列を複製して持つので、元のバイト列は複製せず Worker へ譲る(ADR 0051)
    const thumbSource = openThumbnailSource(raw);
    session = {
      id,
      pageBody: createPageBodyCache(
        (n) => extractPages(pdf, [n]),
        PAGE_PDF_CACHE
      ),
      pdf,
      thumbSource,
    };
  } catch (e) {
    app.dispatch({ status: plainStatus(loadError(e)), type: "statusChanged" });
    return;
  }
  if (previous) {
    previous.thumbSource.then(closeThumbnailSource, () => {
      // 開けなかった文書は閉じる必要がない
    });
  }
  ctx.setSession(session);
  thumbs.reset(session);
  const thumbsVisible = loadThumbsPref();
  // 一覧・ツールバーの表示を DOM へ反映してから、ページ全体を収める表示の大きさを測る
  flushSync(() =>
    app.dispatch({
      doc: {
        filename: file.name,
        id: session.id,
        pages: pageSizes(session.pdf),
      },
      thumbsVisible,
      type: "documentOpened",
    })
  );
  saveThumbsPref(thumbsVisible);
  document.title = `${file.name} - PDF Unit`;
  await showPage(ctx, 0);
};

export const setThumbsVisible = (
  ctx: ControllerContext,
  visible: boolean
): void => {
  ctx.app.dispatch({ type: "thumbsVisibilityChanged", visible });
  saveThumbsPref(visible);
};
