// サムネイルのラスタライズ(pdf.js)をこの Worker 内で完結させる。pdf.js は `window` が無い環境
// (Worker内)では自身の内部 Worker 生成に失敗し、同一スレッド実行(fake worker)に自動で切り替わる。
// これにより、pdf.js の処理はすべてこの Worker 内に閉じ、メインスレッドは一切ブロックしない(ADR 0041)
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
} from "pdfjs-dist";
// Vite の ?url でビルド時に発行された URL を取る
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

// pdf.js は Worker 内では別 Worker の起動に失敗し、代わりに workerSrc を動的 import して
// 同一スレッドで処理する(fake worker)。workerSrc には実際に WorkerMessageHandler を
// エクスポートするモジュールを指す必要がある
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface OpenJob {
  readonly data: ArrayBuffer;
  readonly docId: number;
  readonly kind: "open";
}
interface RenderJob {
  readonly docId: number;
  readonly kind: "render";
  readonly page: number;
  readonly reqId: number;
  readonly width: number;
}
interface CloseJob {
  readonly docId: number;
  readonly kind: "close";
}
type InMessage = OpenJob | RenderJob | CloseJob;

type OutMessage =
  | { readonly kind: "opened"; readonly docId: number }
  | {
      readonly kind: "open-error";
      readonly docId: number;
      readonly error: string;
    }
  | {
      readonly kind: "rendered";
      readonly reqId: number;
      readonly dataUrl: string;
    }
  | {
      readonly kind: "render-error";
      readonly reqId: number;
      readonly error: string;
    };

// pdf.js の既定(DOMCanvasFactory)は document.createElement("canvas") を呼ぶため、
// document が無い Worker 内では画像デコード等の内部処理が失敗する。OffscreenCanvas で作り直す
interface CanvasAndContext {
  canvas: OffscreenCanvas | null;
  context: OffscreenCanvasRenderingContext2D | null;
}
class OffscreenCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(canvasAndContext: CanvasAndContext, width: number, height: number) {
    if (!canvasAndContext.canvas) {
      throw new Error("Canvas is not specified");
    }
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: CanvasAndContext) {
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

const tasks = new Map<number, PDFDocumentLoadingTask>();

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// btoa は1引数ずつでは遅いため、チャンク単位で文字列化してから渡す
const bufferToBase64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x80_00;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const handleOpen = async (job: OpenJob): Promise<void> => {
  try {
    const task = getDocument({
      CanvasFactory: OffscreenCanvasFactory,
      data: new Uint8Array(job.data),
    });
    tasks.set(job.docId, task);
    await task.promise;
    postMessage({ docId: job.docId, kind: "opened" } satisfies OutMessage);
  } catch (e) {
    tasks.delete(job.docId);
    postMessage({
      docId: job.docId,
      error: errorMessage(e),
      kind: "open-error",
    } satisfies OutMessage);
  }
};

const handleRender = async (job: RenderJob): Promise<void> => {
  try {
    const task = tasks.get(job.docId);
    if (!task) {
      throw new Error("document not open");
    }
    const doc = await task.promise;
    const page = await doc.getPage(job.page + 1);
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: job.width / unscaled.width });
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(viewport.width)),
      Math.max(1, Math.round(viewport.height))
    );
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("2d context unavailable");
    }
    await page.render({
      canvas: null,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const dataUrl = `data:image/png;base64,${bufferToBase64(await blob.arrayBuffer())}`;
    postMessage({
      dataUrl,
      kind: "rendered",
      reqId: job.reqId,
    } satisfies OutMessage);
  } catch (e) {
    postMessage({
      error: errorMessage(e),
      kind: "render-error",
      reqId: job.reqId,
    } satisfies OutMessage);
  }
};

const handleClose = (job: CloseJob): void => {
  tasks.get(job.docId)?.destroy();
  tasks.delete(job.docId);
};

self.onmessage = (e: MessageEvent<InMessage>) => {
  const job = e.data;
  if (job.kind === "open") {
    handleOpen(job);
  } else if (job.kind === "render") {
    handleRender(job);
  } else {
    handleClose(job);
  }
};
