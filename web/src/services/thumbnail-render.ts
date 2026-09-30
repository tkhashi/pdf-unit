// サムネイルのラスタライズは専用 Worker(pdf.js)で行う(ADR 0041)。メインスレッドは
// 要求を投げて結果を待つだけで、パース・描画には関与しない
interface OpenedMessage {
  readonly docId: number;
  readonly kind: "opened";
}
interface OpenErrorMessage {
  readonly docId: number;
  readonly error: string;
  readonly kind: "open-error";
}
interface RenderedMessage {
  readonly dataUrl: string;
  readonly kind: "rendered";
  readonly reqId: number;
}
interface RenderErrorMessage {
  readonly error: string;
  readonly kind: "render-error";
  readonly reqId: number;
}
type OutMessage =
  | OpenedMessage
  | OpenErrorMessage
  | RenderedMessage
  | RenderErrorMessage;

export interface ThumbnailSource {
  readonly docId: number;
}

let worker: Worker | null = null;
let nextDocId = 1;
let nextReqId = 1;
const opening = new Map<
  number,
  { readonly resolve: () => void; readonly reject: (e: Error) => void }
>();
const pending = new Map<
  number,
  { readonly resolve: (v: string) => void; readonly reject: (e: Error) => void }
>();

const handleMessage = (e: MessageEvent<OutMessage>): void => {
  const msg = e.data;
  if (msg.kind === "opened") {
    opening.get(msg.docId)?.resolve();
    opening.delete(msg.docId);
  } else if (msg.kind === "open-error") {
    opening.get(msg.docId)?.reject(new Error(msg.error));
    opening.delete(msg.docId);
  } else if (msg.kind === "rendered") {
    pending.get(msg.reqId)?.resolve(msg.dataUrl);
    pending.delete(msg.reqId);
  } else {
    pending.get(msg.reqId)?.reject(new Error(msg.error));
    pending.delete(msg.reqId);
  }
};

const ensureWorker = (): Worker => {
  if (!worker) {
    worker = new Worker(
      new URL("../workers/thumbnail-worker.ts", import.meta.url),
      { type: "module" }
    );
    worker.onmessage = handleMessage;
  }
  return worker;
};

/**
 * 文書を開く。以後この文書のページは source を使って renderThumb で描画できる。
 * data は複製せずに Worker へ転送する(大きいPDFで複製を増やさないため。呼び出し後の data は空になる。ADR 0050)
 */
export const openThumbnailSource = (
  data: ArrayBuffer
): Promise<ThumbnailSource> => {
  const docId = nextDocId;
  nextDocId += 1;
  const w = ensureWorker();
  return new Promise((resolve, reject) => {
    opening.set(docId, { reject, resolve: () => resolve({ docId }) });
    w.postMessage({ data, docId, kind: "open" }, [data]);
  });
};

/** 数値が小さいほど先に処理する(可視中=0、先読み=1) */
export const THUMB_PRIORITY_VISIBLE = 0;
export const THUMB_PRIORITY_BACKGROUND = 1;

/** 指定ページを幅 width(px) でラスタライズし、data URL を返す */
export const renderThumb = (
  source: ThumbnailSource,
  page: number,
  width: number,
  priority: number
): Promise<string> => {
  const w = ensureWorker();
  const reqId = nextReqId;
  nextReqId += 1;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { reject, resolve });
    w.postMessage({
      docId: source.docId,
      kind: "render",
      page,
      priority,
      reqId,
      width,
    });
  });
};

/** 既に要求済みのページの優先度を変える(表示範囲に入って先読みから昇格した場合など) */
export const reprioritizeThumb = (
  source: ThumbnailSource,
  page: number,
  priority: number
): void => {
  worker?.postMessage({
    docId: source.docId,
    kind: "reprioritize",
    page,
    priority,
  });
};

/** 文書を閉じる。Worker 側で保持しているパース結果を破棄する */
export const closeThumbnailSource = (source: ThumbnailSource): void => {
  worker?.postMessage({ docId: source.docId, kind: "close" });
};
